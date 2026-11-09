/**
 * Health checks em dois níveis:
 *
 *  - PÚBLICOS (/api/health, /api/health/ollama): estado mínimo para o widget e para balanceadores.
 *    Não consultam Qdrant/Neo4j/embeddings, não revelam ambiente, URLs, portas, versões, coleções
 *    nem modo de autenticação. O estado do Ollama é reaproveitado por alguns segundos.
 *
 *  - DIAGNÓSTICO INTERNO (/api/health/details): detalhes para a equipe de infraestrutura. Exige
 *    DIAGNOSTICS_TOKEN (Authorization: Bearer) ou, se DIAGNOSTICS_ALLOW_LOOPBACK estiver ativo,
 *    uma conexão direta de 127.0.0.1/::1 SEM cabeçalhos de proxy reverso.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.ts";
import type { DiagnosticsResponse, OllamaDiagnostics, OllamaHealthResponse, PublicHealthResponse } from "../contracts/api.ts";
import type { SecurityConfig } from "../config/env.ts";
import { HttpError } from "../errors.ts";

const startedAt = Date.now();

const NOT_CONFIGURED = { configured: false, reachable: false, detail: "Embeddings não configurados", dimensions: null };

/** Tempo padrão de reaproveitamento do estado público do Ollama. */
export const PUBLIC_HEALTH_CACHE_MS = 5_000;

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host", "x-forwarded-proto"];

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Comparação em tempo constante (hash de tamanho fixo evita vazar o comprimento). */
function tokenMatches(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

/** Decide se a requisição pode ver o diagnóstico interno. Nunca confia em X-Forwarded-For. */
export function diagnosticsAllowed(req: FastifyRequest, cfg: SecurityConfig["diagnostics"]): boolean {
  const raw = req.headers["authorization"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (header !== undefined) {
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    // Credencial enviada: vale só se for o token administrativo (nunca cai no modo loopback).
    return cfg.token !== null && !!m?.[1] && tokenMatches(m[1], cfg.token);
  }
  if (!cfg.allowLoopback) return false;
  const direct = LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "");
  const proxied = PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
  return direct && !proxied;
}

export async function healthRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const cacheMs = deps.publicHealthCacheMs ?? PUBLIC_HEALTH_CACHE_MS;

  async function ollamaDiagnostics(): Promise<OllamaDiagnostics> {
    const t0 = performance.now();
    const h = await deps.llm.health();
    const status = !h.reachable ? "unavailable" : h.modelAvailable ? "ok" : "degraded";
    return { status, ...h, latencyMs: Math.round(performance.now() - t0) };
  }

  // Cache do estado público: uma única consulta ao Ollama em andamento por vez.
  let cached: { at: number; value: Promise<OllamaHealthResponse> } | null = null;
  function publicOllama(): Promise<OllamaHealthResponse> {
    const now = Date.now();
    if (cached && now - cached.at < cacheMs) return cached.value;
    const value = ollamaDiagnostics().then(({ status, model, latencyMs }) => ({ status, model, latencyMs }));
    cached = { at: now, value };
    value.catch(() => {
      cached = null;
    });
    return value;
  }

  /** Público e mínimo: não toca nas bases nem no Ollama. */
  app.get("/api/health", async (): Promise<PublicHealthResponse> => ({
    status: "ok",
    service: "gerpro-ia-backend",
    version: deps.version,
    timestamp: new Date().toISOString(),
    chat: { maxMessages: deps.config.chat.maxMessages, maxCharsPerMessage: deps.config.chat.maxCharsPerMessage },
  }));

  /** Público e mínimo: 200 = modelo disponível; 503 = indisponível/degradado. */
  app.get("/api/health/ollama", async (_req, reply): Promise<OllamaHealthResponse> => {
    const body = await publicOllama();
    reply.code(body.status === "ok" ? 200 : 503);
    reply.header("cache-control", "no-store");
    return body;
  });

  /** Diagnóstico interno completo. Nunca expõe chaves, usuários, senhas ou tokens. */
  app.get("/api/health/details", async (req, reply): Promise<DiagnosticsResponse> => {
    if (!diagnosticsAllowed(req, deps.config.security.diagnostics)) {
      throw new HttpError(403, "forbidden", "Diagnóstico restrito à equipe de infraestrutura.");
    }
    reply.header("cache-control", "no-store");
    const [vs, graphStore, embeddings, ollama] = await Promise.all([
      deps.vectorStore.health(),
      deps.graphStore.health(),
      deps.embeddings ? deps.embeddings.health() : Promise.resolve(NOT_CONFIGURED),
      ollamaDiagnostics(),
    ]);

    // Coerência entre embeddings e coleções (dimensão do vetor).
    const warnings = [...(deps.warnings ?? [])];
    const expectedDims = embeddings.dimensions ?? deps.embeddings?.dimensions ?? null;
    for (const c of vs.collections ?? []) {
      if (!c.exists) warnings.push(`Coleção ${c.name}: ${c.detail}`);
      else if (c.dimensions === null) warnings.push(`Coleção ${c.name}: vetor configurado não encontrado`);
      else if (expectedDims !== null && expectedDims !== c.dimensions) {
        warnings.push(`Coleção ${c.name}: usa dimensão ${c.dimensions}, mas o modelo de embeddings gera ${expectedDims}`);
      }
    }

    return {
      status: "ok",
      service: "gerpro-ia-backend",
      version: deps.version,
      environment: deps.config.environment,
      strict: deps.config.security.strict,
      chatRequiresAuth: deps.config.security.requireChatAuth,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
      ollama,
      adapters: {
        vectorStore: { configured: vs.configured, reachable: vs.reachable, detail: vs.detail },
        graphStore: { configured: graphStore.configured, reachable: graphStore.reachable, detail: graphStore.detail },
        embeddings: { configured: embeddings.configured, reachable: embeddings.reachable, detail: embeddings.detail },
      },
      retrieval: {
        enabled: deps.retrieval.enabled,
        requireSources: deps.config.retrieval.requireSources,
        authMode: deps.auth.mode,
        collections: deps.vectorStore.collections.length,
        graphQueries: deps.graphStore.queries.length,
        warnings: [...new Set(warnings)],
      },
    };
  });
}

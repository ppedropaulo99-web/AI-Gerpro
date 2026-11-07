import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import type { HealthResponse, OllamaHealthResponse } from "../contracts/api.ts";

const startedAt = Date.now();

const NOT_CONFIGURED = { configured: false, reachable: false, detail: "Embeddings não configurados", dimensions: null };

export async function healthRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  /** Estado geral. Nunca expõe URLs, usuários, chaves ou nomes de banco. */
  app.get("/api/health", async (): Promise<HealthResponse> => {
    const [vs, graphStore, embeddings] = await Promise.all([
      deps.vectorStore.health(),
      deps.graphStore.health(),
      deps.embeddings ? deps.embeddings.health() : Promise.resolve(NOT_CONFIGURED),
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
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
      adapters: {
        vectorStore: { configured: vs.configured, reachable: vs.reachable, detail: vs.detail },
        graphStore: { configured: graphStore.configured, reachable: graphStore.reachable, detail: graphStore.detail },
        embeddings: { configured: embeddings.configured, reachable: embeddings.reachable, detail: embeddings.detail },
      },
      retrieval: {
        enabled: deps.retrieval.enabled,
        authMode: deps.auth.mode,
        collections: deps.vectorStore.collections.length,
        graphQueries: deps.graphStore.queries.length,
        warnings: [...new Set(warnings)],
      },
    };
  });

  app.get("/api/health/ollama", async (_req, reply): Promise<OllamaHealthResponse> => {
    const t0 = performance.now();
    const h = await deps.llm.health();
    const latencyMs = Math.round(performance.now() - t0);
    const status = !h.reachable ? "unavailable" : h.modelAvailable ? "ok" : "degraded";
    reply.code(status === "ok" ? 200 : 503);
    return { status, ...h, latencyMs };
  });
}

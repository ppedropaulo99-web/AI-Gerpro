/**
 * Conector Qdrant (cliente oficial @qdrant/js-client-rest) — SOMENTE LEITURA.
 *
 * Usa apenas: versionInfo (conectividade), getCollection (metadados para health) e query
 * (busca vetorial). Nenhum método de criação/alteração/exclusão é chamado.
 * O filtro de organização/permissão vem SEMPRE do AuthContext do servidor.
 */
import { QdrantClient } from "@qdrant/js-client-rest";
import type { QdrantConfig } from "../config/env.ts";
import type { CollectionMapping } from "../retrieval/mapping.ts";
import {
  AdapterError,
  getPath,
  toIdentifier,
  withDeadline,
  type AdapterHealth,
  type RetrievedRecord,
} from "./types.ts";
import type { MetadataFilter, VectorCollectionHealth, VectorSearchRequest, VectorStore } from "./vector-store.ts";

type Payload = Record<string, unknown>;
type Condition = Record<string, unknown>;

/** Subconjunto do cliente usado pelo conector (permite testes com dublês). */
export interface QdrantReadClient {
  versionInfo(): Promise<{ version?: string }>;
  getCollection(name: string): Promise<{ config?: { params?: { vectors?: unknown } } }>;
  query(
    collection: string,
    args: {
      query: number[];
      using?: string;
      limit: number;
      score_threshold?: number;
      filter?: { must: Condition[] };
      with_payload: string[] | boolean;
      with_vector: false;
      timeout?: number;
    },
  ): Promise<{ points: { id: string | number; score: number; payload?: Payload | null }[] }>;
}

export function createQdrantClient(cfg: QdrantConfig): QdrantReadClient {
  const url = new URL(cfg.url);
  const client = new QdrantClient({
    url: cfg.url,
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    https: url.protocol === "https:",
    timeout: cfg.timeoutMs,
    // Evita uma chamada extra a cada inicialização; a versão é verificada no health.
    checkCompatibility: false,
  });
  return {
    versionInfo: () => client.versionInfo(),
    getCollection: (name) => client.getCollection(name) as Promise<{ config?: { params?: { vectors?: unknown } } }>,
    query: (collection, args) =>
      client.query(collection, args) as unknown as Promise<{
        points: { id: string | number; score: number; payload?: Payload | null }[];
      }>,
  };
}

/** Converte erros do cliente em AdapterError sem repassar o corpo bruto (pode conter dados). */
export function mapQdrantError(err: unknown): AdapterError {
  if (err instanceof AdapterError) return err;
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "QdrantClientTimeoutError" || name === "AbortError" || /timeout/i.test(message)) {
    return new AdapterError("timeout", "Qdrant: tempo esgotado");
  }
  const status = /Unexpected Response:\s*(\d{3})/.exec(message)?.[1];
  if (status === "401" || status === "403") return new AdapterError("unauthorized", `Qdrant recusou a credencial (HTTP ${status})`);
  if (status === "404") return new AdapterError("not_found", "Qdrant: coleção não encontrada");
  if (status === "429") return new AdapterError("upstream", "Qdrant: limite de requisições atingido");
  if (status) return new AdapterError("upstream", `Qdrant respondeu HTTP ${status}`);
  return new AdapterError("unavailable", "Qdrant inacessível");
}

function vectorSize(vectors: unknown, vectorName: string | null): number | null {
  if (!vectors || typeof vectors !== "object") return null;
  const v = vectors as Record<string, unknown>;
  const target = vectorName === null ? v : v[vectorName];
  if (target && typeof target === "object" && typeof (target as { size?: unknown }).size === "number") {
    return (target as { size: number }).size;
  }
  return null;
}

function toCondition(f: MetadataFilter): Condition {
  if ("equals" in f) return { key: f.field, match: { value: f.equals } };
  if ("anyOf" in f) return { key: f.field, match: { any: f.anyOf } };
  return { key: f.field, range: f.range };
}

export class QdrantVectorStore implements VectorStore {
  readonly kind = "qdrant";
  readonly collections: readonly CollectionMapping[];
  readonly #client: QdrantReadClient;
  readonly #timeoutMs: number;

  constructor(client: QdrantReadClient, collections: readonly CollectionMapping[], timeoutMs: number) {
    this.#client = client;
    this.collections = collections;
    this.#timeoutMs = timeoutMs;
  }

  #collection(name: string): CollectionMapping {
    const col = this.collections.find((c) => c.name === name);
    if (!col) throw new AdapterError("forbidden_query", `Coleção não mapeada: ${name}`);
    return col;
  }

  /** Monta o filtro final: autorização (obrigatória) + filtros de metadados permitidos. */
  buildFilter(col: CollectionMapping, req: VectorSearchRequest): { must: Condition[] } | null {
    const must: Condition[] = [];
    if (!col.public) {
      if (!col.organizationField) throw new AdapterError("forbidden_query", "Coleção sem campo de organização");
      must.push({ key: col.organizationField, match: { value: req.auth.organizationId } });
    }
    if (col.permissionsField) {
      if (req.auth.permissions.length === 0) return null; // sem permissões → nada visível
      must.push({ key: col.permissionsField, match: { any: req.auth.permissions } });
    }
    const reserved = new Set([col.organizationField, col.permissionsField].filter(Boolean));
    for (const f of req.filters ?? []) {
      if (!col.filterableFields.includes(f.field) || reserved.has(f.field)) {
        throw new AdapterError("forbidden_query", `Campo não filtrável: ${f.field}`);
      }
      must.push(toCondition(f));
    }
    return { must };
  }

  async search(req: VectorSearchRequest): Promise<RetrievedRecord[]> {
    const col = this.#collection(req.collection);
    if (col.requiredPermission && !req.auth.permissions.includes(col.requiredPermission)) {
      throw new AdapterError("unauthorized", `Sem permissão para a coleção ${col.label}`);
    }
    if (!Array.isArray(req.vector) || req.vector.length === 0) throw new AdapterError("invalid_request", "Vetor vazio");
    const filter = this.buildFilter(col, req);
    if (filter === null) return [];

    const limit = Math.min(Math.max(1, req.limit ?? col.limit), col.limit);
    const threshold = req.scoreThreshold ?? col.scoreThreshold;
    const payloadFields = [
      ...new Set([col.contentField, col.titleField, col.urlField, ...col.identifierFields].filter((x): x is string => !!x)),
    ];

    let res;
    try {
      res = await withDeadline(
        () =>
          this.#client.query(col.name, {
            query: req.vector,
            ...(col.vectorName ? { using: col.vectorName } : {}),
            limit,
            ...(threshold !== null ? { score_threshold: threshold } : {}),
            ...(filter.must.length ? { filter } : {}),
            with_payload: payloadFields,
            with_vector: false,
            timeout: Math.max(1, Math.ceil(this.#timeoutMs / 1000)),
          }),
        this.#timeoutMs,
        req.signal,
        "Qdrant",
      );
    } catch (err) {
      throw mapQdrantError(err);
    }
    if (!res || !Array.isArray(res.points)) throw new AdapterError("upstream", "Qdrant: resposta inválida");

    const out: RetrievedRecord[] = [];
    for (const p of res.points.slice(0, limit)) {
      const payload = (p.payload ?? {}) as Payload;
      const content = getPath(payload, col.contentField);
      if (typeof content !== "string" || !content.trim()) continue; // ponto sem texto utilizável
      const identifiers: Record<string, string> = {};
      for (const f of col.identifierFields) {
        const v = toIdentifier(getPath(payload, f));
        if (v !== null) identifiers[f] = v;
      }
      const title = col.titleField ? toIdentifier(getPath(payload, col.titleField)) : null;
      const url = col.urlField ? toIdentifier(getPath(payload, col.urlField)) : null;
      out.push({
        id: `qdrant:${col.name}:${String(p.id)}`,
        origin: "qdrant",
        score: typeof p.score === "number" ? p.score : null,
        content,
        reference: { container: col.name, label: col.label, title, url: url && /^https?:\/\//i.test(url) ? url : null, identifiers },
      });
    }
    return out;
  }

  async health(): Promise<AdapterHealth & { collections: VectorCollectionHealth[] }> {
    try {
      const info = await withDeadline(() => this.#client.versionInfo(), this.#timeoutMs, undefined, "Qdrant");
      const collections = await Promise.all(
        this.collections.map(async (c): Promise<VectorCollectionHealth> => {
          try {
            const meta = await withDeadline(() => this.#client.getCollection(c.name), this.#timeoutMs, undefined, "Qdrant");
            const dims = vectorSize(meta.config?.params?.vectors, c.vectorName);
            return { name: c.name, exists: true, dimensions: dims, detail: dims === null ? "vetor não encontrado" : "ok" };
          } catch (err) {
            const e = mapQdrantError(err);
            return { name: c.name, exists: false, dimensions: null, detail: e.message };
          }
        }),
      );
      const ok = collections.every((c) => c.exists && c.dimensions !== null);
      return {
        configured: true,
        reachable: true,
        detail: `Qdrant ${info.version ?? "?"}; ${collections.length} coleção(ões) mapeada(s)${ok ? "" : " — verificar coleções"}`,
        collections,
      };
    } catch (err) {
      return { configured: true, reachable: false, detail: mapQdrantError(err).message, collections: [] };
    }
  }

  async close(): Promise<void> {}
}

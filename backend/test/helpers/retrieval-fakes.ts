/**
 * Dublês dos conectores para testes. Nenhum dado aqui é real: são registros sintéticos,
 * usados apenas para exercitar o código (não constituem base de demonstração).
 */
import { createHmac } from "node:crypto";
import type { QdrantReadClient } from "../../src/adapters/qdrant.ts";
import type { GraphRow, Neo4jReadExecutor } from "../../src/adapters/neo4j.ts";
import type { EmbeddingProvider } from "../../src/embeddings/provider.ts";
import type { AuthContext } from "../../src/auth/context.ts";
import { parseMapping, type RetrievalMapping } from "../../src/retrieval/mapping.ts";

export const AUTH: AuthContext = {
  userId: "u-teste",
  organizationId: "org-teste",
  permissions: ["docs:ler"],
  source: "teste",
  expiresAt: null,
};

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });

type QueryArgs = Parameters<QdrantReadClient["query"]>[1];
type Point = { id: string | number; score: number; payload?: Record<string, unknown> | null };

export class FakeQdrant implements QdrantReadClient {
  calls: { collection: string; args: QueryArgs }[] = [];
  points: Record<string, Point[]> = {};
  error: unknown = null;
  delayMs = 0;
  dims = 4;

  async versionInfo() {
    if (this.error) throw this.error;
    return { version: "teste" };
  }
  async getCollection(name: string) {
    if (!(name in this.points)) throw new Error("Unexpected Response: 404 (Not Found)\nRaw response content:\n{}");
    return { config: { params: { vectors: { size: this.dims, distance: "Cosine" } } } };
  }
  async query(collection: string, args: QueryArgs) {
    this.calls.push({ collection, args });
    if (this.delayMs) await sleep(this.delayMs);
    if (this.error) throw this.error;
    return { points: this.points[collection] ?? [] };
  }
}

export class FakeNeo4j implements Neo4jReadExecutor {
  calls: { cypher: string; params: Record<string, unknown>; metadata: Record<string, string> }[] = [];
  rows: (cypher: string, params: Record<string, unknown>) => GraphRow[] = () => [];
  error: unknown = null;
  delayMs = 0;
  closed = false;

  async verifyConnectivity() {
    if (this.error) throw this.error;
    return { version: "Neo4j/teste" };
  }
  async read(cypher: string, params: Record<string, unknown>, opts: { timeoutMs: number; metadata: Record<string, string> }) {
    this.calls.push({ cypher, params, metadata: opts.metadata });
    if (this.delayMs) await sleep(this.delayMs);
    if (this.error) throw this.error;
    return this.rows(cypher, params);
  }
  async close() {
    this.closed = true;
  }
}

export class FakeEmbeddings implements EmbeddingProvider {
  readonly model = "embed-teste";
  readonly dimensions = 4;
  calls: string[] = [];
  error: unknown = null;
  async embedQuery(text: string) {
    this.calls.push(text);
    if (this.error) throw this.error;
    return [0.1, 0.2, 0.3, 0.4];
  }
  async health() {
    return { configured: true, reachable: true, detail: "ok", dimensions: 4 };
  }
}

/** Mapeamento sintético: 1 coleção e 2 consultas (uma por regex da pergunta, outra por vínculo). */
export function testMapping(): RetrievalMapping {
  return parseMapping({
    version: 1,
    qdrant: {
      collections: [
        {
          name: "docs_teste",
          label: "Documentos (teste)",
          contentField: "texto",
          titleField: "titulo",
          urlField: "url",
          identifierFields: ["documentoId", "registroId"],
          organizationField: "orgId",
          permissionsField: "permissoes",
          filterableFields: ["tipo"],
          limit: 3,
        },
      ],
    },
    neo4j: {
      queries: [
        {
          name: "registroPorCodigo",
          label: "Registro por código",
          cypher: "MATCH (r:Registro {codigo: $codigo}) WHERE r.orgId = $auth_organizationId RETURN r.codigo AS id, r.resumo AS resumo LIMIT $limit",
          params: { codigo: { type: "string", pattern: "REG-[0-9]{4}" } },
          fromQuestion: { codigo: "\\b(REG-[0-9]{4})\\b" },
          idField: "id",
          contentFields: ["resumo"],
        },
        {
          name: "registroPorId",
          label: "Registro vinculado",
          cypher: "MATCH (r:Registro {id: $registroId}) WHERE r.orgId = $auth_organizationId RETURN r.id AS id, r.resumo AS resumo LIMIT $limit",
          params: { registroId: { type: "string", maxLength: 64 } },
          idField: "id",
          contentFields: ["resumo"],
        },
      ],
      links: [{ collection: "docs_teste", payloadField: "registroId", query: "registroPorId", param: "registroId" }],
    },
  });
}

export const TEST_SECRET = "segredo-de-teste-com-mais-de-32-bytes!!";

/** Emite um JWT HS256 de teste. */
export function signJwt(claims: Record<string, unknown>, secret = TEST_SECRET, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = enc(header);
  const p = enc(claims);
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

export const nowSec = () => Math.floor(Date.now() / 1000);

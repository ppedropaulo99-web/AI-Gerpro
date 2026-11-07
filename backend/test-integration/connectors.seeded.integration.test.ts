/**
 * Testes REAIS dos conectores contra instâncias ISOLADAS de Qdrant e Neo4j, com dados técnicos
 * mínimos e descartáveis (criados e removidos pelo próprio teste).
 *
 *   npm run test:integration -w backend
 *
 * Segurança:
 * - Usa variáveis PRÓPRIAS (IT_*), nunca QDRANT_* / NEO4J_* de produção: o teste escreve dados e
 *   não pode, por engano, apontar para uma base corporativa.
 * - Só aceita localhost, a menos que IT_ALLOW_REMOTE=true (instância de teste dedicada).
 * - Qdrant: cria uma coleção "ai_gerpro_it_<aleatório>" (recusa se já existir) e a exclui ao final.
 * - Neo4j: cria nós com o rótulo AiGerproIT e um runId aleatório e remove só esses nós ao final.
 * - Nenhum dado de processos, clientes ou contratos: apenas textos técnicos ("ponto técnico A").
 *
 * Variáveis:
 *   IT_QDRANT_URL, IT_QDRANT_API_KEY (opcional)
 *   IT_NEO4J_URI, IT_NEO4J_USER, IT_NEO4J_PASSWORD, IT_NEO4J_DATABASE (opcional)
 *   IT_ALLOW_REMOTE=true (opcional)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import neo4j from "neo4j-driver";
import { QdrantVectorStore, createQdrantClient } from "../src/adapters/qdrant.ts";
import { Neo4jGraphStore, createNeo4jExecutor, mapNeo4jError } from "../src/adapters/neo4j.ts";
import { parseMapping } from "../src/retrieval/mapping.ts";
import { RetrievalService } from "../src/retrieval/service.ts";
import type { AuthContext } from "../src/auth/context.ts";
import type { EmbeddingProvider } from "../src/embeddings/provider.ts";

const env = process.env;
const runId = randomBytes(4).toString("hex");
const isLocal = (raw: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(raw).hostname);
const allowed = (raw: string | undefined): raw is string => !!raw && (isLocal(raw) || env["IT_ALLOW_REMOTE"] === "true");

const qdrantUrl = env["IT_QDRANT_URL"];
const neo4jUri = env["IT_NEO4J_URI"];
const skipQdrant = allowed(qdrantUrl) ? false : "defina IT_QDRANT_URL (instância isolada; localhost ou IT_ALLOW_REMOTE=true)";
const skipNeo4j = allowed(neo4jUri) ? false : "defina IT_NEO4J_URI/USER/PASSWORD (instância isolada; localhost ou IT_ALLOW_REMOTE=true)";

const ORG_A: AuthContext = { userId: "it-user", organizationId: `it-org-a-${runId}`, permissions: ["it:ler"], source: "it", expiresAt: null };
const ORG_B: AuthContext = { ...ORG_A, organizationId: `it-org-b-${runId}` };

/** Vetores fixos de 4 dimensões: o teste valida o conector, não a qualidade semântica. */
const V = { a: [1, 0, 0, 0], b: [0.9, 0.1, 0, 0], c: [0, 1, 0, 0] };
class FixedEmbeddings implements EmbeddingProvider {
  readonly model = "fixo-it";
  readonly dimensions = 4;
  async embedQuery() {
    return V.a;
  }
  async health() {
    return { configured: true, reachable: true, detail: "fixo", dimensions: 4 };
  }
}

const collection = `ai_gerpro_it_${runId}`;

function mapping() {
  return parseMapping({
    version: 1,
    qdrant: {
      collections: [
        {
          name: collection,
          contentField: "texto",
          titleField: "titulo",
          identifierFields: ["itemId"],
          organizationField: "orgId",
          permissionsField: "perms",
          filterableFields: ["tipo"],
          limit: 5,
        },
      ],
    },
    neo4j: {
      queries: [
        {
          name: "itemTecnico",
          cypher:
            "MATCH (n:AiGerproIT {runId: $runId, itemId: $itemId}) WHERE n.orgId = $auth_organizationId RETURN n.itemId AS id, n.texto AS texto LIMIT $limit",
          params: { runId: { type: "string" }, itemId: { type: "string" } },
          idField: "id",
          contentFields: ["texto"],
        },
      ],
      links: [],
    },
  });
}

test("Qdrant real: busca somente leitura com filtros de organização, permissão e metadados", { skip: skipQdrant }, async () => {
  const admin = new QdrantClient({
    url: qdrantUrl!,
    ...(env["IT_QDRANT_API_KEY"] ? { apiKey: env["IT_QDRANT_API_KEY"] } : {}),
    checkCompatibility: false,
  });
  const exists = await admin.collectionExists(collection);
  assert.equal(exists.exists, false, "coleção de teste já existe: abortando para não tocar em dados alheios");
  await admin.createCollection(collection, { vectors: { size: 4, distance: "Cosine" } });
  try {
    await admin.upsert(collection, {
      wait: true,
      points: [
        { id: 1, vector: V.a, payload: { texto: "ponto técnico A", titulo: "A", itemId: "IT-A", orgId: ORG_A.organizationId, perms: ["it:ler"], tipo: "x" } },
        { id: 2, vector: V.b, payload: { texto: "ponto técnico B", titulo: "B", itemId: "IT-B", orgId: ORG_B.organizationId, perms: ["it:ler"], tipo: "x" } },
        { id: 3, vector: V.c, payload: { texto: "ponto técnico C", titulo: "C", itemId: "IT-C", orgId: ORG_A.organizationId, perms: ["outra"], tipo: "y" } },
      ],
    });
    const store = new QdrantVectorStore(
      createQdrantClient({ url: qdrantUrl!, apiKey: env["IT_QDRANT_API_KEY"] ?? null, timeoutMs: 5000 }),
      mapping().collections,
      5000,
    );
    const h = await store.health();
    assert.equal(h.reachable, true, h.detail);
    assert.deepEqual(h.collections?.[0]?.dimensions, 4);

    const a = await store.search({ collection, vector: V.a, auth: ORG_A });
    assert.deepEqual(a.map((r) => r.id), [`qdrant:${collection}:1`], "só a organização A, com a permissão it:ler");
    assert.equal(a[0]!.reference.identifiers["itemId"], "IT-A");

    const b = await store.search({ collection, vector: V.a, auth: ORG_B });
    assert.deepEqual(b.map((r) => r.id), [`qdrant:${collection}:2`]);

    const noPerm = await store.search({ collection, vector: V.c, auth: { ...ORG_A, permissions: ["outra"] } });
    assert.deepEqual(noPerm.map((r) => r.id), [`qdrant:${collection}:3`]);

    const filtered = await store.search({ collection, vector: V.a, auth: ORG_A, filters: [{ field: "tipo", equals: "y" }] });
    assert.equal(filtered.length, 0);

    const missing = new QdrantVectorStore(
      createQdrantClient({ url: qdrantUrl!, apiKey: env["IT_QDRANT_API_KEY"] ?? null, timeoutMs: 5000 }),
      parseMapping({ version: 1, qdrant: { collections: [{ name: `${collection}_inexistente`, contentField: "t", organizationField: "o" }] } }).collections,
      5000,
    );
    await assert.rejects(missing.search({ collection: `${collection}_inexistente`, vector: V.a, auth: ORG_A }), { kind: "not_found" });
  } finally {
    await admin.deleteCollection(collection);
  }
});

test("Neo4j real: consulta pré-autorizada em sessão de leitura, escopo de organização e escrita recusada", { skip: skipNeo4j }, async () => {
  const cfg = {
    uri: neo4jUri!,
    user: env["IT_NEO4J_USER"] ?? null,
    password: env["IT_NEO4J_PASSWORD"] ?? null,
    database: env["IT_NEO4J_DATABASE"] ?? null,
    timeoutMs: 5000,
    maxPoolSize: 2,
  };
  const admin = neo4j.driver(cfg.uri, cfg.user && cfg.password ? neo4j.auth.basic(cfg.user, cfg.password) : undefined);
  const db = cfg.database ? { database: cfg.database } : {};
  const exec = createNeo4jExecutor(cfg);
  try {
    await admin.executeQuery(
      "UNWIND $rows AS r CREATE (:AiGerproIT {runId: $runId, itemId: r.itemId, orgId: r.orgId, texto: r.texto})",
      {
        runId,
        rows: [
          { itemId: "IT-1", orgId: ORG_A.organizationId, texto: "nó técnico 1" },
          { itemId: "IT-1", orgId: ORG_B.organizationId, texto: "nó técnico 1 de outra organização" },
        ],
      },
      { ...db, routing: neo4j.routing.WRITE },
    );

    const store = new Neo4jGraphStore(exec, mapping().queries, 5000);
    assert.equal((await store.health()).reachable, true);
    const a = await store.run({ query: "itemTecnico", params: { runId, itemId: "IT-1" }, auth: ORG_A });
    assert.deepEqual(a.map((r) => r.content), ["texto: nó técnico 1"], "somente a organização do AuthContext");
    const b = await store.run({ query: "itemTecnico", params: { runId, itemId: "IT-1" }, auth: ORG_B });
    assert.deepEqual(b.map((r) => r.content), ["texto: nó técnico 1 de outra organização"]);

    // Garantia de leitura vem do servidor: mesmo contornando o cypher-guard, a sessão READ recusa escrita.
    const write = exec.read("CREATE (n:AiGerproIT {runId: $runId, itemId: 'ESCRITA'}) RETURN n LIMIT 1", { runId }, { timeoutMs: 5000, metadata: { app: "ai-gerpro-it" } });
    await assert.rejects(write, (err: unknown) => mapNeo4jError(err).kind === "forbidden_query");
    const check = await admin.executeQuery("MATCH (n:AiGerproIT {runId: $runId, itemId: 'ESCRITA'}) RETURN count(n) AS c", { runId }, db);
    assert.equal(check.records[0]!.get("c").toNumber(), 0, "nenhum nó foi criado pela sessão de leitura");

    // Serviço completo com conectores reais (somente o grafo aqui)
    const svc = new RetrievalService({
      vectorStore: { kind: "unconfigured", collections: [], health: async () => ({ configured: false, reachable: false, detail: "" }), search: async () => [], close: async () => {} },
      graphStore: store,
      embeddings: new FixedEmbeddings(),
      mapping: mapping(),
      config: { mappingPath: null, timeoutMs: 8000, maxSources: 8, maxContextChars: 6000, maxCharsPerSource: 1500, contextTurns: 4 },
    });
    assert.equal(svc.graphEnabled, true);
  } finally {
    await admin.executeQuery("MATCH (n:AiGerproIT {runId: $runId}) DETACH DELETE n", { runId }, { ...db, routing: neo4j.routing.WRITE });
    await exec.close();
    await admin.close();
  }
});

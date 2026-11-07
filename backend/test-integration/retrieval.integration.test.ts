/**
 * Testes de integração OPCIONAIS contra serviços reais de TESTE autorizados.
 *
 *   npm run test:integration -w backend
 *
 * São ignorados (skip) se INTEGRATION_RETRIEVAL não for "true". Usam a mesma configuração do
 * backend (backend/.env): QDRANT_*, NEO4J_*, EMBEDDINGS_*, RETRIEVAL_CONFIG_PATH.
 * Somente leitura: nenhum teste cria, altera ou exclui dados ou coleções.
 * NÃO aponte para bases com dados reais de clientes sem autorização expressa.
 *
 * Variáveis opcionais para a busca ponta a ponta:
 *   INTEGRATION_QUESTION   pergunta de teste
 *   INTEGRATION_ORG        organização de teste (simula o AuthContext emitido pelo Gerpro)
 *   INTEGRATION_USER       usuário de teste (padrão: integration-test)
 *   INTEGRATION_PERMS      permissões separadas por vírgula
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/env.ts";
import { createRetrievalStack } from "../src/retrieval/bootstrap.ts";

const enabled = process.env["INTEGRATION_RETRIEVAL"] === "true";
const skip = enabled ? false : "defina INTEGRATION_RETRIEVAL=true e configure serviços de teste autorizados";

test("Qdrant: conectividade e coleções mapeadas", { skip }, async (t) => {
  const config = loadConfig();
  if (!config.qdrant) return t.skip("QDRANT_URL não configurado");
  const stack = createRetrievalStack(config);
  try {
    const h = await stack.vectorStore.health();
    assert.equal(h.reachable, true, h.detail);
    for (const c of h.collections ?? []) {
      assert.equal(c.exists, true, `coleção ${c.name}: ${c.detail}`);
      assert.notEqual(c.dimensions, null, `coleção ${c.name}: vetor não encontrado`);
    }
  } finally {
    await stack.retrieval.close();
  }
});

test("Embeddings: dimensão compatível com as coleções", { skip }, async (t) => {
  const config = loadConfig();
  if (!config.qdrant || !config.embeddings) return t.skip("Qdrant ou EMBEDDINGS_MODEL não configurado");
  const stack = createRetrievalStack(config);
  try {
    const e = await stack.embeddings!.health();
    assert.equal(e.reachable, true, e.detail);
    const h = await stack.vectorStore.health();
    for (const c of h.collections ?? []) {
      assert.equal(c.dimensions, e.dimensions, `coleção ${c.name}: dimensão ${c.dimensions} ≠ embeddings ${e.dimensions}`);
    }
  } finally {
    await stack.retrieval.close();
  }
});

test("Neo4j: conectividade (sessão de leitura)", { skip }, async (t) => {
  const config = loadConfig();
  if (!config.neo4j) return t.skip("NEO4J_URI não configurado");
  const stack = createRetrievalStack(config);
  try {
    const h = await stack.graphStore.health();
    assert.equal(h.reachable, true, h.detail);
  } finally {
    await stack.retrieval.close();
  }
});

test("Recuperação ponta a ponta com contexto de autorização de teste", { skip }, async (t) => {
  const question = process.env["INTEGRATION_QUESTION"];
  const org = process.env["INTEGRATION_ORG"];
  if (!question || !org) return t.skip("defina INTEGRATION_QUESTION e INTEGRATION_ORG");
  const stack = createRetrievalStack(loadConfig());
  try {
    const r = await stack.retrieval.retrieve(question, {
      userId: process.env["INTEGRATION_USER"] ?? "integration-test",
      organizationId: org,
      permissions: (process.env["INTEGRATION_PERMS"] ?? "").split(",").map((p) => p.trim()).filter(Boolean),
      source: "integration-test",
      expiresAt: null,
    });
    t.diagnostic(`grounding=${r.grounding} qdrant=${r.status.qdrant.state}(${r.status.qdrant.count}) neo4j=${r.status.neo4j.state}(${r.status.neo4j.count}) ${r.durationMs} ms`);
    assert.notEqual(r.status.qdrant.state, "error", r.status.qdrant.detail);
    assert.notEqual(r.status.neo4j.state, "error", r.status.neo4j.detail);
    for (const s of r.sources) assert.match(s.id, /^(qdrant|neo4j):/);
  } finally {
    await stack.retrieval.close();
  }
});

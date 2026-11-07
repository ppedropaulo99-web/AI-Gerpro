import { test } from "node:test";
import assert from "node:assert/strict";
import neo4j from "neo4j-driver";
import { QdrantVectorStore, mapQdrantError } from "../src/adapters/qdrant.ts";
import { Neo4jGraphStore, mapNeo4jError, normalizeNeo4jValue } from "../src/adapters/neo4j.ts";
import { AdapterError } from "../src/adapters/types.ts";
import { AUTH, FakeNeo4j, FakeQdrant, testMapping } from "./helpers/retrieval-fakes.ts";

const VEC = [0.1, 0.2, 0.3, 0.4];

function qdrant(timeoutMs = 1000) {
  const client = new FakeQdrant();
  return { client, store: new QdrantVectorStore(client, testMapping().collections, timeoutMs) };
}
function graph(timeoutMs = 1000) {
  const exec = new FakeNeo4j();
  return { exec, store: new Neo4jGraphStore(exec, testMapping().queries, timeoutMs) };
}

// ---------------- Qdrant ----------------

test("Qdrant: filtro de organização e permissões vem do AuthContext; só leitura de payload", async () => {
  const { client, store } = qdrant();
  client.points["docs_teste"] = [];
  await store.search({ collection: "docs_teste", vector: VEC, auth: AUTH, filters: [{ field: "tipo", equals: "parecer" }] });
  const { args } = client.calls[0]!;
  assert.deepEqual(args.filter?.must, [
    { key: "orgId", match: { value: "org-teste" } },
    { key: "permissoes", match: { any: ["docs:ler"] } },
    { key: "tipo", match: { value: "parecer" } },
  ]);
  assert.equal(args.with_vector, false);
  assert.deepEqual(args.with_payload, ["texto", "titulo", "url", "documentoId", "registroId"]);
  assert.equal(args.limit, 3, "limite da coleção");
});

test("Qdrant: filtros em campos não permitidos ou de autorização são recusados", async () => {
  const { client, store } = qdrant();
  for (const field of ["orgId", "permissoes", "qualquer"]) {
    await assert.rejects(
      store.search({ collection: "docs_teste", vector: VEC, auth: AUTH, filters: [{ field, equals: "org-de-outro" }] }),
      { kind: "forbidden_query" },
    );
  }
  assert.equal(client.calls.length, 0);
});

test("Qdrant: coleção não mapeada, limite acima do máximo e usuário sem permissões", async () => {
  const { client, store } = qdrant();
  await assert.rejects(store.search({ collection: "outra", vector: VEC, auth: AUTH }), { kind: "forbidden_query" });
  client.points["docs_teste"] = [];
  await store.search({ collection: "docs_teste", vector: VEC, auth: AUTH, limit: 999 });
  assert.equal(client.calls[0]!.args.limit, 3);
  const none = await store.search({ collection: "docs_teste", vector: VEC, auth: { ...AUTH, permissions: [] } });
  assert.deepEqual(none, []);
  assert.equal(client.calls.length, 1, "sem permissões nem consulta o Qdrant");
});

test("Qdrant: resultados normalizados com id, score, conteúdo e referência", async () => {
  const { client, store } = qdrant();
  client.points["docs_teste"] = [
    { id: 7, score: 0.91, payload: { texto: "Trecho A", titulo: "Doc A", url: "https://exemplo.invalid/a", documentoId: "D-1", registroId: "R-1" } },
    { id: "x", score: 0.5, payload: { titulo: "sem texto" } },
    { id: 8, score: 0.4, payload: { texto: "Trecho B", url: "javascript:alert(1)" } },
  ];
  const out = await store.search({ collection: "docs_teste", vector: VEC, auth: AUTH });
  assert.equal(out.length, 2, "ponto sem texto é ignorado");
  assert.deepEqual(out[0], {
    id: "qdrant:docs_teste:7",
    origin: "qdrant",
    score: 0.91,
    content: "Trecho A",
    reference: {
      container: "docs_teste",
      label: "Documentos (teste)",
      title: "Doc A",
      url: "https://exemplo.invalid/a",
      identifiers: { documentoId: "D-1", registroId: "R-1" },
    },
  });
  assert.equal(out[1]!.reference.url, null, "URL não http(s) é descartada");
});

test("Qdrant: erros e indisponibilidade viram AdapterError sem vazar o corpo da resposta", async () => {
  const cases: [unknown, string][] = [
    [new Error('Unexpected Response: 401 (Unauthorized)\nRaw response content:\n{"segredo":"x"}'), "unauthorized"],
    [new Error("Unexpected Response: 404 (Not Found)"), "not_found"],
    [new Error("Unexpected Response: 500 (Internal)"), "upstream"],
    [Object.assign(new Error("x"), { name: "QdrantClientTimeoutError" }), "timeout"],
    [new TypeError("fetch failed"), "unavailable"],
  ];
  for (const [err, kind] of cases) {
    const e = mapQdrantError(err);
    assert.equal(e.kind, kind);
    assert.doesNotMatch(e.message, /segredo/);
  }
  const { client, store } = qdrant();
  client.error = new TypeError("fetch failed");
  await assert.rejects(store.search({ collection: "docs_teste", vector: VEC, auth: AUTH }), { kind: "unavailable" });
  const h = await store.health();
  assert.equal(h.reachable, false);
});

test("Qdrant: timeout local interrompe a espera", async () => {
  const { client, store } = qdrant(50);
  client.delayMs = 500;
  const t0 = performance.now();
  await assert.rejects(store.search({ collection: "docs_teste", vector: VEC, auth: AUTH }), { kind: "timeout" });
  assert.ok(performance.now() - t0 < 400);
});

test("Qdrant: health informa existência e dimensão das coleções", async () => {
  const { client, store } = qdrant();
  client.points["docs_teste"] = [];
  const h = await store.health();
  assert.equal(h.reachable, true);
  assert.deepEqual(h.collections, [{ name: "docs_teste", exists: true, dimensions: 4, detail: "ok" }]);
});

// ---------------- Neo4j ----------------

test("Neo4j: só executa consultas pré-autorizadas; nunca Cypher livre", async () => {
  const { exec, store } = graph();
  await assert.rejects(store.run({ query: "MATCH (n) DETACH DELETE n", params: {}, auth: AUTH }), { kind: "forbidden_query" });
  await assert.rejects(store.run({ query: "naoExiste", params: {}, auth: AUTH }), { kind: "forbidden_query" });
  assert.equal(exec.calls.length, 0);
});

test("Neo4j: parâmetros validados (ausentes, extras, formato) e auth_* injetados pelo servidor", async () => {
  const { exec, store } = graph();
  await assert.rejects(store.run({ query: "registroPorCodigo", params: {}, auth: AUTH }), { kind: "invalid_request" });
  await assert.rejects(store.run({ query: "registroPorCodigo", params: { codigo: "REG-0001' OR 1=1" }, auth: AUTH }), {
    kind: "invalid_request",
  });
  await assert.rejects(
    store.run({ query: "registroPorCodigo", params: { codigo: "REG-0001", auth_organizationId: "org-de-outro" }, auth: AUTH }),
    { kind: "invalid_request" },
    "o chamador não pode sobrescrever a organização",
  );
  await store.run({ query: "registroPorCodigo", params: { codigo: "REG-0001" }, auth: AUTH, limit: 999 });
  const call = exec.calls[0]!;
  assert.equal(call.params["codigo"], "REG-0001");
  assert.equal(call.params["auth_organizationId"], "org-teste");
  assert.equal(call.params["auth_userId"], "u-teste");
  assert.ok(neo4j.isInt(call.params["limit"]), "LIMIT enviado como inteiro do Neo4j");
  assert.equal((call.params["limit"] as ReturnType<typeof neo4j.int>).toNumber(), 10, "limite máximo da consulta");
  assert.equal(call.metadata["query"], "registroPorCodigo");
});

test("Neo4j: linhas normalizadas; registros sem identificador são descartados", async () => {
  const { exec, store } = graph();
  exec.rows = () => [{ id: "REG-0001", resumo: "Resumo sintético" }, { id: null, resumo: "sem id" }];
  const out = await store.run({ query: "registroPorCodigo", params: { codigo: "REG-0001" }, auth: AUTH });
  assert.deepEqual(out, [
    {
      id: "neo4j:registroPorCodigo:REG-0001",
      origin: "neo4j",
      score: null,
      content: "resumo: Resumo sintético",
      reference: { container: "registroPorCodigo", label: "Registro por código", title: null, url: null, identifiers: { id: "REG-0001" } },
    },
  ]);
});

test("Neo4j: tipos do driver são convertidos para JSON simples", () => {
  assert.equal(normalizeNeo4jValue(neo4j.int(42)), 42);
  assert.equal(normalizeNeo4jValue(neo4j.int("9007199254740993")), "9007199254740993");
  assert.equal(normalizeNeo4jValue(new neo4j.types.Date(2026, 1, 2)), "2026-01-02");
  const node = new neo4j.types.Node(neo4j.int(1), ["Registro"], { codigo: "REG-1", n: neo4j.int(3) }, "4:x:1");
  assert.deepEqual(normalizeNeo4jValue(node), { codigo: "REG-1", n: 3, _labels: ["Registro"], _elementId: "4:x:1" });
});

test("Neo4j: erros do driver mapeados; escrita recusada pelo servidor vira forbidden_query", () => {
  const e = (code: string) => mapNeo4jError(Object.assign(new Error("detalhe interno"), { code }));
  assert.equal(e("ServiceUnavailable").kind, "unavailable");
  assert.equal(e("Neo.ClientError.Security.Unauthorized").kind, "unauthorized");
  assert.equal(e("Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration").kind, "timeout");
  assert.equal(e("Neo.ClientError.Statement.AccessMode").kind, "forbidden_query");
  assert.equal(e("Neo.ClientError.Statement.SyntaxError").kind, "invalid_request");
  assert.doesNotMatch(e("Neo.TransientError.General.Whatever").message, /detalhe interno/);
});

test("Neo4j: timeout e falha de conexão", async () => {
  const { exec, store } = graph(50);
  exec.delayMs = 1000;
  await assert.rejects(store.run({ query: "registroPorCodigo", params: { codigo: "REG-0001" }, auth: AUTH }), { kind: "timeout" });
  exec.delayMs = 0;
  exec.error = Object.assign(new Error("x"), { code: "ServiceUnavailable" });
  await assert.rejects(store.run({ query: "registroPorCodigo", params: { codigo: "REG-0001" }, auth: AUTH }), AdapterError);
  assert.equal((await store.health()).reachable, false);
  await store.close();
  assert.ok(exec.closed);
});

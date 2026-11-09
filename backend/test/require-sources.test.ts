/**
 * Modo contextual obrigatório (RETRIEVAL_REQUIRE_SOURCES): sem fontes relevantes, o backend
 * responde com texto fixo e NÃO chama o modelo — em /api/chat e /api/chat/stream, para qualquer
 * cliente. Dados sintéticos, conectores simulados.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { ConfigError, loadConfig } from "../src/config/env.ts";
import { createRetrievalStack } from "../src/retrieval/bootstrap.ts";
import { REQUIRED_SOURCES_TEXT } from "../src/retrieval/grounding.ts";
import type { RetrievalMapping } from "../src/retrieval/mapping.ts";
import type { ChatMessage, LlmClient, LlmStreamEvent } from "../src/ollama/client.ts";
import { FakeEmbeddings, FakeNeo4j, FakeQdrant, TEST_SECRET, nowSec, signJwt, testMapping } from "./helpers/retrieval-fakes.ts";

/** Modelo simulado: registra cada chamada e o sinal de cancelamento recebido. */
class SpyLlm implements LlmClient {
  readonly model = "fake:1b";
  calls: ChatMessage[][] = [];
  signals: AbortSignal[] = [];
  answer = "Conforme [Q1], o trecho fictício diz X.";
  /** Stream que fica aberto até o cancelamento (para testar a interrupção). */
  hang = false;
  async health() {
    return { reachable: true, modelAvailable: true, model: this.model, availableModels: [this.model], version: "0", error: null };
  }
  async chat(messages: ChatMessage[], signal?: AbortSignal) {
    this.calls.push(messages);
    if (signal) this.signals.push(signal);
    return { model: this.model, content: this.answer, totalDurationMs: 1, promptTokens: 1, completionTokens: 1 };
  }
  async openChatStream(messages: ChatMessage[], signal?: AbortSignal): Promise<AsyncIterable<LlmStreamEvent>> {
    this.calls.push(messages);
    if (signal) this.signals.push(signal);
    const { answer, model, hang } = this;
    return (async function* (): AsyncGenerator<LlmStreamEvent> {
      yield { type: "content", text: answer };
      if (hang) {
        await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
        return;
      }
      yield { type: "done", model, totalDurationMs: 1, promptTokens: 1, completionTokens: 1 };
    })();
  }
}

/** Mapeamento de teste com limite de relevância em toda coleção (exigência do modo). */
function thresholdMapping(): RetrievalMapping {
  const m = testMapping();
  return { ...m, collections: m.collections.map((c) => ({ ...c, scoreThreshold: 0.5 })) };
}

interface SetupOpts {
  require?: boolean;
  qdrant?: boolean;
  neo4j?: boolean;
  mapping?: RetrievalMapping;
}

function setup(opts: SetupOpts = {}) {
  const env: Record<string, string> = {
    EMBEDDINGS_MODEL: "embed-teste",
    GERPRO_AUTH_MODE: "jwt-hs256",
    GERPRO_AUTH_JWT_SECRET: TEST_SECRET,
  };
  if (opts.qdrant !== false) env["QDRANT_URL"] = "http://127.0.0.1:6333";
  if (opts.neo4j !== false) Object.assign(env, { NEO4J_URI: "bolt://127.0.0.1:7687", NEO4J_USER: "leitor", NEO4J_PASSWORD: "senha-ficticia" });
  if (opts.require !== false) env["RETRIEVAL_REQUIRE_SOURCES"] = "true";
  const config = loadConfig(env);
  const qdrant = new FakeQdrant();
  const neo = new FakeNeo4j();
  const embeddings = new FakeEmbeddings();
  const stack = createRetrievalStack(config, {
    qdrantClient: qdrant,
    neo4jExecutor: neo,
    embeddings,
    mapping: opts.mapping ?? thresholdMapping(),
  });
  const llm = new SpyLlm();
  const app = buildApp({ config, version: "test", llm, ...stack, publicHealthCacheMs: 0 });
  return { app, llm, qdrant, neo, embeddings, config };
}

const token = (over: Record<string, unknown> = {}) =>
  signJwt({ sub: "u-1", org: "org-1", perms: ["docs:ler"], iat: nowSec(), exp: nowSec() + 300, ...over });
const ask = (content: string) => ({ messages: [{ role: "user", content }] });
const auth = () => ({ authorization: `Bearer ${token()}` });
const events = (payload: string) => payload.split("\n").filter(Boolean).map((l) => JSON.parse(l));

// ---------------------------------------------------------------- configuração

test("RETRIEVAL_REQUIRE_SOURCES: padrão false; aceita true/false; recusa valor inválido", () => {
  assert.equal(loadConfig({}).retrieval.requireSources, false);
  assert.equal(loadConfig({ RETRIEVAL_REQUIRE_SOURCES: "true" }).retrieval.requireSources, true);
  assert.equal(loadConfig({ RETRIEVAL_REQUIRE_SOURCES: "false" }).retrieval.requireSources, false);
  assert.throws(() => loadConfig({ RETRIEVAL_REQUIRE_SOURCES: "talvez" }), ConfigError);
});

test("ativado sem recuperação utilizável: a inicialização é recusada", () => {
  const config = loadConfig({ RETRIEVAL_REQUIRE_SOURCES: "true", GERPRO_AUTH_MODE: "jwt-hs256", GERPRO_AUTH_JWT_SECRET: TEST_SECRET });
  assert.throws(() => createRetrievalStack(config), /exige recuperação ativa/);
});

test("ativado sem autenticação: a inicialização é recusada", () => {
  const config = loadConfig({ RETRIEVAL_REQUIRE_SOURCES: "true", QDRANT_URL: "http://127.0.0.1:6333", EMBEDDINGS_MODEL: "embed-teste" });
  assert.throws(
    () => createRetrievalStack(config, { qdrantClient: new FakeQdrant(), embeddings: new FakeEmbeddings(), mapping: thresholdMapping() }),
    /exige autenticação/,
  );
});

test("ativado com coleção do Qdrant sem scoreThreshold: a inicialização é recusada", () => {
  assert.throws(() => setup({ mapping: testMapping() }), (err: unknown) => err instanceof ConfigError && /scoreThreshold.*docs_teste/.test(err.message));
});

test("Neo4j sem Qdrant: nenhum limite numérico é exigido do grafo (relevância por identificador)", () => {
  const { app } = setup({ qdrant: false, mapping: testMapping() });
  assert.ok(app);
});

test("desativado: coleção sem scoreThreshold continua aceita (compatibilidade)", () => {
  assert.ok(setup({ require: false, mapping: testMapping() }).app);
});

test("diagnóstico informa requireSources (true e false)", async () => {
  for (const require of [true, false]) {
    const { app } = setup({ require });
    const res = await app.inject({ method: "GET", url: "/api/health/details" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().retrieval.requireSources, require);
  }
});

// ---------------------------------------------------------------- desativado (comportamento anterior)

test("desativado: sem fontes, o modelo continua sendo chamado como antes", async () => {
  const { app, llm } = setup({ require: false });
  const res = await app.inject({ method: "POST", url: "/api/chat", headers: auth(), payload: ask("Qual é a capital da Austrália?") });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().grounding, "no_sources");
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0]!.at(-2)!.content, /NÃO encontrou fontes relevantes/);
});

test("desativado: com fontes, a regra 7 original (conhecimento geral separado) é mantida", async () => {
  const { app, llm, qdrant } = setup({ require: false });
  qdrant.points["docs_teste"] = [{ id: 1, score: 0.9, payload: { texto: "Trecho fictício", orgId: "org-1" } }];
  await app.inject({ method: "POST", url: "/api/chat", headers: auth(), payload: ask("O que diz o documento?") });
  assert.match(llm.calls[0]!.at(-2)!.content, /Se acrescentar conhecimento geral/);
});

// ---------------------------------------------------------------- ativado com fontes

test("ativado com fontes relevantes: o modelo é chamado, só com as fontes, e a resposta traz fontes e citações", async () => {
  const { app, llm, qdrant } = setup();
  qdrant.points["docs_teste"] = [{ id: 1, score: 0.9, payload: { texto: "O contrato fictício CT-001 vale 12 meses.", orgId: "org-1" } }];
  const res = await app.inject({ method: "POST", url: "/api/chat", headers: auth(), payload: ask("Qual a vigência do CT-001?") });
  const body = res.json();
  assert.equal(body.grounding, "sources");
  assert.equal(body.sources[0].ref, "Q1");
  assert.deepEqual(body.citations, { valid: ["Q1"], unknown: [] });
  assert.equal(llm.calls.length, 1);
  const context = llm.calls[0]!.at(-2)!.content;
  assert.match(context, /FONTES RECUPERADAS DO GERPRO/);
  assert.match(context, /Responda somente com base nos trechos abaixo/);
  assert.doesNotMatch(context, /Se acrescentar conhecimento geral/);
  // O limite de relevância do mapeamento chega ao Qdrant.
  assert.equal(qdrant.calls[0]!.args.score_threshold, 0.5);
});

test("ativado: stream com fontes mantém a sequência start → sources → delta → done", async () => {
  const { app, qdrant } = setup();
  qdrant.points["docs_teste"] = [{ id: 1, score: 0.9, payload: { texto: "Trecho fictício", orgId: "org-1" } }];
  const res = await app.inject({ method: "POST", url: "/api/chat/stream", headers: auth(), payload: ask("pergunta") });
  const ev = events(res.payload);
  assert.deepEqual(ev.map((e) => e.type), ["start", "sources", "delta", "done"]);
  assert.equal(ev[3].grounding, "sources");
  assert.deepEqual(ev[3].citations, { valid: ["Q1"], unknown: [] });
});

test("ativado: falha parcial com fonte relevante do outro conector ainda responde (só com a fonte real)", async () => {
  const { app, llm, qdrant, neo } = setup();
  qdrant.error = new TypeError("fetch failed");
  neo.rows = (_c, p) => (p["codigo"] ? [{ id: p["codigo"], resumo: "Registro fictício" }] : []);
  const res = await app.inject({ method: "POST", url: "/api/chat", headers: auth(), payload: ask("Resumo do REG-0001") });
  const body = res.json();
  assert.equal(body.grounding, "sources");
  assert.deepEqual(body.sources.map((s: { ref: string }) => s.ref), ["N1"]);
  assert.equal(llm.calls.length, 1);
});

// ---------------------------------------------------------------- ativado sem fontes: o modelo NÃO é chamado

test("ativado sem fontes: resposta fixa de insuficiência e o modelo não é chamado (/api/chat)", async () => {
  const { app, llm, qdrant, neo } = setup();
  const res = await app.inject({ method: "POST", url: "/api/chat", headers: auth(), payload: ask("Qual é a capital da Austrália?") });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.grounding, "no_sources");
  assert.equal(body.message.content, REQUIRED_SOURCES_TEXT.no_sources);
  assert.deepEqual(body.sources, []);
  assert.deepEqual(body.citations, { valid: [], unknown: [] });
  assert.deepEqual(body.usage, { promptTokens: null, completionTokens: null });
  assert.equal(llm.calls.length, 0);
  // As bases foram de fato consultadas (não é atalho antes da recuperação).
  assert.equal(qdrant.calls.length, 1);
  assert.equal(neo.calls.length, 0); // nenhuma consulta de grafo aplicável à pergunta
});

test("ativado sem fontes: stream com o mesmo contrato e sem chamar o modelo", async () => {
  const { app, llm } = setup();
  const res = await app.inject({ method: "POST", url: "/api/chat/stream", headers: auth(), payload: ask("Qual é a capital da Austrália?") });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /application\/x-ndjson/);
  const ev = events(res.payload);
  assert.deepEqual(ev.map((e) => e.type), ["start", "sources", "delta", "done"]);
  assert.equal(ev[1].grounding, "no_sources");
  assert.deepEqual(ev[1].sources, []);
  assert.equal(ev[2].content, REQUIRED_SOURCES_TEXT.no_sources);
  assert.equal(ev[3].grounding, "no_sources");
  assert.deepEqual(ev[3].citations, { valid: [], unknown: [] });
  assert.equal(llm.calls.length, 0);
});

test("ativado: resultados abaixo do limite (Qdrant devolve vazio com score_threshold) não contam como fonte", async () => {
  const { app, llm, qdrant } = setup();
  // O Qdrant aplica o limite e não devolve nada; o backend não reinterpreta isso como fonte.
  qdrant.points["docs_teste"] = [];
  const res = await app.inject({ method: "POST", url: "/api/chat", headers: auth(), payload: ask("assunto sem relação") });
  assert.equal(res.json().grounding, "no_sources");
  assert.equal(qdrant.calls[0]!.args.score_threshold, 0.5);
  assert.equal(llm.calls.length, 0);
});

test("ativado com falha da recuperação (Qdrant fora do ar): sem chat genérico, o modelo não é chamado", async () => {
  const { app, llm, qdrant } = setup();
  qdrant.error = new TypeError("fetch failed");
  for (const url of ["/api/chat", "/api/chat/stream"]) {
    const res = await app.inject({ method: "POST", url, headers: auth(), payload: ask("Qual a vigência do CT-001?") });
    assert.equal(res.statusCode, 200);
    const text = url === "/api/chat" ? res.json().message.content : events(res.payload).find((e) => e.type === "delta").content;
    assert.equal(text, REQUIRED_SOURCES_TEXT.unavailable);
  }
  assert.equal(llm.calls.length, 0);
});

test("ativado com falha do embedding: tratada como base indisponível, sem chamar o modelo", async () => {
  const { app, llm, embeddings } = setup({ neo4j: false });
  embeddings.error = new Error("embeddings fora do ar");
  const res = await app.inject({ method: "POST", url: "/api/chat", headers: auth(), payload: ask("pergunta") });
  assert.equal(res.json().grounding, "unavailable");
  assert.equal(llm.calls.length, 0);
});

test("ativado com falha do Neo4j e Qdrant sem resultados: indisponível, sem chamar o modelo", async () => {
  const { app, llm, neo } = setup();
  neo.error = new Error("ServiceUnavailable");
  const res = await app.inject({ method: "POST", url: "/api/chat", headers: auth(), payload: ask("Resumo do REG-0001") });
  assert.equal(res.json().grounding, "unavailable");
  assert.equal(llm.calls.length, 0);
});

test("ativado sem credencial (chat sem autenticação obrigatória): nenhuma base consultada e o modelo não é chamado", async () => {
  const { app, llm, qdrant, neo } = setup();
  const res = await app.inject({ method: "POST", url: "/api/chat", payload: ask("Resumo do REG-0001") });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().grounding, "unauthorized");
  assert.equal(res.json().message.content, REQUIRED_SOURCES_TEXT.unauthorized);
  assert.equal(qdrant.calls.length + neo.calls.length + llm.calls.length, 0);
});

test("ativado com credencial inválida: continua 401, sem bases nem modelo", async () => {
  const { app, llm, qdrant } = setup();
  const bad = signJwt({ sub: "u", org: "o", iat: nowSec(), exp: nowSec() + 60 }, "x".repeat(40));
  const res = await app.inject({ method: "POST", url: "/api/chat/stream", headers: { authorization: `Bearer ${bad}` }, payload: ask("oi") });
  assert.equal(res.statusCode, 401);
  assert.equal(llm.calls.length + qdrant.calls.length, 0);
});

test("ativado: pergunta ambígua mantém o pedido de esclarecimento fixo (sem modelo)", async () => {
  const { app, llm } = setup();
  const res = await app.inject({
    method: "POST",
    url: "/api/chat",
    headers: auth(),
    payload: {
      messages: [
        { role: "user", content: "Compare REG-0001 e REG-0002" },
        { role: "assistant", content: "Ok." },
        { role: "user", content: "E o responsável por ele?" },
      ],
    },
  });
  assert.equal(res.json().grounding, "ambiguous");
  assert.equal(llm.calls.length, 0);
});

// ---------------------------------------------------------------- Neo4j: relevância por identificador

test("ativado só com Neo4j: sem identificador na pergunta, nenhuma consulta e o modelo não é chamado", async () => {
  const { app, llm, neo } = setup({ qdrant: false });
  neo.rows = (_c, p) => (p["codigo"] ? [{ id: p["codigo"], resumo: "Registro fictício" }] : []);
  const res = await app.inject({ method: "POST", url: "/api/chat", headers: auth(), payload: ask("Qual é a capital da Austrália?") });
  assert.equal(res.json().grounding, "no_sources");
  assert.equal(neo.calls.length + llm.calls.length, 0);
});

test("ativado só com Neo4j: identificador reconhecido e registro encontrado → o modelo é chamado", async () => {
  const { app, llm, neo } = setup({ qdrant: false });
  neo.rows = (_c, p) => (p["codigo"] ? [{ id: p["codigo"], resumo: "Registro fictício" }] : []);
  const res = await app.inject({ method: "POST", url: "/api/chat", headers: auth(), payload: ask("Resumo do REG-0001") });
  assert.equal(res.json().grounding, "sources");
  assert.equal(llm.calls.length, 1);
});

test("ativado só com Neo4j: identificador reconhecido mas inexistente para a organização → sem modelo", async () => {
  const { app, llm, neo } = setup({ qdrant: false });
  const res = await app.inject({ method: "POST", url: "/api/chat", headers: auth(), payload: ask("Resumo do REG-0009") });
  assert.equal(res.json().grounding, "no_sources");
  assert.equal(neo.calls.length, 1);
  assert.equal(llm.calls.length, 0);
});

// ---------------------------------------------------------------- organização e permissões

test("ativado: organização e permissões vêm do token verificado (Qdrant e Neo4j)", async () => {
  const { app, qdrant, neo } = setup();
  neo.rows = () => [];
  await app.inject({
    method: "POST",
    url: "/api/chat",
    headers: { authorization: `Bearer ${token({ org: "org-ficticia-7", perms: ["docs:ler"] })}` },
    payload: ask("Resumo do REG-0001"),
  });
  const filter = qdrant.calls[0]!.args.filter as { must: unknown[] };
  assert.deepEqual(filter.must[0], { key: "orgId", match: { value: "org-ficticia-7" } });
  assert.ok(JSON.stringify(filter).includes("docs:ler"), "filtro de permissões aplicado");
  assert.equal(neo.calls[0]!.params["auth_organizationId"], "org-ficticia-7");
});

test("ativado: o corpo da requisição continua sem aceitar organização, filtros ou flags", async () => {
  const { app, llm } = setup();
  for (const extra of [{ organizationId: "outra" }, { requireSources: false }, { filters: [] }]) {
    const res = await app.inject({ method: "POST", url: "/api/chat", headers: auth(), payload: { ...ask("oi"), ...extra } });
    assert.equal(res.statusCode, 400, JSON.stringify(extra));
  }
  assert.equal(llm.calls.length, 0);
});

// ---------------------------------------------------------------- cancelamento

test("ativado: cancelar o stream com fontes cancela a geração no modelo", async () => {
  const { app, llm, qdrant } = setup();
  llm.hang = true;
  qdrant.points["docs_teste"] = [{ id: 1, score: 0.9, payload: { texto: "Trecho fictício", orgId: "org-1" } }];
  await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    const address = app.server.address() as { port: number };
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${address.port}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth() },
      body: JSON.stringify(ask("pergunta")),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes('"delta"')) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    await reader.cancel().catch(() => {});
    const signal = llm.signals[0]!;
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    assert.equal(signal.aborted, true);
  } finally {
    await app.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config/env.ts";
import { createRetrievalStack } from "../src/retrieval/bootstrap.ts";
import type { ChatMessage, LlmClient, LlmStreamEvent } from "../src/ollama/client.ts";
import { FakeEmbeddings, FakeNeo4j, FakeQdrant, TEST_SECRET, nowSec, signJwt, testMapping } from "./helpers/retrieval-fakes.ts";

class EchoLlm implements LlmClient {
  readonly model = "fake:1b";
  calls: ChatMessage[][] = [];
  answer = "Conforme [Q1], o trecho diz X. Também [Q5].";
  async health() {
    return { reachable: true, modelAvailable: true, model: this.model, availableModels: [this.model], version: "0", error: null };
  }
  async chat(messages: ChatMessage[]) {
    this.calls.push(messages);
    return { model: this.model, content: this.answer, totalDurationMs: 1, promptTokens: 1, completionTokens: 1 };
  }
  async openChatStream(messages: ChatMessage[]): Promise<AsyncIterable<LlmStreamEvent>> {
    this.calls.push(messages);
    const answer = this.answer;
    const model = this.model;
    return (async function* (): AsyncGenerator<LlmStreamEvent> {
      yield { type: "content", text: answer };
      yield { type: "done", model, totalDurationMs: 1, promptTokens: 1, completionTokens: 1 };
    })();
  }
}

const SECRET_KEY = "chave-api-qdrant-super-secreta";
const NEO_PASS = "senha-neo4j-super-secreta";

function setup(opts: { auth?: boolean } = {}) {
  const env: Record<string, string> = {
    QDRANT_URL: "http://127.0.0.1:6333",
    QDRANT_API_KEY: SECRET_KEY,
    NEO4J_URI: "bolt://127.0.0.1:7687",
    NEO4J_USER: "leitor",
    NEO4J_PASSWORD: NEO_PASS,
    EMBEDDINGS_MODEL: "embed-teste",
  };
  if (opts.auth !== false) Object.assign(env, { GERPRO_AUTH_MODE: "jwt-hs256", GERPRO_AUTH_JWT_SECRET: TEST_SECRET });
  const config = loadConfig(env);
  const qdrant = new FakeQdrant();
  const neo = new FakeNeo4j();
  qdrant.points["docs_teste"] = [{ id: 1, score: 0.9, payload: { texto: "Trecho sintético de teste", documentoId: "D-1" } }];
  const stack = createRetrievalStack(config, {
    qdrantClient: qdrant,
    neo4jExecutor: neo,
    embeddings: new FakeEmbeddings(),
    mapping: testMapping(),
  });
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const llm = new EchoLlm();
  const app = buildApp({ config, version: "test", llm, ...stack }, { logger: { level: "debug", stream } });
  return { app, llm, qdrant, neo, logs };
}

const token = (over: Record<string, unknown> = {}) =>
  signJwt({ sub: "u-1", org: "org-1", perms: ["docs:ler"], iat: nowSec(), exp: nowSec() + 300, ...over });
const ask = (content: string) => ({ messages: [{ role: "user", content }] });

test("com credencial válida: fontes entram no contexto antes da pergunta e a resposta traz grounding", async () => {
  const { app, llm, qdrant } = setup();
  const res = await app.inject({
    method: "POST",
    url: "/api/chat",
    headers: { authorization: `Bearer ${token()}` },
    payload: ask("Qual o conteúdo do documento?"),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.grounding, "sources");
  assert.equal(body.sources[0].ref, "Q1");
  assert.equal(body.sources[0].id, "qdrant:docs_teste:1");
  assert.deepEqual(body.citations, { valid: ["Q1"], unknown: ["Q5"] });

  const msgs = llm.calls[0]!;
  assert.equal(msgs[0]!.role, "system");
  assert.equal(msgs.at(-2)!.role, "system");
  assert.match(msgs.at(-2)!.content, /FONTES RECUPERADAS DO GERPRO/);
  assert.equal(msgs.at(-1)!.content, "Qual o conteúdo do documento?");
  // Filtro de organização veio do token verificado, não do navegador.
  assert.deepEqual(qdrant.calls[0]!.args.filter?.must[0], { key: "orgId", match: { value: "org-1" } });
});

test("stream: evento sources após start e done com grounding/citations", async () => {
  const { app } = setup();
  const res = await app.inject({
    method: "POST",
    url: "/api/chat/stream",
    headers: { authorization: `Bearer ${token()}` },
    payload: ask("pergunta"),
  });
  const events = res.payload.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e: { type: string }) => e.type), ["start", "sources", "delta", "done"]);
  assert.equal(events[1].grounding, "sources");
  assert.ok(events[1].sources[0].excerpt.length <= 301);
  assert.equal(events[3].grounding, "sources");
  assert.deepEqual(events[3].citations.unknown, ["Q5"]);
});

test("sem credencial: nenhuma base consultada e o modelo é instruído a não afirmar fatos corporativos", async () => {
  const { app, llm, qdrant, neo } = setup();
  const res = await app.inject({ method: "POST", url: "/api/chat", payload: ask("Resumo do REG-0001") });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().grounding, "unauthorized");
  assert.equal(qdrant.calls.length + neo.calls.length, 0);
  assert.match(llm.calls[0]!.at(-2)!.content, /não afirme nenhum fato/);
});

test("GERPRO_AUTH_MODE=none: mesmo com bases configuradas, nada é consultado", async () => {
  const { app, qdrant } = setup({ auth: false });
  const res = await app.inject({
    method: "POST",
    url: "/api/chat",
    headers: { authorization: `Bearer ${token()}` },
    payload: ask("pergunta"),
  });
  assert.equal(res.json().grounding, "unauthorized");
  assert.equal(qdrant.calls.length, 0);
});

test("credencial inválida → 401, sem chamar o modelo nem as bases", async () => {
  const { app, llm, qdrant } = setup();
  for (const t of [token({ exp: nowSec() - 999, iat: nowSec() - 1200 }), signJwt({ sub: "u", org: "o", exp: nowSec() + 60 }, "x".repeat(40))]) {
    const res = await app.inject({ method: "POST", url: "/api/chat/stream", headers: { authorization: `Bearer ${t}` }, payload: ask("oi") });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "unauthorized");
  }
  assert.equal(llm.calls.length + qdrant.calls.length, 0);
});

test("o navegador não consegue enviar filtros, organização ou contexto de autorização no corpo", async () => {
  const { app, llm } = setup();
  for (const extra of [{ filters: [{ field: "orgId", equals: "outra" }] }, { auth: { organizationId: "outra" } }, { organizationId: "outra" }]) {
    const res = await app.inject({ method: "POST", url: "/api/chat", payload: { ...ask("oi"), ...extra } });
    assert.equal(res.statusCode, 400, JSON.stringify(extra));
  }
  assert.equal(llm.calls.length, 0);
});

test("falha das bases não derruba o chat: grounding unavailable e resposta normal", async () => {
  const { app, qdrant } = setup();
  qdrant.error = new TypeError("fetch failed");
  const res = await app.inject({
    method: "POST",
    url: "/api/chat",
    headers: { authorization: `Bearer ${token()}` },
    payload: ask("pergunta"),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().grounding, "unavailable");
});

test("logs e /api/health não expõem segredos, tokens, perguntas ou conteúdo recuperado", async () => {
  const { app, logs } = setup();
  const t = token();
  await app.inject({ method: "POST", url: "/api/chat", headers: { authorization: `Bearer ${t}` }, payload: ask("pergunta-confidencial-xyz") });
  const health = await app.inject({ method: "GET", url: "/api/health" });
  const all = logs.join("") + health.payload;
  for (const secret of [SECRET_KEY, NEO_PASS, TEST_SECRET, t, "pergunta-confidencial-xyz", "Trecho sintético", "127.0.0.1:6333", "leitor"]) {
    assert.ok(!all.includes(secret), `vazou: ${secret.slice(0, 12)}…`);
  }
  assert.match(logs.join(""), /"grounding":"sources"/, "o log registra apenas o estado da recuperação");
  const h = health.json();
  assert.equal(h.retrieval.enabled, true);
  assert.equal(h.retrieval.authMode, "jwt-hs256");
  assert.equal(h.adapters.vectorStore.reachable, true);
  assert.equal(h.adapters.graphStore.reachable, true);
});

test("CORS permite o cabeçalho Authorization para a origem configurada", async () => {
  const config = loadConfig({ CORS_ORIGIN: "http://hospedeiro.test" });
  const app = buildApp({ config, version: "t", llm: new EchoLlm(), ...createRetrievalStack(config) });
  const res = await app.inject({ method: "OPTIONS", url: "/api/chat", headers: { origin: "http://hospedeiro.test" } });
  assert.match(String(res.headers["access-control-allow-headers"]), /authorization/);
});

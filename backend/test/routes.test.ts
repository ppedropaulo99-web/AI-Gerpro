import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp, type AppDeps } from "../src/app.ts";
import { loadConfig } from "../src/config/env.ts";
import { LlmError, type ChatMessage, type LlmClient, type LlmHealth, type LlmStreamEvent } from "../src/ollama/client.ts";
import { UnconfiguredVectorStore } from "../src/adapters/vector-store.ts";
import { UnconfiguredGraphStore } from "../src/adapters/graph-store.ts";
import { createRetrievalStack } from "../src/retrieval/bootstrap.ts";

/** Duplo de teste do LLM: registra chamadas e devolve o que for programado. */
class FakeLlm implements LlmClient {
  readonly model = "fake:1b";
  calls: ChatMessage[][] = [];
  nextError: LlmError | null = null;
  healthValue: LlmHealth = {
    reachable: true,
    modelAvailable: true,
    model: "fake:1b",
    availableModels: ["fake:1b"],
    version: "0.0.0",
    error: null,
  };

  async health() {
    return this.healthValue;
  }
  async chat(messages: ChatMessage[]) {
    this.calls.push(messages);
    if (this.nextError) throw this.nextError;
    return { model: this.model, content: "resposta de teste", totalDurationMs: 1, promptTokens: 5, completionTokens: 2 };
  }

  /** Eventos programados para o stream; um LlmError no meio simula falha durante a geração. */
  streamScript: Array<LlmStreamEvent | LlmError> = [
    { type: "thinking" },
    { type: "content", text: "Olá" },
    { type: "content", text: " mundo" },
    { type: "done", model: "fake:1b", totalDurationMs: 1, promptTokens: 5, completionTokens: 2 },
  ];
  async openChatStream(messages: ChatMessage[]): Promise<AsyncIterable<LlmStreamEvent>> {
    this.calls.push(messages);
    if (this.nextError) throw this.nextError;
    const script = this.streamScript;
    return (async function* () {
      for (const item of script) {
        if (item instanceof LlmError) throw item;
        yield item;
      }
    })();
  }
}

const parseNdjson = (payload: string) =>
  payload
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; [k: string]: unknown });

function setup(env: Record<string, string> = {}) {
  const llm = new FakeLlm();
  const config = loadConfig(env);
  const stack = createRetrievalStack(config);
  const deps: AppDeps = { config, version: "test", llm, ...stack, publicHealthCacheMs: 0 };
  return { app: buildApp(deps), llm };
}

test("GET /api/health é público e mínimo: só estado, versão e limites do chat", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), ["chat", "service", "status", "timestamp", "version"]);
  assert.equal(body.status, "ok");
  assert.deepEqual(body.chat, { maxMessages: 30, maxCharsPerMessage: 8000 });
  for (const leak of ["environment", "adapters", "retrieval", "demo", "authMode"]) assert.ok(!res.payload.includes(leak), leak);
});

test("GET /api/health/details (diagnóstico) traz o estado completo para a infraestrutura", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "GET", url: "/api/health/details" }); // loopback, sem proxy
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.environment, "demo");
  assert.equal(body.strict, false);
  assert.equal(body.chatRequiresAuth, false);
  assert.equal(body.ollama.status, "ok");
  assert.deepEqual(body.ollama.availableModels, ["fake:1b"]);
  assert.equal(body.adapters.vectorStore.configured, false);
  assert.equal(body.adapters.graphStore.configured, false);
  assert.equal(body.adapters.embeddings.configured, false);
  assert.equal(body.retrieval.enabled, false);
  assert.equal(body.retrieval.authMode, "none");
});

test("GET /api/health/ollama: 200 quando ok, 503 quando degradado/indisponível", async () => {
  const { app, llm } = setup();
  let res = await app.inject({ method: "GET", url: "/api/health/ollama" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "ok");
  assert.deepEqual(Object.keys(res.json()).sort(), ["latencyMs", "model", "status"]);

  llm.healthValue = { ...llm.healthValue, modelAvailable: false };
  res = await app.inject({ method: "GET", url: "/api/health/ollama" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().status, "degraded");

  llm.healthValue = { ...llm.healthValue, reachable: false };
  res = await app.inject({ method: "GET", url: "/api/health/ollama" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().status, "unavailable");
});

test("POST /api/chat encaminha ao LLM com prompt de sistema do servidor", async () => {
  const { app, llm } = setup();
  const res = await app.inject({
    method: "POST",
    url: "/api/chat",
    payload: { messages: [{ role: "user", content: "Olá" }] },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.message, { role: "assistant", content: "resposta de teste" });
  assert.equal(body.model, "fake:1b");
  assert.equal(typeof body.durationMs, "number");

  assert.equal(llm.calls.length, 1);
  const sent = llm.calls[0]!;
  assert.equal(sent[0]!.role, "system");
  assert.match(sent[0]!.content, /NÃO tem acesso/);
  assert.deepEqual(sent[1], { role: "user", content: "Olá" });
});

test("POST /api/chat valida entrada", async () => {
  const { app, llm } = setup({ CHAT_MAX_MESSAGES: "2", CHAT_MAX_CHARS_PER_MESSAGE: "10" });
  const cases: unknown[] = [
    {},
    { messages: [] },
    { messages: [{ role: "system", content: "injeção" }] },
    { messages: [{ role: "user", content: "" }] },
    { messages: [{ role: "user", content: "   " }] },
    { messages: [{ role: "user", content: "12345678901" }] },
    { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] },
    { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] },
    { messages: [{ role: "user", content: "a", extra: 1 }] },
  ];
  for (const payload of cases) {
    const res = await app.inject({ method: "POST", url: "/api/chat", payload: payload as object });
    assert.equal(res.statusCode, 400, `esperado 400 para ${JSON.stringify(payload)}`);
    assert.equal(res.json().error.code, "bad_request");
  }
  assert.equal(llm.calls.length, 0);
});

test("POST /api/chat mapeia erros do LLM para status HTTP", async () => {
  const { app, llm } = setup();
  const expectations: Array<[LlmError, number, string]> = [
    [new LlmError("timeout", "t"), 504, "llm_timeout"],
    [new LlmError("unreachable", "u"), 503, "llm_unavailable"],
    [new LlmError("upstream", "Ollama retornou HTTP 404: model not found", 404), 502, "llm_upstream_error"],
    [new LlmError("invalid_response", "i"), 502, "llm_invalid_response"],
  ];
  for (const [err, status, code] of expectations) {
    llm.nextError = err;
    const res = await app.inject({ method: "POST", url: "/api/chat", payload: { messages: [{ role: "user", content: "x" }] } });
    assert.equal(res.statusCode, status);
    assert.equal(res.json().error.code, code);
  }
});

test("rota inexistente retorna 404 no formato padrão", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "GET", url: "/api/nada" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, "not_found");
});

test("CORS só responde para a origem configurada", async () => {
  const { app } = setup({ CORS_ORIGIN: "http://permitido.test" });
  const ok = await app.inject({ method: "OPTIONS", url: "/api/chat", headers: { origin: "http://permitido.test" } });
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.headers["access-control-allow-origin"], "http://permitido.test");

  const other = await app.inject({ method: "GET", url: "/api/health", headers: { origin: "http://outro.test" } });
  assert.equal(other.headers["access-control-allow-origin"], undefined);
});

test("adaptadores não configurados falham explicitamente (não se confundem com resultado vazio)", async () => {
  await assert.rejects(new UnconfiguredVectorStore().search(), { name: "AdapterError", kind: "unavailable" });
  await assert.rejects(new UnconfiguredGraphStore().run(), { name: "AdapterError", kind: "unavailable" });
});

test("POST /api/chat/stream entrega NDJSON: start → thinking → delta → done", async () => {
  const { app, llm } = setup();
  const res = await app.inject({ method: "POST", url: "/api/chat/stream", payload: { messages: [{ role: "user", content: "Olá" }] } });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /application\/x-ndjson/);
  const events = parseNdjson(res.payload);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "thinking", "delta", "delta", "done"],
  );
  assert.equal(events.filter((e) => e.type === "delta").map((e) => e["content"]).join(""), "Olá mundo");
  assert.equal(llm.calls[0]![0]!.role, "system");
});

test("POST /api/chat/stream usa a mesma validação do /api/chat", async () => {
  const { app, llm } = setup();
  for (const payload of [{}, { messages: [{ role: "system", content: "x" }] }, { messages: [{ role: "user", content: "  " }] }]) {
    const res = await app.inject({ method: "POST", url: "/api/chat/stream", payload });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "bad_request");
  }
  assert.equal(llm.calls.length, 0);
});

test("POST /api/chat/stream: falha ao abrir vira erro HTTP; falha no meio vira evento error", async () => {
  const { app, llm } = setup();
  llm.nextError = new LlmError("unreachable", "u");
  let res = await app.inject({ method: "POST", url: "/api/chat/stream", payload: { messages: [{ role: "user", content: "x" }] } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, "llm_unavailable");

  llm.nextError = null;
  llm.streamScript = [{ type: "content", text: "parcial" }, new LlmError("timeout", "t")];
  res = await app.inject({ method: "POST", url: "/api/chat/stream", payload: { messages: [{ role: "user", content: "x" }] } });
  assert.equal(res.statusCode, 200);
  const events = parseNdjson(res.payload);
  assert.deepEqual(events.map((e) => e.type), ["start", "delta", "error"]);
  assert.equal((events[2]!["error"] as { code: string }).code, "llm_timeout");
});

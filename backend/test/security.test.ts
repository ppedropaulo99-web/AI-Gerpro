/**
 * Etapa 4.1: proteções de ambiente corporativo — configuração estrita, autenticação do chat,
 * diagnóstico interno protegido, health público mínimo e erros sem detalhes de infraestrutura.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { loadConfig, ConfigError } from "../src/config/env.ts";
import { createRetrievalStack } from "../src/retrieval/bootstrap.ts";
import { LlmError, OllamaClient, type ChatMessage, type LlmClient, type LlmHealth, type LlmStreamEvent } from "../src/ollama/client.ts";
import { TEST_SECRET, nowSec, signJwt } from "./helpers/retrieval-fakes.ts";

const STRICT_OK = {
  APP_ENV: "producao",
  GERPRO_AUTH_MODE: "jwt-hs256",
  GERPRO_AUTH_JWT_SECRET: TEST_SECRET,
  GERPRO_AUTH_JWT_ISSUER: "gerpro",
  GERPRO_AUTH_JWT_AUDIENCE: "ai-gerpro",
};
const DIAG_TOKEN = "token-de-diagnostico-com-mais-de-32-bytes";

class CountingLlm implements LlmClient {
  readonly model = "fake:1b";
  healthCalls = 0;
  chatCalls = 0;
  nextError: LlmError | null = null;
  healthValue: LlmHealth = { reachable: true, modelAvailable: true, model: "fake:1b", availableModels: ["fake:1b"], version: "9.9.9", error: null };
  async health() {
    this.healthCalls++;
    return this.healthValue;
  }
  async chat(_m: ChatMessage[]) {
    this.chatCalls++;
    if (this.nextError) throw this.nextError;
    return { model: this.model, content: "ok", totalDurationMs: 1, promptTokens: 1, completionTokens: 1 };
  }
  async openChatStream(_m: ChatMessage[]): Promise<AsyncIterable<LlmStreamEvent>> {
    this.chatCalls++;
    if (this.nextError) throw this.nextError;
    const model = this.model;
    return (async function* (): AsyncGenerator<LlmStreamEvent> {
      yield { type: "content", text: "ok" };
      yield { type: "done", model, totalDurationMs: 1, promptTokens: 1, completionTokens: 1 };
    })();
  }
}

function setup(env: Record<string, string> = {}, cacheMs = 0) {
  const config = loadConfig(env);
  const llm = new CountingLlm();
  const app = buildApp({ config, version: "t", llm, ...createRetrievalStack(config), publicHealthCacheMs: cacheMs });
  return { app, llm, config };
}

const jwt = (over: Record<string, unknown> = {}) =>
  signJwt({ sub: "u-1", org: "org-1", perms: [], iat: nowSec(), exp: nowSec() + 300, iss: "gerpro", aud: "ai-gerpro", ...over });
const ask = { messages: [{ role: "user", content: "olá" }] };

// ---------- Configuração de ambiente corporativo ----------

test("ambientes locais mantêm o modo de demonstração (chat sem login, diagnóstico por loopback)", () => {
  for (const env of ["demo", "dev", "development", "local", "test"]) {
    const c = loadConfig({ APP_ENV: env });
    assert.equal(c.security.strict, false, env);
    assert.equal(c.security.requireChatAuth, false, env);
    assert.equal(c.security.diagnostics.allowLoopback, true, env);
  }
});

test("ambiente corporativo exige autenticação do chat, com JWT de emissor e audiência definidos", () => {
  assert.throws(() => loadConfig({ APP_ENV: "producao" }), /GERPRO_AUTH_MODE/);
  assert.throws(() => loadConfig({ ...STRICT_OK, CHAT_REQUIRE_AUTH: "false" }), /CHAT_REQUIRE_AUTH=false/);
  assert.throws(() => loadConfig({ ...STRICT_OK, GERPRO_AUTH_JWT_ISSUER: "" }), /ISSUER e GERPRO_AUTH_JWT_AUDIENCE/);
  assert.throws(() => loadConfig({ ...STRICT_OK, GERPRO_AUTH_JWT_AUDIENCE: "" }), /AUDIENCE/);
  const c = loadConfig(STRICT_OK);
  assert.equal(c.security.strict, true);
  assert.equal(c.security.requireChatAuth, true);
  assert.equal(c.security.diagnostics.allowLoopback, false);
  assert.equal(loadConfig({ ...STRICT_OK, APP_ENV: "homologacao" }).security.strict, true);
});

test("ambiente corporativo rejeita TLS inseguro nas bases", () => {
  assert.throws(() => loadConfig({ ...STRICT_OK, NEO4J_URI: "neo4j+ssc://grafo.interno:7687" }), /\+ssc/);
  assert.throws(() => loadConfig({ ...STRICT_OK, NEO4J_URI: "bolt+ssc://grafo.interno:7687" }), /\+ssc/);
  assert.throws(() => loadConfig({ ...STRICT_OK, NEO4J_URI: "neo4j+s://grafo.interno:7687", NEO4J_ALLOW_INSECURE: "true" }), /NEO4J_ALLOW_INSECURE/);
  assert.throws(() => loadConfig({ ...STRICT_OK, QDRANT_URL: "https://q.interno", QDRANT_ALLOW_INSECURE: "true" }), /QDRANT_ALLOW_INSECURE/);
  assert.ok(loadConfig({ ...STRICT_OK, NEO4J_URI: "neo4j+s://grafo.interno:7687" }).neo4j);
  // Em demonstração, +ssc continua aceito (instâncias de teste com certificado próprio).
  assert.ok(loadConfig({ NEO4J_URI: "neo4j+ssc://grafo.interno:7687" }).neo4j);
});

test("CHAT_REQUIRE_AUTH pode ser ativado localmente, mas exige integração de autenticação", () => {
  assert.throws(() => loadConfig({ CHAT_REQUIRE_AUTH: "true" }), /GERPRO_AUTH_MODE=jwt-hs256/);
  const c = loadConfig({ CHAT_REQUIRE_AUTH: "true", GERPRO_AUTH_MODE: "jwt-hs256", GERPRO_AUTH_JWT_SECRET: TEST_SECRET });
  assert.equal(c.security.requireChatAuth, true);
});

test("DIAGNOSTICS_TOKEN: mínimo de 32 bytes e diferente do segredo JWT; erros não ecoam o valor", () => {
  assert.throws(() => loadConfig({ DIAGNOSTICS_TOKEN: "curto" }), /32 bytes/);
  assert.throws(
    () => loadConfig({ GERPRO_AUTH_MODE: "jwt-hs256", GERPRO_AUTH_JWT_SECRET: TEST_SECRET, DIAGNOSTICS_TOKEN: TEST_SECRET }),
    (e: unknown) => e instanceof ConfigError && /diferente/.test(e.message) && !e.message.includes(TEST_SECRET),
  );
  assert.equal(loadConfig({ DIAGNOSTICS_TOKEN: DIAG_TOKEN }).security.diagnostics.token, DIAG_TOKEN);
});

// ---------- Autenticação do chat ----------

test("com autenticação exigida, o chat recusa anônimo e credencial inválida antes de chegar ao modelo", async () => {
  const { app, llm } = setup(STRICT_OK);
  for (const url of ["/api/chat", "/api/chat/stream"]) {
    const anon = await app.inject({ method: "POST", url, payload: ask });
    assert.equal(anon.statusCode, 401, url);
    assert.equal(anon.json().error.code, "unauthorized");
    const bad = await app.inject({ method: "POST", url, payload: ask, headers: { authorization: `Bearer ${jwt({ aud: "outro" })}` } });
    assert.equal(bad.statusCode, 401, url);
    const forged = await app.inject({ method: "POST", url, payload: ask, headers: { authorization: `Bearer ${signJwt({ sub: "u", org: "o", exp: nowSec() + 60, iss: "gerpro", aud: "ai-gerpro" }, "outro-segredo-com-mais-de-32-bytes!!!")}` } });
    assert.equal(forged.statusCode, 401, url);
  }
  assert.equal(llm.chatCalls, 0, "nenhuma chamada anônima chegou à GPU");

  const ok = await app.inject({ method: "POST", url: "/api/chat", payload: ask, headers: { authorization: `Bearer ${jwt()}` } });
  assert.equal(ok.statusCode, 200);
  const stream = await app.inject({ method: "POST", url: "/api/chat/stream", payload: ask, headers: { authorization: `Bearer ${jwt()}` } });
  assert.equal(stream.statusCode, 200);
  assert.match(stream.payload, /"type":"done"/);
  assert.equal(llm.chatCalls, 2);
});

test("modo local preserva o chat sem login", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "POST", url: "/api/chat", payload: ask });
  assert.equal(res.statusCode, 200);
});

// ---------- Diagnóstico interno ----------

test("diagnóstico: loopback direto permitido em modo local; proxy, rede externa e credencial errada recusados", async () => {
  const { app } = setup();
  assert.equal((await app.inject({ method: "GET", url: "/api/health/details" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/health/details", remoteAddress: "::1" })).statusCode, 200);
  const external = await app.inject({ method: "GET", url: "/api/health/details", remoteAddress: "10.0.0.8" });
  assert.equal(external.statusCode, 403);
  assert.equal(external.json().error.code, "forbidden");
  assert.ok(!external.payload.includes("demo"));
  // Proxy reverso na mesma máquina: a conexão chega de 127.0.0.1, mas com cabeçalho de proxy.
  for (const h of ["x-forwarded-for", "forwarded", "x-real-ip"]) {
    assert.equal((await app.inject({ method: "GET", url: "/api/health/details", headers: { [h]: "203.0.113.9" } })).statusCode, 403, h);
  }
  // Uma credencial qualquer (ex.: o JWT do usuário) não abre o diagnóstico.
  assert.equal((await app.inject({ method: "GET", url: "/api/health/details", headers: { authorization: "Bearer qualquer" } })).statusCode, 403);
});

test("diagnóstico: em ambiente corporativo só com DIAGNOSTICS_TOKEN (loopback desativado)", async () => {
  const { app } = setup({ ...STRICT_OK, DIAGNOSTICS_TOKEN: DIAG_TOKEN });
  assert.equal((await app.inject({ method: "GET", url: "/api/health/details" })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/api/health/details", headers: { authorization: `Bearer ${jwt()}` } })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/api/health/details", headers: { authorization: `Bearer ${DIAG_TOKEN}x` } })).statusCode, 403);
  const ok = await app.inject({ method: "GET", url: "/api/health/details", remoteAddress: "10.0.0.8", headers: { authorization: `Bearer ${DIAG_TOKEN}` } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().strict, true);
  assert.equal(ok.json().chatRequiresAuth, true);
  assert.ok(!ok.payload.includes(DIAG_TOKEN) && !ok.payload.includes(TEST_SECRET));
});

test("diagnóstico sem token e com loopback desativado: inacessível", async () => {
  const { app } = setup({ DIAGNOSTICS_ALLOW_LOOPBACK: "false" });
  assert.equal((await app.inject({ method: "GET", url: "/api/health/details" })).statusCode, 403);
});

// ---------- Health público e Ollama ----------

test("health público funciona sem autenticação mesmo com o chat protegido", async () => {
  const { app } = setup(STRICT_OK);
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/health/ollama" })).statusCode, 200);
});

test("/api/health/ollama público não revela versão, modelos instalados nem erro técnico; reaproveita o estado", async () => {
  const { app, llm } = setup({}, 60_000);
  llm.healthValue = {
    reachable: false,
    modelAvailable: false,
    model: "fake:1b",
    availableModels: [],
    version: null,
    error: "Não foi possível conectar ao Ollama em http://gpu-interna.corp:11434",
  };
  const res = await app.inject({ method: "GET", url: "/api/health/ollama" });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json().status, "unavailable");
  for (const leak of ["gpu-interna", "11434", "http://", "availableModels", "version"]) assert.ok(!res.payload.includes(leak), leak);
  for (let i = 0; i < 20; i++) await app.inject({ method: "GET", url: "/api/health/ollama" });
  assert.equal(llm.healthCalls, 1, "chamadas públicas repetidas não sobrecarregam o Ollama");
  // O diagnóstico interno mantém o detalhe útil para a infraestrutura (e não usa o cache).
  const diag = await app.inject({ method: "GET", url: "/api/health/details" });
  assert.match(diag.json().ollama.error, /gpu-interna/);
  assert.equal(llm.healthCalls, 2);
});

// ---------- Erros sem detalhes de infraestrutura ----------

test("erros do LLM enviados ao navegador não contêm URLs, portas, servidores nem corpo do upstream", async () => {
  const { app, llm } = setup();
  const cases = [
    new LlmError("unreachable", "Não foi possível conectar ao Ollama em http://gpu-interna.corp:11434"),
    new LlmError("upstream", "Ollama retornou HTTP 500: open C:\\Users\\svc\\.ollama\\models\\blobs\\sha256-abc: no such file", 500),
    new LlmError("upstream", 'Ollama retornou HTTP 404: model "qwen-x" not found, try pulling it first', 404),
    new LlmError("timeout", "Ollama não respondeu em 120000 ms"),
    new LlmError("invalid_response", "Ollama retornou JSON inválido em gpu-interna.corp"),
  ];
  for (const err of cases) {
    llm.nextError = err;
    for (const url of ["/api/chat", "/api/chat/stream"]) {
      const res = await app.inject({ method: "POST", url, payload: ask });
      for (const leak of ["gpu-interna", "11434", "http://", "C:\\", "blobs", "sha256", "qwen-x", "120000"]) {
        assert.ok(!res.payload.includes(leak), `${url} vazou "${leak}" (${err.kind})`);
      }
      assert.ok(res.json().error.message.length > 0);
    }
  }
});

test("OllamaClient real inacessível: a mensagem com o endereço fica só no erro interno", async () => {
  const client = new OllamaClient(
    { baseUrl: "http://gpu-interna.corp:11434", model: "m", timeoutMs: 1000, think: "auto", keepAlive: null, numCtx: null, preload: false },
    async () => {
      throw new TypeError("fetch failed");
    },
  );
  const config = loadConfig({});
  const app = buildApp({ config, version: "t", llm: client, ...createRetrievalStack(config), publicHealthCacheMs: 0 });
  const chat = await app.inject({ method: "POST", url: "/api/chat", payload: ask });
  assert.equal(chat.statusCode, 503);
  assert.ok(!chat.payload.includes("gpu-interna"));
  const pub = await app.inject({ method: "GET", url: "/api/health/ollama" });
  assert.ok(!pub.payload.includes("gpu-interna"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../src/config/env.ts";

test("aplica padrões quando não há variáveis", () => {
  const c = loadConfig({});
  assert.equal(c.port, 3001);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.ollama.baseUrl, "http://127.0.0.1:11434");
  assert.equal(c.ollama.model, "qwen3:4b-instruct-2507-q4_K_M");
  assert.equal(c.ollama.timeoutMs, 120_000);
  assert.equal(c.ollama.think, "auto");
  assert.equal(c.ollama.keepAlive, "30m");
  assert.equal(c.ollama.numCtx, 8192);
  assert.equal(c.ollama.preload, true);
  assert.equal(c.environment, "demo");
  assert.equal(c.qdrant, null);
  assert.equal(c.neo4j, null);
});

test("lê variáveis e remove barra final da URL", () => {
  const c = loadConfig({
    PORT: "4000",
    OLLAMA_BASE_URL: "http://localhost:11434/",
    OLLAMA_MODEL: "outro:7b",
    OLLAMA_TIMEOUT_MS: "5000",
    OLLAMA_THINK: "false",
  });
  assert.equal(c.port, 4000);
  assert.equal(c.ollama.baseUrl, "http://localhost:11434");
  assert.equal(c.ollama.model, "outro:7b");
  assert.equal(c.ollama.timeoutMs, 5000);
  assert.equal(c.ollama.think, false);
});

test("rejeita valores inválidos", () => {
  assert.throws(() => loadConfig({ PORT: "abc" }), ConfigError);
  assert.throws(() => loadConfig({ OLLAMA_TIMEOUT_MS: "10" }), ConfigError);
  assert.throws(() => loadConfig({ OLLAMA_BASE_URL: "ftp://x" }), ConfigError);
  assert.throws(() => loadConfig({ OLLAMA_THINK: "talvez" }), ConfigError);
  assert.throws(() => loadConfig({ NEO4J_URI: "http://x" }), ConfigError);
});

test("monta configs de adaptadores apenas quando definidas", () => {
  const c = loadConfig({ QDRANT_URL: "http://127.0.0.1:6333", NEO4J_URI: "bolt://127.0.0.1:7687" });
  assert.deepEqual(c.qdrant, { url: "http://127.0.0.1:6333", apiKey: null, timeoutMs: 5000 });
  assert.deepEqual(c.neo4j, {
    uri: "bolt://127.0.0.1:7687",
    user: null,
    password: null,
    database: null,
    timeoutMs: 5000,
    maxPoolSize: 10,
  });
  assert.equal(c.embeddings, null, "sem EMBEDDINGS_MODEL não há modelo de embeddings presumido");
  assert.equal(c.auth.mode, "none");
  assert.equal(c.retrieval.mappingPath, null);
});

test("exige conexão segura com Qdrant e Neo4j fora de localhost", () => {
  assert.throws(() => loadConfig({ QDRANT_URL: "http://qdrant.interno:6333" }), /https/);
  assert.equal(loadConfig({ QDRANT_URL: "https://qdrant.interno:6333" }).qdrant?.url, "https://qdrant.interno:6333");
  assert.ok(loadConfig({ QDRANT_URL: "http://qdrant.interno:6333", QDRANT_ALLOW_INSECURE: "true" }).qdrant);

  assert.throws(() => loadConfig({ NEO4J_URI: "neo4j://grafo.interno:7687" }), /bolt\+s|neo4j\+s/);
  assert.ok(loadConfig({ NEO4J_URI: "neo4j+s://grafo.interno:7687" }).neo4j);
  assert.ok(loadConfig({ NEO4J_URI: "bolt+ssc://grafo.interno:7687" }).neo4j);
});

test("credenciais: pares obrigatórios, nada embutido em URL e erros sem ecoar valores", () => {
  assert.throws(() => loadConfig({ NEO4J_URI: "bolt://127.0.0.1:7687", NEO4J_USER: "leitor" }), /juntos/);
  const withCreds = loadConfig({ NEO4J_URI: "bolt://127.0.0.1:7687", NEO4J_USER: "leitor", NEO4J_PASSWORD: "x" });
  assert.equal(withCreds.neo4j?.user, "leitor");
  try {
    loadConfig({ QDRANT_URL: "https://usuario:segredo123@qdrant.interno" });
    assert.fail("deveria rejeitar credenciais na URL");
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    assert.doesNotMatch(err.message, /segredo123/);
  }
});

test("embeddings só com modelo explícito; dimensão opcional", () => {
  const c = loadConfig({ EMBEDDINGS_MODEL: "modelo-da-indexacao", EMBEDDINGS_DIMENSIONS: "768" });
  assert.equal(c.embeddings?.model, "modelo-da-indexacao");
  assert.equal(c.embeddings?.dimensions, 768);
  assert.equal(c.embeddings?.baseUrl, "http://127.0.0.1:11434");
  assert.throws(() => loadConfig({ EMBEDDINGS_MODEL: "m", EMBEDDINGS_PROVIDER: "servico-pago" }), ConfigError);
});

test("autenticação jwt-hs256 exige segredo forte", () => {
  assert.throws(() => loadConfig({ GERPRO_AUTH_MODE: "jwt-hs256" }), /32 bytes/);
  assert.throws(() => loadConfig({ GERPRO_AUTH_MODE: "jwt-hs256", GERPRO_AUTH_JWT_SECRET: "curto" }), /32 bytes/);
  assert.throws(() => loadConfig({ GERPRO_AUTH_MODE: "basic" }), ConfigError);
  const c = loadConfig({ GERPRO_AUTH_MODE: "jwt-hs256", GERPRO_AUTH_JWT_SECRET: "a".repeat(32) });
  assert.equal(c.auth.mode, "jwt-hs256");
  assert.deepEqual(c.auth.jwt?.claims, { userId: "sub", organizationId: "org", permissions: "perms" });
});

test("valida novas opções do Ollama e ambiente", () => {
  const c = loadConfig({ OLLAMA_THINK: "auto", OLLAMA_KEEP_ALIVE: "default", OLLAMA_NUM_CTX: "0", APP_ENV: "homologacao" });
  assert.equal(c.ollama.think, "auto");
  assert.equal(c.ollama.keepAlive, null);
  assert.equal(c.ollama.numCtx, null);
  assert.equal(c.environment, "homologacao");
  assert.throws(() => loadConfig({ OLLAMA_KEEP_ALIVE: "trinta" }), ConfigError);
  assert.throws(() => loadConfig({ APP_ENV: "Demo Ambiente" }), ConfigError);
});

test("OLLAMA_MODEL permite voltar ao modelo alternativo instalado", () => {
  assert.equal(loadConfig({ OLLAMA_MODEL: "qwen3:4b" }).ollama.model, "qwen3:4b");
});

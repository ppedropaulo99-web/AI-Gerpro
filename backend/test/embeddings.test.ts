import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaEmbeddingProvider } from "../src/embeddings/provider.ts";
import type { EmbeddingsConfig } from "../src/config/env.ts";

const cfg = (over: Partial<EmbeddingsConfig> = {}): EmbeddingsConfig => ({
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "embed-teste",
  dimensions: 3,
  queryPrefix: "query: ",
  timeoutMs: 1000,
  ...over,
});

function fakeFetch(status: number, body: unknown, seen: { url?: string; body?: unknown } = {}) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("embeddings: usa /api/embed local, com o modelo e o prefixo configurados", async () => {
  const seen: { url?: string; body?: unknown } = {};
  const p = new OllamaEmbeddingProvider(cfg(), fakeFetch(200, { embeddings: [[0.1, 0.2, 0.3]] }, seen));
  assert.deepEqual(await p.embedQuery("pergunta"), [0.1, 0.2, 0.3]);
  assert.equal(seen.url, "http://127.0.0.1:11434/api/embed");
  assert.deepEqual(seen.body, { model: "embed-teste", input: "query: pergunta", truncate: true });
});

test("embeddings: modelo ausente, dimensão divergente e resposta malformada", async () => {
  await assert.rejects(new OllamaEmbeddingProvider(cfg(), fakeFetch(404, {})).embedQuery("x"), { kind: "not_found" });
  await assert.rejects(new OllamaEmbeddingProvider(cfg(), fakeFetch(200, { embeddings: [[1, 2]] })).embedQuery("x"), {
    kind: "invalid_request",
  });
  await assert.rejects(new OllamaEmbeddingProvider(cfg(), fakeFetch(200, { embeddings: [["a"]] })).embedQuery("x"), { kind: "upstream" });
  await assert.rejects(new OllamaEmbeddingProvider(cfg(), fakeFetch(500, {})).embedQuery("x"), { kind: "upstream" });
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(new OllamaEmbeddingProvider(cfg(), down).embedQuery("x"), { kind: "unavailable" });
});

test("embeddings: health informa a dimensão real", async () => {
  const h = await new OllamaEmbeddingProvider(cfg({ dimensions: null }), fakeFetch(200, { embeddings: [[1, 2, 3, 4]] })).health();
  assert.deepEqual(h, { configured: true, reachable: true, detail: "Modelo embed-teste, dimensão 4", dimensions: 4 });
});

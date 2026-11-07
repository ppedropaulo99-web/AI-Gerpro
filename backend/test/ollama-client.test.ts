import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaClient, LlmError, stripReasoning, type FetchLike } from "../src/ollama/client.ts";
import type { OllamaConfig } from "../src/config/env.ts";

const cfg: OllamaConfig = { baseUrl: "http://ollama.test", model: "qwen3:4b", timeoutMs: 1_000, think: true, keepAlive: null, numCtx: null, preload: false };

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

test("chat envia payload correto e retorna conteúdo", async () => {
  let captured: { url: string; body: unknown } | null = null;
  const fetchImpl: FetchLike = async (url, init) => {
    captured = { url, body: JSON.parse(String(init?.body)) };
    return json(200, {
      model: "qwen3:4b",
      message: { role: "assistant", content: "  Olá!  " },
      total_duration: 2_500_000_000,
      prompt_eval_count: 12,
      eval_count: 3,
    });
  };
  const client = new OllamaClient(cfg, fetchImpl);
  const r = await client.chat([{ role: "user", content: "oi" }]);

  assert.equal(r.content, "Olá!");
  assert.equal(r.totalDurationMs, 2500);
  assert.equal(r.promptTokens, 12);
  assert.deepEqual(captured, {
    url: "http://ollama.test/api/chat",
    body: { model: "qwen3:4b", messages: [{ role: "user", content: "oi" }], stream: false, think: true },
  });
});

test("chat remove bloco <think> do conteúdo", async () => {
  const client = new OllamaClient(cfg, async () => json(200, { message: { content: "<think>\nraciocínio\n</think>\n\nResposta" } }));
  const r = await client.chat([{ role: "user", content: "oi" }]);
  assert.equal(r.content, "Resposta");
});

test("stripReasoning remove </think> órfão (template que abre <think> no prompt)", () => {
  assert.equal(stripReasoning("raciocínio longo...\n</think>\n\nok"), "ok");
  assert.equal(stripReasoning("sem raciocínio"), "sem raciocínio");
});

test("chat converte erro HTTP do Ollama em LlmError upstream", async () => {
  const client = new OllamaClient(cfg, async () => json(404, { error: "model 'x' not found" }));
  await assert.rejects(client.chat([{ role: "user", content: "oi" }]), (e: unknown) => {
    assert.ok(e instanceof LlmError);
    assert.equal(e.kind, "upstream");
    assert.equal(e.upstreamStatus, 404);
    assert.match(e.message, /not found/);
    return true;
  });
});

test("chat sinaliza servidor inacessível", async () => {
  const client = new OllamaClient(cfg, async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(client.chat([{ role: "user", content: "oi" }]), { name: "LlmError", kind: "unreachable" });
});

test("chat respeita timeout", async () => {
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  const client = new OllamaClient({ ...cfg, timeoutMs: 50 }, fetchImpl);
  await assert.rejects(client.chat([{ role: "user", content: "oi" }]), { name: "LlmError", kind: "timeout" });
});

test("chat sinaliza cancelamento externo", async () => {
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  const client = new OllamaClient(cfg, fetchImpl);
  const ac = new AbortController();
  const p = client.chat([{ role: "user", content: "oi" }], ac.signal);
  ac.abort();
  await assert.rejects(p, { name: "LlmError", kind: "cancelled" });
});

test("chat rejeita resposta sem conteúdo ou vazia", async () => {
  const c1 = new OllamaClient(cfg, async () => json(200, { message: {} }));
  await assert.rejects(c1.chat([{ role: "user", content: "oi" }]), { kind: "invalid_response" });
  const c2 = new OllamaClient(cfg, async () => json(200, { message: { content: "   " } }));
  await assert.rejects(c2.chat([{ role: "user", content: "oi" }]), { kind: "invalid_response" });
  const c3 = new OllamaClient(cfg, async () => new Response("não é json", { status: 200 }));
  await assert.rejects(c3.chat([{ role: "user", content: "oi" }]), { kind: "invalid_response" });
});

test("health detecta modelo disponível e ausente", async () => {
  const fetchImpl: FetchLike = async (url) =>
    url.endsWith("/api/tags") ? json(200, { models: [{ name: "qwen3:4b" }, { name: "llama3:latest" }] }) : json(200, { version: "0.9.0" });

  const ok = await new OllamaClient(cfg, fetchImpl).health();
  assert.equal(ok.reachable, true);
  assert.equal(ok.modelAvailable, true);
  assert.equal(ok.version, "0.9.0");
  assert.equal(ok.error, null);

  const latest = await new OllamaClient({ ...cfg, model: "llama3" }, fetchImpl).health();
  assert.equal(latest.modelAvailable, true);

  const missing = await new OllamaClient({ ...cfg, model: "inexistente" }, fetchImpl).health();
  assert.equal(missing.reachable, true);
  assert.equal(missing.modelAvailable, false);
  assert.match(missing.error ?? "", /ollama pull inexistente/);
});

test("health retorna inacessível sem lançar exceção", async () => {
  const h = await new OllamaClient(cfg, async () => {
    throw new TypeError("fetch failed");
  }).health();
  assert.equal(h.reachable, false);
  assert.ok(h.error);
});

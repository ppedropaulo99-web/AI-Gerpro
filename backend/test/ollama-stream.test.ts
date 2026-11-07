import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaClient, type FetchLike, type LlmStreamEvent } from "../src/ollama/client.ts";
import type { OllamaConfig, ThinkMode } from "../src/config/env.ts";

const cfg = (think: ThinkMode, extra: Partial<OllamaConfig> = {}): OllamaConfig => ({
  baseUrl: "http://ollama.test",
  model: "qwen3:4b",
  timeoutMs: 2_000,
  think,
  keepAlive: null,
  numCtx: null,
  preload: false,
  ...extra,
});

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Corpo NDJSON enviado em pedaços (opcionalmente quebrando linhas no meio). */
function ndjson(lines: unknown[], chunkSize = 0): Response {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const parts = chunkSize > 0 ? Array.from({ length: Math.ceil(text.length / chunkSize) }, (_, i) => text.slice(i * chunkSize, i * chunkSize + chunkSize)) : [text];
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    }),
    { status: 200 },
  );
}

const thinkingChunks = [
  { message: { role: "assistant", content: "", thinking: "segredo " } },
  { message: { role: "assistant", content: "", thinking: "interno" } },
  { message: { role: "assistant", content: "Olá" } },
  { message: { role: "assistant", content: ", tudo bem?" } },
  { model: "qwen3:4b", done: true, message: { content: "" }, total_duration: 3e9, prompt_eval_count: 10, eval_count: 20 },
];

async function collect(it: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

/** fetch falso: /api/show devolve capacidades; /api/chat devolve o stream. */
function fakeFetch(caps: string[] | null, chat: () => Response, bodies: unknown[] = []): FetchLike {
  return async (url, init) => {
    if (url.endsWith("/api/show")) return caps ? json(200, { capabilities: caps }) : json(500, { error: "x" });
    bodies.push(JSON.parse(String(init?.body)));
    return chat();
  };
}

test("stream: descarta raciocínio, anuncia fase e entrega conteúdo + uso", async () => {
  for (const chunkSize of [0, 7, 1]) {
    const client = new OllamaClient(cfg("auto"), fakeFetch(["completion", "thinking"], () => ndjson(thinkingChunks, chunkSize)));
    const events = await collect(await client.openChatStream([{ role: "user", content: "oi" }]));
    assert.deepEqual(events, [
      { type: "thinking" },
      { type: "content", text: "Olá" },
      { type: "content", text: ", tudo bem?" },
      { type: "done", model: "qwen3:4b", totalDurationMs: 3000, promptTokens: 10, completionTokens: 20 },
    ]);
    assert.ok(!JSON.stringify(events).includes("segredo"), "raciocínio não pode vazar");
  }
});

test("think=auto: envia think=true se o modelo raciocina e omite caso contrário", async () => {
  const b1: Array<Record<string, unknown>> = [];
  await collect(await new OllamaClient(cfg("auto"), fakeFetch(["thinking"], () => ndjson(thinkingChunks), b1)).openChatStream([{ role: "user", content: "oi" }]));
  assert.equal(b1[0]!["think"], true);
  assert.equal(b1[0]!["stream"], true);

  const b2: Array<Record<string, unknown>> = [];
  await collect(await new OllamaClient(cfg("auto"), fakeFetch(["completion"], () => ndjson(thinkingChunks), b2)).openChatStream([{ role: "user", content: "oi" }]));
  assert.equal("think" in b2[0]!, false);
});

test("envia keep_alive e num_ctx configurados", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = new OllamaClient(cfg(true, { keepAlive: "30m", numCtx: 8192 }), fakeFetch(null, () => ndjson(thinkingChunks), bodies));
  await collect(await client.openChatStream([{ role: "user", content: "oi" }]));
  assert.equal(bodies[0]!["keep_alive"], "30m");
  assert.deepEqual(bodies[0]!["options"], { num_ctx: 8192 });
});

test("think=false com modelo thinking: retém tudo até </think> órfão", async () => {
  const leaked = [
    { message: { content: "Okay, o usuário quer " } },
    { message: { content: "segredo\n</thi" } },
    { message: { content: "nk>\n\nResposta" } },
    { done: true, message: { content: "" } },
  ];
  const client = new OllamaClient(cfg(false), fakeFetch(["thinking"], () => ndjson(leaked)));
  const events = await collect(await client.openChatStream([{ role: "user", content: "oi" }]));
  const text = events.flatMap((e) => (e.type === "content" ? [e.text] : [])).join("");
  assert.equal(text, "Resposta");
  assert.equal(events[0]!.type, "thinking");
});

test("erro HTTP do Ollama é lançado ao abrir o stream", async () => {
  const client = new OllamaClient(cfg(true), async () => json(404, { error: "model 'x' not found" }));
  await assert.rejects(client.openChatStream([{ role: "user", content: "oi" }]), { name: "LlmError", kind: "upstream" });
});

test("erro no meio do stream é lançado pelo iterador", async () => {
  const client = new OllamaClient(cfg(true), async () => ndjson([{ message: { content: "parcial" } }, { error: "GPU out of memory" }]));
  const it = await client.openChatStream([{ role: "user", content: "oi" }]);
  const seen: LlmStreamEvent[] = [];
  await assert.rejects(
    (async () => {
      for await (const ev of it) seen.push(ev);
    })(),
    { kind: "upstream" },
  );
  assert.deepEqual(seen, [{ type: "content", text: "parcial" }]);
});

test("stream sem resposta visível é inválido", async () => {
  const only = [{ message: { content: "", thinking: "só pensei" } }, { done: true, message: { content: "" } }];
  const client = new OllamaClient(cfg(true), async () => ndjson(only));
  await assert.rejects(collect(await client.openChatStream([{ role: "user", content: "oi" }])), { kind: "invalid_response" });
});

test("stream que termina sem done é inválido", async () => {
  const client = new OllamaClient(cfg(true), async () => ndjson([{ message: { content: "corte" } }]));
  await assert.rejects(collect(await client.openChatStream([{ role: "user", content: "oi" }])), { kind: "invalid_response" });
});

test("timeout durante o stream", async () => {
  const fetchImpl: FetchLike = async (_url, init) =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: "a" } }) + "\n"));
          init?.signal?.addEventListener("abort", () => c.error(init.signal?.reason));
        },
      }),
    );
  const client = new OllamaClient(cfg(true, { timeoutMs: 1_000 }), fetchImpl);
  await assert.rejects(collect(await client.openChatStream([{ role: "user", content: "oi" }])), { kind: "timeout" });
});

test("cancelamento externo durante o stream", async () => {
  const ac = new AbortController();
  const fetchImpl: FetchLike = async (_url, init) =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: "a" } }) + "\n"));
          init?.signal?.addEventListener("abort", () => c.error(init.signal?.reason));
        },
      }),
    );
  const client = new OllamaClient(cfg(true), fetchImpl);
  const it = await client.openChatStream([{ role: "user", content: "oi" }], ac.signal);
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(collect(it), { kind: "cancelled" });
});

test("preload chama /api/generate com as mesmas opções", async () => {
  let body: Record<string, unknown> | null = null;
  let path = "";
  const client = new OllamaClient(cfg(true, { keepAlive: "1h", numCtx: 4096 }), async (url, init) => {
    path = url;
    body = JSON.parse(String(init?.body));
    return json(200, { done: true });
  });
  await client.preload();
  assert.equal(path, "http://ollama.test/api/generate");
  assert.deepEqual(body, { model: "qwen3:4b", keep_alive: "1h", options: { num_ctx: 4096 } });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, createChatApi, type FetchLike } from "../src/api/client.ts";

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

test("sendChat faz POST para /api/chat com o histórico", async () => {
  let call: { url: string; init: RequestInit | undefined } | null = null;
  const fetchImpl: FetchLike = async (url, init) => {
    call = { url, init };
    return json(200, { message: { role: "assistant", content: "ok" }, model: "m", durationMs: 10, usage: {} });
  };
  const api = createChatApi("/api/", fetchImpl);
  const res = await api.sendChat([{ role: "user", content: "oi" }]);

  assert.equal(res.message.content, "ok");
  assert.ok(call);
  const c = call as { url: string; init: RequestInit };
  assert.equal(c.url, "/api/chat");
  assert.equal(c.init.method, "POST");
  assert.deepEqual(JSON.parse(String(c.init.body)), { messages: [{ role: "user", content: "oi" }] });
});

test("sendChat converte erro padronizado do backend em ApiError", async () => {
  const api = createChatApi("/api", async () => json(504, { error: { code: "llm_timeout", message: "demorou" } }));
  await assert.rejects(api.sendChat([{ role: "user", content: "oi" }]), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 504);
    assert.equal(e.code, "llm_timeout");
    assert.equal(e.message, "demorou");
    return true;
  });
});

test("sendChat trata erro sem corpo JSON e falha de rede", async () => {
  const api1 = createChatApi("/api", async () => new Response("<html>", { status: 502 }));
  await assert.rejects(api1.sendChat([{ role: "user", content: "oi" }]), { code: "http_error", status: 502 });

  const api2 = createChatApi("/api", async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(api2.sendChat([{ role: "user", content: "oi" }]), { code: "network_error" });
});

test("sendChat reporta cancelamento", async () => {
  const ac = new AbortController();
  ac.abort();
  const api = createChatApi("/api", async () => {
    throw new DOMException("aborted", "AbortError");
  });
  await assert.rejects(api.sendChat([{ role: "user", content: "oi" }], ac.signal), { code: "aborted" });
});

test("getOllamaHealth aceita 503 com corpo de diagnóstico", async () => {
  const api = createChatApi("/api", async () =>
    json(503, { status: "unavailable", model: "m", latencyMs: 1 }),
  );
  const h = await api.getOllamaHealth();
  assert.equal(h.status, "unavailable");
});

/** Resposta NDJSON em pedaços arbitrários (simula a rede). */
function ndjsonResponse(events: unknown[], chunkSize = 5, status = 200): Response {
  const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < text.length; i += chunkSize) c.enqueue(enc.encode(text.slice(i, i + chunkSize)));
        c.close();
      },
    }),
    { status, headers: { "content-type": "application/x-ndjson" } },
  );
}

const okEvents = [
  { type: "start", model: "m" },
  { type: "thinking" },
  { type: "delta", content: "Olá" },
  { type: "delta", content: " **mundo**" },
  { type: "done", model: "m", durationMs: 5, usage: { promptTokens: 1, completionTokens: 2 } },
];

test("streamChat faz POST em /api/chat/stream e entrega eventos mesmo com linhas partidas", async () => {
  let url = "";
  const api = createChatApi("/api", async (u) => {
    url = u;
    return ndjsonResponse(okEvents, 3);
  });
  const got = [];
  for await (const ev of api.streamChat([{ role: "user", content: "oi" }])) got.push(ev);
  assert.equal(url, "/api/chat/stream");
  assert.deepEqual(got, okEvents);
});

test("streamChat converte evento error em ApiError após os deltas", async () => {
  const api = createChatApi("/api", async () =>
    ndjsonResponse([{ type: "start", model: "m" }, { type: "delta", content: "par" }, { type: "error", error: { code: "llm_timeout", message: "demorou" } }]),
  );
  const got: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const ev of api.streamChat([{ role: "user", content: "oi" }])) got.push(ev.type);
    })(),
    { name: "ApiError", code: "llm_timeout", message: "demorou" },
  );
  assert.deepEqual(got, ["start", "delta"]);
});

test("streamChat: erro HTTP antes do stream usa o corpo padronizado", async () => {
  const api = createChatApi("/api", async () => json(503, { error: { code: "llm_unavailable", message: "offline" } }));
  await assert.rejects(api.streamChat([{ role: "user", content: "oi" }]).next(), { code: "llm_unavailable", status: 503 });
});

test("streamChat: stream que termina sem done é sinalizado", async () => {
  const api = createChatApi("/api", async () => ndjsonResponse([{ type: "start", model: "m" }, { type: "delta", content: "x" }]));
  await assert.rejects(
    (async () => {
      for await (const _ of api.streamChat([{ role: "user", content: "oi" }])) void _;
    })(),
    { code: "stream_interrupted" },
  );
});

test("streamChat: interromper cancela a leitura e lança aborted", async () => {
  const ac = new AbortController();
  let cancelled = false;
  const api = createChatApi("/api", async (_u, init) => {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(JSON.stringify({ type: "start", model: "m" }) + "\n"));
          init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );
  });
  const it = api.streamChat([{ role: "user", content: "oi" }], ac.signal);
  assert.equal((await it.next()).value?.type, "start");
  ac.abort();
  await assert.rejects(it.next(), { code: "aborted" });
  // parar de consumir também fecha a conexão
  const it2 = api.streamChat([{ role: "user", content: "oi" }]);
  await it2.next();
  await it2.return(undefined);
  assert.equal(cancelled, true);
});

test("getAuthToken: envia Authorization Bearer e nunca coloca credenciais no corpo", async () => {
  const seen: (RequestInit | undefined)[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    seen.push(init);
    return json(200, { message: { role: "assistant", content: "ok" }, model: "m", durationMs: 1, usage: {} });
  };
  const api = createChatApi("/api", fetchImpl, { getAuthToken: async () => "tok-123" });
  await api.sendChat([{ role: "user", content: "oi" }]);
  const headers = seen[0]!.headers as Record<string, string>;
  assert.equal(headers["authorization"], "Bearer tok-123");
  assert.deepEqual(Object.keys(JSON.parse(String(seen[0]!.body))), ["messages"]);

  const noSession = createChatApi("/api", fetchImpl, { getAuthToken: () => null });
  await noSession.sendChat([{ role: "user", content: "oi" }]);
  assert.equal((seen[1]!.headers as Record<string, string>)["authorization"], undefined);

  const failing = createChatApi("/api", fetchImpl, {
    getAuthToken: () => {
      throw new Error("sessão expirada");
    },
  });
  await assert.rejects(failing.sendChat([{ role: "user", content: "oi" }]), { code: "auth_unavailable" });
});

test("streamChat repassa o evento sources (novo na Etapa 3.1)", async () => {
  const lines = [
    { type: "start", model: "m" },
    { type: "sources", grounding: "no_sources", sources: [] },
    { type: "delta", content: "x" },
    { type: "done", model: "m", durationMs: 1, usage: {}, grounding: "no_sources", citations: { valid: [], unknown: [] } },
  ];
  const api = createChatApi("/api", async () => new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { status: 200 }));
  const types: string[] = [];
  for await (const ev of api.streamChat([{ role: "user", content: "oi" }])) types.push(ev.type);
  assert.deepEqual(types, ["start", "sources", "delta", "done"]);
});

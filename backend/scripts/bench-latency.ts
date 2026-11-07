/**
 * Benchmark de latência contra o Ollama REAL (não roda em `npm test`).
 * Uso: npm run bench -w backend [-- --runs 3]
 *
 * Mede, com streaming, o tempo até o 1º token (raciocínio), o tempo até o 1º token
 * de resposta visível e o total, separando tokens de raciocínio e de resposta.
 * Não baixa nem altera modelos; só usa parâmetros de requisição.
 */
import { loadConfig } from "../src/config/env.ts";
import { SYSTEM_PROMPT } from "../src/ollama/system-prompt.ts";

const config = loadConfig();
const base = config.ollama.baseUrl;
const model = config.ollama.model;
const runsArg = process.argv.indexOf("--runs");
const RUNS = runsArg !== -1 ? Number(process.argv[runsArg + 1]) : 3;

const QUESTIONS = [
  "Em uma frase, o que é uma petição inicial?",
  "Quais são os requisitos gerais de validade de um contrato no Brasil? Responda em tópicos curtos.",
];

interface Variant {
  name: string;
  system: string;
  options?: Record<string, unknown>;
  cold?: boolean;
}

// Prompt sem a instrução de concisão, para comparar com o prompt atual.
const BASE = SYSTEM_PROMPT.replace(/\n\nSeja conciso[\s\S]*$/, "");

const VARIANTS: Variant[] = [
  { name: "carga a frio (modelo descarregado)", system: SYSTEM_PROMPT, cold: true },
  { name: "prompt sem concisão", system: BASE },
  { name: "prompt atual (conciso)", system: SYSTEM_PROMPT },
];

interface Sample {
  loadMs: number;
  firstTokenMs: number;
  firstContentMs: number;
  totalMs: number;
  thinkingChars: number;
  contentChars: number;
  evalCount: number;
  tokPerSec: number;
}

async function unload(): Promise<void> {
  await fetch(`${base}/api/generate`, { method: "POST", body: JSON.stringify({ model, keep_alive: 0 }) });
  // aguarda o descarregamento efetivo
  for (let i = 0; i < 50; i++) {
    const ps = (await (await fetch(`${base}/api/ps`)).json()) as { models?: Array<{ name: string }> };
    if (!ps.models?.some((m) => m.name === model)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function run(v: Variant, question: string): Promise<Sample> {
  if (v.cold) await unload();
  const t0 = performance.now();
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    body: JSON.stringify({
      model,
      stream: true,
      think: true,
      ...(config.ollama.keepAlive ? { keep_alive: config.ollama.keepAlive } : {}),
      messages: [
        { role: "system", content: v.system },
        { role: "user", content: question },
      ],
      options: { ...(config.ollama.numCtx ? { num_ctx: config.ollama.numCtx } : {}), ...v.options },
    }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  let firstTokenMs = -1;
  let firstContentMs = -1;
  let thinkingChars = 0;
  let contentChars = 0;
  let final: Record<string, number> = {};
  let buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const j = JSON.parse(line) as { message?: { content?: string; thinking?: string }; done?: boolean } & Record<string, number>;
      const now = performance.now() - t0;
      const th = j.message?.thinking ?? "";
      const ct = j.message?.content ?? "";
      if ((th || ct) && firstTokenMs < 0) firstTokenMs = now;
      if (ct && firstContentMs < 0) firstContentMs = now;
      thinkingChars += th.length;
      contentChars += ct.length;
      if (j.done) final = j;
    }
  }
  const totalMs = performance.now() - t0;
  const evalCount = final["eval_count"] ?? 0;
  const evalNs = final["eval_duration"] ?? 1;
  return {
    loadMs: Math.round((final["load_duration"] ?? 0) / 1e6),
    firstTokenMs: Math.round(firstTokenMs),
    firstContentMs: Math.round(firstContentMs),
    totalMs: Math.round(totalMs),
    thinkingChars,
    contentChars,
    evalCount,
    tokPerSec: Math.round(evalCount / (evalNs / 1e9)),
  };
}

const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

console.log(`Modelo: ${model} | ${base} | ${RUNS} execuções por pergunta\n`);
// aquecimento para que a variante "base" não pague a carga
await run({ name: "warmup", system: SYSTEM_PROMPT }, "oi");

const rows: Array<Record<string, string | number>> = [];
for (const v of VARIANTS) {
  const samples: Sample[] = [];
  const runs = v.cold ? 1 : RUNS;
  for (const q of QUESTIONS) for (let i = 0; i < runs; i++) samples.push(await run(v, q));
  rows.push({
    variante: v.name,
    "carga ms": avg(samples.map((s) => s.loadMs)),
    "1º token ms": avg(samples.map((s) => s.firstTokenMs)),
    "1ª resposta visível ms": avg(samples.map((s) => s.firstContentMs)),
    "total ms": avg(samples.map((s) => s.totalMs)),
    "raciocínio chars": avg(samples.map((s) => s.thinkingChars)),
    "resposta chars": avg(samples.map((s) => s.contentChars)),
    "tokens gerados": avg(samples.map((s) => s.evalCount)),
    "tok/s": avg(samples.map((s) => s.tokPerSec)),
  });
  console.log(`✔ ${v.name}`);
}
console.log();
console.table(rows);

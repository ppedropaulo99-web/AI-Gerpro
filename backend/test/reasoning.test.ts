import { test } from "node:test";
import assert from "node:assert/strict";
import { ReasoningStreamFilter, stripReasoning } from "../src/ollama/reasoning.ts";

/** Alimenta o filtro com pedaços arbitrários e devolve o texto visível total. */
function run(mode: "leading-tag" | "until-close", chunks: string[]): string {
  const f = new ReasoningStreamFilter(mode);
  return chunks.map((c) => f.push(c)).join("") + f.end();
}

/** Divide um texto em pedaços de tamanho n (simula tokens chegando). */
const split = (s: string, n: number) => Array.from({ length: Math.ceil(s.length / n) }, (_, i) => s.slice(i * n, i * n + n));

test("stripReasoning cobre bloco completo e </think> órfão", () => {
  assert.equal(stripReasoning("<think>x</think>\n\nResposta"), "Resposta");
  assert.equal(stripReasoning("raciocínio...\n</think>\n\nok"), "ok");
  assert.equal(stripReasoning("sem raciocínio"), "sem raciocínio");
});

test("leading-tag: conteúdo limpo passa direto (sem reter)", () => {
  const f = new ReasoningStreamFilter("leading-tag");
  assert.equal(f.push("Olá"), "Olá");
  assert.equal(f.push(", mundo"), ", mundo");
  assert.equal(f.end(), "");
});

test("leading-tag: remove bloco <think> inicial dividido em qualquer ponto", () => {
  const text = "<think>\nraciocínio secreto\n</think>\n\nResposta **final**";
  for (const n of [1, 2, 3, 5, 8, 13, 100]) {
    const out = run("leading-tag", split(text, n));
    assert.equal(out, "Resposta **final**", `pedaços de ${n}`);
    assert.ok(!out.includes("secreto"));
  }
});

test("leading-tag: texto que começa parecido com a tag não é retido para sempre", () => {
  assert.equal(run("leading-tag", ["<th", "is is html"]), "<this is html");
  assert.equal(run("leading-tag", ["<t"]), "<t");
});

test("leading-tag: <think> não fechado (truncado) não vaza nada", () => {
  assert.equal(run("leading-tag", ["<think>pensando", " sem fim"]), "");
});

test("until-close: suprime tudo até </think> órfão, em qualquer divisão", () => {
  const text = "Okay, the user wants... segredo\n</think>\n\nResposta visível";
  for (const n of [1, 3, 7, 50]) {
    const out = run("until-close", split(text, n));
    assert.equal(out, "Resposta visível", `pedaços de ${n}`);
  }
});

test("until-close: sem </think>, o texto retido é a resposta (modelo sem raciocínio)", () => {
  assert.equal(run("until-close", ["Resposta ", "direta"]), "Resposta direta");
});

test("until-close: sinaliza retenção enquanto não fecha", () => {
  const f = new ReasoningStreamFilter("until-close");
  f.push("pensando");
  assert.equal(f.suppressing, true);
  f.push("</think>ok");
  assert.equal(f.suppressing, false);
});

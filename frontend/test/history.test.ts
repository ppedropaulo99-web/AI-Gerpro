import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CHAT_LIMITS, buildRequestHistory, normalizeLimits } from "../src/api/history.ts";
import type { ChatMessage } from "../src/api/types.ts";

const u = (content: string): ChatMessage => ({ role: "user", content });
const a = (content: string): ChatMessage => ({ role: "assistant", content });

test("histórico curto é enviado inteiro e sem alterações", () => {
  const conv = [u("p1"), a("r1"), u("p2")];
  assert.deepEqual(buildRequestHistory(conv, DEFAULT_CHAT_LIMITS), conv);
});

test("50 perguntas seguidas: nenhuma requisição passa do limite e todas começam pelo usuário", () => {
  for (const maxMessages of [30, 29, 10, 3, 2, 1]) {
    const limits = { maxMessages, maxCharsPerMessage: 8000 };
    const conv: ChatMessage[] = [];
    for (let i = 1; i <= 50; i++) {
      conv.push(u(`pergunta ${i}`));
      const sent = buildRequestHistory(conv, limits);
      assert.ok(sent.length <= maxMessages, `limite ${maxMessages}, pergunta ${i}: ${sent.length}`);
      assert.ok(sent.length >= 1);
      assert.equal(sent[0]!.role, "user", "começa por pergunta do usuário");
      assert.deepEqual(sent.at(-1), u(`pergunta ${i}`), "termina na pergunta atual");
      // Pares preservados: alternância usuário → assistente sem respostas órfãs.
      sent.forEach((m, k) => assert.equal(m.role, k % 2 === 0 ? "user" : "assistant"));
      // A janela é a mais recente possível.
      if (i > 1 && maxMessages >= 3) assert.deepEqual(sent.at(-2), a(`resposta ${i - 1}`));
      conv.push(a(`resposta ${i}`));
    }
  }
});

test("a conversa original (visível no widget) não é alterada", () => {
  const conv = Array.from({ length: 60 }, (_, i) => (i % 2 ? a(`r${i}`) : u(`p${i}`)));
  conv.push(u("atual"));
  const copy = structuredClone(conv);
  buildRequestHistory(conv, { maxMessages: 5, maxCharsPerMessage: 3 });
  assert.deepEqual(conv, copy);
});

test("continuação: o identificador informado na pergunta recente continua na janela enviada", () => {
  const conv: ChatMessage[] = [];
  for (let i = 0; i < 30; i++) conv.push(u(`assunto geral ${i}`), a(`ok ${i}`));
  conv.push(u("Quais informações existem sobre o PRC-0042?"), a("Segundo [N1], ..."), u("Quem é o responsável por ele?"));
  const sent = buildRequestHistory(conv, DEFAULT_CHAT_LIMITS);
  assert.ok(sent.length <= 30);
  assert.ok(sent.some((m) => m.role === "user" && m.content.includes("PRC-0042")));
  assert.equal(sent.at(-1)!.content, "Quem é o responsável por ele?");
});

test("respostas longas antigas são encurtadas para caber no limite de caracteres", () => {
  const longa = "x".repeat(20_000);
  const sent = buildRequestHistory([u("p1"), a(longa), u("p2")], { maxMessages: 30, maxCharsPerMessage: 8000 });
  assert.equal(sent[1]!.content.length, 8000);
  assert.ok(sent[1]!.content.endsWith("…"));
  assert.equal(sent[2]!.content, "p2");
});

test("mensagens vazias (resposta interrompida sem texto) não são enviadas", () => {
  const sent = buildRequestHistory([u("p1"), a("   "), u("p2")], DEFAULT_CHAT_LIMITS);
  assert.deepEqual(sent, [u("p1"), u("p2")]);
});

test("normalizeLimits aceita só inteiros positivos vindos do servidor", () => {
  assert.deepEqual(normalizeLimits({ maxMessages: 12, maxCharsPerMessage: 500 }), { maxMessages: 12, maxCharsPerMessage: 500 });
  assert.deepEqual(normalizeLimits({ maxMessages: 0, maxCharsPerMessage: -1 }), DEFAULT_CHAT_LIMITS);
  assert.deepEqual(normalizeLimits(null), DEFAULT_CHAT_LIMITS);
  assert.deepEqual(normalizeLimits({ maxMessages: 2.5 } as never), DEFAULT_CHAT_LIMITS);
});

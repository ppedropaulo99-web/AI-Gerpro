import { test } from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_PROMPT } from "../src/ollama/system-prompt.ts";

// Protege as regras aprovadas na Etapa 2.1 contra remoção acidental.
// (Regras de prompt são medidas auxiliares, não garantias; ver docs/ARCHITECTURE.md.)

test("prompt identifica o assistente e mantém conversa natural em português", () => {
  assert.match(SYSTEM_PROMPT, /AI Gerpro/);
  assert.match(SYSTEM_PROMPT, /português do Brasil/);
  assert.match(SYSTEM_PROMPT, /Converse normalmente/);
});

test("prompt proíbe acesso presumido e invenção de dados", () => {
  assert.match(SYSTEM_PROMPT, /NÃO tem acesso ao sistema Gerpro/);
  assert.match(SYSTEM_PROMPT, /Nunca invente/);
  assert.match(SYSTEM_PROMPT, /Nunca crie exemplos, simulações ou versões "fictícias"/);
});

test("prompt proíbe referências jurídicas numeradas sem fonte verificada", () => {
  assert.match(SYSTEM_PROMPT, /NÃO cite números de artigos, leis, súmulas, precedentes, julgados/);
  assert.match(SYSTEM_PROMPT, /fornecer na conversa o texto/);
});

test("prompt impede prazos, obrigações e interpretações como fatos confirmados", () => {
  assert.match(SYSTEM_PROMPT, /prazos processuais, obrigações legais ou interpretações jurídicas específicas como fatos confirmados/);
});

test("prompt orienta reconhecer a limitação quando faltar informação", () => {
  assert.match(SYSTEM_PROMPT, /Reconheça a limitação/);
});

test("último parágrafo começa com 'Seja conciso' (usado pelo benchmark de latência)", () => {
  assert.match(SYSTEM_PROMPT, /\n\nSeja conciso[^\n]*$/);
});

test("prompt proíbe informar números de prazos, percentuais ou valores legais", () => {
  assert.match(SYSTEM_PROMPT, /NÃO informe a quantidade de dias, meses ou anos de prazos/);
  assert.match(SYSTEM_PROMPT, /evite conclusões categóricas/);
  assert.match(SYSTEM_PROMPT, /Antes de responder a um tema jurídico, confira/);
});

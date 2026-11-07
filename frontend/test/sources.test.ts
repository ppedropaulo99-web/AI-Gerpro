import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeCitations,
  clip,
  formatScore,
  groundingNote,
  identifiersLine,
  resolutionNote,
  safeSourceUrl,
  splitCitations,
} from "../src/sources/model.ts";
import type { SourceSummary } from "../src/api/types.ts";

const src = (ref: string, over: Partial<SourceSummary> = {}): SourceSummary => ({
  ref,
  id: `qdrant:c:${ref}`,
  origin: ref.startsWith("Q") ? "qdrant" : "neo4j",
  score: 0.87,
  label: "Coleção",
  title: null,
  url: null,
  identifiers: {},
  excerpt: "trecho",
  linkedFrom: null,
  ...over,
});

test("splitCitations: só marcadores de fontes recebidas são válidos", () => {
  const segs = splitCitations("Segundo [Q1] e [N1], mas não [Q9].", new Set(["Q1", "N1"]));
  assert.deepEqual(segs, [
    { t: "text", v: "Segundo " },
    { t: "cite", ref: "Q1", valid: true },
    { t: "text", v: " e " },
    { t: "cite", ref: "N1", valid: true },
    { t: "text", v: ", mas não " },
    { t: "cite", ref: "Q9", valid: false },
    { t: "text", v: "." },
  ]);
  assert.deepEqual(splitCitations("sem marcadores [X1] [Q] [Q1", new Set(["Q1"])), [{ t: "text", v: "sem marcadores [X1] [Q] [Q1" }]);
});

test("sem fontes, qualquer marcador é sinalizado como sem fonte", () => {
  assert.deepEqual(splitCitations("[Q1]", new Set()), [{ t: "cite", ref: "Q1", valid: false }]);
  assert.deepEqual(analyzeCitations("Veja [Q1] e [N2] e [Q1].", []), { cited: [], unknown: ["Q1", "N2"] });
});

test("analyzeCitations separa citadas e inexistentes", () => {
  assert.deepEqual(analyzeCitations("Isso [N1], aquilo [Q3] e [Q1].", [src("Q1"), src("N1")]), {
    cited: ["N1", "Q1"],
    unknown: ["Q3"],
  });
});

test("safeSourceUrl aceita só http(s) absolutos", () => {
  assert.equal(safeSourceUrl("https://gerpro.example/doc/1"), "https://gerpro.example/doc/1");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "/relativo", "https:// x", "ftp://x", "", null, undefined, "https://a\nb"]) {
    assert.equal(safeSourceUrl(bad), null, String(bad));
  }
});

test("clip remove controles e encurta textos vindos das bases", () => {
  assert.equal(clip("a\u0000b\n\nc", 80), "a b c");
  assert.equal(clip("x".repeat(100), 10), `${"x".repeat(9)}…`);
  assert.equal(clip(null), "");
});

test("notas de fundamentação e resolução", () => {
  assert.equal(groundingNote("sources"), null);
  assert.equal(groundingNote("disabled"), null);
  assert.equal(groundingNote("ambiguous"), null, "o próprio texto já pede esclarecimento");
  assert.match(groundingNote("no_sources")!, /Nenhuma fonte/);
  assert.match(groundingNote("unavailable")!, /não responderam/);
  assert.match(groundingNote("unauthorized")!, /Sem acesso/);
  assert.equal(resolutionNote({ kind: "explicit", values: ["A"] }), null);
  assert.equal(resolutionNote({ kind: "contextual", values: ["PRC-0001"] }), "Considerando PRC-0001, mencionado antes na conversa.");
});

test("marcadores com espaços internos ([ N1 ]) também são reconhecidos", () => {
  assert.deepEqual(splitCitations("x [ N1 ] y", new Set(["N1"])), [
    { t: "text", v: "x " },
    { t: "cite", ref: "N1", valid: true },
    { t: "text", v: " y" },
  ]);
});

test("identificadores e similaridade formatados com limite", () => {
  assert.equal(identifiersLine({ a: "1", b: "2", c: "3", d: "4", e: "5" }), "a: 1 · b: 2 · c: 3 · d: 4");
  assert.equal(formatScore(0.873), "87%");
  assert.equal(formatScore(null), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, safeHref, type Block, type Inline } from "../src/markdown/parse.ts";

const p = (...c: Inline[]): Block => ({ t: "p", c });
const txt = (v: string): Inline => ({ t: "text", v });

/** Coleta todos os hrefs da árvore. */
function hrefs(x: unknown): string[] {
  if (Array.isArray(x)) return x.flatMap(hrefs);
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return [...(typeof o["href"] === "string" ? [o["href"] as string] : []), ...Object.values(o).flatMap(hrefs)];
  }
  return [];
}

test("parágrafos, quebras de linha e ênfases", () => {
  assert.deepEqual(parseMarkdown("Olá **mundo** e *itálico* e ~~riscado~~\nlinha 2\n\nOutro"), [
    p(txt("Olá "), { t: "strong", c: [txt("mundo")] }, txt(" e "), { t: "em", c: [txt("itálico")] }, txt(" e "), { t: "del", c: [txt("riscado")] }, { t: "br" }, txt("linha 2")),
    p(txt("Outro")),
  ]);
});

test("snake_case e asteriscos soltos não viram ênfase", () => {
  assert.deepEqual(parseMarkdown("nome_do_arquivo e 2 * 3 * 4"), [p(txt("nome_do_arquivo e 2 * 3 * 4"))]);
});

test("ênfase sem fechamento (streaming) aparece como texto", () => {
  assert.deepEqual(parseMarkdown("texto **parcial"), [p(txt("texto **parcial"))]);
});

test("código inline e bloco de código, inclusive não fechado", () => {
  assert.deepEqual(parseMarkdown("use `npm test` agora"), [p(txt("use "), { t: "code", v: "npm test" }, txt(" agora"))]);
  assert.deepEqual(parseMarkdown("```ts\nconst a = '<b>';\n```"), [{ t: "code", lang: "ts", v: "const a = '<b>';" }]);
  assert.deepEqual(parseMarkdown("```\nparcial"), [{ t: "code", lang: "", v: "parcial" }]);
  // ênfase dentro de código é literal
  assert.deepEqual(parseMarkdown("`**x**`"), [p({ t: "code", v: "**x**" })]);
});

test("títulos e linha horizontal", () => {
  const out = parseMarkdown("## Título **forte**\n\n---\n\ntexto");
  assert.deepEqual(out[0], { t: "h", level: 2, c: [txt("Título "), { t: "strong", c: [txt("forte")] }] });
  assert.deepEqual(out[1], { t: "hr" });
});

test("listas simples, numeradas e aninhadas", () => {
  const out = parseMarkdown("1. Capacidade\n2. Objeto lícito\n   - possível\n   - determinado\n3. Forma");
  assert.equal(out.length, 1);
  const list = out[0] as Extract<Block, { t: "list" }>;
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 3);
  const nested = list.items[1]![1] as Extract<Block, { t: "list" }>;
  assert.equal(nested.t, "list");
  assert.equal(nested.ordered, false);
  assert.equal(nested.items.length, 2);
});

test("lista com itens separados por linha em branco continua a mesma lista", () => {
  const out = parseMarkdown("- a\n\n- b\n\nfim");
  assert.equal(out.length, 2);
  assert.equal((out[0] as Extract<Block, { t: "list" }>).items.length, 2);
});

test("lista começando em outro número preserva o início", () => {
  const out = parseMarkdown("3. três\n4. quatro");
  assert.equal((out[0] as Extract<Block, { t: "list" }>).start, 3);
});

test("citação", () => {
  assert.deepEqual(parseMarkdown("> citado **aqui**"), [{ t: "quote", c: [p(txt("citado "), { t: "strong", c: [txt("aqui")] })] }]);
});

test("tabela GFM com alinhamento", () => {
  const out = parseMarkdown("| Item | Valor |\n|:---|---:|\n| A | 1 |\n| B |");
  assert.deepEqual(out, [
    {
      t: "table",
      align: ["left", "right"],
      head: [[txt("Item")], [txt("Valor")]],
      rows: [
        [[txt("A")], [txt("1")]],
        [[txt("B")], []],
      ],
    },
  ]);
});

test("links seguros são mantidos; esquemas perigosos viram texto", () => {
  const out = parseMarkdown(
    "[ok](https://exemplo.com) [x](javascript:alert(1)) [y](JaVaScRiPt:alert(1)) [z](data:text/html,oi) [w](vbscript:x) [m](mailto:a@b.com)",
  );
  assert.deepEqual(hrefs(out), ["https://exemplo.com", "mailto:a@b.com"]);
  assert.ok(JSON.stringify(out).includes('"v":"x"'), "texto do link inseguro é preservado");
});

test("imagens não são carregadas: viram links seguros", () => {
  const out = parseMarkdown("![logo](https://exemplo.com/a.png) ![x](javascript:alert(1))");
  assert.deepEqual(hrefs(out), ["https://exemplo.com/a.png"]);
});

test("URL solta vira link sem a pontuação final", () => {
  assert.deepEqual(parseMarkdown("veja https://exemplo.com/a."), [
    p(txt("veja "), { t: "link", href: "https://exemplo.com/a", c: [txt("https://exemplo.com/a")] }, txt(".")),
  ]);
});

test("HTML bruto é tratado como texto", () => {
  const src = '<script>alert(1)</script><img src=x onerror="alert(1)">';
  assert.deepEqual(parseMarkdown(src), [p(txt(src))]);
});

test("escape com barra invertida", () => {
  assert.deepEqual(parseMarkdown("\\*literal\\*"), [p(txt("*literal*"))]);
});

test("safeHref rejeita esquemas disfarçados", () => {
  assert.equal(safeHref("java\nscript:alert(1)"), null);
  assert.equal(safeHref(" javascript:alert(1)"), null);
  assert.equal(safeHref("/relativo"), null);
  assert.equal(safeHref("https://ok.com/x?y=1"), "https://ok.com/x?y=1");
});

test("entradas grandes e profundamente aninhadas não quebram o parser", () => {
  const deep = "> ".repeat(50) + "fundo";
  assert.doesNotThrow(() => parseMarkdown(deep));
  const nestedEm = "*".repeat(2000) + "x" + "*".repeat(2000);
  const t0 = performance.now();
  parseMarkdown(nestedEm);
  parseMarkdown("- item\n".repeat(2000));
  assert.ok(performance.now() - t0 < 2000, "parser deve ser rápido");
});

test("streaming: parse de prefixos sucessivos nunca lança", () => {
  const full = "## Requisitos\n\n1. **Agente capaz**: pessoa com `capacidade`.\n2. Objeto lícito\n   - possível\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nx()\n```\nFim [link](https://a.com).";
  for (let k = 0; k <= full.length; k++) assert.doesNotThrow(() => parseMarkdown(full.slice(0, k)), `prefixo ${k}`);
});

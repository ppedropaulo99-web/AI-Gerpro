/**
 * Parser de Markdown mínimo e seguro para respostas do modelo.
 *
 * Segurança por construção: o resultado é uma árvore de dados (nunca HTML) que o
 * componente <Markdown> converte em elementos React — o React escapa todo texto.
 * HTML bruto no texto é exibido literalmente. Links só com http(s) ou mailto;
 * imagens viram links (nada externo é carregado automaticamente).
 *
 * Suporta: parágrafos, quebras de linha, títulos, negrito, itálico, tachado, código
 * inline e em bloco, listas (com aninhamento), citações, linha horizontal, tabelas GFM
 * e links/URLs. Tolerante a Markdown incompleto (streaming): blocos de código abertos
 * são renderizados como código; delimitadores sem fechamento aparecem como texto.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "quote"; c: Block[] }
  | { t: "hr" }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] };

const MAX_DEPTH = 8;

// ---------------------------------------------------------------------------
// URLs

/** Devolve a URL se for segura (http, https, mailto); caso contrário null. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  // remove caracteres de controle/espaços que poderiam disfarçar o esquema (ex.: "java\nscript:")
  if (/[\u0000-\u001f\u007f\s]/.test(url)) return null;
  if (/^https?:\/\/[^/]/i.test(url)) return url;
  if (/^mailto:[^@\s]+@[^@\s]+$/i.test(url)) return url;
  return null;
}

// ---------------------------------------------------------------------------
// Blocos

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string) => line.match(/^\s*/)![0].replace(/\t/g, "    ").length;
const isBlank = (line: string) => line.trim() === "";

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-"))
  );
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function dedent(lines: string[], n: number): string[] {
  return lines.map((l) => {
    let i = 0;
    let removed = 0;
    while (i < l.length && removed < n && (l[i] === " " || l[i] === "\t")) {
      removed += l[i] === "\t" ? 4 : 1;
      i++;
    }
    return l.slice(i);
  });
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }

    // Bloco de código cercado (aceita fence não fechado — streaming)
    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1]!;
      const indent = indentOf(line);
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // fence de fechamento (ou fim)
      out.push({ t: "code", lang: fence[2] ?? "", v: dedent(body, indent).join("\n") });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      out.push({ t: "h", level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, c: parseInline(heading[2]!, depth) });
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i]!) && (QUOTE.test(lines[i]!) || body.length > 0)) {
        if (!QUOTE.test(lines[i]!) && startsBlock(lines[i]!, lines[i + 1])) break;
        body.push(lines[i]!.replace(QUOTE, ""));
        i++;
      }
      out.push({ t: "quote", c: depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [{ t: "p", c: [{ t: "text", v: body.join("\n") }] }] });
      continue;
    }

    // Tabela GFM: cabeçalho + linha separadora
    const next = lines[i + 1];
    if (line.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-")) {
      const head = splitRow(line);
      const align: Align[] = splitRow(next).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null,
      );
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes("|")) {
        const cells = splitRow(lines[i]!);
        rows.push(head.map((_, k) => parseInline(cells[k] ?? "", depth)));
        i++;
      }
      out.push({ t: "table", align: head.map((_, k) => align[k] ?? null), head: head.map((h) => parseInline(h, depth)), rows });
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      const baseIndent = indentOf(line);
      const ordered = /\d/.test(item[2]!);
      const start = ordered ? parseInt(item[2]!, 10) : 1;
      const items: Block[][] = [];

      while (i < lines.length) {
        const m = lines[i]!.match(LIST_ITEM);
        if (!m || indentOf(lines[i]!) !== baseIndent || /\d/.test(m[2]!) !== ordered) break;
        const contentIndent = baseIndent + m[2]!.length + 1;
        const body: string[] = [m[3]!];
        i++;
        while (i < lines.length) {
          const l = lines[i]!;
          if (isBlank(l)) {
            // linha em branco: continua o item só se o que vem depois estiver indentado
            let j = i + 1;
            while (j < lines.length && isBlank(lines[j]!)) j++;
            if (j < lines.length && indentOf(lines[j]!) > baseIndent) {
              body.push(...lines.slice(i, j));
              i = j;
              continue;
            }
            break;
          }
          const ind = indentOf(l);
          if (ind > baseIndent) {
            body.push(l);
            i++;
            continue;
          }
          // continuação "preguiçosa" de parágrafo (linha sem indentação que não inicia bloco)
          if (!startsBlock(l, lines[i + 1]) && !isBlank(body[body.length - 1] ?? "")) {
            body.push(l);
            i++;
            continue;
          }
          break;
        }
        const inner = [body[0]!, ...dedent(body.slice(1), contentIndent)];
        items.push(depth < MAX_DEPTH ? parseBlocks(inner, depth + 1) : [{ t: "p", c: [{ t: "text", v: inner.join("\n") }] }]);
        // pula linhas em branco entre itens do mesmo nível
        let j = i;
        while (j < lines.length && isBlank(lines[j]!)) j++;
        const nm = j < lines.length ? lines[j]!.match(LIST_ITEM) : null;
        if (nm && indentOf(lines[j]!) === baseIndent && /\d/.test(nm[2]!) === ordered) i = j;
        else break;
      }
      out.push({ t: "list", ordered, start, items });
      continue;
    }

    // Parágrafo
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!, lines[i + 1])) {
      para.push(lines[i]!.trim());
      i++;
    }
    out.push({ t: "p", c: parseInline(para.join("\n"), depth) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const isAlnum = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

/** Procura o fechamento de um delimitador de ênfase a partir de `from`. */
function findClose(s: string, delim: string, from: number): number {
  let k = from;
  while ((k = s.indexOf(delim, k)) !== -1) {
    const before = s[k - 1];
    const after = s[k + delim.length];
    const okBefore = !isSpace(before);
    // "_" e "__" não fecham no meio de palavra (snake_case)
    const okWord = delim[0] !== "_" || !isAlnum(after);
    // "*" simples não fecha num "**"
    const okSingle = delim.length > 1 || (s[k + 1] !== delim && s[k - 1] !== delim) || k === from;
    if (okBefore && okWord && okSingle && k > from) return k;
    k += delim.length;
  }
  return -1;
}

function parseInline(s: string, depth: number): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  const nested = (inner: string) => (depth < MAX_DEPTH ? parseInline(inner, depth + 1) : [{ t: "text" as const, v: inner }]);

  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;

    if (ch === "\\" && PUNCT.test(s[i + 1] ?? "")) {
      text += s[i + 1];
      i += 2;
      continue;
    }

    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }

    if (ch === "`") {
      const run = s.slice(i).match(/^`+/)![0];
      const end = s.indexOf(run, i + run.length);
      if (end !== -1) {
        flush();
        out.push({ t: "code", v: s.slice(i + run.length, end).replace(/^ (.+) $/, "$1") });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }

    // Link [texto](url) e imagem ![alt](url) → link
    if (ch === "[" || (ch === "!" && s[i + 1] === "[")) {
      const open = ch === "!" ? i + 1 : i;
      const m = s.slice(open).match(/^\[([^\]\n]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/);
      if (m) {
        const href = safeHref(m[2]!);
        const label = m[1] || m[2]!;
        flush();
        if (href) out.push({ t: "link", href, c: nested(label) });
        else out.push(...nested(label)); // URL insegura: mantém só o texto
        i = open + m[0].length;
        continue;
      }
    }

    // URL solta
    if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(s.slice(i, i + 8)) && !isAlnum(s[i - 1])) {
      const m = s.slice(i).match(/^https?:\/\/[^\s<>"'`]+/i);
      const url = m ? m[0].replace(/[.,;:!?)\]]+$/, "") : "";
      const href = url ? safeHref(url) : null;
      if (href) {
        flush();
        out.push({ t: "link", href, c: [{ t: "text", v: url }] });
        i += url.length;
        continue;
      }
    }

    // Ênfase: ***, **, __, ~~, *, _
    if (ch === "*" || ch === "_" || (ch === "~" && s[i + 1] === "~")) {
      const triple = s.slice(i, i + 3);
      const double = s.slice(i, i + 2);
      const canOpen = !isSpace(s[i + 1 + (double === ch + ch ? 1 : 0)]) && (ch !== "_" || !isAlnum(s[i - 1]));

      if (canOpen) {
        if (ch !== "~" && triple === ch.repeat(3)) {
          const end = findClose(s, triple, i + 3);
          if (end !== -1) {
            flush();
            out.push({ t: "strong", c: [{ t: "em", c: nested(s.slice(i + 3, end)) }] });
            i = end + 3;
            continue;
          }
        }
        if (double === ch + ch) {
          const end = findClose(s, double, i + 2);
          if (end !== -1) {
            flush();
            out.push(ch === "~" ? { t: "del", c: nested(s.slice(i + 2, end)) } : { t: "strong", c: nested(s.slice(i + 2, end)) });
            i = end + 2;
            continue;
          }
        } else if (ch !== "~") {
          const end = findClose(s, ch, i + 1);
          if (end !== -1) {
            flush();
            out.push({ t: "em", c: nested(s.slice(i + 1, end)) });
            i = end + 1;
            continue;
          }
        }
      }
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

/** Converte Markdown em árvore de blocos. */
export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, "\n").split("\n"), 0);
}

/**
 * Renderiza a árvore produzida por parseMarkdown como elementos React.
 * Nunca usa dangerouslySetInnerHTML: todo texto é escapado pelo React.
 */
import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "../markdown/parse.ts";
import { splitCitations } from "../sources/model.ts";

/**
 * Marcadores de fonte [Q1]/[N1] no texto. Só os presentes em `valid` (fontes recebidas nesta
 * resposta) viram botão; os demais aparecem sinalizados como sem fonte correspondente.
 */
export interface CitationOptions {
  valid: ReadonlySet<string>;
  describe?: (ref: string) => string;
  onSelect?: (ref: string) => void;
}

const CitationContext = createContext<CitationOptions | null>(null);

function Citations({ text }: { text: string }) {
  const opts = useContext(CitationContext);
  if (!opts) return <>{text}</>;
  return (
    <>
      {splitCitations(text, opts.valid).map((seg, i) =>
        seg.t === "text" ? (
          seg.v
        ) : seg.valid ? (
          <button
            key={i}
            type="button"
            className={`gia-cite gia-cite--${seg.ref[0] === "Q" ? "qdrant" : "neo4j"}`}
            title={opts.describe?.(seg.ref) ?? `Fonte ${seg.ref}`}
            onClick={() => opts.onSelect?.(seg.ref)}
          >
            {seg.ref}
          </button>
        ) : (
          <span key={i} className="gia-cite gia-cite--unknown" title="Marcador sem fonte correspondente nesta resposta">
            [{seg.ref}]
          </span>
        ),
      )}
    </>
  );
}

function renderInline(nodes: Inline[], inLink = false): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return inLink ? n.v : <Citations key={i} text={n.v} />;
      case "br":
        return <br key={i} />;
      case "code":
        return <code key={i}>{n.v}</code>;
      case "strong":
        return <strong key={i}>{renderInline(n.c, inLink)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.c, inLink)}</em>;
      case "del":
        return <del key={i}>{renderInline(n.c, inLink)}</del>;
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
            {renderInline(n.c, true)}
          </a>
        );
    }
  });
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.t) {
      case "p":
        return <p key={i}>{renderInline(b.c)}</p>;
      case "h": {
        const Tag = `h${Math.min(b.level + 2, 6)}` as "h3" | "h4" | "h5" | "h6"; // títulos menores dentro do balão
        return <Tag key={i}>{renderInline(b.c)}</Tag>;
      }
      case "code":
        return (
          <pre key={i} data-lang={b.lang || undefined}>
            <code>{b.v}</code>
          </pre>
        );
      case "list": {
        const items = b.items.map((it, k) => <li key={k}>{renderBlocks(it)}</li>);
        return b.ordered ? (
          <ol key={i} start={b.start !== 1 ? b.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      }
      case "quote":
        return <blockquote key={i}>{renderBlocks(b.c)}</blockquote>;
      case "hr":
        return <hr key={i} />;
      case "table":
        return (
          <div key={i} className="gia-table-wrap">
            <table>
              <thead>
                <tr>
                  {b.head.map((h, k) => (
                    <th key={k} style={b.align[k] ? { textAlign: b.align[k]! } : undefined}>
                      {renderInline(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((c, k) => (
                      <td key={k} style={b.align[k] ? { textAlign: b.align[k]! } : undefined}>
                        {renderInline(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export const Markdown = memo(function Markdown({ text, citations }: { text: string; citations?: CitationOptions | null }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <CitationContext.Provider value={citations ?? null}>
      <div className="gia-md">{renderBlocks(blocks)}</div>
    </CitationContext.Provider>
  );
});

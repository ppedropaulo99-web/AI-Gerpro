/**
 * Fontes recuperadas de uma resposta: bloco compacto e recolhido sob a mensagem.
 * Exibe só o que o backend enviou (rótulo, título, identificadores, trecho, link http/https).
 * Fontes recebidas são "consultadas"; as citadas no texto são destacadas como "citada".
 */
import { useEffect, useRef } from "react";
import type { SourceSummary } from "../api/types.ts";
import { ORIGIN_LABEL, clip, formatScore, identifiersLine, safeSourceUrl } from "../sources/model.ts";

export interface SourceListProps {
  /** Prefixo único por mensagem, para ids dos elementos. */
  idPrefix: string;
  sources: SourceSummary[];
  cited: string[];
  unknown: string[];
  /** Marcador selecionado no texto (n muda a cada clique): abre e destaca a fonte. */
  selected: { ref: string; n: number } | null;
}

export function SourceList({ idPrefix, sources, cited, unknown, selected }: SourceListProps) {
  const outer = useRef<HTMLDetailsElement | null>(null);
  const items = useRef(new Map<string, HTMLDetailsElement>());

  useEffect(() => {
    if (!selected) return;
    const item = items.current.get(selected.ref);
    if (!outer.current || !item) return;
    outer.current.open = true;
    item.open = true;
    item.scrollIntoView?.({ block: "nearest" });
    item.querySelector("summary")?.focus();
  }, [selected?.ref, selected?.n]);

  if (sources.length === 0 && unknown.length === 0) return null;
  const citedSet = new Set(cited);

  return (
    <div className="gia-sources-wrap">
      {unknown.length > 0 && (
        <p className="gia-sources-warn" role="note">
          A resposta menciona {unknown.map((r) => `[${r}]`).join(", ")} sem fonte correspondente. Desconsidere essa
          referência.
        </p>
      )}
      {sources.length > 0 && (
        <details className="gia-sources" ref={outer}>
          <summary>
            Fontes consultadas ({sources.length})
            {cited.length > 0 && <span className="gia-sources-count"> · {cited.length} citada{cited.length > 1 ? "s" : ""}</span>}
          </summary>
          <ol className="gia-sources-list">
            {sources.map((s) => {
              const origin = ORIGIN_LABEL[s.origin];
              const url = safeSourceUrl(s.url);
              const score = formatScore(s.score);
              const ids = identifiersLine(s.identifiers);
              const title = clip(s.title, 90);
              return (
                <li key={s.ref} id={`${idPrefix}-${s.ref}`}>
                  <details
                    className={`gia-source gia-source--${s.origin}${selected?.ref === s.ref ? " gia-source--selected" : ""}`}
                    ref={(el) => {
                      if (el) items.current.set(s.ref, el);
                      else items.current.delete(s.ref);
                    }}
                  >
                    <summary>
                      <span className={`gia-cite gia-cite--${s.origin}`} aria-hidden="true">
                        {s.ref}
                      </span>
                      <span className="gia-source-head">
                        <span className="gia-source-kind">{origin.short}</span>
                        <span className="gia-source-label">{clip(s.label, 50)}</span>
                        {title && <span className="gia-source-title">{title}</span>}
                      </span>
                      {citedSet.has(s.ref) && <span className="gia-source-flag">citada</span>}
                    </summary>
                    <dl className="gia-source-details">
                      <dt>Origem</dt>
                      <dd>{origin.long}</dd>
                      {ids && (
                        <>
                          <dt>Identificadores</dt>
                          <dd>{ids}</dd>
                        </>
                      )}
                      {s.linkedFrom && (
                        <>
                          <dt>Vínculo</dt>
                          <dd>
                            por {clip(s.linkedFrom.field, 24)} = {clip(s.linkedFrom.value, 40)}
                          </dd>
                        </>
                      )}
                      {score && (
                        <>
                          <dt>Similaridade</dt>
                          <dd>{score}</dd>
                        </>
                      )}
                      <dt>Referência</dt>
                      <dd className="gia-source-id">{clip(s.id, 120)}</dd>
                      {s.excerpt && (
                        <>
                          <dt>Trecho</dt>
                          <dd className="gia-source-excerpt">{clip(s.excerpt, 320)}</dd>
                        </>
                      )}
                    </dl>
                    {url && (
                      <a className="gia-source-link" href={url} target="_blank" rel="noopener noreferrer nofollow">
                        Abrir na origem
                      </a>
                    )}
                  </details>
                </li>
              );
            })}
          </ol>
        </details>
      )}
    </div>
  );
}

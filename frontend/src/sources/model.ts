/**
 * Lógica de apresentação das fontes (sem React, testável no Node).
 *
 * Princípios:
 * - Só mostra o que o backend enviou: nenhum título, URL ou identificador é inventado.
 * - Um marcador [Q1]/[N1] só é exibido como fonte se corresponder a uma fonte recebida NESTA
 *   resposta; caso contrário é sinalizado como "sem fonte correspondente".
 * - Textos vindos das bases são dados não confiáveis: renderizados como texto (o React escapa)
 *   e encurtados; links só http/https.
 */
import type { Grounding, ResolutionSummary, SourceSummary } from "../api/types.ts";

export type CitationSegment = { t: "text"; v: string } | { t: "cite"; ref: string; valid: boolean };

/** Aceita espaços internos ("[ N1 ]"), que o modelo às vezes gera. */
const MARKER = /\[ ?([QN]\d{1,3}) ?\]/g;

/** Divide um texto em trechos normais e marcadores de citação. */
export function splitCitations(text: string, validRefs: ReadonlySet<string>): CitationSegment[] {
  const out: CitationSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(MARKER)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ t: "text", v: text.slice(last, i) });
    out.push({ t: "cite", ref: m[1]!, valid: validRefs.has(m[1]!) });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

/** Marcadores citados na resposta, separados em válidos (na ordem) e sem fonte. */
export function analyzeCitations(answer: string, sources: readonly SourceSummary[]): { cited: string[]; unknown: string[] } {
  const refs = new Set(sources.map((s) => s.ref));
  const all = [...new Set([...answer.matchAll(MARKER)].map((m) => m[1]!))];
  return { cited: all.filter((r) => refs.has(r)), unknown: all.filter((r) => !refs.has(r)) };
}

/** Aceita só URLs http(s) absolutas, sem espaços nem caracteres de controle. */
export function safeSourceUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const u = url.trim();
  if (!/^https?:\/\/[^\s/]/i.test(u) || /[\u0000-\u001f\u007f\s]/.test(u)) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Encurta textos vindos das bases (rótulos, títulos, identificadores) para o painel. */
export function clip(text: string | null | undefined, max = 80): string {
  if (!text) return "";
  const t = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export const ORIGIN_LABEL: Record<SourceSummary["origin"], { short: string; long: string }> = {
  qdrant: { short: "Documento", long: "Busca semântica (Qdrant)" },
  neo4j: { short: "Registro", long: "Grafo de relacionamentos (Neo4j)" },
};

/** Similaridade em porcentagem, só para fontes do Qdrant. */
export function formatScore(score: number | null): string | null {
  return typeof score === "number" && Number.isFinite(score) ? `${Math.round(score * 100)}%` : null;
}

/** Aviso curto sobre a fundamentação quando NÃO há fontes. null = nada a mostrar. */
export function groundingNote(grounding: Grounding | undefined): string | null {
  switch (grounding) {
    case "no_sources":
      return "Nenhuma fonte do Gerpro foi encontrada para esta pergunta.";
    case "unavailable":
      return "As bases do Gerpro não responderam; esta resposta não usa fontes.";
    case "unauthorized":
      return "Sem acesso autorizado às bases do Gerpro nesta sessão.";
    default:
      return null;
  }
}

/** Nota sobre a pergunta de continuação: qual identificador (digitado antes pelo usuário) foi usado. */
export function resolutionNote(resolution: ResolutionSummary | undefined): string | null {
  if (resolution?.kind !== "contextual" || resolution.values.length === 0) return null;
  return `Considerando ${resolution.values.map((v) => clip(v, 40)).join(", ")}, mencionado antes na conversa.`;
}

/** Linha de identificadores seguros (já vindos do backend), encurtada. */
export function identifiersLine(ids: Record<string, string>, maxItems = 4): string {
  return Object.entries(ids)
    .slice(0, maxItems)
    .map(([k, v]) => `${clip(k, 24)}: ${clip(v, 40)}`)
    .join(" · ");
}

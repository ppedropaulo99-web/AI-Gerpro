/**
 * Contratos HTTP do backend, espelhados de backend/src/contracts/api.ts.
 * Mantidos em sincronia manual nesta etapa.
 */

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatResponse {
  message: { role: "assistant"; content: string };
  model: string;
  durationMs: number;
  usage: { promptTokens: number | null; completionTokens: number | null };
  /** Ausentes em backends anteriores à Etapa 3.1. */
  grounding?: Grounding;
  sources?: SourceSummary[];
  citations?: CitationCheck;
  resolution?: ResolutionSummary;
}

/** Fundamentação da resposta: "disabled" = sem bases configuradas (só o modelo). */
export type Grounding = "sources" | "no_sources" | "unavailable" | "unauthorized" | "disabled" | "ambiguous";

/** Identificadores digitados pelo usuário que ligaram a pergunta às bases (nunca vêm do modelo). */
export interface ResolutionSummary {
  kind: "none" | "explicit" | "contextual" | "ambiguous";
  values: string[];
}

export interface SourceSummary {
  /** Marcador citável na resposta (Q = Qdrant, N = Neo4j). */
  ref: string;
  id: string;
  origin: "qdrant" | "neo4j";
  score: number | null;
  label: string;
  title: string | null;
  url: string | null;
  identifiers: Record<string, string>;
  excerpt: string;
  linkedFrom: { sourceId: string; field: string; value: string } | null;
}

export interface CitationCheck {
  valid: string[];
  unknown: string[];
}

export interface ErrorResponse {
  error: { code: string; message: string };
}

/** Eventos NDJSON de POST /api/chat/stream. "thinking" indica só a fase; o raciocínio não é enviado. */
export type ChatStreamEvent =
  | { type: "start"; model: string }
  | { type: "sources"; grounding: Grounding; sources: SourceSummary[]; resolution?: ResolutionSummary }
  | { type: "thinking" }
  | { type: "delta"; content: string }
  | {
      type: "done";
      model: string;
      durationMs: number;
      usage: ChatResponse["usage"];
      grounding?: Grounding;
      citations?: CitationCheck;
    }
  | { type: "error"; error: ErrorResponse["error"] };

export interface OllamaHealthResponse {
  status: "ok" | "degraded" | "unavailable";
  reachable: boolean;
  modelAvailable: boolean;
  model: string;
  availableModels: string[];
  version: string | null;
  latencyMs: number;
  error: string | null;
}

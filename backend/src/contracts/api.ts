/**
 * Contratos HTTP públicos do backend (consumidos pelo componente de chat).
 * Mantidos em sincronia manual com frontend/src/api/types.ts.
 */

export type ClientChatRole = "user" | "assistant";

export interface ClientChatMessage {
  role: ClientChatRole;
  content: string;
}

export interface ChatRequest {
  /** Histórico da conversa; a última mensagem deve ser do usuário. */
  messages: ClientChatMessage[];
}

export interface ChatResponse {
  message: { role: "assistant"; content: string };
  model: string;
  /** Tempo total medido pelo backend (ms). */
  durationMs: number;
  usage: { promptTokens: number | null; completionTokens: number | null };
  /** Fundamentação da resposta (ver Grounding). */
  grounding: Grounding;
  /** Fontes entregues ao modelo (vazio se a recuperação estiver desativada ou sem resultados). */
  sources: SourceSummary[];
  /** Marcadores [Q1]/[N1] citados na resposta: válidos e desconhecidos (possível invenção). */
  citations: CitationCheck;
  /** Presente quando a recuperação está configurada. */
  resolution?: ResolutionSummary;
}

/**
 * - "disabled": Qdrant/Neo4j não configurados — resposta só do modelo (conhecimento geral).
 * - "unauthorized": sem contexto de autorização do Gerpro — nenhuma base foi consultada.
 * - "unavailable": as bases falharam ou não responderam a tempo.
 * - "no_sources": consultadas, sem resultados relevantes.
 * - "sources": há fontes recuperadas no contexto.
 * - "ambiguous": a pergunta de continuação pode se referir a mais de um identificador; o backend
 *   responde pedindo esclarecimento, sem consultar as bases nem o modelo.
 */
export type Grounding = "sources" | "no_sources" | "unavailable" | "unauthorized" | "disabled" | "ambiguous";

/**
 * Como a pergunta foi ligada a identificadores. Os valores são apenas os digitados pelo próprio
 * usuário (pergunta atual ou anteriores); nunca vêm de respostas do modelo.
 */
export interface ResolutionSummary {
  kind: "none" | "explicit" | "contextual" | "ambiguous";
  values: string[];
}

export interface SourceSummary {
  /** Marcador citável na resposta (Q = Qdrant, N = Neo4j). */
  ref: string;
  /** Identificador global: "qdrant:<coleção>:<id>" ou "neo4j:<consulta>:<id>". */
  id: string;
  origin: "qdrant" | "neo4j";
  score: number | null;
  label: string;
  title: string | null;
  url: string | null;
  identifiers: Record<string, string>;
  /** Início do trecho (até 300 caracteres). */
  excerpt: string;
  linkedFrom: { sourceId: string; field: string; value: string } | null;
}

export interface CitationCheck {
  valid: string[];
  unknown: string[];
}

/**
 * POST /api/chat/stream → corpo `application/x-ndjson`: um evento JSON por linha.
 * Ordem: start → sources? → thinking? → delta* → (done | error). "sources" só é enviado
 * quando a recuperação está configurada; clientes antigos podem ignorá-lo. O raciocínio nunca é enviado;
 * "thinking" indica apenas que o modelo está processando.
 */
export type ChatStreamEvent =
  | { type: "start"; model: string }
  | { type: "sources"; grounding: Grounding; sources: SourceSummary[]; resolution: ResolutionSummary }
  | { type: "thinking" }
  | { type: "delta"; content: string }
  | {
      type: "done";
      model: string;
      durationMs: number;
      usage: ChatResponse["usage"];
      grounding: Grounding;
      citations: CitationCheck;
    }
  | { type: "error"; error: ErrorResponse["error"] };

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "llm_timeout"
  | "llm_unavailable"
  | "llm_upstream_error"
  | "llm_invalid_response"
  | "internal_error";

export interface ErrorResponse {
  error: { code: ErrorCode; message: string };
}

export interface AdapterStatus {
  configured: boolean;
  reachable: boolean;
  detail: string;
}

/**
 * GET /api/health — PÚBLICO e mínimo: não consulta bases nem o Ollama e não revela
 * ambiente, URLs, versões de servidores, coleções ou modo de autenticação.
 * `chat` informa os limites aceitos, para o widget nunca enviar mais do que o backend aceita.
 */
export interface PublicHealthResponse {
  status: "ok";
  service: string;
  version: string;
  timestamp: string;
  chat: { maxMessages: number; maxCharsPerMessage: number };
}

/**
 * GET /api/health/ollama — PÚBLICO e mínimo (usado pelo selo do widget). Sem URLs, portas,
 * versão do Ollama, lista de modelos ou mensagens técnicas. Resultado reaproveitado por alguns
 * segundos para que chamadas anônimas repetidas não sobrecarreguem o serviço de IA.
 */
export interface OllamaHealthResponse {
  status: "ok" | "degraded" | "unavailable";
  model: string;
  latencyMs: number;
}

/**
 * GET /api/health/details — DIAGNÓSTICO INTERNO (token administrativo ou loopback sem proxy).
 * Consulta Qdrant, Neo4j, embeddings e Ollama a cada chamada. Nunca inclui segredos.
 */
export interface DiagnosticsResponse {
  status: "ok";
  service: string;
  version: string;
  /** Identificação técnica do ambiente (ex.: "demo"). */
  environment: string;
  /** Regras de ambiente corporativo ativas (APP_ENV fora de demo/dev/local/test). */
  strict: boolean;
  chatRequiresAuth: boolean;
  uptimeSec: number;
  timestamp: string;
  ollama: OllamaDiagnostics;
  adapters: { vectorStore: AdapterStatus; graphStore: AdapterStatus; embeddings: AdapterStatus };
  retrieval: {
    /** Há conector utilizável (Qdrant + embeddings, ou Neo4j com consultas mapeadas). */
    enabled: boolean;
    /**
     * Modo contextual obrigatório (RETRIEVAL_REQUIRE_SOURCES): sem fontes, resposta fixa e o
     * modelo não é chamado. Clientes que exigem essa garantia devem conferir este campo.
     */
    requireSources: boolean;
    /** Integração de identidade com o Gerpro: "none" = nenhuma consulta corporativa. */
    authMode: string;
    collections: number;
    graphQueries: number;
    /** Problemas de configuração detectados (ex.: dimensão do embedding ≠ coleção). */
    warnings: string[];
  };
}

/** Detalhes do Ollama: só no diagnóstico interno (a mensagem de erro pode citar o endereço interno). */
export interface OllamaDiagnostics {
  status: "ok" | "degraded" | "unavailable";
  reachable: boolean;
  modelAvailable: boolean;
  model: string;
  availableModels: string[];
  version: string | null;
  latencyMs: number;
  error: string | null;
}

/**
 * Cliente HTTP do componente de chat. Fala apenas com o backend do AI Gerpro,
 * nunca com o Ollama diretamente. Sem dependência de React.
 */
import type { ChatMessage, ChatResponse, ChatStreamEvent, ErrorResponse, OllamaHealthResponse } from "./types.ts";

export class ApiError extends Error {
  override name = "ApiError";
  readonly status: number | null;
  readonly code: string;

  constructor(status: number | null, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Fornece a credencial de curta duração emitida pelo BACKEND do Gerpro para o usuário logado
 * (enviada como `Authorization: Bearer`). Retorne null quando não houver sessão.
 * O widget nunca guarda o token; a identidade e as permissões são verificadas no servidor.
 */
export type AuthTokenProvider = () => string | null | Promise<string | null>;

export interface ChatApiOptions {
  getAuthToken?: AuthTokenProvider;
}

export interface ChatApi {
  /** Resposta completa de uma vez (sem streaming). */
  sendChat(messages: ChatMessage[], signal?: AbortSignal): Promise<ChatResponse>;
  /**
   * Resposta em streaming. Um evento "error" do servidor é convertido em ApiError lançado
   * pelo iterador; cancelamento via `signal` lança ApiError com code "aborted".
   */
  streamChat(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<Exclude<ChatStreamEvent, { type: "error" }>>;
  getOllamaHealth(signal?: AbortSignal): Promise<OllamaHealthResponse>;
}

function isErrorResponse(data: unknown): data is ErrorResponse {
  const e = (data as ErrorResponse | null)?.error;
  return typeof e?.code === "string" && typeof e?.message === "string";
}

const aborted = () => new ApiError(null, "aborted", "Requisição cancelada.");
const network = () => new ApiError(null, "network_error", "Não foi possível contatar o servidor do assistente.");

export function createChatApi(
  baseUrl = "/api",
  fetchImpl: FetchLike = (i, init) => fetch(i, init),
  options: ChatApiOptions = {},
): ChatApi {
  const root = baseUrl.replace(/\/+$/, "");

  async function authHeaders(): Promise<Record<string, string>> {
    if (!options.getAuthToken) return {};
    let token: string | null;
    try {
      token = await options.getAuthToken();
    } catch {
      throw new ApiError(null, "auth_unavailable", "Não foi possível obter a credencial de acesso do Gerpro.");
    }
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  async function open(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(`${root}${path}`, init);
    } catch {
      throw init.signal?.aborted ? aborted() : network();
    }
  }

  async function errorFrom(res: Response): Promise<ApiError> {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // corpo vazio ou não-JSON
    }
    if (isErrorResponse(data)) return new ApiError(res.status, data.error.code, data.error.message);
    return new ApiError(res.status, "http_error", `Erro HTTP ${res.status} do servidor.`);
  }

  async function call<T>(path: string, init: RequestInit, acceptStatuses: number[] = []): Promise<T> {
    const res = await open(path, init);
    if (!res.ok && !acceptStatuses.includes(res.status)) throw await errorFrom(res);
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // tratado abaixo
    }
    if (data === null) throw new ApiError(res.status, "invalid_response", "Resposta inválida do servidor.");
    return data as T;
  }

  const jsonPost = async (messages: ChatMessage[], signal?: AbortSignal): Promise<RequestInit> => ({
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ messages }),
    ...(signal ? { signal } : {}),
  });

  return {
    async sendChat(messages, signal) {
      return call<ChatResponse>("/chat", await jsonPost(messages, signal));
    },

    async *streamChat(messages, signal) {
      const res = await open("/chat/stream", await jsonPost(messages, signal));
      if (!res.ok) throw await errorFrom(res);
      if (!res.body) throw new ApiError(res.status, "invalid_response", "O servidor não enviou o stream.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finished = false;

      const parse = (line: string): ChatStreamEvent => {
        try {
          return JSON.parse(line) as ChatStreamEvent;
        } catch {
          throw new ApiError(res.status, "invalid_response", "Fragmento inválido no stream do servidor.");
        }
      };

      try {
        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            throw signal?.aborted ? aborted() : new ApiError(null, "stream_interrupted", "A conexão com o servidor foi interrompida.");
          }
          if (chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const ev = parse(line);
            if (ev.type === "error") throw new ApiError(res.status, ev.error.code, ev.error.message);
            if (ev.type === "done") finished = true;
            yield ev;
          }
        }
        if (!finished) throw new ApiError(res.status, "stream_interrupted", "A resposta terminou antes de ser concluída.");
      } finally {
        // Ao interromper (break/return/erro), fecha a conexão — o backend cancela a geração no Ollama.
        if (!finished) await reader.cancel().catch(() => {});
      }
    },

    getOllamaHealth(signal) {
      // 503 também traz o corpo de diagnóstico (degradado/indisponível).
      return call<OllamaHealthResponse>("/health/ollama", { method: "GET", ...(signal ? { signal } : {}) }, [503]);
    },
  };
}

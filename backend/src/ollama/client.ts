/**
 * Cliente mínimo para a API HTTP local do Ollama.
 * Usa fetch nativo do Node; sem dependências externas.
 *
 * Garantia: nenhum método deste cliente devolve o raciocínio interno do modelo.
 */
import type { OllamaConfig } from "../config/env.ts";
import { ReasoningStreamFilter, stripReasoning, type ReasoningFilterMode } from "./reasoning.ts";

export { stripReasoning } from "./reasoning.ts";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface LlmUsage {
  /** Duração total reportada pelo Ollama, em ms (se disponível). */
  totalDurationMs: number | null;
  promptTokens: number | null;
  /** Tokens gerados, incluindo os de raciocínio (descartados). */
  completionTokens: number | null;
}

export interface LlmChatResult extends LlmUsage {
  model: string;
  content: string;
}

/**
 * Eventos de streaming. "thinking" sinaliza apenas a FASE (o modelo está raciocinando);
 * nunca carrega o texto do raciocínio.
 */
export type LlmStreamEvent =
  | { type: "thinking" }
  | { type: "content"; text: string }
  | ({ type: "done"; model: string } & LlmUsage);

export interface LlmHealth {
  reachable: boolean;
  modelAvailable: boolean;
  model: string;
  availableModels: string[];
  version: string | null;
  error: string | null;
}

export type LlmErrorKind = "timeout" | "unreachable" | "cancelled" | "upstream" | "invalid_response";

export class LlmError extends Error {
  override name = "LlmError";
  readonly kind: LlmErrorKind;
  readonly upstreamStatus: number | null;

  constructor(kind: LlmErrorKind, message: string, upstreamStatus: number | null = null, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
    this.upstreamStatus = upstreamStatus;
  }
}

/** Contrato usado pelas rotas; permite trocar de provedor ou usar duplo em testes. */
export interface LlmClient {
  readonly model: string;
  health(): Promise<LlmHealth>;
  chat(messages: ChatMessage[], signal?: AbortSignal): Promise<LlmChatResult>;
  /**
   * Abre um stream. Erros de conexão/HTTP são lançados aqui (antes de qualquer evento);
   * erros no meio do stream são lançados pelo iterador.
   */
  openChatStream(messages: ChatMessage[], signal?: AbortSignal): Promise<AsyncIterable<LlmStreamEvent>>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const HEALTH_TIMEOUT_MS = 5_000;
const nsToMs = (ns: unknown): number | null => (typeof ns === "number" ? Math.round(ns / 1e6) : null);
const asNumber = (v: unknown): number | null => (typeof v === "number" ? v : null);

interface OllamaChunk {
  model?: unknown;
  message?: { content?: unknown; thinking?: unknown };
  done?: unknown;
  error?: unknown;
  total_duration?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
}

interface ThinkPlan {
  /** Valor do parâmetro `think` enviado ao Ollama (undefined = omitido). */
  think: boolean | undefined;
  filterMode: ReasoningFilterMode;
}

export class OllamaClient implements LlmClient {
  private readonly config: OllamaConfig;
  private readonly fetchImpl: FetchLike;
  private capabilities: Promise<string[] | null> | null = null;

  constructor(config: OllamaConfig, fetchImpl: FetchLike = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  get model(): string {
    return this.config.model;
  }

  async health(): Promise<LlmHealth> {
    const wanted = this.config.model;
    let tags: unknown;
    try {
      tags = await this.request("/api/tags", { method: "GET" }, HEALTH_TIMEOUT_MS);
    } catch (err) {
      return {
        reachable: false,
        modelAvailable: false,
        model: wanted,
        availableModels: [],
        version: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const rawModels = (tags as { models?: unknown }).models;
    const availableModels = Array.isArray(rawModels)
      ? rawModels.map((m: { name?: unknown }) => m?.name).filter((n): n is string => typeof n === "string")
      : [];

    let version: string | null = null;
    try {
      const v = (await this.request("/api/version", { method: "GET" }, HEALTH_TIMEOUT_MS)) as { version?: unknown };
      version = typeof v.version === "string" ? v.version : null;
    } catch {
      // versão é apenas informativa
    }

    const modelAvailable = availableModels.some((n) => n === wanted || n === `${wanted}:latest`);
    return {
      reachable: true,
      modelAvailable,
      model: wanted,
      availableModels,
      version,
      error: modelAvailable ? null : `Modelo "${wanted}" não encontrado no Ollama (execute: ollama pull ${wanted})`,
    };
  }

  /** Carrega o modelo na memória (sem gerar texto) com as mesmas opções das conversas. */
  async preload(): Promise<void> {
    await this.request(
      "/api/generate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.config.model, ...this.commonParams() }),
      },
      this.config.timeoutMs,
    );
  }

  async chat(messages: ChatMessage[], signal?: AbortSignal): Promise<LlmChatResult> {
    const plan = await this.thinkPlan();
    const data = (await this.request(
      "/api/chat",
      this.chatInit(messages, false, plan),
      this.config.timeoutMs,
      signal,
    )) as OllamaChunk;

    const content = data?.message?.content;
    if (typeof content !== "string") {
      throw new LlmError("invalid_response", "Resposta do Ollama sem conteúdo de mensagem");
    }
    const visible = stripReasoning(content);
    if (visible === "") {
      throw new LlmError("invalid_response", "O modelo retornou uma resposta vazia");
    }
    return {
      model: typeof data.model === "string" ? data.model : this.config.model,
      content: visible,
      ...usageOf(data),
    };
  }

  async openChatStream(messages: ChatMessage[], signal?: AbortSignal): Promise<AsyncIterable<LlmStreamEvent>> {
    const plan = await this.thinkPlan();
    const timeoutMs = this.config.timeoutMs;
    const { res, timeoutSignal } = await this.connect("/api/chat", this.chatInit(messages, true, plan), timeoutMs, signal);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw upstreamError(res.status, text);
    }
    if (!res.body) throw new LlmError("invalid_response", "Ollama não retornou corpo de stream", res.status);

    const body = res.body;
    const fallbackModel = this.config.model;
    const classify = (err: unknown): LlmError => {
      if (err instanceof LlmError) return err;
      if (signal?.aborted) return new LlmError("cancelled", "Requisição cancelada pelo cliente", null, { cause: err });
      if (timeoutSignal.aborted) return new LlmError("timeout", `Ollama não respondeu em ${timeoutMs} ms`, null, { cause: err });
      return new LlmError("invalid_response", "Stream do Ollama interrompido", null, { cause: err });
    };

    return (async function* (): AsyncGenerator<LlmStreamEvent> {
      const filter = new ReasoningStreamFilter(plan.filterMode);
      const decoder = new TextDecoder();
      let buf = "";
      let announcedThinking = false;
      let visibleChars = 0;
      let finished = false;

      function* handle(line: string): Generator<LlmStreamEvent> {
        let chunk: OllamaChunk;
        try {
          chunk = JSON.parse(line) as OllamaChunk;
        } catch (err) {
          throw new LlmError("invalid_response", "Ollama enviou um fragmento JSON inválido", null, { cause: err });
        }
        if (typeof chunk.error === "string") throw new LlmError("upstream", `Ollama: ${chunk.error}`);

        const thinking = chunk.message?.thinking;
        const raw = typeof chunk.message?.content === "string" ? chunk.message.content : "";
        const visible = raw ? filter.push(raw) : "";

        if (!announcedThinking && ((typeof thinking === "string" && thinking) || (raw && filter.suppressing))) {
          announcedThinking = true;
          yield { type: "thinking" };
        }
        if (visible) {
          visibleChars += visible.length;
          yield { type: "content", text: visible };
        }
        if (chunk.done === true) {
          const tail = filter.end();
          if (tail) {
            visibleChars += tail.length;
            yield { type: "content", text: tail };
          }
          if (visibleChars === 0) {
            throw new LlmError("invalid_response", "O modelo retornou uma resposta vazia");
          }
          finished = true;
          yield { type: "done", model: typeof chunk.model === "string" ? chunk.model : fallbackModel, ...usageOf(chunk) };
        }
      }

      try {
        for await (const part of body) {
          buf += decoder.decode(part as Uint8Array, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) yield* handle(line);
            if (finished) return;
          }
        }
        const last = (buf + decoder.decode()).trim();
        if (last) yield* handle(last);
        if (!finished) throw new LlmError("invalid_response", "Stream do Ollama terminou sem conclusão");
      } catch (err) {
        throw classify(err);
      } finally {
        // Se o consumidor parar de ler (ex.: usuário interrompeu), encerra a conexão com o Ollama.
        if (!finished) await body.cancel().catch(() => {});
      }
    })();
  }

  // ---------------------------------------------------------------------------

  /** Decide o parâmetro `think` e o modo do filtro conforme a configuração e o modelo. */
  private async thinkPlan(): Promise<ThinkPlan> {
    const mode = this.config.think;
    if (mode === true) return { think: true, filterMode: "leading-tag" };

    const caps = await this.getCapabilities();
    // Capacidades desconhecidas: assume que o modelo pode raciocinar (opção mais segura).
    const canThink = caps === null || caps.includes("thinking");
    if (mode === "auto") {
      return canThink ? { think: true, filterMode: "leading-tag" } : { think: undefined, filterMode: "leading-tag" };
    }
    return { think: false, filterMode: canThink ? "until-close" : "leading-tag" };
  }

  private getCapabilities(): Promise<string[] | null> {
    if (!this.capabilities) {
      this.capabilities = this.request(
        "/api/show",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: this.config.model }) },
        HEALTH_TIMEOUT_MS,
      )
        .then((d) => {
          const caps = (d as { capabilities?: unknown }).capabilities;
          return Array.isArray(caps) ? caps.filter((c): c is string => typeof c === "string") : null;
        })
        .catch(() => {
          this.capabilities = null; // tenta de novo na próxima chamada
          return null;
        });
    }
    return this.capabilities;
  }

  private commonParams(): Record<string, unknown> {
    const p: Record<string, unknown> = {};
    if (this.config.keepAlive !== null) p["keep_alive"] = this.config.keepAlive;
    if (this.config.numCtx !== null) p["options"] = { num_ctx: this.config.numCtx };
    return p;
  }

  private chatInit(messages: ChatMessage[], stream: boolean, plan: ThinkPlan): RequestInit {
    const body: Record<string, unknown> = { model: this.config.model, messages, stream, ...this.commonParams() };
    if (plan.think !== undefined) body["think"] = plan.think;
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  }

  private async connect(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    external?: AbortSignal,
  ): Promise<{ res: Response; timeoutSignal: AbortSignal }> {
    // Cancelado antes de conectar (ex.: durante a consulta de capacidades): não abre a conexão.
    if (external?.aborted) throw new LlmError("cancelled", "Requisição cancelada pelo cliente");
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = external ? AbortSignal.any([timeoutSignal, external]) : timeoutSignal;
    try {
      const res = await this.fetchImpl(`${this.config.baseUrl}${path}`, { ...init, signal });
      return { res, timeoutSignal };
    } catch (err) {
      if (external?.aborted) throw new LlmError("cancelled", "Requisição cancelada pelo cliente", null, { cause: err });
      if (timeoutSignal.aborted) throw new LlmError("timeout", `Ollama não respondeu em ${timeoutMs} ms`, null, { cause: err });
      throw new LlmError("unreachable", `Não foi possível conectar ao Ollama em ${this.config.baseUrl}`, null, { cause: err });
    }
  }

  private async request(path: string, init: RequestInit, timeoutMs: number, external?: AbortSignal): Promise<unknown> {
    const { res, timeoutSignal } = await this.connect(path, init, timeoutMs, external);

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (external?.aborted) throw new LlmError("cancelled", "Requisição cancelada pelo cliente", null, { cause: err });
      if (timeoutSignal.aborted) throw new LlmError("timeout", `Ollama não respondeu em ${timeoutMs} ms`, null, { cause: err });
      throw new LlmError("invalid_response", "Falha ao ler resposta do Ollama", res.status, { cause: err });
    }

    if (!res.ok) throw upstreamError(res.status, text);

    try {
      return JSON.parse(text);
    } catch (err) {
      throw new LlmError("invalid_response", "Ollama retornou JSON inválido", res.status, { cause: err });
    }
  }
}

function usageOf(d: OllamaChunk): LlmUsage {
  return {
    totalDurationMs: nsToMs(d.total_duration),
    promptTokens: asNumber(d.prompt_eval_count),
    completionTokens: asNumber(d.eval_count),
  };
}

function upstreamError(status: number, text: string): LlmError {
  let detail = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed?.error === "string") detail = parsed.error;
  } catch {
    // corpo não-JSON
  }
  return new LlmError("upstream", `Ollama retornou HTTP ${status}: ${detail}`, status);
}

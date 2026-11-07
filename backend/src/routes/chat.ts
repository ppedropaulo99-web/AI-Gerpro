import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.ts";
import type { ChatRequest, ChatResponse, ChatStreamEvent, Grounding, ResolutionSummary, SourceSummary } from "../contracts/api.ts";
import { LlmError, type ChatMessage, type LlmChatResult, type LlmStreamEvent } from "../ollama/client.ts";
import { SYSTEM_PROMPT } from "../ollama/system-prompt.ts";
import { HttpError, llmErrorToResponse } from "../errors.ts";
import { checkCitations, clarificationText, sanitizeSourceText, type RetrievedSource } from "../retrieval/grounding.ts";

/** Resumo enviado ao navegador: referência e início do trecho (o usuário já é autorizado a vê-lo). */
function summarize(s: RetrievedSource): SourceSummary {
  const text = sanitizeSourceText(s.content);
  return {
    ref: s.ref,
    id: s.id,
    origin: s.origin,
    score: s.score,
    label: s.reference.label,
    title: s.reference.title,
    url: s.reference.url,
    identifiers: s.reference.identifiers,
    excerpt: text.length > 300 ? `${text.slice(0, 300)}…` : text,
    linkedFrom: s.linkedFrom,
  };
}

interface PreparedChat {
  messages: ChatMessage[];
  grounding: Grounding;
  /** Fontes efetivamente entregues ao modelo. */
  included: RetrievedSource[];
  /** null quando a recuperação está desativada. */
  resolution: ResolutionSummary | null;
  /** Resposta determinística do backend (ex.: pedido de esclarecimento); dispensa o modelo. */
  fixedAnswer: string | null;
}

/** Resposta fixa no mesmo formato do LLM (para reaproveitar o fluxo de stream e de /api/chat). */
function fixedResult(model: string, text: string): LlmChatResult {
  return { model, content: text, totalDurationMs: 0, promptTokens: null, completionTokens: null };
}

async function* fixedStream(model: string, text: string): AsyncGenerator<LlmStreamEvent> {
  yield { type: "content", text };
  yield { type: "done", model, totalDurationMs: 0, promptTokens: null, completionTokens: null };
}

export async function chatRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { maxMessages, maxCharsPerMessage } = deps.config.chat;

  const bodySchema = {
    type: "object",
    additionalProperties: false,
    required: ["messages"],
    properties: {
      messages: {
        type: "array",
        minItems: 1,
        maxItems: maxMessages,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["role", "content"],
          properties: {
            role: { type: "string", enum: ["user", "assistant"] },
            content: { type: "string", minLength: 1, maxLength: maxCharsPerMessage },
          },
        },
      },
    },
  } as const;

  /** Validações que o JSON Schema não expressa. */
  function validateMessages(body: ChatRequest): void {
    const { messages } = body;
    if (messages.some((m) => m.content.trim() === "")) {
      throw new HttpError(400, "bad_request", "Mensagens não podem estar em branco");
    }
    if (messages.at(-1)?.role !== "user") {
      throw new HttpError(400, "bad_request", "A última mensagem deve ser do usuário");
    }
  }

  /**
   * Monta o histórico para o modelo: prompt do servidor + conversa + (se a recuperação estiver
   * configurada) o contexto das fontes, inserido logo antes da pergunta atual.
   * O contexto de autorização vem SOMENTE do resolvedor do servidor (cabeçalho verificado),
   * nunca do corpo da requisição — que aceita apenas `messages`.
   */
  async function prepareChat(req: FastifyRequest<{ Body: ChatRequest }>, signal: AbortSignal): Promise<PreparedChat> {
    // Autenticação antes de qualquer trabalho: com CHAT_REQUIRE_AUTH, nada chega à GPU sem
    // AuthContext válido. Credencial inválida → AuthError → 401 (motivo só no log).
    const requireAuth = deps.config.security.requireChatAuth;
    const auth = requireAuth || deps.retrieval.enabled ? await deps.auth.resolve(req.headers) : null;
    if (requireAuth && auth === null) {
      throw new HttpError(401, "unauthorized", "Autenticação necessária para usar o assistente.");
    }

    validateMessages(req.body);
    const history: ChatMessage[] = req.body.messages.map((m) => ({ role: m.role, content: m.content }));
    const system: ChatMessage = { role: "system", content: SYSTEM_PROMPT };
    if (!deps.retrieval.enabled) {
      return { messages: [system, ...history], grounding: "disabled", included: [], resolution: null, fixedAnswer: null };
    }

    const question = history.at(-1)!.content;
    // Turnos anteriores só para resolver referências; o resolvedor usa apenas os do usuário.
    const previous = req.body.messages.slice(0, -1);
    const { result, context } = await deps.retrieval.retrieveForChat(question, auth, signal, previous);
    const { qdrant, neo4j } = result.status;
    // Apenas estados, contagens e tempos: nunca conteúdo recuperado, perguntas ou credenciais.
    req.log.info(
      {
        retrieval: {
          grounding: result.grounding,
          partial: result.partial,
          durationMs: result.durationMs,
          qdrant: { state: qdrant.state, count: qdrant.count, durationMs: qdrant.durationMs },
          neo4j: { state: neo4j.state, count: neo4j.count, durationMs: neo4j.durationMs },
          included: context.included.length,
          truncated: context.truncated,
          // Só o tipo e a quantidade: identificadores podem ser dados do caso.
          resolution: { kind: result.resolution.kind, values: result.resolution.values.length },
        },
      },
      "recuperação",
    );
    const messages: ChatMessage[] = [system, ...history.slice(0, -1)];
    if (context.message) messages.push({ role: "system", content: context.message });
    messages.push(history.at(-1)!);
    return {
      messages,
      grounding: result.grounding,
      included: context.included,
      resolution: result.resolution,
      fixedAnswer: result.grounding === "ambiguous" ? clarificationText(result.resolution.values) : null,
    };
  }

  /** Cancela a chamada ao Ollama se o cliente desconectar antes do fim da resposta. */
  function abortOnDisconnect(reply: FastifyReply): AbortController {
    const controller = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    return controller;
  }

  app.post<{ Body: ChatRequest }>("/api/chat", { schema: { body: bodySchema } }, async (req, reply): Promise<ChatResponse> => {
    const controller = abortOnDisconnect(reply);
    const t0 = performance.now();
    const prepared = await prepareChat(req, controller.signal);
    const result =
      prepared.fixedAnswer !== null
        ? fixedResult(deps.llm.model, prepared.fixedAnswer)
        : await deps.llm.chat(prepared.messages, controller.signal);

    return {
      message: { role: "assistant", content: result.content },
      model: result.model,
      durationMs: Math.round(performance.now() - t0),
      usage: { promptTokens: result.promptTokens, completionTokens: result.completionTokens },
      grounding: prepared.grounding,
      sources: prepared.included.map(summarize),
      citations: checkCitations(result.content, prepared.included),
      ...(prepared.resolution ? { resolution: prepared.resolution } : {}),
    };
  });

  app.post<{ Body: ChatRequest }>("/api/chat/stream", { schema: { body: bodySchema } }, async (req, reply) => {
    const controller = abortOnDisconnect(reply);
    const t0 = performance.now();
    // Recuperação antes do stream: credencial inválida vira HTTP 401; falhas das bases não
    // interrompem a resposta (viram grounding "unavailable").
    const prepared = await prepareChat(req, controller.signal);

    // Erros de conexão/HTTP com o Ollama ocorrem aqui e viram respostas HTTP normais (503/502/504).
    const stream =
      prepared.fixedAnswer !== null
        ? fixedStream(deps.llm.model, prepared.fixedAnswer)
        : await deps.llm.openChatStream(prepared.messages, controller.signal);
    const model = deps.llm.model;
    const log = req.log;

    async function* ndjson(): AsyncGenerator<string> {
      const line = (ev: ChatStreamEvent) => `${JSON.stringify(ev)}\n`;
      yield line({ type: "start", model });
      if (prepared.resolution) {
        yield line({
          type: "sources",
          grounding: prepared.grounding,
          sources: prepared.included.map(summarize),
          resolution: prepared.resolution,
        });
      }
      let answer = "";
      try {
        for await (const ev of stream) {
          if (ev.type === "thinking") yield line({ type: "thinking" });
          else if (ev.type === "content") {
            answer += ev.text;
            yield line({ type: "delta", content: ev.text });
          } else {
            yield line({
              type: "done",
              model: ev.model,
              durationMs: Math.round(performance.now() - t0),
              usage: { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens },
              grounding: prepared.grounding,
              citations: checkCitations(answer, prepared.included),
            });
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return; // cliente já desconectou
        const llmErr = err instanceof LlmError ? err : new LlmError("invalid_response", String(err));
        log.warn({ kind: llmErr.kind, detail: llmErr.message }, "falha durante o stream do LLM");
        yield line({ type: "error", error: llmErrorToResponse(llmErr).error });
      }
    }

    return reply
      .header("content-type", "application/x-ndjson; charset=utf-8")
      .header("cache-control", "no-cache, no-transform")
      .header("x-accel-buffering", "no")
      .send(Readable.from(ndjson(), { objectMode: false }));
  });
}

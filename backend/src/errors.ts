import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { ErrorCode, ErrorResponse } from "./contracts/api.ts";
import { LlmError, type LlmErrorKind } from "./ollama/client.ts";
import { AuthError } from "./auth/context.ts";

export class HttpError extends Error {
  override name = "HttpError";
  readonly statusCode: number;
  readonly code: ErrorCode;

  constructor(statusCode: number, code: ErrorCode, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const LLM_ERROR_MAP: Record<LlmErrorKind, { status: number; code: ErrorCode; message: string }> = {
  timeout: { status: 504, code: "llm_timeout", message: "O modelo demorou demais para responder. Tente novamente." },
  unreachable: { status: 503, code: "llm_unavailable", message: "O serviço de IA local (Ollama) não está acessível." },
  cancelled: { status: 499, code: "bad_request", message: "Requisição cancelada." },
  upstream: { status: 502, code: "llm_upstream_error", message: "O serviço de IA retornou um erro." },
  invalid_response: { status: 502, code: "llm_invalid_response", message: "O serviço de IA retornou uma resposta inválida." },
};

const body = (code: ErrorCode, message: string): ErrorResponse => ({ error: { code, message } });

const MODEL_MISSING_MESSAGE = "O modelo de IA configurado não está disponível no servidor.";

/**
 * Converte um LlmError no status HTTP e no corpo de erro padronizado (também usado no stream).
 * A mensagem enviada ao navegador é SEMPRE genérica: o detalhe técnico (endereço interno do
 * Ollama, corpo de erro do upstream, caminhos de arquivo) fica apenas no log do servidor.
 */
export function llmErrorToResponse(err: LlmError): { status: number; error: ErrorResponse["error"] } {
  const mapped = LLM_ERROR_MAP[err.kind];
  const message = err.kind === "upstream" && err.upstreamStatus === 404 ? MODEL_MISSING_MESSAGE : mapped.message;
  return { status: mapped.status, error: { code: mapped.code, message } };
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof HttpError) {
    void reply.code(err.statusCode).send(body(err.code, err.message));
    return;
  }

  if (err instanceof AuthError) {
    // O motivo exato fica só no log do servidor (não ajuda um atacante a ajustar o token).
    req.log.warn({ reason: err.message }, "credencial do Gerpro rejeitada");
    void reply.code(401).send(body("unauthorized", "Credencial de acesso inválida ou expirada."));
    return;
  }

  if (err instanceof LlmError) {
    req.log.warn({ kind: err.kind, upstreamStatus: err.upstreamStatus, detail: err.message }, "falha na chamada ao LLM");
    const { status, error } = llmErrorToResponse(err);
    void reply.code(status).send({ error });
    return;
  }

  const fe = err as FastifyError;
  if (fe.validation) {
    void reply.code(400).send(body("bad_request", `Requisição inválida: ${fe.message}`));
    return;
  }
  if (typeof fe.statusCode === "number" && fe.statusCode >= 400 && fe.statusCode < 500) {
    void reply.code(fe.statusCode).send(body("bad_request", fe.message));
    return;
  }

  req.log.error({ err }, "erro não tratado");
  void reply.code(500).send(body("internal_error", "Erro interno do servidor."));
}

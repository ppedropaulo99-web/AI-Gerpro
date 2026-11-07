/**
 * Recorte do histórico enviado ao backend.
 *
 * A conversa VISÍVEL no widget fica inteira; o que vai para o backend é só a janela mais recente
 * que cabe nos limites que ele aceita (CHAT_MAX_MESSAGES e CHAT_MAX_CHARS_PER_MESSAGE, informados
 * por GET /api/health). Regras:
 *  - no máximo `maxMessages` mensagens, sempre terminando na pergunta atual;
 *  - a janela começa por uma mensagem do USUÁRIO (nunca por uma resposta solta), preservando os
 *    pares pergunta → resposta;
 *  - mensagens vazias (ex.: resposta interrompida sem texto) não são enviadas;
 *  - mensagens antigas maiores que o limite de caracteres são encurtadas (o backend recusaria).
 */
import type { ChatMessage } from "./types.ts";

export interface ChatLimits {
  maxMessages: number;
  maxCharsPerMessage: number;
}

/** Padrões do backend (usados até /api/health responder ou se ele não responder). */
export const DEFAULT_CHAT_LIMITS: ChatLimits = { maxMessages: 30, maxCharsPerMessage: 8000 };

/** Valida limites recebidos do servidor; valores ausentes ou absurdos caem no padrão. */
export function normalizeLimits(raw: Partial<ChatLimits> | null | undefined): ChatLimits {
  const int = (v: unknown, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : fallback);
  return {
    maxMessages: int(raw?.maxMessages, DEFAULT_CHAT_LIMITS.maxMessages),
    maxCharsPerMessage: int(raw?.maxCharsPerMessage, DEFAULT_CHAT_LIMITS.maxCharsPerMessage),
  };
}

const ELLIPSIS = "…";

function clipContent(content: string, max: number): string {
  if (content.length <= max) return content;
  return max <= ELLIPSIS.length ? content.slice(0, max) : `${content.slice(0, max - ELLIPSIS.length)}${ELLIPSIS}`;
}

/** Monta o histórico da requisição a partir da conversa completa (a última é a pergunta atual). */
export function buildRequestHistory(conversation: readonly ChatMessage[], limits: ChatLimits): ChatMessage[] {
  const max = Math.max(1, Math.floor(limits.maxMessages));
  const nonEmpty = conversation.filter((m) => m.content.trim() !== "");
  let start = Math.max(0, nonEmpty.length - max);
  // Começa por uma pergunta do usuário (a resposta cuja pergunta ficou de fora é descartada).
  while (start < nonEmpty.length - 1 && nonEmpty[start]!.role !== "user") start++;
  return nonEmpty.slice(start).map(({ role, content }) => ({ role, content: clipContent(content, limits.maxCharsPerMessage) }));
}

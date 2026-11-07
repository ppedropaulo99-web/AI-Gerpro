/**
 * Tipos comuns aos conectores de recuperação (Qdrant, Neo4j).
 * Os conectores são SOMENTE LEITURA: nenhum contrato expõe escrita, criação ou exclusão.
 */
import type { AuthContext } from "../auth/context.ts";

export type { AuthContext };

export interface AdapterHealth {
  configured: boolean;
  reachable: boolean;
  /** Mensagem curta, sem URLs, credenciais nem dados. */
  detail: string;
}

export type SourceOrigin = "qdrant" | "neo4j";

/** Referência à origem do registro, para o usuário conferir no Gerpro. */
export interface SourceReference {
  /** Coleção (Qdrant) ou nome da consulta autorizada (Neo4j). */
  container: string;
  /** Rótulo legível configurado no mapeamento. */
  label: string;
  title: string | null;
  url: string | null;
  /** Identificadores explícitos copiados do registro (ex.: documentId, processoId). */
  identifiers: Record<string, string>;
}

/** Registro recuperado, já normalizado. */
export interface RetrievedRecord {
  /** Identificador global estável: "qdrant:<coleção>:<id>" ou "neo4j:<consulta>:<id>". */
  id: string;
  origin: SourceOrigin;
  /** Similaridade (Qdrant); null para o grafo. */
  score: number | null;
  /** Texto que pode ser usado como contexto. Nunca é tratado como instrução. */
  content: string;
  reference: SourceReference;
}

export type AdapterErrorKind =
  | "unavailable"
  | "timeout"
  | "unauthorized"
  | "forbidden_query"
  | "invalid_request"
  | "not_found"
  | "upstream"
  | "cancelled";

/** Erro normalizado dos conectores. A mensagem nunca contém segredos nem dados recuperados. */
export class AdapterError extends Error {
  override name = "AdapterError";
  readonly kind: AdapterErrorKind;
  constructor(kind: AdapterErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Executa `fn` com prazo e cancelamento externo, convertendo-os em AdapterError. */
export async function withDeadline<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  external: AbortSignal | undefined,
  what: string,
): Promise<T> {
  if (external?.aborted) throw new AdapterError("cancelled", `${what}: cancelado`);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => controller.abort();
  external?.addEventListener("abort", onAbort, { once: true });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AdapterError("timeout", `${what}: tempo esgotado (${timeoutMs} ms)`));
    }, timeoutMs);
    controller.signal.addEventListener(
      "abort",
      () => {
        if (external?.aborted) reject(new AdapterError("cancelled", `${what}: cancelado`));
      },
      { once: true },
    );
  });
  try {
    return await Promise.race([fn(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onAbort);
  }
}

/** Converte um valor de payload/propriedade em texto curto e seguro para referência. */
export function toIdentifier(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value.trim().slice(0, 200) : null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  return null;
}

/** Lê um caminho com pontos ("meta.titulo") de um objeto. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

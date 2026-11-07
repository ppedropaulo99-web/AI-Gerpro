/**
 * Contrato do repositório de grafo — SOMENTE LEITURA e SEM CYPHER LIVRE.
 *
 * Só é possível executar consultas pré-autorizadas, identificadas por nome no arquivo de
 * mapeamento, com parâmetros validados. Nem o navegador nem o modelo enviam Cypher.
 */
import { AdapterError, type AdapterHealth, type AuthContext, type RetrievedRecord } from "./types.ts";
import type { GraphQueryMapping, ParamSpec } from "../retrieval/mapping.ts";

export type { AdapterHealth };

export type GraphParamValue = string | number | boolean | string[];

export interface GraphQueryRequest {
  /** Nome da consulta pré-autorizada. */
  query: string;
  params: Record<string, unknown>;
  /** Contexto de autorização confiável (obrigatório). */
  auth: AuthContext;
  limit?: number;
  signal?: AbortSignal;
}

export interface GraphStore {
  readonly kind: string;
  readonly queries: readonly GraphQueryMapping[];
  health(): Promise<AdapterHealth>;
  run(req: GraphQueryRequest): Promise<RetrievedRecord[]>;
  close(): Promise<void>;
}

function checkOne(name: string, spec: ParamSpec, v: unknown): GraphParamValue {
  const fail = (why: string): never => {
    throw new AdapterError("invalid_request", `Parâmetro ${name}: ${why}`);
  };
  switch (spec.type) {
    case "string":
      if (typeof v !== "string") fail("deve ser texto");
      if ((v as string).length > spec.maxLength) fail("longo demais");
      if (spec.pattern && !spec.pattern.test(v as string)) fail("formato inválido");
      return v as string;
    case "integer":
      if (typeof v !== "number" || !Number.isSafeInteger(v)) fail("deve ser inteiro");
      return v as number;
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) fail("deve ser número");
      return v as number;
    case "boolean":
      if (typeof v !== "boolean") fail("deve ser true/false");
      return v as boolean;
    case "string[]":
      if (!Array.isArray(v) || v.length > 100) fail("deve ser lista de textos (até 100)");
      for (const item of v as unknown[]) {
        if (typeof item !== "string" || item.length > spec.maxLength) fail("item inválido");
        if (spec.pattern && !spec.pattern.test(item as string)) fail("item com formato inválido");
      }
      return v as string[];
  }
}

/** Valida os parâmetros contra a especificação: rejeita ausentes, extras e tipos errados. */
export function validateGraphParams(q: GraphQueryMapping, params: Record<string, unknown>): Record<string, GraphParamValue> {
  const out: Record<string, GraphParamValue> = {};
  for (const key of Object.keys(params)) {
    if (!(key in q.params)) throw new AdapterError("invalid_request", `Parâmetro não declarado: ${key}`);
  }
  for (const [name, spec] of Object.entries(q.params)) {
    const v = params[name];
    if (v === undefined || v === null) {
      if (spec.required) throw new AdapterError("invalid_request", `Parâmetro obrigatório ausente: ${name}`);
      continue;
    }
    out[name] = checkOne(name, spec, v);
  }
  return out;
}

export class UnconfiguredGraphStore implements GraphStore {
  readonly kind = "unconfigured";
  readonly queries: readonly GraphQueryMapping[] = [];

  async health(): Promise<AdapterHealth> {
    return { configured: false, reachable: false, detail: "Neo4j não configurado" };
  }
  async run(): Promise<RetrievedRecord[]> {
    throw new AdapterError("unavailable", "Neo4j não configurado");
  }
  async close(): Promise<void> {}
}

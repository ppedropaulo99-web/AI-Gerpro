/**
 * Conector Neo4j (driver oficial neo4j-driver) — SOMENTE LEITURA.
 *
 * Defesa em profundidade:
 *  1. só consultas pré-autorizadas do mapeamento (validadas por cypher-guard ao carregar);
 *  2. parâmetros validados e sempre passados separadamente (nunca interpolados);
 *  3. sessões com defaultAccessMode READ e `executeRead` (o servidor recusa escrita);
 *  4. parâmetros auth_* injetados pelo servidor a partir do AuthContext;
 *  5. LIMIT obrigatório e timeout de transação. Recomenda-se usuário com papel só de leitura.
 */
import neo4j, { type Driver } from "neo4j-driver";
import type { Neo4jConfig } from "../config/env.ts";
import type { GraphQueryMapping } from "../retrieval/mapping.ts";
import { AdapterError, getPath, toIdentifier, withDeadline, type AdapterHealth, type RetrievedRecord } from "./types.ts";
import { validateGraphParams, type GraphQueryRequest, type GraphStore } from "./graph-store.ts";

export type GraphRow = Record<string, unknown>;

/** Executor somente leitura (permite testes com dublês). */
export interface Neo4jReadExecutor {
  verifyConnectivity(): Promise<{ version: string | null }>;
  /** Executa em transação de LEITURA; devolve linhas já normalizadas para tipos JS. */
  read(cypher: string, params: Record<string, unknown>, opts: { timeoutMs: number; metadata: Record<string, string> }): Promise<GraphRow[]>;
  close(): Promise<void>;
}

/** Converte tipos do driver (Integer, Node, temporais...) em valores JSON simples. */
export function normalizeNeo4jValue(v: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (v === null || v === undefined) return null;
  if (neo4j.isInt(v)) return v.inSafeRange() ? v.toNumber() : v.toString();
  if (typeof v === "bigint") return v.toString();
  if (neo4j.isNode(v)) {
    return { ...normalizeNeo4jValue(v.properties, depth + 1) as object, _labels: v.labels, _elementId: v.elementId };
  }
  if (neo4j.isRelationship(v)) {
    return { ...normalizeNeo4jValue(v.properties, depth + 1) as object, _type: v.type, _elementId: v.elementId };
  }
  if (neo4j.isPath(v)) return { _path: v.segments.length };
  if (
    neo4j.isDate(v) || neo4j.isDateTime(v) || neo4j.isLocalDateTime(v) || neo4j.isLocalTime(v) ||
    neo4j.isTime(v) || neo4j.isDuration(v) || neo4j.isPoint(v)
  ) {
    return String(v);
  }
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => normalizeNeo4jValue(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = normalizeNeo4jValue(x, depth + 1);
    return out;
  }
  return v;
}

/** Converte números inteiros em Integer do Neo4j (LIMIT e comparações com propriedades inteiras). */
function toDriverParams(params: Record<string, unknown>, integerKeys: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) out[k] = integerKeys.has(k) && typeof v === "number" ? neo4j.int(v) : v;
  return out;
}

export function createNeo4jExecutor(cfg: Neo4jConfig): Neo4jReadExecutor {
  const auth = cfg.user !== null && cfg.password !== null ? neo4j.auth.basic(cfg.user, cfg.password) : undefined;
  const driver: Driver = neo4j.driver(cfg.uri, auth, {
    maxConnectionPoolSize: cfg.maxPoolSize,
    connectionTimeout: cfg.timeoutMs,
    connectionAcquisitionTimeout: cfg.timeoutMs,
    userAgent: "ai-gerpro/0.1",
  });
  const sessionOpts = {
    defaultAccessMode: neo4j.session.READ,
    ...(cfg.database ? { database: cfg.database } : {}),
  };
  return {
    async verifyConnectivity() {
      const info = await driver.getServerInfo(cfg.database ? { database: cfg.database } : {});
      return { version: info.agent ?? null };
    },
    async read(cypher, params, opts) {
      const session = driver.session(sessionOpts);
      try {
        const result = await session.executeRead((tx) => tx.run(cypher, params), {
          timeout: opts.timeoutMs,
          metadata: opts.metadata,
        });
        return result.records.map((r) => {
          const row: GraphRow = {};
          for (const key of r.keys) row[String(key)] = normalizeNeo4jValue(r.get(key));
          return row;
        });
      } finally {
        await session.close();
      }
    },
    close: () => driver.close(),
  };
}

/** Converte erros do driver em AdapterError sem repassar a mensagem bruta. */
export function mapNeo4jError(err: unknown): AdapterError {
  if (err instanceof AdapterError) return err;
  const code = String((err as { code?: unknown })?.code ?? "");
  if (code === "ServiceUnavailable" || code === "SessionExpired") return new AdapterError("unavailable", "Neo4j inacessível");
  if (code.startsWith("Neo.ClientError.Security.Unauthorized") || code.includes("AuthenticationRateLimit") || code.includes("CredentialsExpired")) {
    return new AdapterError("unauthorized", "Neo4j recusou a credencial");
  }
  if (code.includes("TransactionTimedOut") || code.includes("Timeout")) return new AdapterError("timeout", "Neo4j: tempo esgotado");
  if (code.includes("AccessMode") || code.includes("Security.Forbidden")) {
    return new AdapterError("forbidden_query", "Neo4j recusou a operação (somente leitura)");
  }
  if (code.includes("DatabaseNotFound")) return new AdapterError("not_found", "Neo4j: banco de dados não encontrado");
  if (code.startsWith("Neo.ClientError.Statement")) return new AdapterError("invalid_request", `Neo4j recusou a consulta (${code})`);
  if (code) return new AdapterError("upstream", `Neo4j: erro ${code}`);
  return new AdapterError("unavailable", "Neo4j inacessível");
}

function valueToText(v: unknown, max = 2_000): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export class Neo4jGraphStore implements GraphStore {
  readonly kind = "neo4j";
  readonly queries: readonly GraphQueryMapping[];
  readonly #exec: Neo4jReadExecutor;
  readonly #timeoutMs: number;

  constructor(exec: Neo4jReadExecutor, queries: readonly GraphQueryMapping[], timeoutMs: number) {
    this.#exec = exec;
    this.queries = queries;
    this.#timeoutMs = timeoutMs;
  }

  async run(req: GraphQueryRequest): Promise<RetrievedRecord[]> {
    const q = this.queries.find((x) => x.name === req.query);
    if (!q) throw new AdapterError("forbidden_query", `Consulta não autorizada: ${req.query}`);
    if (q.requiredPermission && !req.auth.permissions.includes(q.requiredPermission)) {
      throw new AdapterError("unauthorized", `Sem permissão para a consulta ${q.label}`);
    }
    const params = validateGraphParams(q, req.params);
    const limit = Math.min(Math.max(1, req.limit ?? q.maxRows), q.maxRows);
    const integerKeys = new Set(["limit", ...Object.entries(q.params).filter(([, s]) => s.type === "integer").map(([k]) => k)]);
    const driverParams = toDriverParams(
      {
        ...params,
        limit,
        auth_userId: req.auth.userId,
        auth_organizationId: req.auth.organizationId,
        auth_permissions: req.auth.permissions,
      },
      integerKeys,
    );

    let rows: GraphRow[];
    try {
      rows = await withDeadline(
        () =>
          this.#exec.read(q.cypher, driverParams, {
            timeoutMs: this.#timeoutMs,
            // Metadados de auditoria visíveis em SHOW TRANSACTIONS / query.log do Neo4j.
            metadata: { app: "ai-gerpro", query: q.name, userId: req.auth.userId, organizationId: req.auth.organizationId },
          }),
        this.#timeoutMs + 500,
        req.signal,
        "Neo4j",
      );
    } catch (err) {
      throw mapNeo4jError(err);
    }

    const out: RetrievedRecord[] = [];
    for (const row of rows.slice(0, limit)) {
      const entityId = toIdentifier(getPath(row, q.idField));
      if (entityId === null) continue; // sem identificador confiável → não vira fonte
      const lines = q.contentFields
        .map((f) => [f, valueToText(getPath(row, f))] as const)
        .filter(([, text]) => text.trim() !== "")
        .map(([f, text]) => `${f}: ${text}`);
      if (lines.length === 0) continue;
      const identifiers: Record<string, string> = { [q.idField]: entityId };
      for (const f of q.identifierFields) {
        const v = toIdentifier(getPath(row, f));
        if (v !== null) identifiers[f] = v;
      }
      const url = q.urlField ? toIdentifier(getPath(row, q.urlField)) : null;
      out.push({
        id: `neo4j:${q.name}:${entityId}`,
        origin: "neo4j",
        score: null,
        content: lines.join("\n"),
        reference: {
          container: q.name,
          label: q.label,
          title: q.titleField ? toIdentifier(getPath(row, q.titleField)) : null,
          url: url && /^https?:\/\//i.test(url) ? url : null,
          identifiers,
        },
      });
    }
    return out;
  }

  async health(): Promise<AdapterHealth> {
    try {
      const info = await withDeadline(() => this.#exec.verifyConnectivity(), this.#timeoutMs, undefined, "Neo4j");
      return {
        configured: true,
        reachable: true,
        detail: `${info.version ?? "Neo4j"}; ${this.queries.length} consulta(s) autorizada(s)`,
      };
    } catch (err) {
      return { configured: true, reachable: false, detail: mapNeo4jError(err).message };
    }
  }

  async close(): Promise<void> {
    await this.#exec.close();
  }
}

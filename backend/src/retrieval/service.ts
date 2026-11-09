/**
 * Orquestração da recuperação: consulta Qdrant e Neo4j de forma INDEPENDENTE e em paralelo,
 * combina resultados preservando identificadores e origem, aplica limites e trata falhas
 * parciais. Nenhuma consulta corporativa é feita sem AuthContext confiável.
 *
 * Relações entre registros: só são criadas por `links` declarados no mapeamento, usando um
 * identificador explícito presente no payload do Qdrant. Nada é inferido por similaridade.
 */
import type { RetrievalConfig } from "../config/env.ts";
import { AdapterError, withDeadline, type AuthContext, type RetrievedRecord } from "../adapters/types.ts";
import type { VectorStore } from "../adapters/vector-store.ts";
import type { GraphStore } from "../adapters/graph-store.ts";
import type { EmbeddingProvider } from "../embeddings/provider.ts";
import type { RetrievalMapping } from "./mapping.ts";
import { prepareContext, type Grounding, type PreparedContext, type RetrievedSource } from "./grounding.ts";
import { resolveReferences, type ConversationTurn, type GraphRun, type ReferenceResolution } from "./context-resolver.ts";

export type { ConversationTurn };

/** Resumo da resolução de referências (valores digitados pelo próprio usuário). */
export interface ResolutionSummary {
  kind: ReferenceResolution["kind"];
  values: string[];
}

export type ConnectorState = "ok" | "empty" | "skipped" | "error" | "timeout" | "unauthorized" | "disabled";

export interface ConnectorStatus {
  state: ConnectorState;
  /** Mensagem curta, sem segredos nem conteúdo recuperado. */
  detail: string;
  count: number;
  durationMs: number;
}

export interface RetrievalResult {
  grounding: Grounding;
  sources: RetrievedSource[];
  status: { qdrant: ConnectorStatus; neo4j: ConnectorStatus };
  /** Houve falha em um conector, mas o outro trouxe resultados. */
  partial: boolean;
  durationMs: number;
  /** Como a pergunta foi ligada a identificadores (explícitos, do contexto ou ambíguos). */
  resolution: ResolutionSummary;
}

export interface RetrievalLogger {
  warn(obj: object, msg: string): void;
}

export interface RetrievalServiceDeps {
  vectorStore: VectorStore;
  graphStore: GraphStore;
  embeddings: EmbeddingProvider | null;
  mapping: RetrievalMapping;
  config: RetrievalConfig;
}

/** Máximo de consultas de vínculo (Qdrant → Neo4j) por pergunta. */
const MAX_LINK_QUERIES = 5;

const status = (state: ConnectorState, detail: string, count = 0, durationMs = 0): ConnectorStatus => ({
  state,
  detail,
  count,
  durationMs,
});

function stateOf(err: unknown): ConnectorState {
  if (err instanceof AdapterError) {
    if (err.kind === "timeout") return "timeout";
    if (err.kind === "unauthorized") return "unauthorized";
  }
  return "error";
}

const detailOf = (err: unknown) => (err instanceof AdapterError ? err.message : "falha inesperada");

export class RetrievalService {
  readonly #d: RetrievalServiceDeps;

  constructor(deps: RetrievalServiceDeps) {
    this.#d = deps;
  }

  get vectorEnabled(): boolean {
    const d = this.#d;
    return d.vectorStore.kind !== "unconfigured" && d.embeddings !== null && d.vectorStore.collections.length > 0;
  }

  get graphEnabled(): boolean {
    return this.#d.graphStore.kind !== "unconfigured" && this.#d.graphStore.queries.length > 0;
  }

  /** Há ao menos um conector utilizável. Sem isso o assistente funciona como antes (só Ollama). */
  get enabled(): boolean {
    return this.vectorEnabled || this.graphEnabled;
  }

  get limits() {
    return { maxContextChars: this.#d.config.maxContextChars, maxCharsPerSource: this.#d.config.maxCharsPerSource };
  }

  /** Busca semântica em todas as coleções aplicáveis. */
  async #searchVector(question: string, auth: AuthContext, signal: AbortSignal): Promise<RetrievedRecord[]> {
    const { vectorStore, embeddings } = this.#d;
    const cols = vectorStore.collections.filter(
      (c) => c.searchByDefault && (!c.requiredPermission || auth.permissions.includes(c.requiredPermission)),
    );
    if (cols.length === 0) throw new AdapterError("unauthorized", "Nenhuma coleção permitida para o usuário");
    const vector = await embeddings!.embedQuery(question, signal);
    const settled = await Promise.allSettled(
      cols.map((c) => vectorStore.search({ collection: c.name, vector, auth, signal })),
    );
    const ok = settled.filter((r): r is PromiseFulfilledResult<RetrievedRecord[]> => r.status === "fulfilled");
    if (ok.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
    return ok.flatMap((r) => r.value).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  /**
   * Consultas de grafo acionadas por identificadores da pergunta ou do contexto (regex do
   * mapeamento). Permissões são verificadas AGORA, com o AuthContext desta requisição.
   */
  async #queryGraph(graphRuns: GraphRun[], auth: AuthContext, signal: AbortSignal): Promise<RetrievedRecord[] | null> {
    const { graphStore } = this.#d;
    const runs: Promise<RetrievedRecord[]>[] = [];
    for (const r of graphRuns) {
      const q = graphStore.queries.find((x) => x.name === r.query);
      if (!q) continue;
      if (q.requiredPermission && !auth.permissions.includes(q.requiredPermission)) continue;
      runs.push(graphStore.run({ query: q.name, params: r.params, auth, signal }));
    }
    if (runs.length === 0) return null;
    const settled = await Promise.allSettled(runs);
    const ok = settled.filter((r): r is PromiseFulfilledResult<RetrievedRecord[]> => r.status === "fulfilled");
    if (ok.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
    return ok.flatMap((r) => r.value);
  }

  /** Vínculos explícitos Qdrant → Neo4j declarados no mapeamento. */
  async #followLinks(vectorHits: RetrievedRecord[], auth: AuthContext, signal: AbortSignal): Promise<RetrievedSource[] | null> {
    const { graphStore, mapping } = this.#d;
    const jobs: { link: (typeof mapping.links)[number]; sourceId: string; value: string }[] = [];
    const seen = new Set<string>();
    for (const hit of vectorHits) {
      for (const link of mapping.links) {
        if (hit.reference.container !== link.collection) continue;
        const value = hit.reference.identifiers[link.payloadField];
        const key = `${link.query}|${value}`;
        if (!value || seen.has(key)) continue;
        seen.add(key);
        jobs.push({ link, sourceId: hit.id, value });
      }
    }
    if (jobs.length === 0) return null; // nenhum identificador de vínculo nos resultados
    const settled = await Promise.allSettled(
      jobs.slice(0, MAX_LINK_QUERIES).map(async (j) => {
        const rows = await graphStore.run({ query: j.link.query, params: { [j.link.param]: j.value }, auth, signal });
        return rows.map(
          (r): RetrievedSource => ({ ...r, ref: "", linkedFrom: { sourceId: j.sourceId, field: j.link.payloadField, value: j.value } }),
        );
      }),
    );
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    const ok = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    if (failed && ok.length === 0) throw failed.reason;
    return ok;
  }

  /**
   * Recupera fontes para a pergunta. Nunca lança: falhas viram status por conector.
   * @param auth contexto confiável resolvido no servidor; null → nenhuma consulta.
   */
  async retrieve(
    question: string,
    auth: AuthContext | null,
    signal?: AbortSignal,
    history: readonly ConversationTurn[] = [],
  ): Promise<RetrievalResult> {
    const t0 = performance.now();
    const elapsed = () => Math.round(performance.now() - t0);
    const vectorEnabled = this.vectorEnabled;
    const graphEnabled = this.graphEnabled;
    const off = (on: boolean, what: string) => status(on ? "unauthorized" : "disabled", on ? "sem contexto de autorização" : `${what} não configurado`);

    const noResolution: ResolutionSummary = { kind: "none", values: [] };
    if (!this.enabled) {
      return {
        grounding: "disabled",
        sources: [],
        status: { qdrant: off(false, "Qdrant"), neo4j: off(false, "Neo4j") },
        partial: false,
        durationMs: 0,
        resolution: noResolution,
      };
    }
    // A autorização vem antes da resolução: sem contexto válido, nada (nem o histórico) é examinado.
    if (auth === null) {
      return {
        grounding: "unauthorized",
        sources: [],
        status: { qdrant: off(vectorEnabled, "Qdrant"), neo4j: off(graphEnabled, "Neo4j") },
        partial: false,
        durationMs: 0,
        resolution: noResolution,
      };
    }

    const ref = resolveReferences(question, history, graphEnabled ? this.#d.graphStore.queries : [], {
      maxTurns: this.#d.config.contextTurns,
    });
    const resolution: ResolutionSummary = { kind: ref.kind, values: ref.values };
    if (ref.kind === "ambiguous") {
      const skipped = status("skipped", "referência ambígua: aguardando esclarecimento");
      return { grounding: "ambiguous", sources: [], status: { qdrant: skipped, neo4j: skipped }, partial: false, durationMs: elapsed(), resolution };
    }
    // Na continuação, a busca semântica recebe a pergunta + o identificador resolvido (não a conversa).
    const searchText = ref.kind === "contextual" ? `${question}\nReferência: ${ref.values.join(", ")}` : question;

    const budget = this.#d.config.timeoutMs;
    const timed = <T>(fn: (s: AbortSignal) => Promise<T>, what: string) => withDeadline(fn, budget, signal, what);

    const vectorTask = vectorEnabled
      ? timed((s) => this.#searchVector(searchText, auth, s), "recuperação Qdrant")
      : Promise.resolve(null);
    const graphTask = graphEnabled
      ? timed((s) => this.#queryGraph(ref.runs, auth, s), "recuperação Neo4j")
      : Promise.resolve(null);

    const [vec, graph] = await Promise.allSettled([vectorTask, graphTask]);
    const tVec = elapsed();

    let qdrant: ConnectorStatus;
    let vectorHits: RetrievedRecord[] = [];
    if (!vectorEnabled) qdrant = status("disabled", "Qdrant não configurado");
    else if (vec.status === "rejected") qdrant = status(stateOf(vec.reason), detailOf(vec.reason), 0, tVec);
    else {
      vectorHits = vec.value ?? [];
      qdrant = status(vectorHits.length ? "ok" : "empty", vectorHits.length ? "ok" : "nenhum trecho relevante", vectorHits.length, tVec);
    }

    let neo4j: ConnectorStatus;
    let graphHits: RetrievedRecord[] = [];
    if (!graphEnabled) neo4j = status("disabled", "Neo4j não configurado");
    else if (graph.status === "rejected") neo4j = status(stateOf(graph.reason), detailOf(graph.reason), 0, tVec);
    else if (graph.value === null) neo4j = status("skipped", "nenhuma consulta aplicável à pergunta", 0, tVec);
    else {
      graphHits = graph.value;
      neo4j = status(graphHits.length ? "ok" : "empty", graphHits.length ? "ok" : "nenhum registro", graphHits.length, tVec);
    }

    // Vínculos explícitos: só depois do Qdrant, com o tempo restante do orçamento.
    let linked: RetrievedSource[] = [];
    const remaining = budget - elapsed();
    if (graphEnabled && vectorHits.length > 0 && this.#d.mapping.links.length > 0 && remaining > 100 && neo4j.state !== "unauthorized") {
      try {
        const result = await withDeadline((s) => this.#followLinks(vectorHits, auth, s), remaining, signal, "vínculos Neo4j");
        linked = result ?? [];
        if (result === null) {
          // nenhum vínculo aplicável: mantém o estado anterior do Neo4j
        } else if (linked.length) {
          neo4j = status("ok", "ok", graphHits.length + linked.length, elapsed());
        } else if (neo4j.state === "skipped") {
          neo4j = status("empty", "nenhum registro vinculado", 0, elapsed());
        }
      } catch (err) {
        if (graphHits.length === 0) neo4j = status(stateOf(err), detailOf(err), 0, elapsed());
      }
    }

    // Combina: grafo por identificador exato da pergunta → trechos semânticos → registros vinculados.
    const seen = new Set<string>();
    const combined: RetrievedSource[] = [];
    let q = 0;
    let n = 0;
    for (const r of [...graphHits.map((x) => ({ ...x, ref: "", linkedFrom: null })), ...vectorHits.map((x) => ({ ...x, ref: "", linkedFrom: null })), ...linked]) {
      if (seen.has(r.id) || combined.length >= this.#d.config.maxSources) continue;
      seen.add(r.id);
      combined.push({ ...r, ref: r.origin === "qdrant" ? `Q${++q}` : `N${++n}` });
    }

    const failed = (s: ConnectorStatus) => s.state === "error" || s.state === "timeout" || s.state === "unauthorized";
    const anyFailed = failed(qdrant) || failed(neo4j);
    const grounding: Grounding = combined.length > 0 ? "sources" : anyFailed ? "unavailable" : "no_sources";
    return {
      grounding,
      sources: combined,
      status: { qdrant, neo4j },
      partial: combined.length > 0 && anyFailed,
      durationMs: elapsed(),
      resolution,
    };
  }

  /** Recupera e prepara o contexto para o modelo em uma chamada. */
  async retrieveForChat(
    question: string,
    auth: AuthContext | null,
    signal?: AbortSignal,
    history: readonly ConversationTurn[] = [],
  ): Promise<{ result: RetrievalResult; context: PreparedContext }> {
    const result = await this.retrieve(question, auth, signal, history);
    const sourcesOnly = this.#d.config.requireSources;
    return { result, context: prepareContext(result.grounding, result.sources, this.limits, result.resolution, { sourcesOnly }) };
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.#d.vectorStore.close(), this.#d.graphStore.close()]);
  }
}

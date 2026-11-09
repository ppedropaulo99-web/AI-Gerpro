/**
 * Monta os conectores e o serviço de recuperação a partir da configuração.
 * Sem Qdrant/Neo4j configurados, devolve implementações "não configuradas" e o assistente
 * funciona exatamente como antes (somente Ollama).
 */
import { ConfigError, type AppConfig } from "../config/env.ts";
import { UnconfiguredVectorStore, type VectorStore } from "../adapters/vector-store.ts";
import { UnconfiguredGraphStore, type GraphStore } from "../adapters/graph-store.ts";
import { QdrantVectorStore, createQdrantClient, type QdrantReadClient } from "../adapters/qdrant.ts";
import { Neo4jGraphStore, createNeo4jExecutor, type Neo4jReadExecutor } from "../adapters/neo4j.ts";
import { OllamaEmbeddingProvider, type EmbeddingProvider } from "../embeddings/provider.ts";
import { createAuthResolver, type AuthContextResolver } from "../auth/context.ts";
import { EMPTY_MAPPING, loadMappingFile, type RetrievalMapping } from "./mapping.ts";
import { RetrievalService } from "./service.ts";

export interface RetrievalStack {
  vectorStore: VectorStore;
  graphStore: GraphStore;
  embeddings: EmbeddingProvider | null;
  retrieval: RetrievalService;
  auth: AuthContextResolver;
  mapping: RetrievalMapping;
  /** Avisos de configuração (sem segredos), exibidos no log e em /api/health/details. */
  warnings: string[];
}

/** Pontos de substituição para testes (clientes simulados). */
export interface StackOverrides {
  qdrantClient?: QdrantReadClient;
  neo4jExecutor?: Neo4jReadExecutor;
  embeddings?: EmbeddingProvider | null;
  mapping?: RetrievalMapping;
}

export function createRetrievalStack(config: AppConfig, overrides: StackOverrides = {}): RetrievalStack {
  const warnings: string[] = [];
  const anyBackend = config.qdrant !== null || config.neo4j !== null;
  let mapping = overrides.mapping ?? EMPTY_MAPPING;
  if (!overrides.mapping && config.retrieval.mappingPath) mapping = loadMappingFile(config.retrieval.mappingPath); // MappingError → falha na inicialização
  if (anyBackend && !overrides.mapping && !config.retrieval.mappingPath) {
    warnings.push("Qdrant/Neo4j configurados sem RETRIEVAL_CONFIG_PATH: nenhuma coleção ou consulta mapeada");
  }

  let vectorStore: VectorStore = new UnconfiguredVectorStore();
  if (config.qdrant) {
    vectorStore = new QdrantVectorStore(overrides.qdrantClient ?? createQdrantClient(config.qdrant), mapping.collections, config.qdrant.timeoutMs);
  } else if (mapping.collections.length) {
    warnings.push("Coleções mapeadas, mas QDRANT_URL não está definido");
  }

  let graphStore: GraphStore = new UnconfiguredGraphStore();
  if (config.neo4j) {
    graphStore = new Neo4jGraphStore(overrides.neo4jExecutor ?? createNeo4jExecutor(config.neo4j), mapping.queries, config.neo4j.timeoutMs);
  } else if (mapping.queries.length) {
    warnings.push("Consultas mapeadas, mas NEO4J_URI não está definido");
  }

  const embeddings =
    overrides.embeddings !== undefined
      ? overrides.embeddings
      : config.embeddings
        ? new OllamaEmbeddingProvider(config.embeddings)
        : null;
  if (config.qdrant && mapping.collections.length && embeddings === null) {
    warnings.push("Qdrant configurado sem EMBEDDINGS_MODEL: busca vetorial desativada");
  }

  const auth = createAuthResolver(config.auth);
  const retrieval = new RetrievalService({ vectorStore, graphStore, embeddings, mapping, config: config.retrieval });
  if (retrieval.enabled && auth.mode === "none") {
    warnings.push("GERPRO_AUTH_MODE=none: nenhuma consulta corporativa será feita até integrar a autenticação do Gerpro");
  }
  // O widget envia só as últimas CHAT_MAX_MESSAGES mensagens (começando por uma do usuário):
  // cabem nelas (CHAT_MAX_MESSAGES - 1) / 2 perguntas anteriores para resolver continuações.
  const userTurnsInWindow = Math.floor((config.chat.maxMessages - 1) / 2);
  if (retrieval.graphEnabled && config.retrieval.contextTurns > userTurnsInWindow) {
    warnings.push(
      `RETRIEVAL_CONTEXT_TURNS=${config.retrieval.contextTurns} excede as perguntas anteriores que cabem em ` +
        `CHAT_MAX_MESSAGES=${config.chat.maxMessages} (${userTurnsInWindow}); aumente CHAT_MAX_MESSAGES ou reduza RETRIEVAL_CONTEXT_TURNS`,
    );
  }
  if (config.retrieval.requireSources) assertRequireSources(retrieval, auth, mapping);
  return { vectorStore, graphStore, embeddings, retrieval, auth, mapping, warnings };
}

/**
 * RETRIEVAL_REQUIRE_SOURCES=true: recusa iniciar sem as condições que tornam "fonte" uma evidência.
 *
 * - Recuperação ativa (Qdrant com embeddings e coleções, e/ou Neo4j com consultas mapeadas) e
 *   autenticação real: sem elas, nenhuma pergunta teria fontes.
 * - Qdrant: toda coleção mapeada precisa de `scoreThreshold`. Sem limite, o Qdrant sempre devolve
 *   os vizinhos mais próximos, mesmo sem relação com a pergunta.
 * - Neo4j: não há pontuação. As consultas só rodam com identificadores extraídos da pergunta
 *   pelas regex `fromQuestion` (ou de turnos anteriores do usuário), e os vínculos só partem de
 *   resultados do Qdrant que já passaram pelo limite. Esse mecanismo é preservado; nenhum limite
 *   numérico é exigido do grafo.
 */
function assertRequireSources(retrieval: RetrievalService, auth: AuthContextResolver, mapping: RetrievalMapping): void {
  const hint = "RETRIEVAL_REQUIRE_SOURCES=true";
  if (!retrieval.enabled) {
    throw new ConfigError(
      `${hint} exige recuperação ativa: Qdrant com EMBEDDINGS_MODEL e coleções mapeadas, e/ou Neo4j com consultas mapeadas (RETRIEVAL_CONFIG_PATH)`,
    );
  }
  if (auth.mode === "none") {
    throw new ConfigError(`${hint} exige autenticação (GERPRO_AUTH_MODE=jwt-hs256 ou um resolvedor próprio)`);
  }
  if (retrieval.vectorEnabled) {
    const missing = mapping.collections.filter((c) => c.scoreThreshold === null).map((c) => c.name);
    if (missing.length) {
      throw new ConfigError(`${hint} exige scoreThreshold em toda coleção do Qdrant (sem limite: ${missing.join(", ")})`);
    }
  }
}

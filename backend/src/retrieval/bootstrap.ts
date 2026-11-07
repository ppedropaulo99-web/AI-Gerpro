/**
 * Monta os conectores e o serviço de recuperação a partir da configuração.
 * Sem Qdrant/Neo4j configurados, devolve implementações "não configuradas" e o assistente
 * funciona exatamente como antes (somente Ollama).
 */
import type { AppConfig } from "../config/env.ts";
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
  /** Avisos de configuração (sem segredos), exibidos no log e em /api/health. */
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
  return { vectorStore, graphStore, embeddings, retrieval, auth, mapping, warnings };
}

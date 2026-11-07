import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { AppConfig } from "./config/env.ts";
import type { LlmClient } from "./ollama/client.ts";
import type { VectorStore } from "./adapters/vector-store.ts";
import type { GraphStore } from "./adapters/graph-store.ts";
import type { EmbeddingProvider } from "./embeddings/provider.ts";
import type { AuthContextResolver } from "./auth/context.ts";
import type { RetrievalService } from "./retrieval/service.ts";
import { healthRoutes } from "./routes/health.ts";
import { chatRoutes } from "./routes/chat.ts";
import { errorHandler } from "./errors.ts";

export interface AppDeps {
  config: AppConfig;
  version: string;
  llm: LlmClient;
  vectorStore: VectorStore;
  graphStore: GraphStore;
  /** null = EMBEDDINGS_MODEL não configurado (busca vetorial desativada). */
  embeddings: EmbeddingProvider | null;
  retrieval: RetrievalService;
  /** Resolve o contexto de autorização confiável a partir da requisição (integração com o Gerpro). */
  auth: AuthContextResolver;
  /** Avisos de configuração detectados na inicialização (sem segredos). */
  warnings?: string[];
}

export function buildApp(deps: AppDeps, options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    // Rejeita campos extras em vez de removê-los silenciosamente; não converte tipos.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    ...options,
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: { code: "not_found", message: "Rota não encontrada" } });
  });

  // CORS mínimo, apenas para a origem configurada (uso fora do proxy do Vite).
  const origin = deps.config.corsOrigin;
  if (origin) {
    app.addHook("onRequest", async (req, reply) => {
      if (req.headers.origin !== origin) return;
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "origin");
      if (req.method === "OPTIONS") {
        reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
        reply.header("access-control-allow-headers", "content-type, authorization");
        reply.header("access-control-max-age", "600");
        return reply.code(204).send();
      }
    });
  }

  app.register(async (scope) => {
    await healthRoutes(scope, deps);
    await chatRoutes(scope, deps);
  });

  return app;
}

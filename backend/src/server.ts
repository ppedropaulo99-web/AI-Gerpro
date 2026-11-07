import { readFileSync } from "node:fs";
import { buildApp } from "./app.ts";
import { loadConfig, ConfigError, describeEndpoint, type AppConfig } from "./config/env.ts";
import { OllamaClient } from "./ollama/client.ts";
import { createRetrievalStack, type RetrievalStack } from "./retrieval/bootstrap.ts";
import { MappingError } from "./retrieval/mapping.ts";

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  let config: AppConfig;
  let stack: RetrievalStack;
  try {
    config = loadConfig();
    stack = createRetrievalStack(config);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof MappingError) {
      console.error(`Configuração inválida: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const llm = new OllamaClient(config.ollama);
  const app = buildApp(
    {
      config,
      version: readVersion(),
      llm,
      vectorStore: stack.vectorStore,
      graphStore: stack.graphStore,
      embeddings: stack.embeddings,
      retrieval: stack.retrieval,
      auth: stack.auth,
      warnings: stack.warnings,
    },
    {
      logger: {
        level: process.env["LOG_LEVEL"] ?? "info",
        // Defesa extra: nunca registrar credenciais, mesmo que um log de requisição as inclua.
        redact: ["req.headers.authorization", "req.headers.cookie", "headers.authorization"],
      },
    },
  );

  const shutdown = async (signal: string) => {
    app.log.info(`Recebido ${signal}, encerrando...`);
    await app.close();
    await stack.retrieval.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: config.host });
  const o = config.ollama;
  app.log.info(
    `Ambiente: ${config.environment} | Ollama: ${o.baseUrl} | modelo: ${o.model} | think: ${o.think} | ` +
      `keep_alive: ${o.keepAlive ?? "padrão"} | num_ctx: ${o.numCtx ?? "padrão"} | timeout: ${o.timeoutMs} ms`,
  );

  // Recuperação: apenas esquema/host e contagens — nunca chaves, usuários ou senhas.
  const r = stack.retrieval;
  app.log.info(
    `Recuperação: ${r.enabled ? "ativa" : "desativada (somente Ollama)"} | ` +
      `Qdrant: ${config.qdrant ? describeEndpoint(config.qdrant.url) : "não configurado"} ` +
      `(${stack.mapping.collections.length} coleção(ões)) | ` +
      `Neo4j: ${config.neo4j ? describeEndpoint(config.neo4j.uri) : "não configurado"} ` +
      `(${stack.mapping.queries.length} consulta(s)) | ` +
      `embeddings: ${config.embeddings?.model ?? "não configurado"} | auth: ${stack.auth.mode}`,
  );
  for (const w of stack.warnings) app.log.warn(`Recuperação: ${w}`);
  // Segurança: apenas indicadores booleanos — nunca tokens ou segredos.
  const sec = config.security;
  app.log.info(
    `Segurança: modo ${sec.strict ? "corporativo (estrito)" : "local"} | chat exige autenticação: ${sec.requireChatAuth ? "sim" : "não"} | ` +
      `diagnóstico: ${sec.diagnostics.token ? "token" : "sem token"}${sec.diagnostics.allowLoopback ? " + loopback" : ""}`,
  );
  if (!sec.requireChatAuth) app.log.warn("Chat sem autenticação: aceitável só em ambiente local de demonstração");

  // Pré-carga em segundo plano: a 1ª pergunta não paga o tempo de carregar o modelo na GPU.
  if (o.preload) {
    const t0 = performance.now();
    llm
      .preload()
      .then(() => app.log.info(`Modelo ${o.model} pré-carregado em ${Math.round(performance.now() - t0)} ms`))
      .catch((err: unknown) =>
        app.log.warn(`Pré-carga do modelo falhou (o backend segue funcionando): ${err instanceof Error ? err.message : err}`),
      );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

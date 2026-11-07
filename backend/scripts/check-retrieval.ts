/**
 * Verificação de conectividade e configuração da recuperação (somente leitura).
 *
 *   npm run check:retrieval -w backend
 *   npm run check:retrieval -w backend -- --question "..." --org ORG --perms a,b [--show-content]
 *
 * Mostra: configuração (sem segredos), validação do mapeamento, saúde de Qdrant/coleções,
 * embeddings e Neo4j. Com --question, executa uma recuperação com um AuthContext de TESTE
 * informado na linha de comando (em produção ele vem do Gerpro) e lista as fontes.
 * O conteúdo dos trechos só é exibido com --show-content.
 */
import { parseArgs } from "node:util";
import { ConfigError, describeEndpoint, loadConfig } from "../src/config/env.ts";
import { createRetrievalStack } from "../src/retrieval/bootstrap.ts";
import { MappingError } from "../src/retrieval/mapping.ts";

const { values } = parseArgs({
  options: {
    question: { type: "string" },
    org: { type: "string" },
    user: { type: "string", default: "check-retrieval" },
    perms: { type: "string", default: "" },
    "show-content": { type: "boolean", default: false },
  },
});

const mark = (ok: boolean) => (ok ? "✔" : "✖");

async function main(): Promise<number> {
  let config;
  let stack;
  try {
    config = loadConfig();
    stack = createRetrievalStack(config);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof MappingError) {
      console.error(`✖ Configuração inválida: ${err.message}`);
      return 1;
    }
    throw err;
  }

  console.log("Configuração (sem segredos)");
  console.log(`  Qdrant:     ${config.qdrant ? `${describeEndpoint(config.qdrant.url)} | api key: ${config.qdrant.apiKey ? "definida" : "não definida"}` : "não configurado"}`);
  console.log(`  Neo4j:      ${config.neo4j ? `${describeEndpoint(config.neo4j.uri)} | usuário: ${config.neo4j.user ? "definido" : "não definido"} | banco: ${config.neo4j.database ? "definido" : "padrão"}` : "não configurado"}`);
  console.log(`  Embeddings: ${config.embeddings ? `${config.embeddings.model} (${describeEndpoint(config.embeddings.baseUrl)})` : "não configurado"}`);
  console.log(`  Mapeamento: ${config.retrieval.mappingPath ? "carregado" : "não definido"} | ${stack.mapping.collections.length} coleção(ões), ${stack.mapping.queries.length} consulta(s), ${stack.mapping.links.length} vínculo(s)`);
  console.log(`  Autenticação: ${stack.auth.mode}`);
  console.log(`  Recuperação: ${stack.retrieval.enabled ? "ativa" : "desativada (somente Ollama)"}`);
  for (const w of stack.warnings) console.log(`  ⚠ ${w}`);

  let failures = 0;
  console.log("\nSaúde");
  const vs = await stack.vectorStore.health();
  if (vs.configured) {
    console.log(`  ${mark(vs.reachable)} Qdrant: ${vs.detail}`);
    failures += vs.reachable ? 0 : 1;
    for (const c of vs.collections ?? []) {
      const ok = c.exists && c.dimensions !== null;
      failures += ok ? 0 : 1;
      console.log(`    ${mark(ok)} coleção ${c.name}: ${c.exists ? `dimensão ${c.dimensions ?? "?"}` : c.detail}`);
    }
  }
  if (stack.embeddings) {
    const e = await stack.embeddings.health();
    failures += e.reachable ? 0 : 1;
    console.log(`  ${mark(e.reachable)} Embeddings: ${e.detail}`);
    for (const c of vs.collections ?? []) {
      if (e.dimensions !== null && c.dimensions !== null && c.dimensions !== e.dimensions) {
        failures++;
        console.log(`    ✖ coleção ${c.name} usa dimensão ${c.dimensions}; o modelo gera ${e.dimensions} (modelo diferente do usado na indexação?)`);
      }
    }
  }
  const gs = await stack.graphStore.health();
  if (gs.configured) {
    failures += gs.reachable ? 0 : 1;
    console.log(`  ${mark(gs.reachable)} Neo4j: ${gs.detail}`);
  }
  if (!vs.configured && !gs.configured) console.log("  (nenhuma base configurada)");

  if (values.question) {
    if (!values.org) {
      console.error("\n✖ --question exige --org (organização de teste para o AuthContext)");
      await stack.retrieval.close();
      return 1;
    }
    const auth = {
      userId: values.user ?? "check-retrieval",
      organizationId: values.org,
      permissions: (values.perms ?? "").split(",").map((p) => p.trim()).filter(Boolean),
      source: "check-retrieval",
      expiresAt: null,
    };
    const { result, context } = await stack.retrieval.retrieveForChat(values.question, auth);
    console.log(`\nRecuperação: grounding=${result.grounding}${result.partial ? " (parcial)" : ""} em ${result.durationMs} ms`);
    for (const [name, s] of Object.entries(result.status)) {
      console.log(`  ${name}: ${s.state} | ${s.count} resultado(s) | ${s.durationMs} ms | ${s.detail}`);
    }
    for (const s of context.included) {
      const ids = Object.entries(s.reference.identifiers).map(([k, v]) => `${k}=${v}`).join(", ");
      console.log(`  [${s.ref}] ${s.id}${s.score !== null ? ` score=${s.score.toFixed(3)}` : ""}${ids ? ` | ${ids}` : ""}`);
      if (values["show-content"]) console.log(`      ${s.content.slice(0, 300).replace(/\s+/g, " ")}`);
    }
    if (context.truncated) console.log("  (contexto truncado pelo orçamento RETRIEVAL_MAX_*)");
  }

  await stack.retrieval.close();
  console.log(failures ? `\n✖ ${failures} problema(s) encontrado(s)` : "\n✔ Verificação concluída");
  return failures ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);

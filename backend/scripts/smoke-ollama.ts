/**
 * Teste de fumaça contra o Ollama REAL (não roda em `npm test`).
 * Uso: npm run smoke
 * Verifica conectividade, presença do modelo e faz uma pergunta real.
 */
import { loadConfig } from "../src/config/env.ts";
import { OllamaClient } from "../src/ollama/client.ts";
import { SYSTEM_PROMPT } from "../src/ollama/system-prompt.ts";

const config = loadConfig();
const client = new OllamaClient(config.ollama);

console.log(`Ollama: ${config.ollama.baseUrl} | modelo: ${config.ollama.model}`);
const health = await client.health();
console.log("Health:", JSON.stringify(health));
if (!health.reachable || !health.modelAvailable) {
  console.error("FALHA: Ollama inacessível ou modelo ausente.");
  process.exit(1);
}

const question = process.argv[2] ?? "Em uma frase, o que é uma petição inicial?";
console.log(`Pergunta: ${question}`);
const t0 = performance.now();
const result = await client.chat([
  { role: "system", content: SYSTEM_PROMPT },
  { role: "user", content: question },
]);
console.log(`Resposta (${Math.round(performance.now() - t0)} ms, modelo ${result.model}):\n${result.content}`);
console.log(`Tokens: prompt=${result.promptTokens} resposta=${result.completionTokens}`);

/**
 * Leitura e validação da configuração a partir de variáveis de ambiente.
 * Nenhum valor sensível possui padrão embutido. Segredos (API keys, senhas, chaves de
 * assinatura) existem apenas no backend e nunca são registrados em log.
 *
 * O MAPEAMENTO de coleções, campos e consultas (sem segredos) fica num arquivo JSON
 * separado — ver RETRIEVAL_CONFIG_PATH e src/retrieval/mapping.ts.
 */

/**
 * "auto": consulta as capacidades do modelo; se suportar raciocínio, pede ao Ollama
 * para separá-lo (think=true) — o raciocínio é sempre descartado pelo backend.
 */
export type ThinkMode = "auto" | boolean;

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  think: ThinkMode;
  /** Tempo que o Ollama mantém o modelo carregado (ex.: "30m"); null = padrão do Ollama. */
  keepAlive: string | null;
  /** Janela de contexto (tokens); null = padrão do Ollama. */
  numCtx: number | null;
  /** Carrega o modelo na GPU ao iniciar o backend, evitando a espera da 1ª pergunta. */
  preload: boolean;
}

/** Identificação técnica do ambiente (ex.: "demo"). Não é exibida no título do assistente. */
export type AppEnvironment = string;

export interface ChatLimits {
  maxMessages: number;
  maxCharsPerMessage: number;
}

/** Conexão com o Qdrant (o mapeamento de coleções fica no arquivo de mapeamento). */
export interface QdrantConfig {
  url: string;
  /** Segredo. Nunca enviar ao frontend nem registrar em log. */
  apiKey: string | null;
  timeoutMs: number;
}

/** Conexão com o Neo4j (as consultas autorizadas ficam no arquivo de mapeamento). */
export interface Neo4jConfig {
  /** bolt+s:// ou neo4j+s:// (TLS). Esquemas sem TLS só em loopback ou com NEO4J_ALLOW_INSECURE=true. */
  uri: string;
  user: string | null;
  /** Segredo. Nunca enviar ao frontend nem registrar em log. */
  password: string | null;
  database: string | null;
  timeoutMs: number;
  maxPoolSize: number;
}

/** Provedor de embeddings da PERGUNTA. Deve ser o mesmo modelo usado para indexar as coleções. */
export interface EmbeddingsConfig {
  provider: "ollama";
  baseUrl: string;
  model: string;
  /** Dimensão esperada (validada contra a resposta e contra a coleção). */
  dimensions: number | null;
  /** Prefixo exigido por alguns modelos para consultas (ex.: "query: " no E5). */
  queryPrefix: string;
  timeoutMs: number;
}

export interface RetrievalConfig {
  /** Caminho do arquivo JSON de mapeamento (coleções, campos, consultas Cypher autorizadas). */
  mappingPath: string | null;
  /** Tempo máximo total da recuperação antes de responder sem as fontes que não chegaram. */
  timeoutMs: number;
  maxSources: number;
  maxContextChars: number;
  maxCharsPerSource: number;
  /** Mensagens anteriores do usuário examinadas em perguntas de continuação; 0 = desativa. */
  contextTurns: number;
  /**
   * Modo contextual obrigatório (RETRIEVAL_REQUIRE_SOURCES). Ativo: o modelo só é chamado quando
   * a recuperação trouxe fontes; sem elas, o backend responde com um texto fixo de insuficiência
   * de informações. Padrão false (comportamento anterior). Requisitos validados na inicialização
   * em src/retrieval/bootstrap.ts.
   */
  requireSources: boolean;
}

export type AuthMode = "none" | "jwt-hs256";

export interface AuthConfig {
  mode: AuthMode;
  jwt: {
    /** Segredo compartilhado com o backend do Gerpro (HS256). */
    secret: string;
    issuer: string | null;
    audience: string | null;
    maxTtlSeconds: number;
    clockSkewSeconds: number;
    claims: { userId: string; organizationId: string; permissions: string };
  } | null;
}

/**
 * Proteções de ambiente corporativo. "strict" vale para todo APP_ENV fora de RELAXED_ENVIRONMENTS
 * (ex.: homologacao, producao): exige autenticação no chat, JWT com emissor e audiência, TLS
 * verificado nas bases e diagnósticos protegidos. Os ambientes locais mantêm o comportamento atual.
 */
export interface SecurityConfig {
  strict: boolean;
  /** Exige AuthContext válido para usar o chat (sem acesso anônimo à GPU). */
  requireChatAuth: boolean;
  diagnostics: {
    /** Token administrativo para GET /api/health/details (Authorization: Bearer). Segredo. */
    token: string | null;
    /** Permite o diagnóstico sem token a partir de 127.0.0.1/::1, sem cabeçalhos de proxy. */
    allowLoopback: boolean;
  };
}

/** Ambientes locais (desenvolvimento/demonstração): regras estritas desativadas. */
export const RELAXED_ENVIRONMENTS: readonly string[] = ["demo", "dev", "development", "local", "test"];

export interface AppConfig {
  environment: AppEnvironment;
  port: number;
  host: string;
  corsOrigin: string | null;
  ollama: OllamaConfig;
  chat: ChatLimits;
  /** null = não configurado: o assistente funciona normalmente, sem recuperação. */
  qdrant: QdrantConfig | null;
  neo4j: Neo4jConfig | null;
  embeddings: EmbeddingsConfig | null;
  retrieval: RetrievalConfig;
  auth: AuthConfig;
  security: SecurityConfig;
}

/** Modelo padrão: Qwen3 4B Instruct (sem raciocínio obrigatório), quantização Q4_K_M. */
export const DEFAULT_OLLAMA_MODEL = "qwen3:4b-instruct-2507-q4_K_M";

export class ConfigError extends Error {
  override name = "ConfigError";
}

type Env = Record<string, string | undefined>;

function readStr(env: Env, key: string): string | null {
  const raw = env[key]?.trim();
  return raw ? raw : null;
}

function readInt(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = readStr(env, key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} deve ser um inteiro entre ${min} e ${max} (recebido: "${raw}")`);
  }
  return value;
}

function readBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = readStr(env, key)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (["true", "1", "yes", "sim"].includes(raw)) return true;
  if (["false", "0", "no", "nao", "não"].includes(raw)) return false;
  throw new ConfigError(`${key} deve ser true ou false (recebido: "${raw}")`);
}

/** Lê uma URL sem ecoar o valor no erro (pode conter credenciais embutidas). */
function readUrl(env: Env, key: string, fallback: string, protocols: string[] = ["http:", "https:"]): string {
  const raw = readStr(env, key) ?? fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${key} deve ser uma URL válida`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new ConfigError(`${key} deve usar ${protocols.join(" ou ")} (recebido: "${url.protocol}")`);
  }
  if (url.username || url.password) {
    throw new ConfigError(`${key} não deve conter usuário/senha na URL; use as variáveis de credencial próprias`);
  }
  return raw.replace(/\/+$/, "");
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const isLoopback = (raw: string) => LOOPBACK.has(new URL(raw).hostname.toLowerCase());

function readThink(env: Env): ThinkMode {
  const raw = readStr(env, "OLLAMA_THINK")?.toLowerCase();
  if (raw === undefined || raw === "auto") return "auto";
  return readBool(env, "OLLAMA_THINK", true);
}

function readKeepAlive(env: Env): string | null {
  const raw = readStr(env, "OLLAMA_KEEP_ALIVE") ?? "30m";
  if (raw.toLowerCase() === "default") return null;
  if (!/^-?\d+(ms|s|m|h)?$/.test(raw)) {
    throw new ConfigError(`OLLAMA_KEEP_ALIVE deve ser uma duração como 30m, 1h, 300s ou -1 (recebido: "${raw}")`);
  }
  return raw;
}

function readEnvironment(env: Env): AppEnvironment {
  const raw = readStr(env, "APP_ENV") ?? "demo";
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(raw)) {
    throw new ConfigError(`APP_ENV deve conter apenas letras minúsculas, números e hífen (recebido: "${raw}")`);
  }
  return raw;
}

const STRICT_HINT = "em ambiente corporativo (APP_ENV fora de demo/dev/local/test)";

function loadQdrant(env: Env, strict: boolean): QdrantConfig | null {
  if (readStr(env, "QDRANT_URL") === null) return null;
  const url = readUrl(env, "QDRANT_URL", "");
  const allowInsecure = readBool(env, "QDRANT_ALLOW_INSECURE", false);
  if (strict && allowInsecure) throw new ConfigError(`QDRANT_ALLOW_INSECURE=true não é permitido ${STRICT_HINT}`);
  if (url.startsWith("http:") && !isLoopback(url) && !allowInsecure) {
    throw new ConfigError("QDRANT_URL deve usar https:// fora de localhost (ou defina QDRANT_ALLOW_INSECURE=true conscientemente)");
  }
  return {
    url,
    apiKey: readStr(env, "QDRANT_API_KEY"),
    timeoutMs: readInt(env, "QDRANT_TIMEOUT_MS", 5_000, 100, 120_000),
  };
}

function loadNeo4j(env: Env, strict: boolean): Neo4jConfig | null {
  if (readStr(env, "NEO4J_URI") === null) return null;
  const uri = readUrl(env, "NEO4J_URI", "", ["bolt:", "bolt+s:", "bolt+ssc:", "neo4j:", "neo4j+s:", "neo4j+ssc:"]);
  const secure = /^(bolt|neo4j)\+(s|ssc):/.test(uri);
  const allowInsecure = readBool(env, "NEO4J_ALLOW_INSECURE", false);
  if (strict && allowInsecure) throw new ConfigError(`NEO4J_ALLOW_INSECURE=true não é permitido ${STRICT_HINT}`);
  if (strict && /^(bolt|neo4j)\+ssc:/.test(uri)) {
    throw new ConfigError(`NEO4J_URI com +ssc (certificado não verificado) não é permitido ${STRICT_HINT}; use bolt+s:// ou neo4j+s://`);
  }
  if (!secure && !isLoopback(uri) && !allowInsecure) {
    throw new ConfigError("NEO4J_URI deve usar bolt+s:// ou neo4j+s:// fora de localhost (ou defina NEO4J_ALLOW_INSECURE=true conscientemente)");
  }
  const user = readStr(env, "NEO4J_USER");
  const password = readStr(env, "NEO4J_PASSWORD");
  if ((user === null) !== (password === null)) {
    throw new ConfigError("NEO4J_USER e NEO4J_PASSWORD devem ser informados juntos");
  }
  return {
    uri,
    user,
    password,
    database: readStr(env, "NEO4J_DATABASE"),
    timeoutMs: readInt(env, "NEO4J_TIMEOUT_MS", 5_000, 100, 120_000),
    maxPoolSize: readInt(env, "NEO4J_MAX_POOL_SIZE", 10, 1, 100),
  };
}

function loadEmbeddings(env: Env, ollamaBaseUrl: string): EmbeddingsConfig | null {
  const model = readStr(env, "EMBEDDINGS_MODEL");
  if (model === null) return null; // sem padrão: o modelo DEVE ser o mesmo da indexação
  const provider = readStr(env, "EMBEDDINGS_PROVIDER") ?? "ollama";
  if (provider !== "ollama") throw new ConfigError(`EMBEDDINGS_PROVIDER não suportado: "${provider}" (disponível: ollama)`);
  const dims = readInt(env, "EMBEDDINGS_DIMENSIONS", 0, 0, 65_536);
  return {
    provider: "ollama",
    baseUrl: readUrl(env, "EMBEDDINGS_BASE_URL", ollamaBaseUrl),
    model,
    dimensions: dims === 0 ? null : dims,
    queryPrefix: env["EMBEDDINGS_QUERY_PREFIX"] ?? "",
    timeoutMs: readInt(env, "EMBEDDINGS_TIMEOUT_MS", 10_000, 100, 120_000),
  };
}

function loadRetrieval(env: Env): RetrievalConfig {
  return {
    mappingPath: readStr(env, "RETRIEVAL_CONFIG_PATH"),
    timeoutMs: readInt(env, "RETRIEVAL_TIMEOUT_MS", 8_000, 100, 60_000),
    maxSources: readInt(env, "RETRIEVAL_MAX_SOURCES", 8, 1, 50),
    maxContextChars: readInt(env, "RETRIEVAL_MAX_CONTEXT_CHARS", 6_000, 500, 100_000),
    maxCharsPerSource: readInt(env, "RETRIEVAL_MAX_CHARS_PER_SOURCE", 1_500, 100, 20_000),
    contextTurns: readInt(env, "RETRIEVAL_CONTEXT_TURNS", 4, 0, 20),
    requireSources: readBool(env, "RETRIEVAL_REQUIRE_SOURCES", false),
  };
}

function loadAuth(env: Env): AuthConfig {
  const mode = (readStr(env, "GERPRO_AUTH_MODE") ?? "none").toLowerCase();
  if (mode === "none") return { mode: "none", jwt: null };
  if (mode !== "jwt-hs256") throw new ConfigError(`GERPRO_AUTH_MODE inválido: "${mode}" (use none ou jwt-hs256)`);
  const secret = readStr(env, "GERPRO_AUTH_JWT_SECRET");
  if (secret === null || Buffer.byteLength(secret, "utf8") < 32) {
    throw new ConfigError("GERPRO_AUTH_JWT_SECRET é obrigatório no modo jwt-hs256 e deve ter ao menos 32 bytes");
  }
  return {
    mode: "jwt-hs256",
    jwt: {
      secret,
      issuer: readStr(env, "GERPRO_AUTH_JWT_ISSUER"),
      audience: readStr(env, "GERPRO_AUTH_JWT_AUDIENCE"),
      maxTtlSeconds: readInt(env, "GERPRO_AUTH_MAX_TTL_SECONDS", 900, 30, 86_400),
      clockSkewSeconds: readInt(env, "GERPRO_AUTH_CLOCK_SKEW_SECONDS", 30, 0, 300),
      claims: {
        userId: readStr(env, "GERPRO_AUTH_CLAIM_USER") ?? "sub",
        organizationId: readStr(env, "GERPRO_AUTH_CLAIM_ORG") ?? "org",
        permissions: readStr(env, "GERPRO_AUTH_CLAIM_PERMISSIONS") ?? "perms",
      },
    },
  };
}

function loadSecurity(env: Env, strict: boolean, auth: AuthConfig): SecurityConfig {
  const requireChatAuth = readBool(env, "CHAT_REQUIRE_AUTH", strict);
  if (strict && !requireChatAuth) {
    throw new ConfigError(`CHAT_REQUIRE_AUTH=false não é permitido ${STRICT_HINT}: o chat não pode ser anônimo`);
  }
  if (requireChatAuth && auth.mode === "none") {
    throw new ConfigError(
      "A autenticação do chat (CHAT_REQUIRE_AUTH) exige GERPRO_AUTH_MODE=jwt-hs256 (ou um resolvedor próprio)" +
        (strict ? `; ela é obrigatória ${STRICT_HINT}` : ""),
    );
  }
  if (strict && auth.jwt && (auth.jwt.issuer === null || auth.jwt.audience === null)) {
    throw new ConfigError(`GERPRO_AUTH_JWT_ISSUER e GERPRO_AUTH_JWT_AUDIENCE são obrigatórios ${STRICT_HINT}`);
  }
  const token = readStr(env, "DIAGNOSTICS_TOKEN");
  if (token !== null && Buffer.byteLength(token, "utf8") < 32) {
    throw new ConfigError("DIAGNOSTICS_TOKEN deve ter ao menos 32 bytes");
  }
  if (token !== null && auth.jwt && token === auth.jwt.secret) {
    throw new ConfigError("DIAGNOSTICS_TOKEN deve ser diferente de GERPRO_AUTH_JWT_SECRET");
  }
  return {
    strict,
    requireChatAuth,
    diagnostics: { token, allowLoopback: readBool(env, "DIAGNOSTICS_ALLOW_LOOPBACK", !strict) },
  };
}

export function loadConfig(env: Env = process.env): AppConfig {
  const numCtx = readInt(env, "OLLAMA_NUM_CTX", 8192, 0, 262_144);
  const ollamaBaseUrl = readUrl(env, "OLLAMA_BASE_URL", "http://127.0.0.1:11434");
  const environment = readEnvironment(env);
  const strict = !RELAXED_ENVIRONMENTS.includes(environment);
  const auth = loadAuth(env);
  return {
    environment,
    port: readInt(env, "PORT", 3001, 1, 65535),
    host: readStr(env, "HOST") ?? "127.0.0.1",
    corsOrigin: readStr(env, "CORS_ORIGIN"),
    ollama: {
      baseUrl: ollamaBaseUrl,
      // Padrão aprovado na Etapa 2.1 (ver docs/BENCHMARK-MODELOS.md). Alternativa instalada: "qwen3:4b".
      model: readStr(env, "OLLAMA_MODEL") ?? DEFAULT_OLLAMA_MODEL,
      timeoutMs: readInt(env, "OLLAMA_TIMEOUT_MS", 120_000, 1_000, 600_000),
      think: readThink(env),
      keepAlive: readKeepAlive(env),
      numCtx: numCtx === 0 ? null : numCtx,
      preload: readBool(env, "OLLAMA_PRELOAD", true),
    },
    chat: {
      maxMessages: readInt(env, "CHAT_MAX_MESSAGES", 30, 1, 200),
      maxCharsPerMessage: readInt(env, "CHAT_MAX_CHARS_PER_MESSAGE", 8_000, 1, 100_000),
    },
    qdrant: loadQdrant(env, strict),
    neo4j: loadNeo4j(env, strict),
    embeddings: loadEmbeddings(env, ollamaBaseUrl),
    retrieval: loadRetrieval(env),
    auth,
    security: loadSecurity(env, strict, auth),
  };
}

/** Descreve um endpoint para logs sem credenciais nem caminho (apenas esquema + host + porta). */
export function describeEndpoint(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(inválido)";
  }
}

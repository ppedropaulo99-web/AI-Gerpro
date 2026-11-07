/**
 * Contexto de autorização confiável, fornecido pelo Gerpro.
 *
 * REGRA: identidade, organização e permissões NUNCA vêm do corpo da requisição nem de
 * filtros enviados pelo navegador. Elas são extraídas de uma credencial que o backend
 * verifica criptograficamente (ou de outra integração no servidor que implemente
 * `AuthContextResolver`). Sem contexto válido, não há consulta às bases corporativas.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthConfig } from "../config/env.ts";

export interface AuthContext {
  userId: string;
  organizationId: string;
  /** Permissões/papéis emitidos pelo Gerpro (ex.: "processos:ler"). */
  permissions: string[];
  /** Como o contexto foi obtido (para auditoria). */
  source: string;
  /** Expiração da credencial (epoch em segundos), se houver. */
  expiresAt: number | null;
}

/** Credencial presente, porém inválida (assinatura, expiração, emissor...). Vira HTTP 401. */
export class AuthError extends Error {
  override name = "AuthError";
}

export type RequestHeaders = Record<string, string | string[] | undefined>;

/** Ponto de integração com a autenticação do Gerpro. */
export interface AuthContextResolver {
  readonly mode: string;
  /** null = sem credencial (consulta corporativa não permitida). Lança AuthError se inválida. */
  resolve(headers: RequestHeaders): Promise<AuthContext | null>;
}

/** Padrão: nenhuma integração de identidade → nenhuma consulta corporativa. */
export class NoAuthResolver implements AuthContextResolver {
  readonly mode = "none";
  async resolve(): Promise<AuthContext | null> {
    return null;
  }
}

function b64urlDecode(part: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) throw new AuthError("Token malformado");
  return Buffer.from(part, "base64url");
}

function parseJson(buf: Buffer): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(buf.toString("utf8"));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* tratado abaixo */
  }
  throw new AuthError("Token malformado");
}

const MAX_TOKEN_LENGTH = 8_192;
const ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;

/**
 * Implementação de referência: JWT HS256 emitido pelo BACKEND do Gerpro (curta duração),
 * entregue ao widget pelo hospedeiro e enviado em `Authorization: Bearer <token>`.
 * Verifica assinatura (tempo constante), alg, exp, nbf, iat, emissor, audiência e TTL máximo.
 */
export class JwtHs256Resolver implements AuthContextResolver {
  readonly mode = "jwt-hs256";
  readonly #key: Buffer;
  readonly #cfg: NonNullable<AuthConfig["jwt"]>;
  readonly #now: () => number;

  constructor(cfg: NonNullable<AuthConfig["jwt"]>, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.#cfg = cfg;
    this.#key = Buffer.from(cfg.secret, "utf8");
    this.#now = now;
  }

  async resolve(headers: RequestHeaders): Promise<AuthContext | null> {
    const raw = headers["authorization"];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) return null;
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match?.[1]) throw new AuthError("Cabeçalho Authorization inválido");
    return this.verify(match[1]);
  }

  verify(token: string): AuthContext {
    if (token.length > MAX_TOKEN_LENGTH) throw new AuthError("Token grande demais");
    const parts = token.split(".");
    if (parts.length !== 3) throw new AuthError("Token malformado");
    const [h, p, s] = parts as [string, string, string];

    const header = parseJson(b64urlDecode(h));
    if (header["alg"] !== "HS256") throw new AuthError("Algoritmo de assinatura não permitido");
    if (header["typ"] !== undefined && header["typ"] !== "JWT") throw new AuthError("Tipo de token inválido");

    const expected = createHmac("sha256", this.#key).update(`${h}.${p}`).digest();
    const given = b64urlDecode(s);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new AuthError("Assinatura inválida");
    }

    const claims = parseJson(b64urlDecode(p));
    const now = this.#now();
    const skew = this.#cfg.clockSkewSeconds;
    const num = (k: string) => (typeof claims[k] === "number" ? (claims[k] as number) : null);
    const exp = num("exp");
    const iat = num("iat");
    const nbf = num("nbf");
    if (exp === null) throw new AuthError("Token sem expiração");
    if (now > exp + skew) throw new AuthError("Token expirado");
    if (nbf !== null && now + skew < nbf) throw new AuthError("Token ainda não válido");
    if (iat !== null && iat > now + skew) throw new AuthError("Token emitido no futuro");
    const issuedAt = iat ?? nbf ?? now;
    if (exp - issuedAt > this.#cfg.maxTtlSeconds) throw new AuthError("Validade do token acima do máximo permitido");

    if (this.#cfg.issuer !== null && claims["iss"] !== this.#cfg.issuer) throw new AuthError("Emissor inválido");
    if (this.#cfg.audience !== null) {
      const aud = claims["aud"];
      const ok = Array.isArray(aud) ? aud.includes(this.#cfg.audience) : aud === this.#cfg.audience;
      if (!ok) throw new AuthError("Audiência inválida");
    }

    const names = this.#cfg.claims;
    const userId = claims[names.userId];
    const organizationId = claims[names.organizationId];
    const perms = claims[names.permissions] ?? [];
    if (typeof userId !== "string" || !ID_PATTERN.test(userId)) throw new AuthError("Identificador de usuário ausente ou inválido");
    if (typeof organizationId !== "string" || !ID_PATTERN.test(organizationId)) {
      throw new AuthError("Organização ausente ou inválida");
    }
    if (!Array.isArray(perms) || perms.length > 200 || !perms.every((x) => typeof x === "string" && ID_PATTERN.test(x))) {
      throw new AuthError("Permissões inválidas");
    }
    return { userId, organizationId, permissions: [...new Set(perms as string[])], source: this.mode, expiresAt: exp };
  }
}

export function createAuthResolver(cfg: AuthConfig): AuthContextResolver {
  if (cfg.mode === "jwt-hs256" && cfg.jwt) return new JwtHs256Resolver(cfg.jwt);
  return new NoAuthResolver();
}

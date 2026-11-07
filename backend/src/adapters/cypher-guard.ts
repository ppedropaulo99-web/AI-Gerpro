/**
 * Validação léxica das consultas Cypher PRÉ-AUTORIZADAS (definidas pela equipe no arquivo
 * de mapeamento, nunca pelo usuário nem pelo modelo).
 *
 * É uma camada de defesa em profundidade, não a única: as consultas também rodam em sessões
 * de LEITURA (o Neo4j recusa escrita) e o usuário de banco deve ter apenas papel de leitura.
 */

/** Cláusulas de escrita, administração ou execução arbitrária. */
const FORBIDDEN_KEYWORDS = [
  "CREATE", "MERGE", "DELETE", "DETACH", "SET", "REMOVE", "DROP", "FOREACH", "LOAD", "CALL",
  "USE", "ALTER", "GRANT", "DENY", "REVOKE", "TERMINATE", "START", "STOP", "SHOW", "RENAME",
  "ENABLE", "DISABLE", "SUSPEND", "FINISH", "INSERT",
];
/** Namespaces de funções/procedimentos com efeitos colaterais ou acesso administrativo. */
const FORBIDDEN_NAMESPACES = /\b(apoc|gds|dbms)\s*\./i;

/** Parâmetros injetados pelo servidor a partir do contexto de autorização confiável. */
export const SERVER_PARAMS = ["limit", "auth_userId", "auth_organizationId", "auth_permissions"] as const;

export class CypherValidationError extends Error {
  override name = "CypherValidationError";
}

/** Remove comentários, literais de texto e identificadores entre crases, preservando o resto. */
export function stripCypher(cypher: string): string {
  let out = "";
  let i = 0;
  while (i < cypher.length) {
    const c = cypher[i]!;
    const next = cypher[i + 1];
    if (c === "/" && next === "/") {
      while (i < cypher.length && cypher[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = cypher.indexOf("*/", i + 2);
      if (end === -1) throw new CypherValidationError("Comentário não terminado");
      i = end + 2;
      out += " ";
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < cypher.length && cypher[i] !== c) {
        if (cypher[i] === "\\" && c !== "`") i++;
        i++;
      }
      if (i >= cypher.length) throw new CypherValidationError("Texto ou identificador não terminado");
      i++;
      out += c === "`" ? " _ident_ " : " '' ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export interface CypherCheck {
  /** Parâmetros $nome referenciados pela consulta. */
  params: string[];
}

/**
 * Valida a consulta. Exige RETURN, `LIMIT $limit`, uma única instrução e nenhuma cláusula de
 * escrita/administração. `tenantScoped` exige o filtro por $auth_organizationId.
 */
export function validateCypher(cypher: string, opts: { tenantScoped: boolean }): CypherCheck {
  if (cypher.length > 10_000) throw new CypherValidationError("Consulta longa demais");
  const code = stripCypher(cypher);
  if (code.includes(";")) throw new CypherValidationError("Apenas uma instrução por consulta (sem ';')");
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, "i").test(code)) {
      throw new CypherValidationError(`Cláusula não permitida em consulta somente leitura: ${kw}`);
    }
  }
  if (FORBIDDEN_NAMESPACES.test(code)) throw new CypherValidationError("Procedimentos/funções apoc, gds e dbms não são permitidos");
  if (!/\bRETURN\b/i.test(code)) throw new CypherValidationError("A consulta deve conter RETURN");
  if (!/\bLIMIT\s+\$limit\b/i.test(code)) throw new CypherValidationError("A consulta deve terminar com LIMIT $limit");
  const params = [...new Set([...code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))];
  if (/\$\s*[`{]/.test(code)) throw new CypherValidationError("Use parâmetros simples ($nome)");
  if (opts.tenantScoped && !params.includes("auth_organizationId")) {
    throw new CypherValidationError("Consulta com escopo de organização deve usar $auth_organizationId");
  }
  return { params };
}

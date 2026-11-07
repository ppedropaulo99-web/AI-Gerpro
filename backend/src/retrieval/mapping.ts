/**
 * Mapeamento das bases corporativas: quais coleções do Qdrant e quais consultas Cypher
 * pré-autorizadas do Neo4j o AI Gerpro pode usar, e como seus campos viram fontes.
 *
 * O arquivo NÃO contém segredos (ficam no .env) e é mantido pela equipe que conhece os
 * esquemas reais. Nada aqui presume um esquema: todos os nomes de campos são declarados.
 * Exemplo comentado: backend/retrieval.config.example.json.
 */
import { readFileSync } from "node:fs";
import { CypherValidationError, SERVER_PARAMS, validateCypher } from "../adapters/cypher-guard.ts";

export interface CollectionMapping {
  /** Nome da coleção no Qdrant (deve existir; o AI Gerpro nunca a cria). */
  name: string;
  label: string;
  /** Vetor nomeado da coleção; null = vetor padrão (sem nome). */
  vectorName: string | null;
  /** Campo do payload com o texto do trecho. */
  contentField: string;
  titleField: string | null;
  urlField: string | null;
  /** Campos de identificação copiados para a referência (ex.: "documentId", "processoId"). */
  identifierFields: string[];
  /** Campo com o id da organização dona do ponto. Obrigatório, salvo `public: true`. */
  organizationField: string | null;
  /** Campo (lista) com as permissões que dão acesso ao ponto; null = sem filtro por permissão. */
  permissionsField: string | null;
  /** Coleção sem dados de organização (ex.: base normativa pública). */
  public: boolean;
  /** Permissão exigida no AuthContext para consultar a coleção; null = qualquer usuário autenticado. */
  requiredPermission: string | null;
  /** Campos que o SERVIDOR pode usar em filtros de metadados (nunca o navegador). */
  filterableFields: string[];
  /** Consultar automaticamente em cada pergunta. */
  searchByDefault: boolean;
  limit: number;
  scoreThreshold: number | null;
}

export type ParamType = "string" | "integer" | "number" | "boolean" | "string[]";

export interface ParamSpec {
  type: ParamType;
  required: boolean;
  maxLength: number;
  /** Expressão regular que o valor (ou cada item) deve satisfazer por inteiro. */
  pattern: RegExp | null;
}

export interface GraphQueryMapping {
  name: string;
  label: string;
  description: string;
  cypher: string;
  params: Record<string, ParamSpec>;
  maxRows: number;
  /** true (padrão) = a consulta filtra por $auth_organizationId. */
  tenantScoped: boolean;
  requiredPermission: string | null;
  /**
   * Execução a partir da pergunta: parâmetro → regex com 1 grupo de captura. A consulta roda
   * só quando TODOS os parâmetros obrigatórios forem extraídos (determinístico, sem o modelo).
   */
  fromQuestion: Record<string, RegExp> | null;
  /**
   * Termos que restringem a execução automática: se definidos, a consulta só roda quando a
   * pergunta atual contém um deles (sem diferenciar maiúsculas e acentos). Ex.: ["responsável"].
   */
  triggerTerms: string[] | null;
  /** Colunas do RETURN usadas na normalização. */
  idField: string;
  titleField: string | null;
  urlField: string | null;
  contentFields: string[];
  identifierFields: string[];
}

/** Liga um resultado do Qdrant a uma consulta do grafo por um identificador EXPLÍCITO. */
export interface GraphLinkMapping {
  collection: string;
  /** Campo do payload com o identificador compartilhado. */
  payloadField: string;
  query: string;
  /** Parâmetro da consulta que recebe o identificador. */
  param: string;
}

export interface RetrievalMapping {
  collections: CollectionMapping[];
  queries: GraphQueryMapping[];
  links: GraphLinkMapping[];
}

export const EMPTY_MAPPING: RetrievalMapping = { collections: [], queries: [], links: [] };

/** Minúsculas e sem acentos, para comparar termos. */
export function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export class MappingError extends Error {
  override name = "MappingError";
}

type Obj = Record<string, unknown>;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function only(o: Obj, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k) && !k.startsWith("$comment")) throw new MappingError(`${where}: campo desconhecido "${k}"`);
  }
}

function str(o: Obj, key: string, where: string, opts: { re?: RegExp; optional?: boolean } = {}): string | null {
  const v = o[key];
  if (v === undefined || v === null) {
    if (opts.optional) return null;
    throw new MappingError(`${where}.${key} é obrigatório`);
  }
  if (typeof v !== "string" || !v.trim()) throw new MappingError(`${where}.${key} deve ser texto não vazio`);
  if (opts.re && !opts.re.test(v)) throw new MappingError(`${where}.${key} tem formato inválido`);
  return v;
}

function req(o: Obj, key: string, where: string, re?: RegExp): string {
  return str(o, key, where, re ? { re } : {})!;
}

function fields(o: Obj, key: string, where: string): string[] {
  const v = o[key] ?? [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && FIELD.test(x))) {
    throw new MappingError(`${where}.${key} deve ser uma lista de nomes de campo`);
  }
  return [...new Set(v as string[])];
}

function int(o: Obj, key: string, where: string, fallback: number, min: number, max: number): number {
  const v = o[key] ?? fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new MappingError(`${where}.${key} deve ser inteiro entre ${min} e ${max}`);
  }
  return v;
}

function bool(o: Obj, key: string, where: string, fallback: boolean): boolean {
  const v = o[key] ?? fallback;
  if (typeof v !== "boolean") throw new MappingError(`${where}.${key} deve ser true ou false`);
  return v;
}

function regex(source: unknown, where: string, groups: boolean): RegExp {
  if (typeof source !== "string" || !source || source.length > 500) throw new MappingError(`${where} deve ser uma regex (texto)`);
  // Erro comum: em JSON, "\b" vira o caractere backspace (não a borda de palavra). Use "\\b", "\\d".
  if (/[\u0000-\u001f]/.test(source)) {
    throw new MappingError(`${where}: a regex contém caractere de controle; em JSON escreva barras duplas (ex.: "\\\\b", "\\\\d")`);
  }
  let re: RegExp;
  try {
    re = new RegExp(groups ? source : "^(?:" + source + ")$", "u");
  } catch {
    throw new MappingError(`${where}: regex inválida`);
  }
  if (groups && !/\((?!\?)/.test(source)) throw new MappingError(`${where}: a regex precisa de um grupo de captura`);
  return re;
}

function parseCollection(raw: unknown, i: number): CollectionMapping {
  const where = `qdrant.collections[${i}]`;
  if (!isObj(raw)) throw new MappingError(`${where} deve ser um objeto`);
  only(raw, [
    "name", "label", "vectorName", "contentField", "titleField", "urlField", "identifierFields", "organizationField",
    "permissionsField", "public", "requiredPermission", "filterableFields", "searchByDefault", "limit", "scoreThreshold",
  ], where);
  const isPublic = bool(raw, "public", where, false);
  const organizationField = str(raw, "organizationField", where, { re: FIELD, optional: true });
  if (!isPublic && organizationField === null) {
    throw new MappingError(`${where}.organizationField é obrigatório (ou declare "public": true conscientemente)`);
  }
  const threshold = raw["scoreThreshold"] ?? null;
  if (threshold !== null && (typeof threshold !== "number" || !Number.isFinite(threshold))) {
    throw new MappingError(`${where}.scoreThreshold deve ser número ou null`);
  }
  const name = req(raw, "name", where, NAME);
  return {
    name,
    label: str(raw, "label", where, { optional: true }) ?? name,
    vectorName: str(raw, "vectorName", where, { re: NAME, optional: true }),
    contentField: req(raw, "contentField", where, FIELD),
    titleField: str(raw, "titleField", where, { re: FIELD, optional: true }),
    urlField: str(raw, "urlField", where, { re: FIELD, optional: true }),
    identifierFields: fields(raw, "identifierFields", where),
    organizationField,
    permissionsField: str(raw, "permissionsField", where, { re: FIELD, optional: true }),
    public: isPublic,
    requiredPermission: str(raw, "requiredPermission", where, { optional: true }),
    filterableFields: fields(raw, "filterableFields", where),
    searchByDefault: bool(raw, "searchByDefault", where, true),
    limit: int(raw, "limit", where, 5, 1, 50),
    scoreThreshold: threshold as number | null,
  };
}

function parseParam(raw: unknown, where: string): ParamSpec {
  if (!isObj(raw)) throw new MappingError(`${where} deve ser um objeto`);
  only(raw, ["type", "required", "maxLength", "pattern"], where);
  const type = raw["type"];
  if (!["string", "integer", "number", "boolean", "string[]"].includes(type as string)) {
    throw new MappingError(`${where}.type deve ser string, integer, number, boolean ou string[]`);
  }
  return {
    type: type as ParamType,
    required: bool(raw, "required", where, true),
    maxLength: int(raw, "maxLength", where, 200, 1, 10_000),
    pattern: raw["pattern"] === undefined ? null : regex(raw["pattern"], `${where}.pattern`, false),
  };
}

function parseQuery(raw: unknown, i: number): GraphQueryMapping {
  const where = `neo4j.queries[${i}]`;
  if (!isObj(raw)) throw new MappingError(`${where} deve ser um objeto`);
  only(raw, [
    "name", "label", "description", "cypher", "params", "maxRows", "tenantScoped", "requiredPermission", "fromQuestion", "triggerTerms",
    "idField", "titleField", "urlField", "contentFields", "identifierFields",
  ], where);
  const name = req(raw, "name", where, /^[A-Za-z][A-Za-z0-9_]{0,63}$/);
  const cypherRaw = raw["cypher"];
  const cypher = Array.isArray(cypherRaw) && cypherRaw.every((l) => typeof l === "string") ? cypherRaw.join("\n") : cypherRaw;
  if (typeof cypher !== "string" || !cypher.trim()) throw new MappingError(`${where}.cypher é obrigatório`);
  const tenantScoped = bool(raw, "tenantScoped", where, true);

  const params: Record<string, ParamSpec> = {};
  const rawParams = raw["params"] ?? {};
  if (!isObj(rawParams)) throw new MappingError(`${where}.params deve ser um objeto`);
  for (const [pname, spec] of Object.entries(rawParams)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(pname)) throw new MappingError(`${where}.params: nome inválido "${pname}"`);
    if (pname.startsWith("auth_") || (SERVER_PARAMS as readonly string[]).includes(pname)) {
      throw new MappingError(`${where}.params.${pname}: nome reservado para parâmetros do servidor`);
    }
    params[pname] = parseParam(spec, `${where}.params.${pname}`);
  }

  let check;
  try {
    check = validateCypher(cypher, { tenantScoped });
  } catch (err) {
    if (err instanceof CypherValidationError) throw new MappingError(`${where}.cypher: ${err.message}`);
    throw err;
  }
  for (const p of check.params) {
    if (!(p in params) && !(SERVER_PARAMS as readonly string[]).includes(p)) {
      throw new MappingError(`${where}.cypher usa $${p}, que não foi declarado em params`);
    }
  }

  let fromQuestion: Record<string, RegExp> | null = null;
  if (raw["fromQuestion"] !== undefined && raw["fromQuestion"] !== null) {
    const fq = raw["fromQuestion"];
    if (!isObj(fq) || Object.keys(fq).length === 0) throw new MappingError(`${where}.fromQuestion deve ser um objeto não vazio`);
    fromQuestion = {};
    for (const [pname, source] of Object.entries(fq)) {
      const spec = params[pname];
      if (!spec) throw new MappingError(`${where}.fromQuestion.${pname} não está declarado em params`);
      if (spec.type !== "string") throw new MappingError(`${where}.fromQuestion.${pname}: apenas parâmetros string`);
      fromQuestion[pname] = regex(source, `${where}.fromQuestion.${pname}`, true);
    }
    const missing = Object.entries(params).filter(([p, s]) => s.required && !fromQuestion![p]).map(([p]) => p);
    if (missing.length) throw new MappingError(`${where}.fromQuestion não cobre os parâmetros obrigatórios: ${missing.join(", ")}`);
  }

  let triggerTerms: string[] | null = null;
  if (raw["triggerTerms"] !== undefined && raw["triggerTerms"] !== null) {
    const tt = raw["triggerTerms"];
    if (!Array.isArray(tt) || tt.length === 0 || tt.length > 50 || !tt.every((t) => typeof t === "string" && t.trim().length >= 2 && t.length <= 60)) {
      throw new MappingError(`${where}.triggerTerms deve ser uma lista de termos (2 a 60 caracteres)`);
    }
    if (!fromQuestion) throw new MappingError(`${where}.triggerTerms exige fromQuestion`);
    triggerTerms = [...new Set((tt as string[]).map((t) => normalizeText(t.trim())))];
  }

  const contentFields = fields(raw, "contentFields", where);
  if (contentFields.length === 0) throw new MappingError(`${where}.contentFields deve listar ao menos uma coluna`);
  return {
    name,
    label: str(raw, "label", where, { optional: true }) ?? name,
    description: str(raw, "description", where, { optional: true }) ?? "",
    cypher,
    params,
    maxRows: int(raw, "maxRows", where, 10, 1, 100),
    tenantScoped,
    requiredPermission: str(raw, "requiredPermission", where, { optional: true }),
    fromQuestion,
    triggerTerms,
    idField: req(raw, "idField", where, FIELD),
    titleField: str(raw, "titleField", where, { re: FIELD, optional: true }),
    urlField: str(raw, "urlField", where, { re: FIELD, optional: true }),
    contentFields,
    identifierFields: fields(raw, "identifierFields", where),
  };
}

function parseLink(raw: unknown, i: number, mapping: RetrievalMapping): GraphLinkMapping {
  const where = `neo4j.links[${i}]`;
  if (!isObj(raw)) throw new MappingError(`${where} deve ser um objeto`);
  only(raw, ["collection", "payloadField", "query", "param"], where);
  const link = {
    collection: req(raw, "collection", where, NAME),
    payloadField: req(raw, "payloadField", where, FIELD),
    query: req(raw, "query", where),
    param: req(raw, "param", where),
  };
  const col = mapping.collections.find((c) => c.name === link.collection);
  if (!col) throw new MappingError(`${where}.collection "${link.collection}" não está mapeada`);
  if (!col.identifierFields.includes(link.payloadField)) {
    throw new MappingError(`${where}.payloadField deve estar em identifierFields da coleção (identificador explícito)`);
  }
  const q = mapping.queries.find((x) => x.name === link.query);
  if (!q) throw new MappingError(`${where}.query "${link.query}" não está mapeada`);
  const spec = q.params[link.param];
  if (!spec || spec.type !== "string") throw new MappingError(`${where}.param deve ser um parâmetro string da consulta`);
  const others = Object.entries(q.params).filter(([p, s]) => p !== link.param && s.required);
  if (others.length) throw new MappingError(`${where}: a consulta tem outros parâmetros obrigatórios (${others.map(([p]) => p).join(", ")})`);
  return link;
}

/** Valida o conteúdo do arquivo de mapeamento. Lança MappingError com o local exato do problema. */
export function parseMapping(raw: unknown): RetrievalMapping {
  if (!isObj(raw)) throw new MappingError("O mapeamento deve ser um objeto JSON");
  only(raw, ["version", "qdrant", "neo4j"], "raiz");
  if (raw["version"] !== 1) throw new MappingError('raiz.version deve ser 1');
  const q = raw["qdrant"] ?? {};
  const n = raw["neo4j"] ?? {};
  if (!isObj(q) || !isObj(n)) throw new MappingError("qdrant e neo4j devem ser objetos");
  only(q, ["collections"], "qdrant");
  only(n, ["queries", "links"], "neo4j");
  const cols = q["collections"] ?? [];
  const qs = n["queries"] ?? [];
  const ls = n["links"] ?? [];
  if (!Array.isArray(cols) || !Array.isArray(qs) || !Array.isArray(ls)) throw new MappingError("collections, queries e links devem ser listas");

  const mapping: RetrievalMapping = { collections: cols.map(parseCollection), queries: qs.map(parseQuery), links: [] };
  const dup = (names: string[]) => names.find((x, i) => names.indexOf(x) !== i);
  const dc = dup(mapping.collections.map((c) => c.name));
  if (dc) throw new MappingError(`Coleção duplicada: ${dc}`);
  const dq = dup(mapping.queries.map((c) => c.name));
  if (dq) throw new MappingError(`Consulta duplicada: ${dq}`);
  mapping.links = ls.map((l, i) => parseLink(l, i, mapping));
  return mapping;
}

export function loadMappingFile(path: string): RetrievalMapping {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new MappingError(`Não foi possível ler o arquivo de mapeamento (RETRIEVAL_CONFIG_PATH)`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new MappingError(`Arquivo de mapeamento não é JSON válido: ${err instanceof Error ? err.message : err}`);
  }
  return parseMapping(json);
}

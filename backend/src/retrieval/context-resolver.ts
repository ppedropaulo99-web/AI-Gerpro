/**
 * Resolução de referências em perguntas de continuação ("Quem é o responsável por ele?").
 *
 * Regras de segurança:
 * - Identificadores só vêm do texto digitado pelo USUÁRIO (pergunta atual ou mensagens anteriores
 *   dele). Mensagens do assistente são ignoradas: o modelo não consegue introduzir identificadores.
 * - A extração usa as mesmas regex declaradas em `fromQuestion` no mapeamento (determinística).
 * - Nada é guardado no servidor: a cada pergunta, as consultas são refeitas com o AuthContext da
 *   requisição atual, que revalida organização e permissões. Identificadores vindos do histórico
 *   valem tanto quanto se o usuário os digitasse agora.
 * - Só a mensagem mais recente do usuário que contém identificadores é usada (âncora). Se ela tiver
 *   mais de um identificador, a referência é ambígua e o backend pede esclarecimento.
 * - Nunca concatena a conversa inteira à consulta.
 */
import { normalizeText, type GraphQueryMapping } from "./mapping.ts";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

/** Execução de consulta do grafo derivada da pergunta (ou do contexto). */
export interface GraphRun {
  query: string;
  params: Record<string, string>;
}

export type ReferenceResolution =
  | { kind: "none"; runs: []; values: [] }
  | { kind: "explicit"; runs: GraphRun[]; values: string[] }
  /** `turnsAgo`: quantas mensagens do usuário antes da atual está a âncora (1 = a anterior). */
  | { kind: "contextual"; runs: GraphRun[]; values: string[]; turnsAgo: number }
  | { kind: "ambiguous"; runs: []; values: string[] };

export interface ResolverOptions {
  /** Quantas mensagens anteriores do usuário examinar (padrão 4). */
  maxTurns: number;
  /** Máximo de identificadores distintos por pergunta explícita (padrão 3). */
  maxValues: number;
}

const DEFAULTS: ResolverOptions = { maxTurns: 4, maxValues: 3 };

/**
 * Indícios de que a pergunta depende de algo dito antes: pronomes/demonstrativos ou
 * início com conjunção ("E quais...", "Também..."). Falsos positivos só fazem o backend
 * considerar um identificador que o próprio usuário já informou, sob a autorização atual.
 */
const FOLLOW_UP = new RegExp(
  [
    "\\b(ele|ela|eles|elas|dele|dela|deles|delas|nele|nela|neles|nelas)\\b",
    "\\b(esse|essa|esses|essas|desse|dessa|desses|dessas|nesse|nessa|nesses|nessas)\\b",
    "\\b(este|esta|estes|estas|deste|desta|destes|destas|neste|nesta|isso|disso|nisso|aquele|aquela|daquele|daquela)\\b",
    "\\b(mesmo|mesma|referido|referida|mencionado|mencionada|citado|citada)\\b",
    "\\b(o|a|do|da|no|na) (processo|contrato|cliente|caso|documento|registro|acao|parte)\\b",
    "^\\s*(e|tambem|alem disso|e quanto|e sobre|e o|e a|e os|e as)\\b",
  ].join("|"),
  "i",
);

export function isFollowUp(question: string): boolean {
  return FOLLOW_UP.test(normalizeText(question));
}

interface Extraction {
  /** consulta → parâmetros extraídos (só consultas com todos os obrigatórios). */
  runs: GraphRun[];
  values: string[];
}

/** Extrai, de um texto do usuário, os identificadores definidos pelas regex `fromQuestion`. */
function extract(text: string, queries: readonly GraphQueryMapping[], maxValues: number): Extraction {
  const values = new Set<string>();
  const perQuery: { q: GraphQueryMapping; params: Record<string, string[]> }[] = [];
  for (const q of queries) {
    if (!q.fromQuestion) continue;
    const params: Record<string, string[]> = {};
    for (const [p, re] of Object.entries(q.fromQuestion)) {
      const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
      const found = [...text.matchAll(new RegExp(re.source, flags))].map((m) => m[1]?.trim()).filter((v): v is string => !!v);
      if (found.length) params[p] = [...new Set(found)];
    }
    if (Object.keys(params).length) perQuery.push({ q, params });
    for (const list of Object.values(params)) for (const v of list) values.add(v);
  }
  const runs: GraphRun[] = [];
  for (const { q, params } of perQuery) {
    const required = Object.entries(q.params).filter(([, s]) => s.required).map(([p]) => p);
    if (!required.every((p) => params[p]?.length)) continue;
    // Um parâmetro com vários valores gera uma execução por valor (limitado); os demais usam o 1º.
    const multi = required.find((p) => (params[p]?.length ?? 0) > 1) ?? required[0];
    const list = (multi ? params[multi] : undefined) ?? [];
    for (const v of list.slice(0, maxValues)) {
      const run: Record<string, string> = {};
      for (const [p, vs] of Object.entries(params)) run[p] = p === multi ? v : vs[0]!;
      runs.push({ query: q.name, params: run });
    }
    if (!multi) runs.push({ query: q.name, params: Object.fromEntries(Object.entries(params).map(([p, vs]) => [p, vs[0]!])) });
  }
  return { runs, values: [...values].slice(0, maxValues * 2) };
}

/** Aplica `triggerTerms`: a consulta só roda se a pergunta ATUAL contiver um dos termos. */
function byTrigger(runs: GraphRun[], question: string, queries: readonly GraphQueryMapping[]): GraphRun[] {
  const text = normalizeText(question);
  return runs.filter((r) => {
    const terms = queries.find((q) => q.name === r.query)?.triggerTerms;
    return !terms || terms.some((t) => text.includes(t));
  });
}

/**
 * Resolve as referências da pergunta atual.
 * @param history mensagens ANTERIORES à pergunta atual (a própria pergunta não entra).
 */
export function resolveReferences(
  question: string,
  history: readonly ConversationTurn[],
  queries: readonly GraphQueryMapping[],
  options: Partial<ResolverOptions> = {},
): ReferenceResolution {
  const opts = { ...DEFAULTS, ...options };
  const current = extract(question, queries, opts.maxValues);
  if (current.values.length) {
    return { kind: "explicit", runs: byTrigger(current.runs, question, queries), values: current.values };
  }
  // maxTurns 0 desativa a continuação (atenção: slice(-0) devolveria o histórico inteiro).
  if (opts.maxTurns <= 0 || !isFollowUp(question)) return { kind: "none", runs: [], values: [] };

  const userTurns = history.filter((t) => t.role === "user").slice(-opts.maxTurns).reverse();
  for (let i = 0; i < userTurns.length; i++) {
    const found = extract(userTurns[i]!.content, queries, opts.maxValues);
    if (!found.values.length) continue;
    if (found.values.length > 1) return { kind: "ambiguous", runs: [], values: found.values };
    return { kind: "contextual", runs: byTrigger(found.runs, question, queries), values: found.values, turnsAgo: i + 1 };
  }
  return { kind: "none", runs: [], values: [] };
}

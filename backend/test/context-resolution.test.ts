import { test } from "node:test";
import assert from "node:assert/strict";
import { isFollowUp, resolveReferences, type ConversationTurn } from "../src/retrieval/context-resolver.ts";
import { parseMapping } from "../src/retrieval/mapping.ts";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config/env.ts";
import { createRetrievalStack } from "../src/retrieval/bootstrap.ts";
import { RetrievalService } from "../src/retrieval/service.ts";
import { Neo4jGraphStore } from "../src/adapters/neo4j.ts";
import { QdrantVectorStore } from "../src/adapters/qdrant.ts";
import type { ChatMessage, LlmClient, LlmStreamEvent } from "../src/ollama/client.ts";
import { AUTH, FakeEmbeddings, FakeNeo4j, FakeQdrant, TEST_SECRET, nowSec, signJwt } from "./helpers/retrieval-fakes.ts";

/** Identificadores técnicos sintéticos (formato PRC-0000), sem relação com dados reais. */
const ID = "\\b(PRC-[0-9]{4})\\b";
const q = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  cypher: "MATCH (p:Item {codigo: $codigo}) WHERE p.org = $auth_organizationId RETURN p.codigo AS id, p.info AS info LIMIT $limit",
  params: { codigo: { type: "string", pattern: "PRC-[0-9]{4}" } },
  fromQuestion: { codigo: ID },
  idField: "id",
  contentFields: ["info"],
  ...extra,
});

function mapping() {
  return parseMapping({
    version: 1,
    qdrant: { collections: [{ name: "docs_teste", contentField: "texto", organizationField: "orgId" }] },
    neo4j: {
      queries: [
        q("itemPorCodigo"),
        q("responsavelDoItem", { triggerTerms: ["responsável", "responsavel"] }),
        q("contratosDoItem", { triggerTerms: ["contrato"], requiredPermission: "contratos:ler" }),
      ],
    },
  });
}
const queries = mapping().queries;
const u = (content: string): ConversationTurn => ({ role: "user", content });
const a = (content: string): ConversationTurn => ({ role: "assistant", content });
const runsOf = (r: ReturnType<typeof resolveReferences>) => r.runs.map((x) => `${x.query}:${x.params["codigo"]}`).sort();

// ---------------- Resolvedor ----------------

test("identificador explícito na pergunta atual tem prioridade", () => {
  const r = resolveReferences("Quais informações existem sobre o PRC-0001?", [u("Fale do PRC-0099")], queries);
  assert.equal(r.kind, "explicit");
  assert.deepEqual(r.values, ["PRC-0001"]);
  assert.deepEqual(runsOf(r), ["itemPorCodigo:PRC-0001"], "triggerTerms filtram as consultas específicas");
});

test("continuação resolve o identificador da mensagem anterior do usuário", () => {
  const hist = [u("Quais informações existem sobre o PRC-0001?"), a("Encontrei o registro [N1].")];
  const r1 = resolveReferences("Quem é o responsável por ele?", hist, queries);
  assert.equal(r1.kind, "contextual");
  assert.deepEqual(r1.values, ["PRC-0001"]);
  assert.deepEqual(runsOf(r1), ["itemPorCodigo:PRC-0001", "responsavelDoItem:PRC-0001"]);

  const r2 = resolveReferences("E quais contratos estão relacionados?", [...hist, u("Quem é o responsável por ele?"), a("…")], queries);
  assert.equal(r2.kind, "contextual");
  assert.deepEqual(runsOf(r2), ["contratosDoItem:PRC-0001", "itemPorCodigo:PRC-0001"]);
  assert.equal(r2.kind === "contextual" && r2.turnsAgo, 2, "âncora duas mensagens do usuário atrás");
});

test("identificadores em mensagens do assistente são ignorados (o modelo não cria referências)", () => {
  const r1 = resolveReferences("Quem é o responsável por ele?", [u("Fale do PRC-0001"), a("Talvez seja o PRC-0777.")], queries);
  assert.deepEqual(r1.values, ["PRC-0001"]);
  const r2 = resolveReferences("Quem é o responsável por ele?", [u("Quais itens existem?"), a("Há o PRC-0777 e o PRC-0778.")], queries);
  assert.equal(r2.kind, "none");
});

test("referência ambígua quando a mensagem-âncora tem mais de um identificador", () => {
  const r = resolveReferences("Quem é o responsável por ele?", [u("Compare o PRC-0001 com o PRC-0002")], queries);
  assert.equal(r.kind, "ambiguous");
  assert.deepEqual(r.values, ["PRC-0001", "PRC-0002"]);
  assert.equal(r.runs.length, 0);
});

test("a âncora é a mensagem mais recente do usuário com identificador", () => {
  const r = resolveReferences("E o responsável dele?", [u("Sobre o PRC-0001"), a("ok"), u("Agora o PRC-0002"), a("ok")], queries);
  assert.equal(r.kind, "contextual");
  assert.deepEqual(r.values, ["PRC-0002"]);
});

test("pergunta nova sem referência não herda contexto; janela de turnos é respeitada", () => {
  assert.equal(resolveReferences("Qual o horário de funcionamento do arquivo?", [u("Sobre o PRC-0001")], queries).kind, "none");
  const old = [u("Sobre o PRC-0001"), u("a"), u("b"), u("c"), u("d")];
  assert.equal(resolveReferences("Quem é o responsável por ele?", old, queries, { maxTurns: 4 }).kind, "none");
  assert.equal(resolveReferences("Quem é o responsável por ele?", old, queries, { maxTurns: 5 }).kind, "contextual");
  assert.equal(resolveReferences("Quem é o responsável por ele?", [u("Sobre o PRC-0001")], queries, { maxTurns: 0 }).kind, "none");
});

test("vários identificadores explícitos geram execuções limitadas", () => {
  const r = resolveReferences("Dados de PRC-0001, PRC-0002, PRC-0003 e PRC-0004", [], queries, { maxValues: 3 });
  assert.equal(r.kind, "explicit");
  assert.deepEqual(runsOf(r), ["itemPorCodigo:PRC-0001", "itemPorCodigo:PRC-0002", "itemPorCodigo:PRC-0003"]);
});

test("detecção de continuação (pt-BR, com e sem acentos)", () => {
  for (const s of ["Quem é o responsável por ele?", "E quais contratos estão relacionados?", "Qual o valor desse contrato?", "e sobre isso?", "Nele há prazos?"]) {
    assert.ok(isFollowUp(s), s);
  }
  for (const s of ["Como redigir uma notificação?", "Explique o que é prescrição."]) assert.ok(!isFollowUp(s), s);
});

// ---------------- Serviço ----------------

function service(contextTurns = 4) {
  const m = mapping();
  const neo = new FakeNeo4j();
  const qd = new FakeQdrant();
  const emb = new FakeEmbeddings();
  qd.points["docs_teste"] = [];
  neo.rows = (_c, p) => [{ id: p["codigo"], info: `Informação técnica de ${p["codigo"]}` }];
  const svc = new RetrievalService({
    vectorStore: new QdrantVectorStore(qd, m.collections, 1000),
    graphStore: new Neo4jGraphStore(neo, m.queries, 1000),
    embeddings: emb,
    mapping: m,
    config: { ...loadConfig({}).retrieval, contextTurns },
  });
  return { svc, neo, qd, emb };
}

test("serviço: continuação consulta o grafo com o identificador e a busca semântica recebe só pergunta + referência", async () => {
  const { svc, neo, emb } = service();
  const r = await svc.retrieve("Quem é o responsável por ele?", AUTH, undefined, [u("Informações sobre o PRC-0001, por favor"), a("…")]);
  assert.equal(r.resolution.kind, "contextual");
  assert.equal(r.grounding, "sources");
  assert.deepEqual(neo.calls.map((c) => c.params["codigo"]), ["PRC-0001", "PRC-0001"]);
  assert.equal(emb.calls[0], "Quem é o responsável por ele?\nReferência: PRC-0001", "não concatena a conversa inteira");
});

test("serviço: permissões revalidadas em cada pergunta (consulta exige contratos:ler)", async () => {
  const { svc, neo } = service();
  const hist = [u("Sobre o PRC-0001")];
  await svc.retrieve("E quais contratos estão relacionados?", AUTH, undefined, hist);
  assert.ok(!neo.calls.some((c) => c.metadata["query"] === "contratosDoItem"), "sem a permissão a consulta não roda");
  neo.calls = [];
  await svc.retrieve("E quais contratos estão relacionados?", { ...AUTH, permissions: ["contratos:ler"] }, undefined, hist);
  assert.ok(neo.calls.some((c) => c.metadata["query"] === "contratosDoItem"));
});

test("serviço: ambíguo não consulta nenhuma base; sem autorização o histórico nem é examinado", async () => {
  const { svc, neo, emb } = service();
  const amb = await svc.retrieve("Quem é o responsável por ele?", AUTH, undefined, [u("PRC-0001 ou PRC-0002?")]);
  assert.equal(amb.grounding, "ambiguous");
  assert.equal(neo.calls.length + emb.calls.length, 0);
  const unauth = await svc.retrieve("Quem é o responsável por ele?", null, undefined, [u("Sobre o PRC-0001")]);
  assert.equal(unauth.grounding, "unauthorized");
  assert.equal(unauth.resolution.kind, "none");
});

test("serviço: cancelamento antes da recuperação não chama os conectores", async () => {
  const { svc, neo, emb } = service();
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await svc.retrieve("Sobre o PRC-0001", AUTH, ctrl.signal);
  assert.equal(neo.calls.length + emb.calls.length, 0);
  assert.notEqual(r.grounding, "sources");
});

test("serviço: falha parcial na continuação (Neo4j fora) mantém a resposta com status de erro", async () => {
  const { svc, neo } = service();
  neo.error = Object.assign(new Error("x"), { code: "ServiceUnavailable" });
  const r = await svc.retrieve("Quem é o responsável por ele?", AUTH, undefined, [u("Sobre o PRC-0001")]);
  assert.equal(r.status.neo4j.state, "error");
  assert.equal(r.grounding, "unavailable");
});

// ---------------- Rotas ----------------

class RecLlm implements LlmClient {
  readonly model = "fake:1b";
  calls: ChatMessage[][] = [];
  async health() {
    return { reachable: true, modelAvailable: true, model: this.model, availableModels: [], version: "0", error: null };
  }
  async chat(messages: ChatMessage[]) {
    this.calls.push(messages);
    return { model: this.model, content: "Resposta [N1].", totalDurationMs: 1, promptTokens: 1, completionTokens: 1 };
  }
  async openChatStream(messages: ChatMessage[]): Promise<AsyncIterable<LlmStreamEvent>> {
    this.calls.push(messages);
    return (async function* (): AsyncGenerator<LlmStreamEvent> {
      yield { type: "content", text: "Resposta [N1]." };
      yield { type: "done", model: "fake:1b", totalDurationMs: 1, promptTokens: 1, completionTokens: 1 };
    })();
  }
}

function app() {
  const config = loadConfig({
    QDRANT_URL: "http://127.0.0.1:6333",
    NEO4J_URI: "bolt://127.0.0.1:7687",
    EMBEDDINGS_MODEL: "embed-teste",
    GERPRO_AUTH_MODE: "jwt-hs256",
    GERPRO_AUTH_JWT_SECRET: TEST_SECRET,
  });
  const neo = new FakeNeo4j();
  neo.rows = (_c, p) => [{ id: p["codigo"], info: `Informação técnica de ${p["codigo"]}` }];
  const qd = new FakeQdrant();
  qd.points["docs_teste"] = [];
  const stack = createRetrievalStack(config, { qdrantClient: qd, neo4jExecutor: neo, embeddings: new FakeEmbeddings(), mapping: mapping() });
  const llm = new RecLlm();
  return { app: buildApp({ config, version: "t", llm, ...stack }), llm, neo };
}
const tok = (org: string, perms: string[] = []) =>
  signJwt({ sub: "u-1", org, perms, iat: nowSec(), exp: nowSec() + 300 });
const convo = (follow: string) => ({
  messages: [
    { role: "user", content: "Quais informações existem sobre o PRC-0001?" },
    { role: "assistant", content: "Há registros [N1]." },
    { role: "user", content: follow },
  ],
});

test("rota: continuação usa o identificador do histórico e informa a resolução", async () => {
  const { app: a1, llm, neo } = app();
  const res = await a1.inject({ method: "POST", url: "/api/chat", headers: { authorization: `Bearer ${tok("org-1")}` }, payload: convo("Quem é o responsável por ele?") });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.resolution, { kind: "contextual", values: ["PRC-0001"] });
  assert.equal(body.grounding, "sources");
  assert.match(llm.calls[0]!.at(-2)!.content, /continuação sobre: PRC-0001/);
  assert.ok(neo.calls.every((c) => c.params["auth_organizationId"] === "org-1"));
});

test("rota: mudança de organização no token → mesmas perguntas consultadas sob a nova organização (sem cache)", async () => {
  const { app: a1, neo } = app();
  for (const org of ["org-1", "org-2"]) {
    await a1.inject({ method: "POST", url: "/api/chat", headers: { authorization: `Bearer ${tok(org)}` }, payload: convo("Quem é o responsável por ele?") });
  }
  const orgs = [...new Set(neo.calls.map((c) => c.params["auth_organizationId"]))];
  assert.deepEqual(orgs, ["org-1", "org-2"]);
});

test("rota: referência ambígua → pedido de esclarecimento determinístico, sem modelo nem bases (stream e completo)", async () => {
  const { app: a1, llm, neo } = app();
  const payload = {
    messages: [
      { role: "user", content: "Compare o PRC-0001 com o PRC-0002" },
      { role: "assistant", content: "…" },
      { role: "user", content: "Quem é o responsável por ele?" },
    ],
  };
  const headers = { authorization: `Bearer ${tok("org-1")}` };
  const full = await a1.inject({ method: "POST", url: "/api/chat", headers, payload });
  const body = full.json();
  assert.equal(body.grounding, "ambiguous");
  assert.match(body.message.content, /mais de um item/);
  assert.match(body.message.content, /PRC-0001/);
  assert.match(body.message.content, /PRC-0002/);

  const st = await a1.inject({ method: "POST", url: "/api/chat/stream", headers, payload });
  const evs = st.payload.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(evs.map((e: { type: string }) => e.type), ["start", "sources", "delta", "done"]);
  assert.equal(evs[1].grounding, "ambiguous");
  assert.deepEqual(evs[1].resolution.values, ["PRC-0001", "PRC-0002"]);
  assert.equal(llm.calls.length + neo.calls.length, 0);
});

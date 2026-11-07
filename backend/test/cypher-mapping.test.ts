import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCypher, CypherValidationError } from "../src/adapters/cypher-guard.ts";
import { parseMapping, MappingError } from "../src/retrieval/mapping.ts";
import { testMapping } from "./helpers/retrieval-fakes.ts";

const OK = "MATCH (n:Doc) WHERE n.org = $auth_organizationId RETURN n.id AS id LIMIT $limit";

test("cypher-guard aceita leitura com LIMIT $limit e filtro de organização", () => {
  assert.deepEqual(validateCypher(OK, { tenantScoped: true }).params.sort(), ["auth_organizationId", "limit"]);
});

test("cypher-guard rejeita escrita, administração e execução arbitrária", () => {
  const bad = [
    "CREATE (n:X) RETURN n LIMIT $limit",
    "MATCH (n) SET n.x = 1 RETURN n LIMIT $limit",
    "MATCH (n) DETACH DELETE n RETURN 1 LIMIT $limit",
    "MERGE (n:X {id: 1}) RETURN n LIMIT $limit",
    "MATCH (n) REMOVE n.x RETURN n LIMIT $limit",
    "LOAD CSV FROM 'file:///x' AS l RETURN l LIMIT $limit",
    "CALL db.labels() YIELD label RETURN label LIMIT $limit",
    "MATCH (n) RETURN apoc.text.join([], '') LIMIT $limit",
    "MATCH (n) RETURN n LIMIT $limit; MATCH (m) DELETE m",
    "MATCH (n) FOREACH (x IN [1] | SET n.y = x) RETURN n LIMIT $limit",
    "SHOW USERS",
    "match (n) set n.x=1 return n limit $limit", // minúsculas
  ];
  for (const c of bad) assert.throws(() => validateCypher(c, { tenantScoped: false }), CypherValidationError, c);
});

test("cypher-guard ignora palavras proibidas dentro de textos e comentários", () => {
  const c = "// não CREATE nada\nMATCH (n:Doc {status: 'DELETE pendente'}) WHERE n.`set` = $auth_organizationId RETURN n.id LIMIT $limit";
  assert.doesNotThrow(() => validateCypher(c, { tenantScoped: true }));
});

test("cypher-guard exige RETURN, LIMIT $limit e escopo de organização", () => {
  assert.throws(() => validateCypher("MATCH (n) RETURN n", { tenantScoped: false }), /LIMIT \$limit/);
  assert.throws(() => validateCypher("MATCH (n) RETURN n LIMIT 1000", { tenantScoped: false }), /LIMIT \$limit/);
  assert.throws(() => validateCypher("MATCH (n) RETURN n LIMIT $limit", { tenantScoped: true }), /auth_organizationId/);
});

test("mapeamento válido é carregado com padrões seguros", () => {
  const m = testMapping();
  assert.equal(m.collections[0]?.public, false);
  assert.equal(m.collections[0]?.searchByDefault, true);
  assert.equal(m.queries[0]?.tenantScoped, true);
  assert.ok(m.queries[0]?.params["codigo"]?.pattern?.test("REG-0001"));
  assert.ok(!m.queries[0]?.params["codigo"]?.pattern?.test("REG-0001 OR 1=1"), "pattern é ancorado");
});

const base = () => ({
  version: 1,
  qdrant: { collections: [{ name: "c", contentField: "t", organizationField: "org", identifierFields: ["rid"] }] },
  neo4j: {
    queries: [
      {
        name: "q",
        cypher: "MATCH (n {id: $id}) WHERE n.org = $auth_organizationId RETURN n.id AS id LIMIT $limit",
        params: { id: { type: "string" } },
        idField: "id",
        contentFields: ["id"],
      },
    ],
    links: [] as unknown[],
  },
});

test("mapeamento rejeita configurações inseguras ou incoerentes", () => {
  const cases: [string, (m: ReturnType<typeof base>) => void, RegExp][] = [
    ["coleção sem organizationField", (m) => delete (m.qdrant.collections[0] as Record<string, unknown>)["organizationField"], /organizationField/],
    ["campo desconhecido", (m) => ((m.qdrant.collections[0] as Record<string, unknown>)["apiKey"] = "x"), /desconhecido/],
    ["parâmetro não declarado", (m) => (m.neo4j.queries[0]!.params = {} as never), /não foi declarado/],
    ["parâmetro reservado", (m) => ((m.neo4j.queries[0]!.params as Record<string, unknown>)["auth_organizationId"] = { type: "string" }), /reservado/],
    ["Cypher de escrita", (m) => (m.neo4j.queries[0]!.cypher = "MATCH (n) DELETE n RETURN 1 LIMIT $limit"), /não permitida/],
    ["vínculo por campo não identificador", (m) => m.neo4j.links.push({ collection: "c", payloadField: "outro", query: "q", param: "id" }), /identifierFields/],
    ["vínculo para consulta inexistente", (m) => m.neo4j.links.push({ collection: "c", payloadField: "rid", query: "x", param: "id" }), /não está mapeada/],
  ];
  for (const [name, mutate, re] of cases) {
    const m = base();
    mutate(m);
    assert.throws(() => parseMapping(m), (err: unknown) => err instanceof MappingError && re.test(err.message), name);
  }
});

test("regex com caractere de controle (\"\\b\" mal escapado em JSON) é recusada; triggerTerms exige fromQuestion", () => {
  const m = base();
  Object.assign(m.neo4j.queries[0]!, { fromQuestion: { id: "\b(X-[0-9]+)\b" } });
  assert.throws(() => parseMapping(m), /caractere de controle/);
  const m2 = base();
  Object.assign(m2.neo4j.queries[0]!, { triggerTerms: ["responsável"] });
  assert.throws(() => parseMapping(m2), /triggerTerms exige fromQuestion/);
});

test("coleção pública precisa ser declarada explicitamente", () => {
  const m = base();
  delete (m.qdrant.collections[0] as Record<string, unknown>)["organizationField"];
  (m.qdrant.collections[0] as Record<string, unknown>)["public"] = true;
  assert.equal(parseMapping(m).collections[0]?.public, true);
});

test("o arquivo de exemplo retrieval.config.example.json é um mapeamento válido", () => {
  const raw = JSON.parse(readFileSync(new URL("../retrieval.config.example.json", import.meta.url), "utf8"));
  const m = parseMapping(raw);
  assert.ok(m.collections.length >= 1);
  assert.ok(m.queries.length >= 1);
});

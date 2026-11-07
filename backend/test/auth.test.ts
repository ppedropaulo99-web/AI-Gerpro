import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthError, JwtHs256Resolver, NoAuthResolver } from "../src/auth/context.ts";
import { loadConfig } from "../src/config/env.ts";
import { TEST_SECRET, nowSec, signJwt } from "./helpers/retrieval-fakes.ts";

function resolver(extra: Record<string, string> = {}) {
  const cfg = loadConfig({ GERPRO_AUTH_MODE: "jwt-hs256", GERPRO_AUTH_JWT_SECRET: TEST_SECRET, ...extra }).auth.jwt!;
  return new JwtHs256Resolver(cfg);
}
const claims = (over: Record<string, unknown> = {}) => ({
  sub: "u-1",
  org: "org-1",
  perms: ["docs:ler"],
  iat: nowSec(),
  exp: nowSec() + 300,
  ...over,
});
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

test("modo none nunca produz contexto (sem consultas corporativas)", async () => {
  assert.equal(await new NoAuthResolver().resolve(), null);
});

test("JWT válido produz contexto com usuário, organização e permissões", async () => {
  const ctx = await resolver().resolve(bearer(signJwt(claims())));
  assert.equal(ctx?.userId, "u-1");
  assert.equal(ctx?.organizationId, "org-1");
  assert.deepEqual(ctx?.permissions, ["docs:ler"]);
  assert.equal(ctx?.source, "jwt-hs256");
});

test("sem cabeçalho Authorization → null (não autenticado, sem erro)", async () => {
  assert.equal(await resolver().resolve({}), null);
});

test("credenciais inválidas são rejeitadas com AuthError", async () => {
  const r = resolver({ GERPRO_AUTH_JWT_ISSUER: "gerpro", GERPRO_AUTH_JWT_AUDIENCE: "ai-gerpro" });
  const good = { iss: "gerpro", aud: "ai-gerpro" };
  const cases: [string, Record<string, string>][] = [
    ["assinatura de outro segredo", bearer(signJwt(claims(good), "outro-segredo-qualquer-com-32-bytes!!"))],
    ["alg none", bearer(signJwt(claims(good), TEST_SECRET, { alg: "none" }))],
    ["alg HS512", bearer(signJwt(claims(good), TEST_SECRET, { alg: "HS512" }))],
    ["expirado", bearer(signJwt(claims({ ...good, iat: nowSec() - 900, exp: nowSec() - 600 })))],
    ["sem exp", bearer(signJwt(claims({ ...good, exp: undefined })))],
    ["validade longa demais", bearer(signJwt(claims({ ...good, exp: nowSec() + 86_400 })))],
    ["emissor errado", bearer(signJwt(claims({ ...good, iss: "outro" })))],
    ["audiência errada", bearer(signJwt(claims({ ...good, aud: "outro" })))],
    ["sem organização", bearer(signJwt(claims({ ...good, org: undefined })))],
    ["organização com caracteres inválidos", bearer(signJwt(claims({ ...good, org: "org' OR 1=1" })))],
    ["permissões não-lista", bearer(signJwt(claims({ ...good, perms: "admin" })))],
    ["token malformado", bearer("abc.def")],
    ["esquema não Bearer", { authorization: "Basic dXNlcjpzZW5oYQ==" }],
  ];
  for (const [name, headers] of cases) {
    await assert.rejects(r.resolve(headers), AuthError, name);
  }
  assert.ok(await r.resolve(bearer(signJwt(claims(good)))), "o mesmo token com claims corretas passa");
});

test("token adulterado (payload trocado) é rejeitado", async () => {
  const [h, , s] = signJwt(claims()).split(".");
  const forged = Buffer.from(JSON.stringify(claims({ org: "org-de-outro-cliente" }))).toString("base64url");
  await assert.rejects(resolver().resolve(bearer(`${h}.${forged}.${s}`)), /Assinatura/);
});

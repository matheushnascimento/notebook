// A sessão lacrada no cookie e as defesas do roteamento, sem rede: o app roda
// num servidor local, com o PGlite em memória, e o login não é chamado.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const SEGREDO = randomBytes(32).toString("base64url");
process.env.SEGREDO_SESSAO = SEGREDO;
process.env.BASE_URL = "https://notebook.test";
process.env.BANCO = ":memory:";
delete process.env.AUTENTICACAO;
delete process.env.DATABASE_URL;

const { tratar } = await import("../src/app.js");
const { chaveDe, lacrar } = await import("../src/cofre.js");
const CHAVE = chaveDe(SEGREDO);

let servidor;
let endereco;
before(async () => {
  servidor = createServer(tratar);
  await new Promise((pronto) => servidor.listen(0, "127.0.0.1", pronto));
  endereco = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => servidor.close());

const sessao = (dado, nome = "__Host-notebook") => `__Host-notebook=${lacrar(CHAVE, nome, dado)}`;
const valida = (sub = "ana") => ({ sub, nome: "Ana", idToken: `token-${sub}`, expiraEm: Date.now() + 60_000 });
const pedir = (caminho, { cookie, metodo = "GET", corpo, origem, tipo } = {}) =>
  fetch(endereco + caminho, {
    method: metodo,
    redirect: "manual",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(origem ? { origin: origem } : {}),
      ...(tipo ? { "content-type": tipo } : {}),
    },
    body: corpo,
  });

test("sem sessão: navegação vai pro login, API e POST respondem 401", async () => {
  let r = await pedir("/caderno/1");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/entrar?volta=%2Fcaderno%2F1");
  r = await pedir("/api/caderno/1");
  assert.equal(r.status, 401);
  r = await pedir("/caderno/novo", { metodo: "POST", corpo: "nome=x", origem: "https://notebook.test", tipo: "application/x-www-form-urlencoded" });
  assert.equal(r.status, 401);
  assert.equal((await pedir("/_mhdn/eu")).status, 401);
});

test("sessão lacrada válida abre o notebook, e cada um vê só o seu", async () => {
  const ana = sessao(valida("ana"));
  let r = await pedir("/caderno/novo", { cookie: ana, metodo: "POST", corpo: "nome=Caderno+da+Ana", origem: "https://notebook.test", tipo: "application/x-www-form-urlencoded" });
  assert.equal(r.status, 303);
  const [, id] = r.headers.get("location").match(/^\/caderno\/(\d+)\/editar$/);

  r = await pedir("/", { cookie: ana });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Caderno da Ana/);
  assert.deepEqual(await (await pedir("/_mhdn/eu", { cookie: ana })).json(), { nome: "Ana", sair: "/sair", metodo: "POST" });

  const bia = sessao(valida("bia"));
  assert.doesNotMatch(await (await pedir("/", { cookie: bia })).text(), /Caderno da Ana/);
  assert.equal((await pedir(`/caderno/${id}`, { cookie: bia })).status, 404);
  assert.equal((await pedir(`/api/caderno/${id}`, { cookie: bia })).status, 404);
});

test("lacre vencido, adulterado, de outra chave ou de outro cookie não é sessão", async () => {
  const vencida = { ...valida(), expiraEm: Date.now() - 1 };
  const boa = lacrar(CHAVE, "__Host-notebook", valida());
  const adulterada = boa.slice(0, -2) + (boa.at(-2) === "A" ? "BB" : "AA");
  const outraChave = lacrar(randomBytes(32), "__Host-notebook", valida());
  for (const cookie of [
    sessao(vencida),
    `__Host-notebook=${adulterada}`,
    `__Host-notebook=${outraChave}`,
    sessao(valida(), "__Host-notebook-login"),
    sessao({ nome: "sem sub", idToken: "t", expiraEm: Date.now() + 60_000 }),
    "__Host-notebook=lixo",
  ]) {
    const r = await pedir("/", { cookie });
    assert.equal(r.status, 303, cookie.slice(0, 60));
  }
});

test("POST de outra origem é recusado mesmo com sessão", async () => {
  const r = await pedir("/caderno/novo", { cookie: sessao(valida()), metodo: "POST", corpo: "nome=x", origem: "https://outro.site", tipo: "application/x-www-form-urlencoded" });
  assert.equal(r.status, 403);
});

test("id grande demais na URL é 404, não 500", async () => {
  const cookie = sessao(valida());
  assert.equal((await pedir("/caderno/99999999999", { cookie })).status, 404);
  assert.equal((await pedir("/sessao/2147483648", { cookie })).status, 404);
});

test("callback sem o lacre do login recomeça o login", async () => {
  const r = await pedir("/callback?code=x&state=y");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/entrar");
});

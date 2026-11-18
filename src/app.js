// notebook mhdn, em notebook.mhdn.com.br: o acompanhamento do modelo de
// estudo (cadernos, disciplinas, sessões e materiais), atrás da Conta mhdn.
//
// Mesmo molde do painel da Conta mhdn (central-contas/painel): servidor Node
// sem framework, páginas geradas no servidor e nenhum JavaScript no navegador.
// O login é OIDC na Conta mhdn, com Authorization Code + PKCE S256, pelo
// openid-client (doc 05 da central-contas: não implementar o fluxo à mão).
//
// Por que não o portão da central-contas: ele só repassa GET a páginas
// estáticas e não diz ao app quem entrou. Aqui há formulários e cada pessoa tem
// o próprio progresso, guardado pelo sub dela.
//
// AUTENTICACAO=local desliga o login para rodar na máquina, com um usuário só.
//
// Este arquivo é o app inteiro, sem servidor: exporta `tratar(req, res)`. Na
// Vercel, api/index.js é a função que o chama; no Docker e na máquina,
// src/server.js o põe atrás de um createServer. Nada fica na memória entre um
// pedido e outro: a sessão vai lacrada no cookie (src/cofre.js) e o progresso
// no Postgres (src/banco.js).

import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

import * as banco from "./banco.js";
import { ehEnderecoPostgres } from "./conexao.js";
import { chaveDe, lacrar, abrir, emPedacos, juntarPedacos, MAX_PEDACOS, nomeDoPedaco } from "./cofre.js";
import { operar, arvoreJson } from "./api.js";
import { ARQUIVOS_APP } from "./frontend.js";
import { lerMarkdown, escreverMarkdown, LIMITE_BYTES, MODELOS } from "./markdown.js";
import { renderInicio, renderCaderno, renderSessao, renderEditar, renderImportar, renderErro, ESTILO, CAMINHO_ESTILO } from "./paginas.js";

export const CONFIG = {
  // Endereço de descoberta = emissor (issuer_mode per_provider, ADR-006 da
  // central-contas).
  emissor: process.env.EMISSOR ?? "https://conta.mhdn.com.br/application/o/notebook/",
  conta: process.env.CONTA ?? "https://conta.mhdn.com.br",
  clientId: process.env.CLIENT_ID ?? "notebook",
  base: enderecoDoNotebook(),
  porta: Number(process.env.PORTA ?? 3000),
  // DATABASE_URL é o Supabase (postgres://, pelo pooler em modo transação). Sem
  // ela, BANCO é a pasta do PGlite, o Postgres embutido (src/conexao.js).
  banco: process.env.DATABASE_URL || process.env.BANCO || "/dados/pglite",
  local: process.env.AUTENTICACAO === "local",
  // Onde o modo local ouve: 127.0.0.1 por padrão, ou o IP da tailnet do
  // homeserver (100.64.0.0/10), pra testar de outro aparelho em
  // http://homeserver:19400. Nunca 0.0.0.0, que publicaria na rede local.
  escuta: process.env.ESCUTA ?? "127.0.0.1",
};

// O endereço público, que vira o redirect_uri. Num preview da Vercel é o
// endereço fixo da branch, que o blueprint aceita por regex. Por isso BASE_URL
// não se define na Vercel: ela venceria o endereço da branch.
function enderecoDoNotebook() {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_BRANCH_URL) return `https://${process.env.VERCEL_BRANCH_URL}`;
  return "https://notebook.mhdn.com.br";
}

// Na Vercel não há disco que dure: o progresso tem de ir pro Supabase. Sem a
// DATABASE_URL a função não sobe, em vez de gravar num PGlite que some.
if (process.env.VERCEL && !ehEnderecoPostgres(CONFIG.banco)) throw new Error("DATABASE_URL não definida");
// O SQLite de antes era um arquivo .db; o PGlite é uma pasta. Um BANCO velho
// apontando pro arquivo é recusado, em vez de virar uma pasta ao lado dele.
if (/\.db$/i.test(CONFIG.banco)) throw new Error(`BANCO=${CONFIG.banco} é o SQLite de antes: aponte pra uma pasta do PGlite`);

// Só openid e profile: o notebook precisa do sub, pra separar o progresso de
// cada pessoa, e do nome, pra nada além de cumprimentar. Sem email (ADR-004 da
// central-contas: escopo mínimo) e sem offline_access, porque o notebook não
// chama API nenhuma em nome da pessoa.
const ESCOPOS = "openid profile";
const COOKIE_SESSAO = "__Host-notebook";
const COOKIE_LOGIN = "__Host-notebook-login";
const DEZ_MINUTOS = 10 * 60 * 1000;
// A sessão do notebook não depende do access token, que ele não usa: dura 7
// dias. Vencida, entrar de novo é só um redirecionamento (sessão de 30 dias da
// Conta mhdn e consentimento implícito).
const SETE_DIAS = 7 * 24 * 60 * 60 * 1000;

// O modo local nunca roda com um endereço da mhdn: seria o app sem login
// publicado de verdade. Fora isso, o host de BASE_URL é aceito (ver atender).
const HOST_LOCAL = CONFIG.local ? new URL(CONFIG.base).host : null;
if (CONFIG.local && /(^|\.)mhdn\.com\.br$/i.test(new URL(CONFIG.base).hostname)) {
  console.error("AUTENTICACAO=local com BASE_URL da mhdn: recusado. Use localhost ou o endereço da tailnet.");
  process.exit(1);
}
const TAILNET = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;
if (CONFIG.local && CONFIG.escuta !== "127.0.0.1" && !TAILNET.test(CONFIG.escuta)) {
  console.error(`AUTENTICACAO=local com ESCUTA=${CONFIG.escuta}: recusado. Use 127.0.0.1 ou um IP da tailnet (100.64.0.0/10).`);
  process.exit(1);
}

// A conexão é aberta no primeiro pedido e reaproveitada pelos seguintes da
// mesma instância. Se falhar, o próximo pedido tenta de novo.
let conexao = null;
function db() {
  conexao ??= banco.abrirBanco(CONFIG.banco).catch((erro) => {
    conexao = null;
    throw erro;
  });
  return conexao;
}

// A sessão ({sub, nome, idToken, expiraEm}) e o login em andamento ficam no
// cookie, lacrados (src/cofre.js, cópia do painel da central-contas). Na Vercel
// a chave é obrigatória: sem ela a função não sobe, em vez de lacrar com uma
// chave que cada instância inventaria. Na máquina, sem chave, o notebook sorteia
// uma na partida, e reiniciar desloga todo mundo.
const CHAVE = process.env.SEGREDO_SESSAO ? chaveDe(process.env.SEGREDO_SESSAO) : chaveProvisoria();

function chaveProvisoria() {
  if (process.env.VERCEL) throw new Error("SEGREDO_SESSAO não definida");
  if (!CONFIG.local) console.warn("SEGREDO_SESSAO não definida: chave sorteada na partida.");
  return randomBytes(32);
}

// Sessões encerradas pelo Sair nesta instância, até o prazo delas. Sem isso, uma
// cópia do cookie tirada antes de sair abriria o notebook até o prazo. Na
// máquina há uma instância só, e a regra vale inteira; na Vercel vale só na
// instância que atendeu o Sair, como no portão da central-contas (ADR-027 dela).
const encerradas = new Map(); // sha256 do id token -> expiraEm
const marcaDaSessao = (sessao) => createHash("sha256").update(String(sessao.idToken)).digest("base64url");

let clienteOidc = null;
let configOidc = null;
async function oidc() {
  // Carregado só quando há login de verdade: o modo local roda sem npm install.
  clienteOidc ??= await import("openid-client");
  configOidc ??= await clienteOidc.discovery(new URL(CONFIG.emissor), CONFIG.clientId, undefined, clienteOidc.None());
  return { client: clienteOidc, config: configOidc };
}

function lerCookies(req) {
  const cookies = Object.create(null);
  for (const parte of (req.headers.cookie ?? "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0) cookies[parte.slice(0, i).trim()] = parte.slice(i + 1).trim();
  }
  return cookies;
}

function cookie(nome, valor, maxAgeSegundos) {
  // __Host- exige Secure, Path=/ e nenhum Domain: o cookie não vaza pra outro
  // subdomínio de mhdn.com.br.
  return `${nome}=${valor}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSegundos}`;
}

// Origem da Conta mhdn: a barra (ADR-021/023) carrega script, estilo e logo dela.
const ORIGEM_CONTA = new URL(CONFIG.conta).origin;

const CABECALHOS_SEGURANCA = {
  "Content-Security-Policy": [
    "default-src 'none'",
    // Script só do próprio notebook: os arquivos do React, com hash no nome.
    // Nada inline e nada de eval.
    // A barra da Conta mhdn: script, estilo e logo vêm da origem da conta.
    `script-src 'self' ${ORIGEM_CONTA}`,
    `style-src 'self' ${ORIGEM_CONTA}`,
    "connect-src 'self'",
    `img-src 'self' ${ORIGEM_CONTA}`,
    "font-src 'self'",
    // O Sair passa por /sair, que redireciona pra Conta mhdn encerrar a sessão.
    `form-action 'self' ${CONFIG.conta}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Cache-Control": "private, no-store",
};

function responder(res, status, corpo, cabecalhos = {}) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...CABECALHOS_SEGURANCA, ...cabecalhos });
  res.end(corpo);
}

function redirecionar(res, destino, cabecalhos = {}) {
  res.writeHead(303, { Location: destino, ...CABECALHOS_SEGURANCA, ...cabecalhos });
  res.end();
}

// A sessão vale até o expiraEm lacrado dentro dela, não até o Max-Age: o
// cookie pode ser guardado além do prazo, o lacre não. O id é a marca do id
// token: as páginas só olham se ele existe (sessão real, com barra e Sair).
function sessaoAtual(req) {
  if (CONFIG.local) return { id: null, sub: "local", nome: "local", podeSair: false };
  const sessao = abrir(CHAVE, COOKIE_SESSAO, juntarPedacos(lerCookies(req), COOKIE_SESSAO));
  if (!sessao || typeof sessao.sub !== "string" || !(Date.now() < sessao.expiraEm)) return null;
  const id = marcaDaSessao(sessao);
  if (encerradas.has(id)) return null;
  return { ...sessao, id, podeSair: true };
}

function gravarSessao(sessao, maxAgeSegundos) {
  return emPedacos(COOKIE_SESSAO, lacrar(CHAVE, COOKIE_SESSAO, sessao)).map(({ nome, valor }) =>
    cookie(nome, valor, valor ? maxAgeSegundos : 0),
  );
}

function apagarSessao() {
  return Array.from({ length: MAX_PEDACOS }, (_, i) => cookie(nomeDoPedaco(COOKIE_SESSAO, i), "", 0));
}

// Só volta pra um caminho do próprio notebook: nada de redirecionamento aberto.
const caminhoSeguro = (v) => (typeof v === "string" && /^\/(?!\/)[\w\-./]*$/.test(v) ? v : "/");

async function lerCorpo(req) {
  const partes = [];
  let tamanho = 0;
  for await (const parte of req) {
    tamanho += parte.length;
    if (tamanho > LIMITE_BYTES + 64 * 1024) throw Object.assign(new Error("corpo grande demais"), { status: 413 });
    partes.push(parte);
  }
  // O Request do próprio Node lê urlencoded e multipart, sem dependência.
  const pedido = new Request("http://notebook/", {
    method: "POST",
    headers: { "content-type": req.headers["content-type"] ?? "application/x-www-form-urlencoded" },
    body: Buffer.concat(partes),
  });
  return pedido.formData();
}

// JSON da API: só com Content-Type application/json, que um formulário de
// outro site não consegue mandar sem passar pelo CORS, e com teto de 64 KB.
async function lerJson(req) {
  if (!/^application\/json(;|$)/i.test(req.headers["content-type"] ?? "")) {
    throw Object.assign(new Error("tipo de conteúdo"), { status: 415, publico: "Use Content-Type: application/json." });
  }
  const partes = [];
  let tamanho = 0;
  for await (const parte of req) {
    tamanho += parte.length;
    if (tamanho > 64 * 1024) throw Object.assign(new Error("json grande demais"), { status: 413, publico: "Pedido grande demais." });
    partes.push(parte);
  }
  try {
    return JSON.parse(Buffer.concat(partes).toString("utf8"));
  } catch {
    throw Object.assign(new Error("json inválido"), { status: 400, publico: "JSON inválido." });
  }
}

function json(res, status, dado) {
  res.writeHead(status, { ...CABECALHOS_SEGURANCA, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(dado));
}

// --- Login -------------------------------------------------------------------

async function entrar(req, res, { url }) {
  if (CONFIG.local) return redirecionar(res, "/");
  const { client, config } = await oidc();
  const verificador = client.randomPKCECodeVerifier();
  const estado = client.randomState();
  const nonce = client.randomNonce();
  const pendente = lacrar(CHAVE, COOKIE_LOGIN, { verificador, estado, nonce, volta: caminhoSeguro(url.searchParams.get("volta")), criadoEm: Date.now() });

  const destino = client.buildAuthorizationUrl(config, {
    redirect_uri: `${CONFIG.base}/callback`,
    scope: ESCOPOS,
    code_challenge: await client.calculatePKCECodeChallenge(verificador),
    // S256 sempre: o authentik aceitaria plain, e omitir o parâmetro cairia em
    // plain (doc 05 da central-contas).
    code_challenge_method: "S256",
    state: estado,
    nonce,
  });
  redirecionar(res, destino.href, { "Set-Cookie": cookie(COOKIE_LOGIN, pendente, 600) });
}

async function callback(req, res) {
  // O lacre não some do servidor ao ser usado, como o Map sumia. Quem repetir
  // o callback esbarra no code, que o authentik só troca uma vez: o
  // invalid_grant leva de volta a /entrar, como um login vencido.
  const pendente = abrir(CHAVE, COOKIE_LOGIN, lerCookies(req)[COOKIE_LOGIN]);
  const limparLogin = cookie(COOKIE_LOGIN, "", 0);
  if (!pendente || !(Date.now() - pendente.criadoEm <= DEZ_MINUTOS)) {
    return redirecionar(res, "/entrar", { "Set-Cookie": limparLogin });
  }

  const { client, config } = await oidc();
  let tokens;
  try {
    tokens = await client.authorizationCodeGrant(config, new URL(req.url, CONFIG.base), {
      pkceCodeVerifier: pendente.verificador,
      expectedState: pendente.estado,
      expectedNonce: pendente.nonce,
      idTokenExpected: true,
    });
  } catch (erro) {
    if (erro?.error === "invalid_grant") return redirecionar(res, "/entrar", { "Set-Cookie": limparLogin });
    throw erro;
  }
  const claims = tokens.claims();

  const sessao = { sub: claims.sub, nome: claims.name ?? "", idToken: tokens.id_token, expiraEm: Date.now() + SETE_DIAS };
  redirecionar(res, caminhoSeguro(pendente.volta), {
    "Set-Cookie": [limparLogin, ...gravarSessao(sessao, SETE_DIAS / 1000)],
  });
}

async function sair(req, res, { sessao }) {
  const limpar = { "Set-Cookie": apagarSessao() };
  const agora = Date.now();
  for (const [marca, expiraEm] of encerradas) if (agora >= expiraEm) encerradas.delete(marca);
  encerradas.set(sessao.id, sessao.expiraEm);
  const { client, config } = await oidc();
  const destino = client.buildEndSessionUrl(config, {
    id_token_hint: sessao.idToken,
    post_logout_redirect_uri: `${CONFIG.base}/`,
  });
  redirecionar(res, destino.href, limpar);
}

// --- Páginas -----------------------------------------------------------------

const naoEncontrado = (res, sessao) =>
  responder(res, 404, renderErro("Não encontrado.", "Esse caderno ou essa sessão não existe, ou não é seu.", sessao));

async function inicio(req, res, { sessao }) {
  responder(res, 200, renderInicio({ usuario: sessao, cadernos: await banco.arvore(await db(), sessao.sub) }));
}

async function verCaderno(req, res, { sessao, params, url }) {
  const c = await banco.caderno(await db(), sessao.sub, Number(params[0]));
  if (!c) return naoEncontrado(res, sessao);
  const importado = url.searchParams.get("importado");
  const aviso = importado != null ? `Importado: ${importado} materiais novos, ${url.searchParams.get("marcados") ?? 0} marcados como concluídos.` : null;
  responder(res, 200, renderCaderno({ usuario: sessao, caderno: c, aviso }));
}

async function baixarCaderno(req, res, { sessao, params }) {
  const c = await banco.caderno(await db(), sessao.sub, Number(params[0]));
  if (!c) return naoEncontrado(res, sessao);
  const arquivo = c.nome.normalize("NFD").replace(/[^\w\- ]/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "caderno";
  res.writeHead(200, {
    ...CABECALHOS_SEGURANCA,
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename="${arquivo}.md"`,
  });
  res.end(escreverMarkdown(c));
}

async function excluir(req, res, { sessao, params }) {
  await banco.excluirCaderno(await db(), sessao.sub, Number(params[0]));
  redirecionar(res, "/");
}

async function verSessao(req, res, { sessao, params }) {
  const r = await banco.sessao(await db(), sessao.sub, Number(params[0]));
  if (!r) return naoEncontrado(res, sessao);
  responder(res, 200, renderSessao({ usuario: sessao, ...r }));
}

async function alternar(req, res, { sessao, params }) {
  const sessaoId = await banco.alternarMaterial(await db(), sessao.sub, Number(params[0]));
  if (sessaoId == null) return naoEncontrado(res, sessao);
  redirecionar(res, `/sessao/${sessaoId}`);
}

async function marcarSessao(req, res, { sessao, params }) {
  const corpo = await lerCorpo(req);
  const id = Number(params[0]);
  await banco.marcarSessao(await db(), sessao.sub, id, corpo.get("acao") === "concluir");
  redirecionar(res, `/sessao/${id}`);
}

// --- API do editor em React (#9) ---------------------------------------------

async function apiLer(req, res, { sessao, params }) {
  const c = await banco.caderno(await db(), sessao.sub, Number(params[0]));
  if (!c) return json(res, 404, { erro: "Caderno não encontrado." });
  json(res, 200, { caderno: arvoreJson(c) });
}

async function apiOperar(req, res, { sessao, params }) {
  try {
    const r = await operar(await db(), sessao.sub, Number(params[0]), await lerJson(req));
    if (!r) return json(res, 404, { erro: "Caderno não encontrado." });
    json(res, 200, r);
  } catch (erro) {
    if (!erro.publico) throw erro;
    json(res, erro.status ?? 400, { erro: erro.publico });
  }
}

async function novoCaderno(req, res, { sessao }) {
  const corpo = await lerCorpo(req);
  const r = await banco.criarCaderno(await db(), sessao.sub, corpo.get("nome"));
  if (r.erro) {
    return responder(res, 422, renderInicio({ usuario: sessao, cadernos: await banco.arvore(await db(), sessao.sub), erro: r.erro, nomeNovo: String(corpo.get("nome") ?? "") }));
  }
  redirecionar(res, `/caderno/${r.id}/editar`);
}

async function verEditar(req, res, { sessao, params }) {
  const c = await banco.caderno(await db(), sessao.sub, Number(params[0]));
  if (!c) return naoEncontrado(res, sessao);
  responder(res, 200, renderEditar({ usuario: sessao, caderno: c, modelos: MODELOS }));
}

async function editar(req, res, { sessao, params }) {
  const id = Number(params[0]);
  const corpo = await lerCorpo(req);
  const campos = [...corpo.entries()].filter(([, v]) => typeof v === "string");
  const r = await banco.aplicarEdicao(await db(), sessao.sub, id, campos, corpo.get("acao"), MODELOS);
  if (!r) return naoEncontrado(res, sessao);
  if (r.excluiuCaderno) return redirecionar(res, "/");
  // Com aviso ou pedido de confirmação, a página volta já com eles, em vez de
  // redirecionar: o que precisa de atenção fica no topo, à vista.
  if (r.avisos.length || r.confirmar) {
    const status = r.avisos.length ? 422 : 200;
    return responder(res, status, renderEditar({ usuario: sessao, caderno: await banco.caderno(await db(), sessao.sub, id), avisos: r.avisos, confirmar: r.confirmar, modelos: MODELOS }));
  }
  redirecionar(res, `/caderno/${id}/editar${r.foco ? `#${r.foco}` : ""}`);
}

async function concluir(req, res, { sessao, params }) {
  const r = await banco.alternarConclusao(await db(), sessao.sub, params[0], Number(params[1]));
  if (!r) return naoEncontrado(res, sessao);
  const destino = { s: `/sessao/${r.id}`, d: `/caderno/${r.cadernoId}#d-${r.id}`, c: `/caderno/${r.cadernoId}` }[r.tipo];
  redirecionar(res, destino);
}

function formImportar(req, res, { sessao }) {
  responder(res, 200, renderImportar({ usuario: sessao }));
}

async function importar(req, res, { sessao }) {
  const corpo = await lerCorpo(req);
  const arquivo = corpo.get("arquivo");
  let texto = typeof arquivo === "object" && arquivo?.size ? await arquivo.text() : "";
  if (!texto.trim()) texto = String(corpo.get("texto") ?? "");
  if (Buffer.byteLength(texto) > LIMITE_BYTES) {
    return responder(res, 413, renderImportar({ usuario: sessao, avisos: ["O arquivo passa de 512 KB."] }));
  }

  const { cadernos, avisos } = lerMarkdown(texto);
  // Com qualquer aviso, nada é gravado: a pessoa corrige e importa de novo, em
  // vez de ficar com metade do arquivo dentro.
  if (avisos.length) return responder(res, 422, renderImportar({ usuario: sessao, avisos, texto }));

  const r = await banco.importar(await db(), sessao.sub, cadernos);
  const destino = r.cadernos.length === 1 ? `/caderno/${r.cadernos[0]}?importado=${r.criados}&marcados=${r.marcados}` : "/";
  redirecionar(res, destino);
}

// --- Roteamento --------------------------------------------------------------

const EXEMPLO = readFileSync(new URL("../exemplos/exemplo.md", import.meta.url));
const ESTATICOS = Object.assign(Object.create(null), {
  // Nome com hash: pode ficar em cache pra sempre, porque CSS novo é outro nome.
  [CAMINHO_ESTILO]: { tipo: "text/css; charset=utf-8", conteudo: ESTILO, imutavel: true },
  "/modelo.md": { tipo: "text/markdown; charset=utf-8", conteudo: EXEMPLO, baixar: "modelo-notebook.md" },
});
// Fontes e marca: lidas uma vez na partida, com lista fechada de nomes. Nenhuma
// parte da URL vira caminho de arquivo, então não há como sair da pasta.
for (const nome of ["eb-garamond-500", "newsreader-400", "newsreader-600"]) {
  ESTATICOS[`/fonts/${nome}.woff2`] = { tipo: "font/woff2", conteudo: readFileSync(new URL(`./fonts/${nome}.woff2`, import.meta.url)) };
}
// O frontend em React: arquivos com hash no nome, então cache imutável.
for (const [caminho, arquivo] of Object.entries(ARQUIVOS_APP)) ESTATICOS[caminho] = { ...arquivo, imutavel: true };
for (const nome of ["logo.svg", "favicon-livro-simples.svg"]) {
  ESTATICOS[`/marca/${nome}`] = { tipo: "image/svg+xml", conteudo: readFileSync(new URL(`./marca/${nome}`, import.meta.url)) };
}

// [método, padrão, função]. As rotas daqui pra baixo exigem sessão.
const ROTAS = [
  ["GET", /^\/$/, inicio],
  ["GET", /^\/importar$/, formImportar],
  ["POST", /^\/importar$/, importar],
  ["GET", /^\/api\/caderno\/(\d+)$/, apiLer],
  ["POST", /^\/api\/caderno\/(\d+)$/, apiOperar],
  ["POST", /^\/caderno\/novo$/, novoCaderno],
  ["GET", /^\/caderno\/(\d+)$/, verCaderno],
  ["GET", /^\/caderno\/(\d+)\/editar$/, verEditar],
  ["POST", /^\/caderno\/(\d+)\/editar$/, editar],
  ["GET", /^\/caderno\/(\d+)\.md$/, baixarCaderno],
  ["POST", /^\/caderno\/(\d+)\/excluir$/, excluir],
  ["GET", /^\/sessao\/(\d+)$/, verSessao],
  ["POST", /^\/sessao\/(\d+)\/marcar$/, marcarSessao],
  ["POST", /^\/material\/(\d+)\/alternar$/, alternar],
  ["POST", /^\/concluir\/([cds])\/(\d+)$/, concluir],
  ["POST", /^\/sair$/, sair],
];

// GET /_mhdn/eu: contrato da barra da Conta mhdn. Quem está logado recebe o
// nome (só claims.name: preferred_username é o email, e não sai daqui) e o
// caminho de Sair. Sem sessão, 401, e a barra mostra só o logo e o tema.
function euDaBarra(req, res) {
  const sessao = sessaoAtual(req);
  if (!sessao || !sessao.id) return json(res, 401, { erro: "Sem sessão." });
  return json(res, 200, { nome: sessao.nome, sair: "/sair", metodo: "POST" });
}

async function atender(req, res) {
  const url = new URL(req.url, CONFIG.base);
  const caminho = url.pathname;
  // HEAD é atendido como GET: o Node descarta o corpo sozinho. Sem isso, a
  // conferência com curl -I recebia 404.
  const metodo = req.method === "HEAD" ? "GET" : req.method;

  // O modo local não tem login, então só atende quem chama pela própria
  // máquina, ou pelo endereço de BASE_URL (o da tailnet, pra testar de outro
  // aparelho). Em 2026-11-12 o npm run local ocupou a porta de produção, e o
  // túnel do Cloudflare, que aponta pra localhost, o publicou em
  // notebook.mhdn.com.br. O túnel manda o Host público, e aqui ele é recusado.
  const host = req.headers.host ?? "";
  if (CONFIG.local && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) && host !== HOST_LOCAL) {
    res.writeHead(421, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("modo local: só atende localhost\n");
  }

  if (metodo === "GET" && caminho === "/saude") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  const estatico = metodo === "GET" && ESTATICOS[caminho];
  if (estatico) {
    res.writeHead(200, {
      "Content-Type": estatico.tipo,
      "Cache-Control": estatico.imutavel ? "public, max-age=31536000, immutable" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      ...(estatico.baixar ? { "Content-Disposition": `attachment; filename="${estatico.baixar}"` } : {}),
    });
    return res.end(estatico.conteudo);
  }
  if (metodo === "GET" && caminho === "/_mhdn/eu") return euDaBarra(req, res);
  if (metodo === "GET" && caminho === "/entrar") return entrar(req, res, { url });
  if (metodo === "GET" && caminho === "/callback") return callback(req, res);

  let rota = null;
  let params = null;
  for (const [metodoRota, padrao, funcao] of ROTAS) {
    const m = caminho.match(padrao);
    if (m && metodoRota === metodo) {
      rota = funcao;
      params = m.slice(1);
      break;
    }
  }
  if (!rota) return responder(res, 404, renderErro("Página não encontrada.", "Volte aos cadernos.", sessaoAtual(req)));

  const sessao = sessaoAtual(req);
  if (!sessao) {
    // A API responde 401 em JSON: quem chama é o editor, não uma navegação.
    if (caminho.startsWith("/api/")) return json(res, 401, { erro: "Sua sessão acabou. Recarregue a página para entrar de novo." });
    if (metodo !== "GET") return responder(res, 401, renderErro("Sua sessão acabou.", "Entre de novo e repita a ação."));
    return redirecionar(res, `/entrar?volta=${encodeURIComponent(caminho)}`);
  }
  // Contra CSRF: toda ação tem de vir de uma página do próprio notebook. Além
  // do SameSite=Lax do cookie, que já barra o POST vindo de outro site.
  if (req.method === "POST" && req.headers.origin !== new URL(CONFIG.base).origin) {
    if (caminho.startsWith("/api/")) return json(res, 403, { erro: "Pedido recusado: origem diferente do notebook." });
    return responder(res, 403, renderErro("Pedido recusado.", "Abra o notebook e repita a ação por ele.", sessao));
  }
  return rota(req, res, { sessao, params, url });
}

export async function tratar(req, res) {
  try {
    await atender(req, res);
  } catch (erro) {
    // Nada de token, nome ou IP no log: só o que falhou e onde.
    console.error(`${req.method} ${new URL(req.url, CONFIG.base).pathname}: ${erro.code ?? ""} ${erro.message}`);
    // Só mensagem escrita pra pessoa (erro.publico) chega à tela; o resto é genérico.
    if (!res.headersSent) responder(res, erro.status ?? 500, renderErro(erro.publico ? "Não deu para gravar." : "Algo deu errado.", erro.publico ?? "Tente de novo em instantes."));
  }
}

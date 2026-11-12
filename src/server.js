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

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import * as banco from "./banco.js";
import { lerMarkdown, escreverMarkdown, LIMITE_BYTES } from "./markdown.js";
import { renderInicio, renderCaderno, renderSessao, renderImportar, renderErro, ESTILO } from "./paginas.js";

const CONFIG = {
  // Endereço de descoberta = emissor (issuer_mode per_provider, ADR-006 da
  // central-contas).
  emissor: process.env.EMISSOR ?? "https://conta.mhdn.com.br/application/o/notebook/",
  conta: process.env.CONTA ?? "https://conta.mhdn.com.br",
  clientId: process.env.CLIENT_ID ?? "notebook",
  base: process.env.BASE_URL ?? "https://notebook.mhdn.com.br",
  porta: Number(process.env.PORTA ?? 3000),
  banco: process.env.BANCO ?? "/dados/notebook.db",
  local: process.env.AUTENTICACAO === "local",
};

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

const db = banco.abrirBanco(CONFIG.banco);

// Sessões só em memória, como no painel: reiniciar desloga todo mundo, e entrar
// de novo é um redirecionamento. O progresso fica no banco, não na sessão.
const sessoes = new Map(); // id -> { sub, nome, idToken, expiraEm }
const loginsPendentes = new Map(); // id -> { verificador, estado, nonce, volta, criadoEm }

let clienteOidc = null;
let configOidc = null;
async function oidc() {
  // Carregado só quando há login de verdade: o modo local roda sem npm install.
  clienteOidc ??= await import("openid-client");
  configOidc ??= await clienteOidc.discovery(new URL(CONFIG.emissor), CONFIG.clientId, undefined, clienteOidc.None());
  return { client: clienteOidc, config: configOidc };
}

const idAleatorio = () => randomBytes(32).toString("base64url");

function lerCookies(req) {
  const cookies = {};
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

const CABECALHOS_SEGURANCA = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self'",
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

function sessaoAtual(req) {
  if (CONFIG.local) return { id: null, sub: "local", nome: "local", podeSair: false };
  const id = lerCookies(req)[COOKIE_SESSAO];
  const sessao = id && sessoes.get(id);
  if (!sessao) return null;
  if (Date.now() >= sessao.expiraEm) {
    sessoes.delete(id);
    return null;
  }
  return { id, ...sessao, podeSair: true };
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

// --- Login -------------------------------------------------------------------

async function entrar(req, res, { url }) {
  if (CONFIG.local) return redirecionar(res, "/");
  const { client, config } = await oidc();
  const verificador = client.randomPKCECodeVerifier();
  const estado = client.randomState();
  const nonce = client.randomNonce();
  const id = idAleatorio();
  loginsPendentes.set(id, { verificador, estado, nonce, volta: caminhoSeguro(url.searchParams.get("volta")), criadoEm: Date.now() });

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
  redirecionar(res, destino.href, { "Set-Cookie": cookie(COOKIE_LOGIN, id, 600) });
}

async function callback(req, res) {
  const id = lerCookies(req)[COOKIE_LOGIN];
  const pendente = id && loginsPendentes.get(id);
  loginsPendentes.delete(id);
  const limparLogin = cookie(COOKIE_LOGIN, "", 0);
  if (!pendente || Date.now() - pendente.criadoEm > DEZ_MINUTOS) {
    return redirecionar(res, "/entrar", { "Set-Cookie": limparLogin });
  }

  const { client, config } = await oidc();
  const tokens = await client.authorizationCodeGrant(config, new URL(req.url, CONFIG.base), {
    pkceCodeVerifier: pendente.verificador,
    expectedState: pendente.estado,
    expectedNonce: pendente.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();

  const sessaoId = idAleatorio();
  sessoes.set(sessaoId, { sub: claims.sub, nome: claims.name ?? claims.preferred_username ?? "", idToken: tokens.id_token, expiraEm: Date.now() + SETE_DIAS });
  redirecionar(res, pendente.volta, {
    "Set-Cookie": [limparLogin, cookie(COOKIE_SESSAO, sessaoId, SETE_DIAS / 1000)],
  });
}

async function sair(req, res, { sessao }) {
  const limpar = { "Set-Cookie": cookie(COOKIE_SESSAO, "", 0) };
  sessoes.delete(sessao.id);
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

function inicio(req, res, { sessao }) {
  responder(res, 200, renderInicio({ usuario: sessao, cadernos: banco.arvore(db, sessao.sub) }));
}

function verCaderno(req, res, { sessao, params, url }) {
  const c = banco.caderno(db, sessao.sub, Number(params[0]));
  if (!c) return naoEncontrado(res, sessao);
  const importado = url.searchParams.get("importado");
  const aviso = importado != null ? `Importado: ${importado} materiais novos, ${url.searchParams.get("marcados") ?? 0} marcados como concluídos.` : null;
  responder(res, 200, renderCaderno({ usuario: sessao, caderno: c, aviso }));
}

function baixarCaderno(req, res, { sessao, params }) {
  const c = banco.caderno(db, sessao.sub, Number(params[0]));
  if (!c) return naoEncontrado(res, sessao);
  const arquivo = c.nome.normalize("NFD").replace(/[^\w\- ]/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "caderno";
  res.writeHead(200, {
    ...CABECALHOS_SEGURANCA,
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename="${arquivo}.md"`,
  });
  res.end(escreverMarkdown(c));
}

function excluir(req, res, { sessao, params }) {
  banco.excluirCaderno(db, sessao.sub, Number(params[0]));
  redirecionar(res, "/");
}

function verSessao(req, res, { sessao, params }) {
  const r = banco.sessao(db, sessao.sub, Number(params[0]));
  if (!r) return naoEncontrado(res, sessao);
  responder(res, 200, renderSessao({ usuario: sessao, ...r }));
}

function alternar(req, res, { sessao, params }) {
  const sessaoId = banco.alternarMaterial(db, sessao.sub, Number(params[0]));
  if (sessaoId == null) return naoEncontrado(res, sessao);
  redirecionar(res, `/sessao/${sessaoId}`);
}

async function marcarSessao(req, res, { sessao, params }) {
  const corpo = await lerCorpo(req);
  const id = Number(params[0]);
  banco.marcarSessao(db, sessao.sub, id, corpo.get("acao") === "concluir");
  redirecionar(res, `/sessao/${id}`);
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

  const r = banco.importar(db, sessao.sub, cadernos);
  const destino = r.cadernos.length === 1 ? `/caderno/${r.cadernos[0]}?importado=${r.criados}&marcados=${r.marcados}` : "/";
  redirecionar(res, destino);
}

// --- Roteamento --------------------------------------------------------------

const EXEMPLO = readFileSync(new URL("../exemplos/cst-mba.md", import.meta.url));
const ESTATICOS = {
  "/estilo.css": { tipo: "text/css; charset=utf-8", conteudo: ESTILO },
  "/modelo.md": { tipo: "text/markdown; charset=utf-8", conteudo: EXEMPLO, baixar: "modelo-notebook.md" },
};
// Fontes e marca: lidas uma vez na partida, com lista fechada de nomes. Nenhuma
// parte da URL vira caminho de arquivo, então não há como sair da pasta.
for (const nome of ["eb-garamond-500", "newsreader-400", "newsreader-600"]) {
  ESTATICOS[`/fonts/${nome}.woff2`] = { tipo: "font/woff2", conteudo: readFileSync(new URL(`./fonts/${nome}.woff2`, import.meta.url)) };
}
for (const nome of ["logo.svg", "favicon-livro-simples.svg"]) {
  ESTATICOS[`/marca/${nome}`] = { tipo: "image/svg+xml", conteudo: readFileSync(new URL(`./marca/${nome}`, import.meta.url)) };
}

// [método, padrão, função]. As rotas daqui pra baixo exigem sessão.
const ROTAS = [
  ["GET", /^\/$/, inicio],
  ["GET", /^\/importar$/, formImportar],
  ["POST", /^\/importar$/, importar],
  ["GET", /^\/caderno\/(\d+)$/, verCaderno],
  ["GET", /^\/caderno\/(\d+)\.md$/, baixarCaderno],
  ["POST", /^\/caderno\/(\d+)\/excluir$/, excluir],
  ["GET", /^\/sessao\/(\d+)$/, verSessao],
  ["POST", /^\/sessao\/(\d+)\/marcar$/, marcarSessao],
  ["POST", /^\/material\/(\d+)\/alternar$/, alternar],
  ["POST", /^\/sair$/, sair],
];

async function atender(req, res) {
  const url = new URL(req.url, CONFIG.base);
  const caminho = url.pathname;

  if (req.method === "GET" && caminho === "/saude") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  const estatico = req.method === "GET" && ESTATICOS[caminho];
  if (estatico) {
    res.writeHead(200, {
      "Content-Type": estatico.tipo,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      ...(estatico.baixar ? { "Content-Disposition": `attachment; filename="${estatico.baixar}"` } : {}),
    });
    return res.end(estatico.conteudo);
  }
  if (req.method === "GET" && caminho === "/entrar") return entrar(req, res, { url });
  if (req.method === "GET" && caminho === "/callback") return callback(req, res);

  let rota = null;
  let params = null;
  for (const [metodo, padrao, funcao] of ROTAS) {
    const m = caminho.match(padrao);
    if (m && metodo === req.method) {
      rota = funcao;
      params = m.slice(1);
      break;
    }
  }
  if (!rota) return responder(res, 404, renderErro("Página não encontrada.", "Volte aos cadernos.", sessaoAtual(req)));

  const sessao = sessaoAtual(req);
  if (!sessao) {
    if (req.method !== "GET") return responder(res, 401, renderErro("Sua sessão acabou.", "Entre de novo e repita a ação."));
    return redirecionar(res, `/entrar?volta=${encodeURIComponent(caminho)}`);
  }
  // Contra CSRF: toda ação tem de vir de uma página do próprio notebook. Além
  // do SameSite=Lax do cookie, que já barra o POST vindo de outro site.
  if (req.method === "POST" && req.headers.origin !== new URL(CONFIG.base).origin) {
    return responder(res, 403, renderErro("Pedido recusado.", "Abra o notebook e repita a ação por ele.", sessao));
  }
  return rota(req, res, { sessao, params, url });
}

setInterval(() => {
  // Faxina: logins abandonados e sessões vencidas não ficam na memória.
  const agora = Date.now();
  for (const [id, l] of loginsPendentes) if (agora - l.criadoEm > DEZ_MINUTOS) loginsPendentes.delete(id);
  for (const [id, s] of sessoes) if (agora >= s.expiraEm) sessoes.delete(id);
}, 60_000).unref();

createServer(async (req, res) => {
  try {
    await atender(req, res);
  } catch (erro) {
    // Nada de token, nome ou IP no log: só o que falhou e onde.
    console.error(`${req.method} ${new URL(req.url, CONFIG.base).pathname}: ${erro.code ?? ""} ${erro.message}`);
    if (!res.headersSent) responder(res, erro.status ?? 500, renderErro("Algo deu errado.", "Tente de novo em instantes."));
  }
}).listen(CONFIG.porta, () => console.log(`notebook ouvindo na porta ${CONFIG.porta}${CONFIG.local ? " (modo local, sem login)" : ""}`));

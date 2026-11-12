// Páginas do notebook, geradas no servidor. Sem framework e sem JavaScript no
// navegador, como o painel da Conta mhdn: marcar um material é um formulário.
//
// Tudo que vem do banco ou do .md passa por esc() antes de entrar no HTML.

import { createHash } from "node:crypto";

import { MODELOS } from "./markdown.js";
import { SCRIPTS } from "./app.js";

const esc = (valor) =>
  String(valor ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const pct = (no) => (no.concluido ? 100 : no.total ? Math.round((no.feitos / no.total) * 100) : 0);

// Gênero de cada nível, pros rótulos: "caderno concluído", "sessão concluída".
const NIVEL = {
  c: { nome: "caderno", concluido: "concluído" },
  d: { nome: "disciplina", concluido: "concluída" },
  s: { nome: "sessão", concluido: "concluída" },
};

const DATA = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });

function pagina(titulo, corpo, { usuario, migalhas = [] } = {}) {
  const trilha = migalhas.length
    ? `<nav class="migalhas" aria-label="Você está em"><a href="/">Cadernos</a>${migalhas
        .map(([texto, href]) => ` <span aria-hidden="true">/</span> ${href ? `<a href="${esc(href)}">${esc(texto)}</a>` : `<span>${esc(texto)}</span>`}`)
        .join("")}</nav>`
    : "";
  const sair = usuario?.podeSair ? `<form method="post" action="/sair"><button type="submit" class="secundario">Sair</button></form>` : "";
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)} · notebook mhdn</title>
<link rel="icon" href="/marca/favicon-livro-simples.svg">
<link rel="stylesheet" href="${CAMINHO_ESTILO}">
</head>
<body>
<main>
<header>
  <a class="marca" href="/"><img class="logo" src="/marca/logo.svg" alt="mhdn" width="40" height="45"><span>notebook</span></a>
  ${sair}
</header>
${trilha}
${corpo}
</main>
<footer>notebook &middot; mhdn.com.br</footer>
</body>
</html>`;
}

function barra(no, rotulo) {
  // Concluído, mesmo sem materiais, enche a barra.
  const max = no.total || 1;
  return `<progress value="${no.concluido ? max : no.feitos}" max="${max}" aria-label="${esc(rotulo)}">${pct(no)}%</progress>`;
}

// O contador mostra os materiais marcados de fato. Concluído a mão com material
// em aberto aparece como "7/9 · concluída", e a barra cheia.
function contador(no, tipo) {
  const estado = no.concluido && tipo ? NIVEL[tipo].concluido : `${pct(no)}%`;
  return `<span class="contador">${no.feitosReais ?? no.feitos}/${no.total} &middot; ${estado}</span>`;
}

// Concluir ou reabrir um nível. Concluído sozinho, com todos os filhos
// concluídos, não tem o que reabrir: o botão só aparece no que depende de mão.
function conclusao(tipo, no) {
  const { nome, concluido } = NIVEL[tipo];
  if (no.manual) {
    const quando = no.concluidoEm ? ` em ${esc(DATA.format(new Date(no.concluidoEm)))}` : "";
    const faltam = no.total - no.feitosReais;
    const aberto = faltam > 0 ? `, com ${faltam === 1 ? "1 material" : `${faltam} materiais`} em aberto` : "";
    return `<form method="post" action="/concluir/${tipo}/${no.id}" class="conclusao">
  <span class="detalhe">${nome[0].toUpperCase()}${nome.slice(1)} ${concluido}${quando}${aberto}.</span>
  <button type="submit" class="secundario">Reabrir ${nome}</button>
</form>`;
  }
  if (no.concluido) return "";
  return `<form method="post" action="/concluir/${tipo}/${no.id}" class="conclusao">
  <button type="submit" class="secundario">Concluir ${nome}</button>
</form>`;
}

// --- Início ------------------------------------------------------------------

export function renderInicio({ usuario, cadernos, erro = null, nomeNovo = "" }) {
  const cartoes = cadernos.map(
    (c) => `
<a class="cartao" href="/caderno/${c.id}">
  <div class="linha-titulo"><h2>${esc(c.nome)}</h2>${contador(c, "c")}</div>
  ${barra(c, `Progresso de ${c.nome}`)}
  <span class="detalhe">${c.disciplinas.length} ${c.disciplinas.length === 1 ? "disciplina" : "disciplinas"} &middot; ${c.sessoesConcluidas} de ${c.sessoesTotal} sessões concluídas</span>
  ${c.concluido ? `<span class="selo">concluído</span>` : c.proximo ? `<span class="detalhe">A seguir: ${esc(c.proximo.sessao.nome)}, ${esc(c.proximo.material.nome)}</span>` : ""}
</a>`,
  );
  const vazio = `
<section>
  <h2>Nenhum caderno ainda</h2>
  <p>Crie um caderno aqui embaixo e monte as disciplinas, as sessões e os materiais pela edição, ou traga tudo de uma vez num arquivo .md.</p>
  <p><a class="botao" href="/importar">Importar um .md</a> <a href="/modelo.md">Baixar o exemplo</a></p>
</section>`;
  const novo = `
<form class="novo-caderno" method="post" action="/caderno/novo">
  <label for="novo-caderno">Novo caderno</label>
  <div class="linha-campo"><input id="novo-caderno" name="nome" required maxlength="200" placeholder="CST, MBA FM2S..." value="${esc(nomeNovo)}"><button type="submit">Criar</button></div>
  ${erro ? `<p class="aviso" role="alert">${esc(erro)}</p>` : ""}
</form>`;
  const corpo = `
<div class="linha-titulo"><h1>Seus cadernos</h1><a class="botao" href="/importar">Importar .md</a></div>
${cadernos.length ? cartoes.join("") : vazio}
${novo}`;
  return pagina("Cadernos", corpo, { usuario });
}

// --- Caderno -----------------------------------------------------------------

export function renderCaderno({ usuario, caderno: c, aviso }) {
  const continuar = c.proximo
    ? `<a class="cartao destaque" href="/sessao/${c.proximo.sessao.id}">
  <span class="rotulo">Continuar</span>
  <strong>${esc(c.proximo.sessao.nome)}</strong>
  <span class="detalhe">${esc(c.proximo.sessao.disciplina)} &middot; próximo: ${esc(c.proximo.material.nome)}</span>
</a>`
    : "";

  const disciplinas = c.disciplinas.map(
    (d) => `
<section id="d-${d.id}">
  <div class="linha-titulo"><h2>${esc(d.nome)}</h2>${contador(d, "d")}</div>
  ${barra(d, `Progresso de ${d.nome}`)}
  <div class="linha-titulo"><span class="detalhe">${d.sessoesConcluidas} de ${d.sessoes.length} sessões concluídas</span>${conclusao("d", d)}</div>
  <ul class="sessoes">
    ${d.sessoes
      .map(
        (s) => `<li><a href="/sessao/${s.id}" class="${s.concluido ? "feito" : ""}">
      <span class="linha-titulo"><span class="nome">${s.concluido ? '<span class="caixa marcada" aria-hidden="true"></span>' : ""}${esc(s.nome)}</span>${contador(s, "s")}</span>
      ${barra(s, `Progresso de ${s.nome}`)}
    </a></li>`,
      )
      .join("")}
  </ul>
</section>`,
  );

  const corpo = `
${aviso ? `<p class="aviso-ok" role="status">${esc(aviso)}</p>` : ""}
<div class="linha-titulo"><h1>${esc(c.nome)}</h1>${contador(c, "c")}</div>
${barra(c, `Progresso de ${c.nome}`)}
<div class="linha-titulo"><p class="detalhe">${c.sessoesConcluidas} de ${c.sessoesTotal} sessões concluídas</p><span class="em-lote">${conclusao("c", c)}<a class="botao secundario" href="/caderno/${c.id}/editar">Editar</a></span></div>
${continuar}
${disciplinas.join("") || `<section><p>Este caderno ainda não tem disciplinas.</p><p><a class="botao" href="/caderno/${c.id}/editar">Montar o caderno</a></p></section>`}
<section class="acoes">
  <h2>Caderno</h2>
  <p><a class="botao" href="/importar">Acrescentar por .md</a> <a href="/caderno/${c.id}.md">Baixar como .md</a></p>
  <p class="detalhe">O .md baixado volta com o progresso marcado em [x]. Edite e importe de novo para acrescentar sessões e materiais.</p>
  <details>
    <summary>Excluir este caderno</summary>
    <form method="post" action="/caderno/${c.id}/excluir">
      <p>Apaga o caderno, as disciplinas, as sessões e todo o progresso. Não dá para desfazer.</p>
      <button type="submit" class="perigo">Excluir ${esc(c.nome)}</button>
    </form>
  </details>
</section>`;
  return pagina(c.nome, corpo, { usuario, migalhas: [[c.nome]] });
}

// --- Sessão ------------------------------------------------------------------

export function renderSessao({ usuario, caderno: c, sessao: s, anterior, seguinte }) {
  const materiais = s.materiais.map(
    (m) => `<li>
  <form method="post" action="/material/${m.id}/alternar">
    <button type="submit" class="material${m.feito ? " feito" : ""}" aria-pressed="${m.feito}">
      <span class="caixa${m.feito ? " marcada" : ""}" aria-hidden="true"></span>
      <span class="nome">${esc(m.nome)}</span>
      ${m.feito && m.feitoEm ? `<span class="quando">${esc(DATA.format(new Date(m.feitoEm)))}</span>` : ""}
    </button>
  </form>
</li>`,
  );

  const vizinha = (v, rotulo) => (v ? `<a href="/sessao/${v.id}"><span class="rotulo">${rotulo}</span>${esc(v.nome)}</a>` : "<span></span>");

  const corpo = `
<span class="rotulo">${esc(s.disciplina)}</span>
<div class="linha-titulo"><h1>${esc(s.nome)}</h1>${contador(s, "s")}</div>
${barra(s, `Progresso de ${s.nome}`)}
${conclusao("s", s) || `<p class="detalhe">Sessão concluída: todos os materiais estão marcados.</p>`}
<section>
  ${materiais.length ? `<ul class="materiais">${materiais.join("")}</ul>` : "<p>Esta sessão ainda não tem materiais.</p>"}
  ${
    materiais.length
      ? `<div class="em-lote">
    <form method="post" action="/sessao/${s.id}/marcar"><input type="hidden" name="acao" value="concluir"><button type="submit" class="secundario">Concluir todos</button></form>
    <form method="post" action="/sessao/${s.id}/marcar"><input type="hidden" name="acao" value="limpar"><button type="submit" class="secundario">Desmarcar todos</button></form>
  </div>`
      : ""
  }
</section>
<p><a href="/caderno/${c.id}/editar?foco=s-${s.id}#s-${s.id}">Editar esta sessão</a></p>
<nav class="vizinhas" aria-label="Outras sessões">${vizinha(anterior, "Anterior")}${vizinha(seguinte, "Seguinte")}</nav>`;
  return pagina(s.nome, corpo, { usuario, migalhas: [[c.nome, `/caderno/${c.id}`], [s.nome]] });
}

// --- Editar ------------------------------------------------------------------
//
// A árvore do caderno em listas aninhadas, num formulário só. Cada envio salva
// todos os nomes e os itens novos digitados, e depois faz a ação do botão
// apertado. O primeiro botão do formulário é o Salvar, então Enter em qualquer
// campo salva. Sem JavaScript: subir e descer no lugar de arrastar.

function controles(tipo, id, nome, { primeiro, ultimo }) {
  const botao = (verbo, simbolo, rotulo, desligado, classe = "") =>
    `<button type="submit" name="acao" value="${verbo}:${tipo}:${id}" class="icone${classe}" title="${rotulo}" aria-label="${esc(`${rotulo}: ${nome}`)}"${desligado ? " disabled" : ""}>${simbolo}</button>`;
  return `<span class="controles">${botao("subir", "&uarr;", "Subir", primeiro)}${botao("descer", "&darr;", "Descer", ultimo)}${botao("excluir", "&times;", "Excluir", false, " excluir")}</span>`;
}

function linha(tipo, id, nome, rotulo, posicao, extra = "") {
  return `<div class="linha-item">
    <input name="nome:${tipo}:${id}" value="${esc(nome)}" maxlength="200" required aria-label="${esc(rotulo)}">${extra}${controles(tipo, id, nome, posicao)}
  </div>`;
}

function novo(campo, placeholder, botaoValor, rotulo, extra = "") {
  return `<li class="novo"><div class="linha-item"><input name="${campo}" maxlength="200" placeholder="${esc(placeholder)}" aria-label="${esc(rotulo)}">${extra}<button type="submit" name="acao" value="${botaoValor}" class="secundario">Acrescentar</button></div></li>`;
}

const posicao = (lista, i) => ({ primeiro: i === 0, ultimo: i === lista.length - 1 });

export function renderEditar({ usuario, caderno: c, avisos = [], confirmar = null, modelos }) {
  const escolhaModelo = (idDisciplina) =>
    `<select name="modelo:s:${idDisciplina}" aria-label="Modelo da sessão nova"><option value="">vazia</option>${Object.keys(modelos)
      .map((m) => `<option value="${m}">modelo ${m}</option>`)
      .join("")}</select>`;

  const arvore = c.disciplinas
    .map(
      (d, i) => `<li id="d-${d.id}" class="nivel-d">
  ${linha("d", d.id, d.nome, "Nome da disciplina", posicao(c.disciplinas, i))}
  <ol class="filhos">
    ${d.sessoes
      .map(
        (s, j) => `<li id="s-${s.id}" class="nivel-s">
      ${linha("s", s.id, s.nome, `Nome da sessão, em ${d.nome}`, posicao(d.sessoes, j), `<span class="contador">${s.feitosReais}/${s.total}</span>`)}
      <ol class="filhos">
        ${s.materiais
          .map(
            (m, k) => `<li id="m-${m.id}" class="nivel-m">${linha("m", m.id, m.nome, `Nome do material, em ${s.nome}`, posicao(s.materiais, k), m.feito ? '<span class="caixa marcada" title="concluído" aria-label="concluído"></span>' : '<span class="caixa" title="em aberto" aria-label="em aberto"></span>')}</li>`,
          )
          .join("")}
        ${novo(`novo:m:${s.id}`, "Novo material", `salvar:s:${s.id}`, `Novo material em ${s.nome}`)}
      </ol>
    </li>`,
      )
      .join("")}
    ${novo(`novo:s:${d.id}`, "Nova sessão", `salvar:d:${d.id}`, `Nova sessão em ${d.nome}`, escolhaModelo(d.id))}
  </ol>
</li>`,
    )
    .join("");

  const confirmacao = confirmar
    ? `<section class="alerta" id="confirmar" role="alert">
  <h2>Excluir ${esc(confirmar.rotulo)} ${esc(confirmar.nome)}?</h2>
  <p>${
    confirmar.tipo === "s"
      ? `Sai junto ${confirmar.materiais === 1 ? "1 material" : `${confirmar.materiais} materiais`}, com o progresso.`
      : `Sai junto ${confirmar.sessoes === 1 ? "1 sessão" : `${confirmar.sessoes} sessões`} e ${confirmar.materiais === 1 ? "1 material" : `${confirmar.materiais} materiais`}, com o progresso.`
  } Não dá para desfazer.</p>
  <div class="em-lote"><button type="submit" name="acao" value="confirmar:${confirmar.tipo}:${confirmar.id}" class="perigo">Excluir</button><a class="botao secundario" href="/caderno/${c.id}/editar#${confirmar.tipo}-${confirmar.id}">Cancelar</a></div>
</section>`
    : "";

  const listaAvisos = avisos.length ? `<section class="alerta" role="alert"><ul>${avisos.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></section>` : "";

  // O formulário abaixo é o editor sem JavaScript. Com o bundle do React, ele
  // monta por cima dele dentro de #editor-app, sem recarregar a página (#9).
  const script = SCRIPTS.editor ? `<script type="module" src="${SCRIPTS.editor}"></script>` : "";
  const corpo = `
<div id="editor-app" data-caderno="${c.id}">
<form method="post" action="/caderno/${c.id}/editar" class="editor">
  <div class="barra-salvar"><h1>Editar</h1><span class="em-lote"><button type="submit" name="acao" value="salvar">Salvar</button><a class="botao secundario" href="/caderno/${c.id}">Concluir</a></span></div>
  ${confirmacao}
  ${listaAvisos}
  <section>
    <label for="nome-caderno">Nome do caderno</label>
    <div class="linha-item" id="c-${c.id}"><input id="nome-caderno" name="nome:c:${c.id}" value="${esc(c.nome)}" maxlength="200" required>${controles("c", c.id, c.nome, { primeiro: false, ultimo: false })}</div>
    <p class="detalhe">As setas mudam a posição do caderno na lista de cadernos.</p>
  </section>
  <section>
    <h2>Disciplinas, sessões e materiais</h2>
    <ol class="arvore">
      ${arvore}
      ${novo("novo:d", "Nova disciplina", `salvar:c:${c.id}`, "Nova disciplina")}
    </ol>
    <p class="detalhe">Os nomes digitados são salvos com qualquer botão. Uma sessão nova com modelo já vem com os materiais dele: ${Object.entries(modelos)
      .map(([m, passos]) => `<strong>${m}</strong> (${passos.length} materiais)`)
      .join(", ")}.</p>
  </section>
  <p><button type="submit" name="acao" value="salvar">Salvar</button></p>
</form>
</div>
${script}`;
  return pagina(`Editar ${c.nome}`, corpo, { usuario, migalhas: [[c.nome, `/caderno/${c.id}`], ["Editar"]] });
}

// --- Importar ----------------------------------------------------------------

export function renderImportar({ usuario, avisos = [], texto = "" }) {
  const listaAvisos = avisos.length
    ? `<section class="alerta" role="alert"><h2>Não deu para importar tudo</h2><ul>${avisos.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></section>`
    : "";
  const modelos = Object.entries(MODELOS)
    .map(([nome, passos]) => `<li><strong>modelo: ${nome}</strong><span class="detalhe">${passos.map(esc).join(" &middot; ")}</span></li>`)
    .join("");
  const corpo = `
<h1>Importar .md</h1>
${listaAvisos}
<section>
  <form method="post" action="/importar" enctype="multipart/form-data">
    <label for="arquivo">Arquivo .md</label>
    <input id="arquivo" name="arquivo" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain">
    <label for="texto">Ou cole o conteúdo</label>
    <textarea id="texto" name="texto" rows="14" spellcheck="false" placeholder="# CST&#10;## Prática em gestão&#10;modelo: cst&#10;### PGUN1 - Unidade 1">${esc(texto)}</textarea>
    <p><button type="submit">Importar</button></p>
  </form>
  <p class="detalhe">A importação mescla com o que já existe: o que tem o mesmo nome é reaproveitado, nada é apagado e nenhum material concluído volta a ficar em aberto.</p>
</section>
<section>
  <h2>O formato</h2>
<pre><code># CST                    ← caderno
## Prática em gestão     ← disciplina
modelo: cst              ← opcional
### PGUN1 - Unidade 1    ← sessão
- [ ] Vídeo              ← material
- [x] Ebook 1/2          ← material concluído
### PGUN2 - Unidade 2
concluído: sim           ← sessão concluída, mesmo com
- [ ] Aula com docente      material em aberto</code></pre>
  <p>Uma sessão sem materiais na lista recebe os do modelo indicado na sessão, na disciplina ou no caderno, nessa ordem:</p>
  <ul>${modelos}</ul>
  <p><a href="/modelo.md">Baixar o exemplo completo</a></p>
</section>`;
  return pagina("Importar", corpo, { usuario, migalhas: [["Importar"]] });
}

export function renderErro(titulo, texto, usuario) {
  return pagina(titulo, `<h1>${esc(titulo)}</h1><p>${esc(texto)}</p><p><a class="botao" href="/">Voltar aos cadernos</a></p>`, { usuario });
}

export const ESTILO = `
/* Tokens do brandbook mhdn, os mesmos do painel da Conta mhdn (ADR-010 da
   central-contas): papel/noite. Fundo nunca é branco puro; cartões sobem pra
   papel-cartao com a sombra-folha; raio-md de 10px; mhdn sempre em
   minúsculas; títulos em caixa de frase; nenhuma fonte sem serifa. */
@font-face { font-family: "EB Garamond"; font-weight: 500; font-style: normal; font-display: swap; src: url("/fonts/eb-garamond-500.woff2") format("woff2"); }
@font-face { font-family: "Newsreader"; font-weight: 400; font-style: normal; font-display: swap; src: url("/fonts/newsreader-400.woff2") format("woff2"); }
@font-face { font-family: "Newsreader"; font-weight: 600; font-style: normal; font-display: swap; src: url("/fonts/newsreader-600.woff2") format("woff2"); }

:root {
  color-scheme: light dark;
  --papel: #f7f2e8; --papel-cartao: #fffcf5; --tinta: #1c2533; --grafite: #5a6372;
  --linha: #d8cfbf; --anil: #233f61; --anil-claro: #dbe4ef; --vermelho: #b4442c;
  --sobre-anil: #f7f2e8; --sobre-vermelho: #fffcf5;
  --sombra-folha: 0 1px 0 rgba(28, 37, 51, 0.08), 0 6px 16px -10px rgba(28, 37, 51, 0.25);
  --raio-md: 10px;
  --titulo: "EB Garamond", "Times New Roman", Times, serif;
  --texto: Newsreader, "Times New Roman", Times, serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --papel: #111a27; --papel-cartao: #182435; --tinta: #efe8da; --grafite: #a9b1bf;
    --linha: #2c3a4f; --anil: #8fb0d9; --anil-claro: #233f61; --vermelho: #e58a72;
    --sobre-anil: #111a27; --sobre-vermelho: #111a27;
    --sombra-folha: 0 1px 0 rgba(0, 0, 0, 0.3), 0 6px 16px -10px rgba(0, 0, 0, 0.6);
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--papel); color: var(--tinta); font: 400 18px/29px var(--texto); }
main { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
.marca { display: inline-flex; align-items: center; gap: 12px; text-decoration: none; color: var(--anil); font: 500 26px/32px var(--titulo); }
.logo { height: 45px; width: auto; }
h1 { font: 500 30px/36px var(--titulo); color: var(--anil); margin: 0 0 8px; overflow-wrap: anywhere; }
h2 { font: 500 22px/28px var(--titulo); color: var(--anil); margin: 0 0 8px; overflow-wrap: anywhere; }
section, .cartao { display: block; background: var(--papel-cartao); border: 1px solid var(--linha); border-radius: var(--raio-md); box-shadow: var(--sombra-folha); padding: 20px; margin-top: 20px; }
.cartao { color: inherit; text-decoration: none; }
.cartao:hover { border-color: var(--anil); }
.cartao.destaque { border-left: 4px solid var(--anil); }
.cartao strong { display: block; font: 500 22px/28px var(--titulo); color: var(--anil); }
p { margin: 0 0 12px; }
ul { list-style: none; padding: 0; margin: 0; }
strong { font-weight: 600; }
a { color: var(--anil); text-underline-offset: 3px; }
.linha-titulo { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.contador { font-size: 15px; line-height: 23px; font-weight: 600; color: var(--grafite); white-space: nowrap; font-variant-numeric: tabular-nums; }
.detalhe { display: block; color: var(--grafite); font-size: 15px; line-height: 23px; }
.rotulo { display: block; font-size: 13px; line-height: 18px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--grafite); }
.selo { display: inline-block; margin-top: 6px; font-size: 13px; line-height: 18px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--grafite); border: 1px solid var(--linha); border-radius: 999px; padding: 1px 10px; }
.migalhas { font-size: 15px; line-height: 23px; color: var(--grafite); margin-bottom: 16px; overflow-wrap: anywhere; }

progress { -webkit-appearance: none; appearance: none; display: block; width: 100%; height: 8px; margin: 6px 0 8px; border: 0; border-radius: 999px; background: var(--anil-claro); overflow: hidden; color: var(--anil); }
progress::-webkit-progress-bar { background: var(--anil-claro); border-radius: 999px; }
progress::-webkit-progress-value { background: var(--anil); border-radius: 999px; }
progress::-moz-progress-bar { background: var(--anil); border-radius: 999px; }

.sessoes { margin-top: 12px; }
.sessoes li { border-top: 1px solid var(--linha); }
.sessoes a { display: block; padding: 10px 0 4px; color: inherit; text-decoration: none; }
.sessoes a:hover .nome { color: var(--anil); text-decoration: underline; }
.sessoes progress { height: 6px; }
.nome { display: inline-flex; align-items: center; gap: 10px; }

.caixa { flex: none; width: 20px; height: 20px; border: 2px solid var(--anil); border-radius: 5px; display: inline-grid; place-items: center; }
.caixa.marcada { background: var(--anil); }
.caixa.marcada::after { content: ""; width: 6px; height: 11px; border: solid var(--sobre-anil); border-width: 0 2px 2px 0; transform: translateY(-1px) rotate(45deg); }
.materiais li { border-bottom: 1px solid var(--linha); }
.materiais li:last-child { border-bottom: 0; }
.material { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 14px; width: 100%; padding: 12px 4px; cursor: pointer; font: 400 18px/27px var(--texto); color: var(--tinta); }
.material:hover .nome { color: var(--anil); }
.material.feito .nome { color: var(--grafite); }
.material .nome { flex: 1; }
.material .quando { font-size: 15px; color: var(--grafite); font-variant-numeric: tabular-nums; }
.material:focus-visible { outline: 3px solid var(--anil); outline-offset: 2px; border-radius: 6px; }
.em-lote { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }

.vizinhas { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 20px; }
.vizinhas a { display: block; background: var(--papel-cartao); border: 1px solid var(--linha); border-radius: var(--raio-md); padding: 12px 16px; text-decoration: none; overflow-wrap: anywhere; }
.vizinhas a:last-child { text-align: right; }

.botao, button { display: inline-block; background: var(--anil); color: var(--sobre-anil); border: 0; border-radius: var(--raio-md); padding: 10px 18px; font: 600 16px/24px var(--texto); text-decoration: none; cursor: pointer; }
button.secundario { background: transparent; color: var(--anil); border: 1px solid var(--anil); padding: 7px 14px; }
button.perigo { background: var(--vermelho); color: var(--sobre-vermelho); }
.botao:focus-visible, button:focus-visible, a:focus-visible, summary:focus-visible { outline: 3px solid var(--anil); outline-offset: 3px; }
details { margin-top: 12px; }
summary { cursor: pointer; color: var(--vermelho); font-weight: 600; }
details form { margin-top: 12px; }

label { display: block; font-weight: 600; margin: 12px 0 6px; }
input[type=file] { font: inherit; color: var(--tinta); max-width: 100%; }
textarea { width: 100%; font: 400 15px/22px "Courier New", Courier, monospace; color: var(--tinta); background: var(--papel); border: 1px solid var(--linha); border-radius: var(--raio-md); padding: 12px; margin-bottom: 8px; }
textarea:focus { outline: 2px solid var(--anil); outline-offset: 1px; }
pre { font-family: "Courier New", Courier, monospace; background: var(--papel); border: 1px solid var(--linha); border-radius: var(--raio-md); padding: 12px; overflow-x: auto; font-size: 14px; line-height: 21px; }
.alerta { border-color: var(--vermelho); }
.alerta h2 { color: var(--vermelho); }
.alerta li { padding: 4px 0; }
.aviso-ok { background: var(--anil-claro); border-radius: var(--raio-md); padding: 10px 14px; }
.acoes li { padding: 6px 0; }
.linha-campo { display: flex; gap: 8px; }
.linha-campo input, .linha-item input { flex: 1; min-width: 0; font: 400 17px/26px var(--texto); color: var(--tinta); background: var(--papel); border: 1px solid var(--linha); border-radius: 8px; padding: 6px 10px; }
.linha-campo input:focus, .linha-item input:focus, select:focus { outline: 2px solid var(--anil); outline-offset: 1px; border-color: var(--anil); }
.novo-caderno { margin-top: 24px; }
.aviso { color: var(--vermelho); margin-top: 8px; }

.barra-salvar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; background: var(--papel); padding: 8px 0; border-bottom: 1px solid var(--linha); }
.barra-salvar h1 { margin: 0; }
.arvore, .filhos { list-style: none; margin: 0; padding: 0; }
.filhos { margin: 4px 0 8px 14px; padding-left: 12px; border-left: 2px solid var(--linha); }
.arvore > li { padding: 12px 0; border-top: 1px solid var(--linha); }
.arvore > li:first-child { border-top: 0; }
.nivel-d > .linha-item input { font: 500 20px/28px var(--titulo); color: var(--anil); }
.nivel-s > .linha-item input { font-weight: 600; }
.linha-item { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
.linha-item .contador { font-size: 13px; }
.controles { display: inline-flex; gap: 2px; flex: none; }
button.icone { width: 34px; height: 34px; padding: 0; display: inline-grid; place-items: center; background: transparent; color: var(--anil); border: 1px solid transparent; border-radius: 8px; font: 600 18px/1 var(--texto); }
button.icone:hover:not(:disabled) { border-color: var(--linha); background: var(--papel); }
button.icone:disabled { color: var(--linha); cursor: default; }
button.icone.excluir { color: var(--vermelho); }
.novo .linha-item input { border-style: dashed; background: transparent; }
.novo button.secundario { padding: 5px 12px; font-size: 15px; }
select { font: 400 15px/22px var(--texto); color: var(--tinta); background: var(--papel); border: 1px solid var(--linha); border-radius: 8px; padding: 6px 4px; max-width: 8.5em; }
.botao.secundario { background: transparent; color: var(--anil); border: 1px solid var(--anil); padding: 7px 14px; }
:target { scroll-margin-top: 72px; }
:target > .linha-item input { border-color: var(--anil); }
@media (max-width: 480px) {
  .filhos { margin-left: 4px; padding-left: 8px; }
  button.icone { width: 30px; }
}
.conclusao { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 4px 0 8px; }
.conclusao .detalhe { display: inline; }
/* Editor em React (#9) */
.estado { font-size: 15px; line-height: 23px; color: var(--grafite); }
.estado-erro { color: var(--vermelho); font-weight: 600; }
button.icone.alca { cursor: grab; color: var(--grafite); touch-action: none; }
button.icone.alca:active { cursor: grabbing; }
button.icone.marcar { width: 30px; }
.arrastando { position: relative; z-index: 2; background: var(--papel-cartao); box-shadow: var(--sombra-folha); border-radius: 8px; opacity: 0.95; }
.confirmar-linha { border: 1px solid var(--vermelho); border-radius: var(--raio-md); padding: 10px 14px; margin: 6px 0 8px; }
.confirmar-linha p { margin: 0 0 8px; }
footer { text-align: center; color: var(--grafite); font-size: 15px; line-height: 23px; padding: 24px 16px; }
`;

// O CSS sai com a versão no nome. O Cloudflare guarda estático por 4 horas, e
// com nome fixo o editor novo apareceu em produção com o CSS velho, sem estilo
// (2026-11-12). Com o hash do conteúdo, CSS novo é endereço novo.
export const CAMINHO_ESTILO = `/estilo.${createHash("sha256").update(ESTILO).digest("hex").slice(0, 12)}.css`;

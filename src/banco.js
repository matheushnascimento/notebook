// Banco do notebook: Postgres, no Supabase em produção e no PGlite na máquina
// (src/conexao.js). Toda consulta filtra pelo dono, o sub da Conta mhdn:
// ninguém alcança o caderno de outra pessoa nem acertando o id.
//
// Todas as funções são assíncronas e recebem a conexão (db) primeiro.

import { conectar } from "./conexao.js";
import { semPrototipo, limparTexto } from "./texto.js";

// Teto de linhas por pessoa, somados os quatro níveis. Um caderno grande tem
// perto de 80; o teto existe pra um envio repetido não encher o disco.
export const LIMITE_ITENS = 20000;
// Teto de itens num arquivo .md só. Um ano inteiro de estudo fica perto de
// mil; o teto limita o tempo que uma importação segura o banco.
export const LIMITE_IMPORTACAO = 5000;

export const abrirBanco = conectar;

// O id de uma linha é integer no Postgres. Um número fora disso, vindo da URL ou
// do editor, faria a consulta falhar com 500; aqui ele só não encontra nada.
const MAIOR_ID = 2 ** 31 - 1;
const idValido = (id) => Number.isSafeInteger(id) && id > 0 && id <= MAIOR_ID;

// Hora de conclusão em UTC, sem milissegundos, no formato que o SQLite guardava.
const agora = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// Listas vão ao banco como JSON (json_to_recordset), sem depender de como cada
// driver serializa arrays. O parâmetro entra como $n::text::json: com só
// ::json, o postgres.js vê um parâmetro json e passa o texto por JSON.stringify
// de novo, e o banco recebe uma string em vez da lista.
const emJson = (valor) => JSON.stringify(valor);

// --- Leitura -----------------------------------------------------------------

function contar(no, filhos) {
  no.total = 0;
  no.feitos = 0;
  for (const f of no[filhos]) {
    no.total += f.total;
    no.feitos += f.feitos;
  }
  no.concluido = no.total > 0 && no.feitos === no.total;
}

// A árvore inteira dos cadernos de uma pessoa (ou de um caderno só), com os
// contadores de progresso em cada nível. Os volumes são de caderno de estudo,
// centenas de linhas: uma consulta e a montagem em memória bastam.
export async function arvore(db, usuario, cadernoId = null) {
  if (cadernoId != null && !idValido(cadernoId)) return [];
  const filtro = cadernoId == null ? "" : "AND c.id = $2";
  const linhas = await db.consulta(
    `SELECT c.id cid, c.nome cnome, c.concluido_em cfeito, d.id did, d.nome dnome, d.concluido_em dfeito,
            s.id sid, s.nome snome, s.concluido_em sfeito, m.id mid, m.nome mnome, m.concluido_em feito
       FROM cadernos c
       LEFT JOIN disciplinas d ON d.caderno_id = c.id
       LEFT JOIN sessoes s ON s.disciplina_id = d.id
       LEFT JOIN materiais m ON m.sessao_id = s.id
      WHERE c.usuario = $1 ${filtro}
      ORDER BY c.ordem, c.id, d.ordem, d.id, s.ordem, s.id, m.ordem, m.id`,
    cadernoId == null ? [usuario] : [usuario, cadernoId],
  );

  const cadernos = new Map();
  const disciplinas = new Map();
  const sessoes = new Map();
  for (const l of linhas) {
    if (!cadernos.has(l.cid)) cadernos.set(l.cid, { id: l.cid, nome: l.cnome, concluidoEm: l.cfeito, disciplinas: [] });
    if (l.did != null && !disciplinas.has(l.did)) {
      const d = { id: l.did, nome: l.dnome, concluidoEm: l.dfeito, sessoes: [] };
      disciplinas.set(l.did, d);
      cadernos.get(l.cid).disciplinas.push(d);
    }
    if (l.sid != null && !sessoes.has(l.sid)) {
      const s = { id: l.sid, nome: l.snome, concluidoEm: l.sfeito, materiais: [], disciplina: disciplinas.get(l.did).nome, cadernoId: l.cid };
      sessoes.set(l.sid, s);
      disciplinas.get(l.did).sessoes.push(s);
    }
    if (l.mid != null) sessoes.get(l.sid).materiais.push({ id: l.mid, nome: l.mnome, feito: l.feito != null, feitoEm: l.feito });
  }

  // Cada nível conclui de dois jeitos: a mão (concluido_em do próprio nível) ou
  // sozinho, quando todos os filhos estão concluídos. Um nível concluído conta
  // como 100% no de cima, mesmo com material em aberto dentro dele: o Ebook que
  // só entra se ficou lacuna não segura a sessão.
  //   feitosReais  materiais marcados de fato, pro contador
  //   feitos       o que conta pra barra e pro nível de cima
  for (const s of sessoes.values()) {
    s.total = s.materiais.length;
    s.feitosReais = s.materiais.filter((m) => m.feito).length;
    s.manual = s.concluidoEm != null;
    s.concluido = s.manual || (s.total > 0 && s.feitosReais === s.total);
    s.feitos = s.concluido ? s.total : s.feitosReais;
  }
  const fechar = (no, filhos) => {
    contar(no, filhos);
    no.feitosReais = no[filhos].reduce((n, f) => n + f.feitosReais, 0);
    no.manual = no.concluidoEm != null;
    no.concluido = no.manual || (no[filhos].length > 0 && no[filhos].every((f) => f.concluido));
    if (no.concluido) no.feitos = no.total;
  };
  for (const d of disciplinas.values()) {
    fechar(d, "sessoes");
    d.sessoesConcluidas = d.concluido ? d.sessoes.length : d.sessoes.filter((s) => s.concluido).length;
  }
  for (const c of cadernos.values()) {
    fechar(c, "disciplinas");
    c.sessoesTotal = c.disciplinas.reduce((n, d) => n + d.sessoes.length, 0);
    c.sessoesConcluidas = c.concluido ? c.sessoesTotal : c.disciplinas.reduce((n, d) => n + d.sessoesConcluidas, 0);
    // O primeiro material em aberto, na ordem do caderno, pulando o que já foi
    // concluído em qualquer nível: o "continuar de onde parei".
    c.proximo = null;
    if (c.concluido) continue;
    for (const d of c.disciplinas) {
      if (d.concluido || c.proximo) continue;
      for (const s of d.sessoes) {
        if (s.concluido) continue;
        const m = s.materiais.find((x) => !x.feito);
        if (m) {
          c.proximo = { sessao: s, material: m };
          break;
        }
      }
    }
  }
  return [...cadernos.values()];
}

export async function caderno(db, usuario, id) {
  return (await arvore(db, usuario, id))[0] ?? null;
}

// Uma sessão com o caderno dela e as vizinhas, pra navegar sem voltar.
export async function sessao(db, usuario, id) {
  if (!idValido(id)) return null;
  const [dono] = await db.consulta(
    `SELECT c.id FROM sessoes s JOIN disciplinas d ON d.id = s.disciplina_id
       JOIN cadernos c ON c.id = d.caderno_id WHERE s.id = $1 AND c.usuario = $2`,
    [id, usuario],
  );
  if (!dono) return null;
  const c = await caderno(db, usuario, dono.id);
  const todas = c.disciplinas.flatMap((d) => d.sessoes);
  const i = todas.findIndex((s) => s.id === id);
  return { caderno: c, sessao: todas[i], anterior: todas[i - 1] ?? null, seguinte: todas[i + 1] ?? null };
}

// --- Escrita -----------------------------------------------------------------

// As sessões da pessoa, com o sub no parâmetro $n.
const sessoesDoDono = (n) => `SELECT s.id FROM sessoes s JOIN disciplinas d ON d.id = s.disciplina_id
                   JOIN cadernos c ON c.id = d.caderno_id WHERE c.usuario = $${n}`;

// Alterna concluído e não concluído. Devolve a sessão do material, ou null se
// o material não existe ou é de outra pessoa.
export async function alternarMaterial(db, usuario, id) {
  if (!idValido(id)) return null;
  const [linha] = await db.consulta(
    `UPDATE materiais
        SET concluido_em = CASE WHEN concluido_em IS NULL THEN $3 ELSE NULL END
      WHERE id = $1 AND sessao_id IN (${sessoesDoDono(2)})
      RETURNING sessao_id`,
    [id, usuario, agora()],
  );
  return linha?.sessao_id ?? null;
}

// Conclui ou reabre um caderno, disciplina ou sessão, sem mexer nos filhos.
// Devolve o caderno e o tipo, pra o servidor saber pra onde voltar, ou null se
// o item não existe ou é de outra pessoa.
export async function alternarConclusao(db, usuario, tipo, id) {
  if (!["c", "d", "s"].includes(tipo)) return null;
  const cadernoId = await cadernoDoItem(db, usuario, tipo, id);
  if (cadernoId == null) return null;
  await db.consulta(
    `UPDATE ${NIVEIS[tipo].tabela}
        SET concluido_em = CASE WHEN concluido_em IS NULL THEN $2 ELSE NULL END
      WHERE id = $1`,
    [id, agora()],
  );
  return { cadernoId, tipo, id };
}

export async function marcarSessao(db, usuario, id, concluir) {
  if (!idValido(id)) return 0;
  const linhas = concluir
    ? await db.consulta(
        `UPDATE materiais SET concluido_em = COALESCE(concluido_em, $3)
          WHERE sessao_id = $1 AND sessao_id IN (${sessoesDoDono(2)}) RETURNING id`,
        [id, usuario, agora()],
      )
    : await db.consulta(
        `UPDATE materiais SET concluido_em = NULL
          WHERE sessao_id = $1 AND sessao_id IN (${sessoesDoDono(2)}) RETURNING id`,
        [id, usuario],
      );
  return linhas.length;
}

export async function excluirCaderno(db, usuario, id) {
  if (!idValido(id)) return false;
  return (await db.consulta("DELETE FROM cadernos WHERE id = $1 AND usuario = $2 RETURNING id", [id, usuario])).length > 0;
}

// Acha ou cria, de uma vez, os filhos de um pai com esses nomes. Dois pedidos
// por pai, e não três por item: no Supabase cada ida ao banco custa, e um .md
// no teto tem 5 mil itens. Devolve o id de cada nome, na mesma ordem, e os ids
// criados agora. Nome repetido no próprio arquivo cai no mesmo item.
async function acharOuCriarVarios(c, tipo, idPai, nomes) {
  if (!nomes.length) return { ids: [], novos: new Set() };
  const { tabela, pai, tipoPai } = NIVEIS[tipo];
  const lista = emJson(nomes.map((nome, i) => ({ nome, i })));
  const criados = await c.consulta(
    `INSERT INTO ${tabela} (${pai}, nome, ordem)
     SELECT $1::${tipoPai}, v.nome, base.ordem + v.i
       FROM json_to_recordset($2::text::json) AS v(nome text, i int),
            (SELECT COALESCE(MAX(ordem), -1) + 1 AS ordem FROM ${tabela} WHERE ${pai} = $1::${tipoPai}) base
      ORDER BY v.i
     ON CONFLICT (${pai}, lower(nome)) DO NOTHING
     RETURNING id`,
    [idPai, lista],
  );
  const achados = await c.consulta(
    `SELECT v.i, t.id FROM json_to_recordset($2::text::json) AS v(nome text, i int)
       JOIN ${tabela} t ON t.${pai} = $1::${tipoPai} AND lower(t.nome) = lower(v.nome)`,
    [idPai, lista],
  );
  const ids = [];
  for (const l of achados) ids[l.i] = l.id;
  return { ids, novos: new Set(criados.map((l) => l.id)) };
}

// Marca concluídos, de uma vez, os ids que ainda não estão. Devolve quantos.
async function concluirVarios(c, tabela, ids) {
  if (!ids.length) return 0;
  const linhas = await c.consulta(
    `UPDATE ${tabela} SET concluido_em = $2
      WHERE id IN (SELECT value::int FROM json_array_elements_text($1::text::json)) AND concluido_em IS NULL
      RETURNING id`,
    [emJson(ids), agora()],
  );
  return linhas.length;
}

// Mescla o que veio do .md com o que já existe, casando pelo nome (sem
// diferenciar maiúsculas) em cada nível. Nada é apagado e nenhum progresso é
// desfeito: um "[ ]" no arquivo não desmarca o que já foi concluído aqui.
export async function importar(db, usuario, cadernos) {
  // Antes de gravar: um arquivo que passa do teto é recusado sem custar nada.
  // Conta pelo tamanho da árvore, um teto por cima, já que itens repetidos
  // seriam reaproveitados.
  const chegando = cadernos.reduce(
    (n, c) => n + 1 + c.disciplinas.reduce((m, d) => m + 1 + d.sessoes.reduce((k, s) => k + 1 + s.materiais.length, 0), 0),
    0,
  );
  if (chegando > LIMITE_IMPORTACAO) {
    throw Object.assign(new Error("arquivo grande demais"), {
      status: 413,
      publico: `O arquivo tem ${chegando.toLocaleString("pt-BR")} itens, e o limite por importação é ${LIMITE_IMPORTACAO.toLocaleString("pt-BR")}. Divida em arquivos menores.`,
    });
  }

  return db.transacao(async (tx) => {
    const resultado = { cadernos: [], criados: 0, marcados: 0 };
    // Como nos materiais, "concluído: sim" conclui, e a ausência não reabre.
    const concluir = { cadernos: [], disciplinas: [], sessoes: [] };
    const feitos = [];
    const criados = new Set();

    const cads = await acharOuCriarVarios(tx, "c", usuario, cadernos.map((c) => c.nome));
    for (const [i, c] of cadernos.entries()) {
      const cadId = cads.ids[i];
      resultado.cadernos.push(cadId);
      if (c.concluido) concluir.cadernos.push(cadId);
      const dis = await acharOuCriarVarios(tx, "d", cadId, c.disciplinas.map((d) => d.nome));
      for (const [j, d] of c.disciplinas.entries()) {
        if (d.concluido) concluir.disciplinas.push(dis.ids[j]);
        const ses = await acharOuCriarVarios(tx, "s", dis.ids[j], d.sessoes.map((s) => s.nome));
        for (const [k, s] of d.sessoes.entries()) {
          if (s.concluido) concluir.sessoes.push(ses.ids[k]);
          const mats = await acharOuCriarVarios(tx, "m", ses.ids[k], s.materiais.map((m) => m.nome));
          for (const id of mats.novos) criados.add(id);
          s.materiais.forEach((m, n) => m.feito && feitos.push(mats.ids[n]));
        }
      }
    }
    for (const [tabela, ids] of Object.entries(concluir)) await concluirVarios(tx, tabela, ids);
    resultado.marcados = await concluirVarios(tx, "materiais", feitos);
    resultado.criados = criados.size;
    await conferirLimite(tx, usuario);
    return resultado;
  });
}

// --- Edição pela interface ---------------------------------------------------
//
// Os quatro níveis em um molde só: c (caderno), d (disciplina), s (sessão),
// m (material). "pai" é a coluna que liga o item ao nível de cima.

const NIVEIS = semPrototipo({
  c: { tabela: "cadernos", pai: "usuario", tipoPai: "text", filhos: "d", nome: "o caderno" },
  d: { tabela: "disciplinas", pai: "caderno_id", tipoPai: "int", filhos: "s", nome: "a disciplina" },
  s: { tabela: "sessoes", pai: "disciplina_id", tipoPai: "int", filhos: "m", nome: "a sessão" },
  m: { tabela: "materiais", pai: "sessao_id", tipoPai: "int", filhos: null, nome: "o material" },
});
const PAI_DE = semPrototipo({ d: "c", s: "d", m: "s" });
const nivel = (tipo) => (Object.hasOwn(NIVEIS, tipo) ? NIVEIS[tipo] : null);

// O caderno a que um item pertence, se ele for da pessoa. É a checagem de dono
// de toda edição: um id de outro caderno, ou de outra pessoa, devolve null.
const CADERNO_DE = semPrototipo({
  c: "SELECT c.id FROM cadernos c WHERE c.id = $1 AND c.usuario = $2",
  d: "SELECT c.id FROM disciplinas d JOIN cadernos c ON c.id = d.caderno_id WHERE d.id = $1 AND c.usuario = $2",
  s: `SELECT c.id FROM sessoes s JOIN disciplinas d ON d.id = s.disciplina_id
        JOIN cadernos c ON c.id = d.caderno_id WHERE s.id = $1 AND c.usuario = $2`,
  m: `SELECT c.id FROM materiais m JOIN sessoes s ON s.id = m.sessao_id JOIN disciplinas d ON d.id = s.disciplina_id
        JOIN cadernos c ON c.id = d.caderno_id WHERE m.id = $1 AND c.usuario = $2`,
});

export async function cadernoDoItem(db, usuario, tipo, id) {
  if (!Object.hasOwn(CADERNO_DE, tipo) || !idValido(id)) return null;
  const [linha] = await db.consulta(CADERNO_DE[tipo], [id, usuario]);
  return linha?.id ?? null;
}

const limparNome = limparTexto;

async function conferirLimite(c, usuario) {
  const [{ n }] = await c.consulta(
    `SELECT ((SELECT COUNT(*) FROM cadernos WHERE usuario = $1)
           + (SELECT COUNT(*) FROM disciplinas d JOIN cadernos c ON c.id = d.caderno_id WHERE c.usuario = $1)
           + (SELECT COUNT(*) FROM sessoes s JOIN disciplinas d ON d.id = s.disciplina_id JOIN cadernos c ON c.id = d.caderno_id WHERE c.usuario = $1)
           + (SELECT COUNT(*) FROM materiais m JOIN sessoes s ON s.id = m.sessao_id JOIN disciplinas d ON d.id = s.disciplina_id
                JOIN cadernos c ON c.id = d.caderno_id WHERE c.usuario = $1))::int AS n`,
    [usuario],
  );
  if (n > LIMITE_ITENS) {
    throw Object.assign(new Error("limite de itens"), {
      status: 413,
      publico: `Passaria do limite de ${LIMITE_ITENS.toLocaleString("pt-BR")} itens por conta. Nada foi gravado.`,
    });
  }
}
// Nome repetido entre irmãos: o índice único sobre lower(nome).
const repetido = (erro) => erro?.code === "23505";

async function paiDe(c, tipo, id) {
  const { tabela, pai } = NIVEIS[tipo];
  const [linha] = await c.consulta(`SELECT ${pai} AS pai, nome FROM ${tabela} WHERE id = $1`, [id]);
  return linha;
}

async function inserir(c, tipo, idPai, nome) {
  const { tabela, pai, tipoPai } = NIVEIS[tipo];
  const [{ id }] = await c.consulta(
    `INSERT INTO ${tabela} (${pai}, nome, ordem)
     SELECT $1::${tipoPai}, $2, COALESCE(MAX(ordem), -1) + 1 FROM ${tabela} WHERE ${pai} = $1::${tipoPai}
     RETURNING id`,
    [idPai, nome],
  );
  return id;
}

// Grava a ordem nova dos irmãos, de 0 a n, num pedido só.
async function ordenar(c, tabela, ids) {
  await c.consulta(
    `UPDATE ${tabela} AS t SET ordem = v.ordem
       FROM json_to_recordset($1::text::json) AS v(id int, ordem int) WHERE t.id = v.id`,
    [emJson(ids.map((id, ordem) => ({ id, ordem })))],
  );
}

async function irmaosDe(c, tipo, id) {
  const { tabela, pai } = NIVEIS[tipo];
  const { pai: idPai } = await paiDe(c, tipo, id);
  const linhas = await c.consulta(`SELECT id FROM ${tabela} WHERE ${pai} = $1 ORDER BY ordem, id`, [idPai]);
  return linhas.map((l) => l.id);
}

// Troca o item de lugar com o vizinho e renumera os irmãos de 0 a n, o que
// também conserta ordens repetidas que tenham ficado de importações antigas.
async function mover(c, tipo, id, passo) {
  const irmaos = await irmaosDe(c, tipo, id);
  const i = irmaos.indexOf(id);
  const j = i + passo;
  if (i < 0 || j < 0 || j >= irmaos.length) return;
  [irmaos[i], irmaos[j]] = [irmaos[j], irmaos[i]];
  await ordenar(c, NIVEIS[tipo].tabela, irmaos);
}

async function contarDentro(c, tipo, id) {
  // Quantas sessões e materiais saem junto, pra confirmação de exclusão dizer.
  if (tipo === "c") {
    const [r] = await c.consulta(
      `SELECT COUNT(DISTINCT s.id)::int AS sessoes, COUNT(m.id)::int AS materiais FROM disciplinas d
         LEFT JOIN sessoes s ON s.disciplina_id = d.id LEFT JOIN materiais m ON m.sessao_id = s.id WHERE d.caderno_id = $1`,
      [id],
    );
    return r;
  }
  if (tipo === "d") {
    const [r] = await c.consulta(
      "SELECT COUNT(DISTINCT s.id)::int AS sessoes, COUNT(m.id)::int AS materiais FROM sessoes s LEFT JOIN materiais m ON m.sessao_id = s.id WHERE s.disciplina_id = $1",
      [id],
    );
    return r;
  }
  if (tipo === "s") {
    const [{ n }] = await c.consulta("SELECT COUNT(*)::int AS n FROM materiais WHERE sessao_id = $1", [id]);
    return { sessoes: 0, materiais: n };
  }
  return { sessoes: 0, materiais: 0 };
}

export async function criarCaderno(db, usuario, nome) {
  const limpo = limparNome(nome);
  if (!limpo) return { erro: "Dê um nome ao caderno." };
  try {
    return await db.transacao(async (tx) => {
      const id = await inserir(tx, "c", usuario, limpo);
      await conferirLimite(tx, usuario);
      return { id };
    });
  } catch (erro) {
    if (repetido(erro)) return { erro: `Já existe um caderno chamado "${limpo}".` };
    if (erro.publico) return { erro: erro.publico };
    throw erro;
  }
}

// Aplica um envio do editor do caderno, numa transação só:
//   1. os renomes (campos nome:<tipo>:<id>, e nome:c para o caderno);
//   2. os itens novos (novo:d, novo:s:<disciplina>, novo:m:<sessão>), com o
//      modelo opcional da sessão nova em modelo:s:<disciplina>;
//   3. a ação do botão apertado: subir, descer, excluir ou confirmar.
// Assim nada digitado se perde quando a pessoa aperta um botão de outra linha.
//
// Excluir item vazio, ou material, é direto. Excluir algo com conteúdo pede
// confirmação: devolve { confirmar } e só apaga quando volta como "confirmar".
//
// Um nome repetido não desfaz o resto: cada renome e cada item novo vai num
// savepoint, e o que bateu num nome existente vira aviso.
export async function aplicarEdicao(db, usuario, cadernoId, campos, acao, modelos) {
  if ((await cadernoDoItem(db, usuario, "c", cadernoId)) !== cadernoId) return null;
  const avisos = [];
  const resultado = { avisos, foco: null, confirmar: null, excluiuCaderno: false };
  // Índice dos campos pelo nome, montado uma vez: buscar o modelo de cada
  // sessão nova numa lista era O(n²) no número de campos do envio.
  const porNome = new Map(campos);

  await db.transacao(async (tx) => {
    const doCaderno = async (tipo, id) => (await cadernoDoItem(tx, usuario, tipo, id)) === cadernoId;

    for (const [chave, valor] of campos) {
      const [campo, tipo, idTexto] = chave.split(":");
      if (campo !== "nome" || !nivel(tipo)) continue;
      const id = tipo === "c" ? cadernoId : Number(idTexto);
      if (!(await doCaderno(tipo, id))) continue;
      const nome = limparNome(valor);
      const atual = await paiDe(tx, tipo, id);
      if (!nome || nome === atual.nome) continue;
      const renomeou = await tx.tentar((sp) => sp.consulta(`UPDATE ${NIVEIS[tipo].tabela} SET nome = $1 WHERE id = $2`, [nome, id]));
      if (!renomeou) avisos.push(`Não renomeei "${atual.nome}": já existe "${nome}" no mesmo lugar.`);
    }

    for (const [chave, valor] of campos) {
      const [campo, tipo, idTexto] = chave.split(":");
      if (campo !== "novo") continue;
      const nome = limparNome(valor);
      if (!nome) continue;
      if (!Object.hasOwn(PAI_DE, tipo)) continue;
      const nivelPai = PAI_DE[tipo];
      const idPai = tipo === "d" ? cadernoId : Number(idTexto);
      if (!(await doCaderno(nivelPai, idPai))) continue;
      const escolhido = tipo === "s" ? porNome.get(`modelo:s:${idTexto}`) : null;
      const modelo = escolhido && Object.hasOwn(modelos, escolhido) ? modelos[escolhido] : null;
      let id = null;
      const criou = await tx.tentar(async (sp) => {
        id = await inserir(sp, tipo, idPai, nome);
        for (const material of modelo ?? []) await inserir(sp, "m", id, material);
      });
      if (criou) resultado.foco = `${tipo}-${id}`;
      else avisos.push(`Não acrescentei "${nome}": já existe um item com esse nome no mesmo lugar.`);
    }

    const [verbo, tipo, idTexto] = String(acao ?? "").split(":");
    const id = tipo === "c" ? cadernoId : Number(idTexto);
    if (nivel(tipo) && (await doCaderno(tipo, id))) {
      resultado.foco ??= `${tipo}-${id}`;
      if (verbo === "subir" || verbo === "descer") await mover(tx, tipo, id, verbo === "subir" ? -1 : 1);
      if (verbo === "excluir" || verbo === "confirmar") {
        const dentro = await contarDentro(tx, tipo, id);
        const temConteudo = tipo !== "m" && (tipo === "s" ? dentro.materiais > 0 : dentro.sessoes > 0 || dentro.materiais > 0 || tipo === "c");
        const atual = await paiDe(tx, tipo, id);
        if (verbo === "excluir" && temConteudo) {
          resultado.confirmar = { tipo, id, nome: atual.nome, rotulo: NIVEIS[tipo].nome, ...dentro };
        } else {
          await tx.consulta(`DELETE FROM ${NIVEIS[tipo].tabela} WHERE id = $1`, [id]);
          if (tipo === "c") resultado.excluiuCaderno = true;
          resultado.foco = tipo === "c" || tipo === "d" ? null : `${PAI_DE[tipo]}-${atual.pai}`;
        }
      }
    }
    await conferirLimite(tx, usuario);
  });
  return resultado;
}

// Move um item para a posição `indice` entre os irmãos (0 é o primeiro), pro
// arrastar e soltar do editor. Só dentro da mesma lista: mudar de pai fica pra
// depois. Índice fora da lista vai pro começo ou pro fim.
export async function moverPara(db, usuario, cadernoId, tipo, id, indice) {
  if (!nivel(tipo) || !Number.isSafeInteger(indice)) return false;
  if ((await cadernoDoItem(db, usuario, tipo, id)) !== cadernoId) return false;
  await db.transacao(async (tx) => {
    const irmaos = (await irmaosDe(tx, tipo, id)).filter((x) => x !== id);
    irmaos.splice(Math.max(0, Math.min(indice, irmaos.length)), 0, id);
    await ordenar(tx, NIVEIS[tipo].tabela, irmaos);
  });
  return true;
}

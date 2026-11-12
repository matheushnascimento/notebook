// Banco do notebook: SQLite embutido no Node (node:sqlite), um arquivo só no
// volume /dados. Toda consulta filtra pelo dono, o sub da Conta mhdn: ninguém
// alcança o caderno de outra pessoa nem acertando o id.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { semPrototipo, limparTexto } from "./texto.js";

// Teto de linhas por pessoa, somados os quatro níveis. Um caderno grande tem
// perto de 80; o teto existe pra um envio repetido não encher o disco.
export const LIMITE_ITENS = 20000;
// Teto de itens num arquivo .md só. Um ano inteiro de estudo fica perto de
// mil; o teto limita o tempo que uma importação segura o servidor.
export const LIMITE_IMPORTACAO = 5000;

// Consultas preparadas uma vez por banco e por texto. Os nomes de tabela e
// coluna vêm só das constantes deste arquivo, nunca do pedido.
const preparadas = new WeakMap();
function consulta(db, sql) {
  let cache = preparadas.get(db);
  if (!cache) preparadas.set(db, (cache = new Map()));
  let stmt = cache.get(sql);
  if (!stmt) cache.set(sql, (stmt = db.prepare(sql)));
  return stmt;
}

export function abrirBanco(caminho) {
  if (caminho !== ":memory:") mkdirSync(dirname(caminho), { recursive: true });
  const db = new DatabaseSync(caminho);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS cadernos (
      id INTEGER PRIMARY KEY,
      usuario TEXT NOT NULL,
      nome TEXT NOT NULL COLLATE NOCASE,
      ordem INTEGER NOT NULL,
      UNIQUE (usuario, nome)
    );
    CREATE TABLE IF NOT EXISTS disciplinas (
      id INTEGER PRIMARY KEY,
      caderno_id INTEGER NOT NULL REFERENCES cadernos(id) ON DELETE CASCADE,
      nome TEXT NOT NULL COLLATE NOCASE,
      ordem INTEGER NOT NULL,
      UNIQUE (caderno_id, nome)
    );
    CREATE TABLE IF NOT EXISTS sessoes (
      id INTEGER PRIMARY KEY,
      disciplina_id INTEGER NOT NULL REFERENCES disciplinas(id) ON DELETE CASCADE,
      nome TEXT NOT NULL COLLATE NOCASE,
      ordem INTEGER NOT NULL,
      UNIQUE (disciplina_id, nome)
    );
    CREATE TABLE IF NOT EXISTS materiais (
      id INTEGER PRIMARY KEY,
      sessao_id INTEGER NOT NULL REFERENCES sessoes(id) ON DELETE CASCADE,
      nome TEXT NOT NULL COLLATE NOCASE,
      ordem INTEGER NOT NULL,
      concluido_em TEXT,
      UNIQUE (sessao_id, nome)
    );
    -- A próxima posição de um item novo é MAX(ordem) entre os irmãos. Sem estes
    -- índices, cada inserção varria os irmãos todos, e importar 20 mil materiais
    -- numa sessão levava 86 s, com o servidor parado (2026-11-12).
    CREATE INDEX IF NOT EXISTS cadernos_ordem ON cadernos (usuario, ordem);
    CREATE INDEX IF NOT EXISTS disciplinas_ordem ON disciplinas (caderno_id, ordem);
    CREATE INDEX IF NOT EXISTS sessoes_ordem ON sessoes (disciplina_id, ordem);
    CREATE INDEX IF NOT EXISTS materiais_ordem ON materiais (sessao_id, ordem);
  `);
  // Conclusão própria de caderno, disciplina e sessão (#7): concluir sem marcar
  // todos os filhos. Bancos de antes ganham a coluna aqui.
  for (const tabela of ["cadernos", "disciplinas", "sessoes"]) {
    const colunas = db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
    if (!colunas.includes("concluido_em")) db.exec(`ALTER TABLE ${tabela} ADD COLUMN concluido_em TEXT`);
  }
  return db;
}

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
export function arvore(db, usuario, cadernoId = null) {
  const filtro = cadernoId == null ? "" : "AND c.id = ?";
  const linhas = db
    .prepare(
      `SELECT c.id cid, c.nome cnome, c.concluido_em cfeito, d.id did, d.nome dnome, d.concluido_em dfeito,
              s.id sid, s.nome snome, s.concluido_em sfeito, m.id mid, m.nome mnome, m.concluido_em feito
         FROM cadernos c
         LEFT JOIN disciplinas d ON d.caderno_id = c.id
         LEFT JOIN sessoes s ON s.disciplina_id = d.id
         LEFT JOIN materiais m ON m.sessao_id = s.id
        WHERE c.usuario = ? ${filtro}
        ORDER BY c.ordem, c.id, d.ordem, d.id, s.ordem, s.id, m.ordem, m.id`,
    )
    .all(...(cadernoId == null ? [usuario] : [usuario, cadernoId]));

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

export function caderno(db, usuario, id) {
  return arvore(db, usuario, id)[0] ?? null;
}

// Uma sessão com o caderno dela e as vizinhas, pra navegar sem voltar.
export function sessao(db, usuario, id) {
  const dono = db
    .prepare(
      `SELECT c.id FROM sessoes s JOIN disciplinas d ON d.id = s.disciplina_id
         JOIN cadernos c ON c.id = d.caderno_id WHERE s.id = ? AND c.usuario = ?`,
    )
    .get(id, usuario);
  if (!dono) return null;
  const c = caderno(db, usuario, dono.id);
  const todas = c.disciplinas.flatMap((d) => d.sessoes);
  const i = todas.findIndex((s) => s.id === id);
  return { caderno: c, sessao: todas[i], anterior: todas[i - 1] ?? null, seguinte: todas[i + 1] ?? null };
}

// --- Escrita -----------------------------------------------------------------

const DO_DONO = `SELECT s.id FROM sessoes s JOIN disciplinas d ON d.id = s.disciplina_id
                   JOIN cadernos c ON c.id = d.caderno_id WHERE c.usuario = ?`;

// Alterna concluído e não concluído. Devolve a sessão do material, ou null se
// o material não existe ou é de outra pessoa.
export function alternarMaterial(db, usuario, id) {
  const linha = db
    .prepare(
      `UPDATE materiais
          SET concluido_em = CASE WHEN concluido_em IS NULL THEN strftime('%Y-%m-%dT%H:%M:%SZ', 'now') ELSE NULL END
        WHERE id = ? AND sessao_id IN (${DO_DONO})
        RETURNING sessao_id`,
    )
    .get(id, usuario);
  return linha?.sessao_id ?? null;
}

// Conclui ou reabre um caderno, disciplina ou sessão, sem mexer nos filhos.
// Devolve o caderno e o tipo, pra o servidor saber pra onde voltar, ou null se
// o item não existe ou é de outra pessoa.
export function alternarConclusao(db, usuario, tipo, id) {
  if (!["c", "d", "s"].includes(tipo)) return null;
  const cadernoId = cadernoDoItem(db, usuario, tipo, id);
  if (cadernoId == null) return null;
  consulta(
    db,
    `UPDATE ${NIVEIS[tipo].tabela}
        SET concluido_em = CASE WHEN concluido_em IS NULL THEN strftime('%Y-%m-%dT%H:%M:%SZ', 'now') ELSE NULL END
      WHERE id = ?`,
  ).run(id);
  return { cadernoId, tipo, id };
}

export function marcarSessao(db, usuario, id, concluir) {
  const r = db
    .prepare(
      `UPDATE materiais
          SET concluido_em = ${concluir ? "COALESCE(concluido_em, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))" : "NULL"}
        WHERE sessao_id = ? AND sessao_id IN (${DO_DONO})`,
    )
    .run(id, usuario);
  return r.changes;
}

export function excluirCaderno(db, usuario, id) {
  return db.prepare("DELETE FROM cadernos WHERE id = ? AND usuario = ?").run(id, usuario).changes > 0;
}

// Mescla o que veio do .md com o que já existe, casando pelo nome (sem
// diferenciar maiúsculas) em cada nível. Nada é apagado e nenhum progresso é
// desfeito: um "[ ]" no arquivo não desmarca o que já foi concluído aqui.
export function importar(db, usuario, cadernos) {
  const resultado = { cadernos: [], criados: 0, marcados: 0 };

  const acharOuCriar = (tabela, pai, idPai, nome) => {
    const filtroPai = pai === "usuario" ? "usuario = ?" : `${pai} = ?`;
    const achado = consulta(db, `SELECT id FROM ${tabela} WHERE ${filtroPai} AND nome = ?`).get(idPai, nome);
    if (achado) return { id: achado.id, novo: false };
    const { ordem } = consulta(db, `SELECT COALESCE(MAX(ordem), -1) + 1 ordem FROM ${tabela} WHERE ${filtroPai}`).get(idPai);
    const r = consulta(db, `INSERT INTO ${tabela} (${pai}, nome, ordem) VALUES (?, ?, ?)`).run(idPai, nome, ordem);
    return { id: Number(r.lastInsertRowid), novo: true };
  };
  const marcar = db.prepare(
    "UPDATE materiais SET concluido_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND concluido_em IS NULL",
  );

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

  db.exec("BEGIN");
  try {
    // Como nos materiais, "concluído: sim" conclui, e a ausência não reabre.
    const concluir = (tabela, id, sim) => {
      if (sim) consulta(db, `UPDATE ${tabela} SET concluido_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND concluido_em IS NULL`).run(id);
    };
    for (const c of cadernos) {
      const cad = acharOuCriar("cadernos", "usuario", usuario, c.nome);
      concluir("cadernos", cad.id, c.concluido);
      resultado.cadernos.push(cad.id);
      for (const d of c.disciplinas) {
        const dis = acharOuCriar("disciplinas", "caderno_id", cad.id, d.nome);
        concluir("disciplinas", dis.id, d.concluido);
        for (const s of d.sessoes) {
          const ses = acharOuCriar("sessoes", "disciplina_id", dis.id, s.nome);
          concluir("sessoes", ses.id, s.concluido);
          for (const m of s.materiais) {
            const mat = acharOuCriar("materiais", "sessao_id", ses.id, m.nome);
            if (mat.novo) resultado.criados++;
            if (m.feito && marcar.run(mat.id).changes) resultado.marcados++;
          }
        }
      }
    }
    conferirLimite(db, usuario);
    db.exec("COMMIT");
  } catch (erro) {
    db.exec("ROLLBACK");
    throw erro;
  }
  return resultado;
}

// --- Edição pela interface ---------------------------------------------------
//
// Os quatro níveis em um molde só: c (caderno), d (disciplina), s (sessão),
// m (material). "pai" é a coluna que liga o item ao nível de cima.

const NIVEIS = semPrototipo({
  c: { tabela: "cadernos", pai: "usuario", filhos: "d", nome: "o caderno" },
  d: { tabela: "disciplinas", pai: "caderno_id", filhos: "s", nome: "a disciplina" },
  s: { tabela: "sessoes", pai: "disciplina_id", filhos: "m", nome: "a sessão" },
  m: { tabela: "materiais", pai: "sessao_id", filhos: null, nome: "o material" },
});
const PAI_DE = semPrototipo({ d: "c", s: "d", m: "s" });
const nivel = (tipo) => (Object.hasOwn(NIVEIS, tipo) ? NIVEIS[tipo] : null);

// O caderno a que um item pertence, se ele for da pessoa. É a checagem de dono
// de toda edição: um id de outro caderno, ou de outra pessoa, devolve null.
const CADERNO_DE = semPrototipo({
  c: "SELECT c.id FROM cadernos c WHERE c.id = ? AND c.usuario = ?",
  d: "SELECT c.id FROM disciplinas d JOIN cadernos c ON c.id = d.caderno_id WHERE d.id = ? AND c.usuario = ?",
  s: `SELECT c.id FROM sessoes s JOIN disciplinas d ON d.id = s.disciplina_id
        JOIN cadernos c ON c.id = d.caderno_id WHERE s.id = ? AND c.usuario = ?`,
  m: `SELECT c.id FROM materiais m JOIN sessoes s ON s.id = m.sessao_id JOIN disciplinas d ON d.id = s.disciplina_id
        JOIN cadernos c ON c.id = d.caderno_id WHERE m.id = ? AND c.usuario = ?`,
});

export function cadernoDoItem(db, usuario, tipo, id) {
  if (!Object.hasOwn(CADERNO_DE, tipo) || !Number.isSafeInteger(id)) return null;
  return consulta(db, CADERNO_DE[tipo]).get(id, usuario)?.id ?? null;
}

const limparNome = limparTexto;

function conferirLimite(db, usuario, chegando = 0) {
  const { n } = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM cadernos WHERE usuario = ?1)
            + (SELECT COUNT(*) FROM disciplinas d JOIN cadernos c ON c.id = d.caderno_id WHERE c.usuario = ?1)
            + (SELECT COUNT(*) FROM sessoes s JOIN disciplinas d ON d.id = s.disciplina_id JOIN cadernos c ON c.id = d.caderno_id WHERE c.usuario = ?1)
            + (SELECT COUNT(*) FROM materiais m JOIN sessoes s ON s.id = m.sessao_id JOIN disciplinas d ON d.id = s.disciplina_id
                 JOIN cadernos c ON c.id = d.caderno_id WHERE c.usuario = ?1) n`,
    )
    .get(usuario);
  if (n + chegando > LIMITE_ITENS) {
    throw Object.assign(new Error("limite de itens"), {
      status: 413,
      publico: `Passaria do limite de ${LIMITE_ITENS.toLocaleString("pt-BR")} itens por conta. Nada foi gravado.`,
    });
  }
}
const repetido = (erro) => /UNIQUE/i.test(erro?.message ?? "");

function paiDe(db, tipo, id) {
  const { tabela, pai } = NIVEIS[tipo];
  return db.prepare(`SELECT ${pai} pai, nome FROM ${tabela} WHERE id = ?`).get(id);
}

function inserir(db, tipo, idPai, nome) {
  const { tabela, pai } = NIVEIS[tipo];
  const { ordem } = consulta(db, `SELECT COALESCE(MAX(ordem), -1) + 1 ordem FROM ${tabela} WHERE ${pai} = ?`).get(idPai);
  return Number(consulta(db, `INSERT INTO ${tabela} (${pai}, nome, ordem) VALUES (?, ?, ?)`).run(idPai, nome, ordem).lastInsertRowid);
}

// Troca o item de lugar com o vizinho e renumera os irmãos de 0 a n, o que
// também conserta ordens repetidas que tenham ficado de importações antigas.
function mover(db, tipo, id, passo) {
  const { tabela, pai } = NIVEIS[tipo];
  const { pai: idPai } = paiDe(db, tipo, id);
  const irmaos = db.prepare(`SELECT id FROM ${tabela} WHERE ${pai} = ? ORDER BY ordem, id`).all(idPai).map((l) => l.id);
  const i = irmaos.indexOf(id);
  const j = i + passo;
  if (i < 0 || j < 0 || j >= irmaos.length) return;
  [irmaos[i], irmaos[j]] = [irmaos[j], irmaos[i]];
  const ordenar = db.prepare(`UPDATE ${tabela} SET ordem = ? WHERE id = ?`);
  irmaos.forEach((irmao, ordem) => ordenar.run(ordem, irmao));
}

function contarDentro(db, tipo, id) {
  // Quantas sessões e materiais saem junto, pra confirmação de exclusão dizer.
  if (tipo === "c") {
    return db
      .prepare(
        `SELECT COUNT(DISTINCT s.id) sessoes, COUNT(m.id) materiais FROM disciplinas d
           LEFT JOIN sessoes s ON s.disciplina_id = d.id LEFT JOIN materiais m ON m.sessao_id = s.id WHERE d.caderno_id = ?`,
      )
      .get(id);
  }
  if (tipo === "d") {
    return db
      .prepare("SELECT COUNT(DISTINCT s.id) sessoes, COUNT(m.id) materiais FROM sessoes s LEFT JOIN materiais m ON m.sessao_id = s.id WHERE s.disciplina_id = ?")
      .get(id);
  }
  if (tipo === "s") return { sessoes: 0, materiais: db.prepare("SELECT COUNT(*) n FROM materiais WHERE sessao_id = ?").get(id).n };
  return { sessoes: 0, materiais: 0 };
}

export function criarCaderno(db, usuario, nome) {
  const limpo = limparNome(nome);
  if (!limpo) return { erro: "Dê um nome ao caderno." };
  db.exec("BEGIN");
  try {
    const id = inserir(db, "c", usuario, limpo);
    conferirLimite(db, usuario);
    db.exec("COMMIT");
    return { id };
  } catch (erro) {
    db.exec("ROLLBACK");
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
export function aplicarEdicao(db, usuario, cadernoId, campos, acao, modelos) {
  const avisos = [];
  const resultado = { avisos, foco: null, confirmar: null, excluiuCaderno: false };
  const doCaderno = (tipo, id) => cadernoDoItem(db, usuario, tipo, id) === cadernoId;
  if (!doCaderno("c", cadernoId)) return null;
  // Índice dos campos pelo nome, montado uma vez: buscar o modelo de cada
  // sessão nova numa lista era O(n²) no número de campos do envio.
  const porNome = new Map(campos);

  db.exec("BEGIN");
  try {
    for (const [chave, valor] of campos) {
      const [campo, tipo, idTexto] = chave.split(":");
      if (campo !== "nome" || !nivel(tipo)) continue;
      const id = tipo === "c" ? cadernoId : Number(idTexto);
      if (!doCaderno(tipo, id)) continue;
      const nome = limparNome(valor);
      const atual = paiDe(db, tipo, id);
      if (!nome || nome === atual.nome) continue;
      try {
        db.prepare(`UPDATE ${NIVEIS[tipo].tabela} SET nome = ? WHERE id = ?`).run(nome, id);
      } catch (erro) {
        if (!repetido(erro)) throw erro;
        avisos.push(`Não renomeei "${atual.nome}": já existe "${nome}" no mesmo lugar.`);
      }
    }

    for (const [chave, valor] of campos) {
      const [campo, tipo, idTexto] = chave.split(":");
      if (campo !== "novo") continue;
      const nome = limparNome(valor);
      if (!nome) continue;
      if (!Object.hasOwn(PAI_DE, tipo)) continue;
      const nivelPai = PAI_DE[tipo];
      const idPai = tipo === "d" ? cadernoId : Number(idTexto);
      if (!doCaderno(nivelPai, idPai)) continue;
      try {
        const id = inserir(db, tipo, idPai, nome);
        resultado.foco = `${tipo}-${id}`;
        const escolhido = tipo === "s" ? porNome.get(`modelo:s:${idTexto}`) : null;
        const modelo = escolhido && Object.hasOwn(modelos, escolhido) ? modelos[escolhido] : null;
        for (const material of modelo ?? []) inserir(db, "m", id, material);
      } catch (erro) {
        if (!repetido(erro)) throw erro;
        avisos.push(`Não acrescentei "${nome}": já existe um item com esse nome no mesmo lugar.`);
      }
    }

    const [verbo, tipo, idTexto] = String(acao ?? "").split(":");
    const id = tipo === "c" ? cadernoId : Number(idTexto);
    if (nivel(tipo) && doCaderno(tipo, id)) {
      resultado.foco ??= `${tipo}-${id}`;
      if (verbo === "subir" || verbo === "descer") mover(db, tipo, id, verbo === "subir" ? -1 : 1);
      if (verbo === "excluir" || verbo === "confirmar") {
        const dentro = contarDentro(db, tipo, id);
        const temConteudo = tipo !== "m" && (tipo === "s" ? dentro.materiais > 0 : dentro.sessoes > 0 || dentro.materiais > 0 || tipo === "c");
        if (verbo === "excluir" && temConteudo) {
          resultado.confirmar = { tipo, id, nome: paiDe(db, tipo, id).nome, rotulo: NIVEIS[tipo].nome, ...dentro };
        } else {
          const { pai } = paiDe(db, tipo, id);
          db.prepare(`DELETE FROM ${NIVEIS[tipo].tabela} WHERE id = ?`).run(id);
          if (tipo === "c") resultado.excluiuCaderno = true;
          resultado.foco = tipo === "c" || tipo === "d" ? null : `${PAI_DE[tipo]}-${pai}`;
        }
      }
    }
    conferirLimite(db, usuario);
    db.exec("COMMIT");
  } catch (erro) {
    db.exec("ROLLBACK");
    throw erro;
  }
  return resultado;
}

// Move um item para a posição `indice` entre os irmãos (0 é o primeiro), pro
// arrastar e soltar do editor. Só dentro da mesma lista: mudar de pai fica pra
// depois. Índice fora da lista vai pro começo ou pro fim.
export function moverPara(db, usuario, cadernoId, tipo, id, indice) {
  if (!nivel(tipo) || !Number.isSafeInteger(indice)) return false;
  if (cadernoDoItem(db, usuario, tipo, id) !== cadernoId) return false;
  const { tabela, pai } = NIVEIS[tipo];
  db.exec("BEGIN");
  try {
    const { pai: idPai } = paiDe(db, tipo, id);
    const irmaos = consulta(db, `SELECT id FROM ${tabela} WHERE ${pai} = ? ORDER BY ordem, id`).all(idPai).map((l) => l.id).filter((x) => x !== id);
    irmaos.splice(Math.max(0, Math.min(indice, irmaos.length)), 0, id);
    const ordenar = consulta(db, `UPDATE ${tabela} SET ordem = ? WHERE id = ?`);
    irmaos.forEach((irmao, ordem) => ordenar.run(ordem, irmao));
    db.exec("COMMIT");
  } catch (erro) {
    db.exec("ROLLBACK");
    throw erro;
  }
  return true;
}

// Banco do notebook: SQLite embutido no Node (node:sqlite), um arquivo só no
// volume /dados. Toda consulta filtra pelo dono, o sub da Conta mhdn: ninguém
// alcança o caderno de outra pessoa nem acertando o id.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
  `);
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
      `SELECT c.id cid, c.nome cnome, d.id did, d.nome dnome, s.id sid, s.nome snome,
              m.id mid, m.nome mnome, m.concluido_em feito
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
    if (!cadernos.has(l.cid)) cadernos.set(l.cid, { id: l.cid, nome: l.cnome, disciplinas: [] });
    if (l.did != null && !disciplinas.has(l.did)) {
      const d = { id: l.did, nome: l.dnome, sessoes: [] };
      disciplinas.set(l.did, d);
      cadernos.get(l.cid).disciplinas.push(d);
    }
    if (l.sid != null && !sessoes.has(l.sid)) {
      const s = { id: l.sid, nome: l.snome, materiais: [], disciplina: disciplinas.get(l.did).nome, cadernoId: l.cid };
      sessoes.set(l.sid, s);
      disciplinas.get(l.did).sessoes.push(s);
    }
    if (l.mid != null) sessoes.get(l.sid).materiais.push({ id: l.mid, nome: l.mnome, feito: l.feito != null, feitoEm: l.feito });
  }

  for (const s of sessoes.values()) {
    s.total = s.materiais.length;
    s.feitos = s.materiais.filter((m) => m.feito).length;
    s.concluido = s.total > 0 && s.feitos === s.total;
  }
  for (const d of disciplinas.values()) {
    contar(d, "sessoes");
    d.sessoesConcluidas = d.sessoes.filter((s) => s.concluido).length;
  }
  for (const c of cadernos.values()) {
    contar(c, "disciplinas");
    c.sessoesTotal = c.disciplinas.reduce((n, d) => n + d.sessoes.length, 0);
    c.sessoesConcluidas = c.disciplinas.reduce((n, d) => n + d.sessoesConcluidas, 0);
    // O primeiro material em aberto, na ordem do caderno: o "continuar de onde parei".
    c.proximo = null;
    for (const d of c.disciplinas) {
      for (const s of d.sessoes) {
        const m = s.materiais.find((x) => !x.feito);
        if (m && !c.proximo) c.proximo = { sessao: s, material: m };
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
    const achado = db.prepare(`SELECT id FROM ${tabela} WHERE ${filtroPai} AND nome = ?`).get(idPai, nome);
    if (achado) return { id: achado.id, novo: false };
    const { ordem } = db.prepare(`SELECT COALESCE(MAX(ordem), -1) + 1 ordem FROM ${tabela} WHERE ${filtroPai}`).get(idPai);
    const r = db.prepare(`INSERT INTO ${tabela} (${pai}, nome, ordem) VALUES (?, ?, ?)`).run(idPai, nome, ordem);
    return { id: Number(r.lastInsertRowid), novo: true };
  };
  const marcar = db.prepare(
    "UPDATE materiais SET concluido_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND concluido_em IS NULL",
  );

  db.exec("BEGIN");
  try {
    for (const c of cadernos) {
      const cad = acharOuCriar("cadernos", "usuario", usuario, c.nome);
      resultado.cadernos.push(cad.id);
      for (const d of c.disciplinas) {
        const dis = acharOuCriar("disciplinas", "caderno_id", cad.id, d.nome);
        for (const s of d.sessoes) {
          const ses = acharOuCriar("sessoes", "disciplina_id", dis.id, s.nome);
          for (const m of s.materiais) {
            const mat = acharOuCriar("materiais", "sessao_id", ses.id, m.nome);
            if (mat.novo) resultado.criados++;
            if (m.feito && marcar.run(mat.id).changes) resultado.marcados++;
          }
        }
      }
    }
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

const NIVEIS = {
  c: { tabela: "cadernos", pai: "usuario", filhos: "d", nome: "o caderno" },
  d: { tabela: "disciplinas", pai: "caderno_id", filhos: "s", nome: "a disciplina" },
  s: { tabela: "sessoes", pai: "disciplina_id", filhos: "m", nome: "a sessão" },
  m: { tabela: "materiais", pai: "sessao_id", filhos: null, nome: "o material" },
};

// O caderno a que um item pertence, se ele for da pessoa. É a checagem de dono
// de toda edição: um id de outro caderno, ou de outra pessoa, devolve null.
const CADERNO_DE = {
  c: "SELECT c.id FROM cadernos c WHERE c.id = ? AND c.usuario = ?",
  d: "SELECT c.id FROM disciplinas d JOIN cadernos c ON c.id = d.caderno_id WHERE d.id = ? AND c.usuario = ?",
  s: `SELECT c.id FROM sessoes s JOIN disciplinas d ON d.id = s.disciplina_id
        JOIN cadernos c ON c.id = d.caderno_id WHERE s.id = ? AND c.usuario = ?`,
  m: `SELECT c.id FROM materiais m JOIN sessoes s ON s.id = m.sessao_id JOIN disciplinas d ON d.id = s.disciplina_id
        JOIN cadernos c ON c.id = d.caderno_id WHERE m.id = ? AND c.usuario = ?`,
};

export function cadernoDoItem(db, usuario, tipo, id) {
  if (!CADERNO_DE[tipo]) return null;
  return db.prepare(CADERNO_DE[tipo]).get(id, usuario)?.id ?? null;
}

const limparNome = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
const repetido = (erro) => /UNIQUE/i.test(erro?.message ?? "");

function paiDe(db, tipo, id) {
  const { tabela, pai } = NIVEIS[tipo];
  return db.prepare(`SELECT ${pai} pai, nome FROM ${tabela} WHERE id = ?`).get(id);
}

function inserir(db, tipo, idPai, nome) {
  const { tabela, pai } = NIVEIS[tipo];
  const { ordem } = db.prepare(`SELECT COALESCE(MAX(ordem), -1) + 1 ordem FROM ${tabela} WHERE ${pai} = ?`).get(idPai);
  return Number(db.prepare(`INSERT INTO ${tabela} (${pai}, nome, ordem) VALUES (?, ?, ?)`).run(idPai, nome, ordem).lastInsertRowid);
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
  try {
    return { id: inserir(db, "c", usuario, limpo) };
  } catch (erro) {
    if (repetido(erro)) return { erro: `Já existe um caderno chamado "${limpo}".` };
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

  db.exec("BEGIN");
  try {
    for (const [chave, valor] of campos) {
      const [campo, tipo, idTexto] = chave.split(":");
      if (campo !== "nome" || !NIVEIS[tipo]) continue;
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
      const nivelPai = { d: "c", s: "d", m: "s" }[tipo];
      if (!nivelPai) continue;
      const idPai = tipo === "d" ? cadernoId : Number(idTexto);
      if (!doCaderno(nivelPai, idPai)) continue;
      try {
        const id = inserir(db, tipo, idPai, nome);
        resultado.foco = `${tipo}-${id}`;
        const modelo = tipo === "s" ? modelos[campos.find(([k]) => k === `modelo:s:${idTexto}`)?.[1]] : null;
        for (const material of modelo ?? []) inserir(db, "m", id, material);
      } catch (erro) {
        if (!repetido(erro)) throw erro;
        avisos.push(`Não acrescentei "${nome}": já existe um item com esse nome no mesmo lugar.`);
      }
    }

    const [verbo, tipo, idTexto] = String(acao ?? "").split(":");
    const id = tipo === "c" ? cadernoId : Number(idTexto);
    if (NIVEIS[tipo] && doCaderno(tipo, id)) {
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
          resultado.foco = tipo === "c" || tipo === "d" ? null : `${{ s: "d", m: "s" }[tipo]}-${pai}`;
        }
      }
    }
    db.exec("COMMIT");
  } catch (erro) {
    db.exec("ROLLBACK");
    throw erro;
  }
  return resultado;
}

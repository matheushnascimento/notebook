// A cópia do SQLite de antes pro Postgres (scripts/copiar-para-supabase.js),
// com o PGlite no lugar do Supabase.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { lerSqlite, copiar } from "../scripts/copiar-para-supabase.js";
import * as banco from "../src/banco.js";

// Um SQLite no formato de antes, com e sem o concluido_em do #7 nos níveis.
function sqliteVelho({ comConclusao }) {
  const caminho = join(mkdtempSync(join(tmpdir(), "notebook-")), "velho.db");
  const db = new DatabaseSync(caminho);
  const extra = comConclusao ? ", concluido_em TEXT" : "";
  db.exec(`CREATE TABLE cadernos (id INTEGER PRIMARY KEY, usuario TEXT NOT NULL, nome TEXT NOT NULL COLLATE NOCASE, ordem INTEGER NOT NULL${extra}, UNIQUE (usuario, nome));
    CREATE TABLE disciplinas (id INTEGER PRIMARY KEY, caderno_id INTEGER NOT NULL REFERENCES cadernos(id) ON DELETE CASCADE, nome TEXT NOT NULL COLLATE NOCASE, ordem INTEGER NOT NULL${extra}, UNIQUE (caderno_id, nome));
    CREATE TABLE sessoes (id INTEGER PRIMARY KEY, disciplina_id INTEGER NOT NULL REFERENCES disciplinas(id) ON DELETE CASCADE, nome TEXT NOT NULL COLLATE NOCASE, ordem INTEGER NOT NULL${extra}, UNIQUE (disciplina_id, nome));
    CREATE TABLE materiais (id INTEGER PRIMARY KEY, sessao_id INTEGER NOT NULL REFERENCES sessoes(id) ON DELETE CASCADE, nome TEXT NOT NULL COLLATE NOCASE, ordem INTEGER NOT NULL, concluido_em TEXT, UNIQUE (sessao_id, nome));
    INSERT INTO cadernos (id, usuario, nome, ordem) VALUES (3, 'ana', 'Velho', 0), (7, 'bia', 'Outro', 0);
    INSERT INTO disciplinas (id, caderno_id, nome, ordem) VALUES (5, 3, 'D', 0), (9, 7, 'D', 0);
    INSERT INTO sessoes (id, disciplina_id, nome, ordem) VALUES (11, 5, 'S', 0), (12, 9, 'S', 0);
    INSERT INTO materiais VALUES (20, 11, 'M1', 0, '2026-11-01T00:00:00Z'), (21, 11, 'M2', 1, NULL), (30, 12, 'X', 0, NULL);`);
  if (comConclusao) db.exec("UPDATE sessoes SET concluido_em = '2026-11-02T00:00:00Z' WHERE id = 12");
  db.close();
  return caminho;
}

test("cópia: os ids e o progresso chegam iguais, e o banco segue de onde parou", async () => {
  const destino = await banco.abrirBanco(":memory:");
  const r = await copiar(lerSqlite(sqliteVelho({ comConclusao: false })), destino);
  assert.deepEqual(r.materiais, { n: 3, feitos: 1 });

  const c = await banco.caderno(destino, "ana", 3);
  assert.equal(c.nome, "Velho");
  assert.deepEqual(c.disciplinas[0].sessoes[0].materiais.map((m) => [m.id, m.nome, m.feito]), [[20, "M1", true], [21, "M2", false]]);
  assert.equal(c.disciplinas[0].sessoes[0].materiais[0].feitoEm, "2026-11-01T00:00:00Z");
  assert.equal(await banco.caderno(destino, "bia", 3), null, "o dono vem junto");

  // A próxima linha não colide com um id copiado, e o nome único sem
  // diferenciar maiúsculas continua valendo.
  const novo = await banco.criarCaderno(destino, "ana", "Novo");
  assert.ok(novo.id > 7);
  assert.match((await banco.criarCaderno(destino, "ana", "velho")).erro, /Já existe/);
});

test("cópia: recusa destino ocupado, e --substituir troca tudo", async () => {
  const destino = await banco.abrirBanco(":memory:");
  const dados = lerSqlite(sqliteVelho({ comConclusao: true }));
  await copiar(dados, destino);
  await banco.criarCaderno(destino, "ana", "Feito depois");

  await assert.rejects(copiar(dados, destino), /--substituir/);
  assert.ok((await banco.arvore(destino, "ana")).some((c) => c.nome === "Feito depois"), "a recusa não apaga nada");

  const r = await copiar(dados, destino, { substituir: true });
  assert.equal(r.cadernos.n, 2);
  assert.ok(!(await banco.arvore(destino, "ana")).some((c) => c.nome === "Feito depois"));
  assert.equal((await banco.sessao(destino, "bia", 12)).sessao.manual, true, "a conclusão da sessão vem junto");
});

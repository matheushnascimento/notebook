import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { lerMarkdown, escreverMarkdown, MODELOS } from "../src/markdown.js";
import * as banco from "../src/banco.js";

const exemplo = readFileSync(new URL("../exemplos/cst-mba.md", import.meta.url), "utf8");

test("o exemplo lê sem avisos, com modelos expandidos", () => {
  const { cadernos, avisos } = lerMarkdown(exemplo);
  assert.deepEqual(avisos, []);
  assert.deepEqual(cadernos.map((c) => c.nome), ["CST", "MBA FM2S"]);
  const pg = cadernos[0].disciplinas[0];
  assert.equal(pg.nome, "Prática em gestão");
  assert.equal(pg.sessoes.length, 4);
  assert.deepEqual(pg.sessoes[0].materiais.map((m) => m.nome), MODELOS.cst);
  const ia = cadernos[0].disciplinas[2].sessoes[0];
  assert.equal(ia.materiais.length, 6, "lista própria vence o modelo");
  assert.deepEqual(cadernos[1].disciplinas[0].sessoes[0].materiais.map((m) => m.nome), MODELOS.mba);
});

test("checkbox, prefixos e frontmatter", () => {
  const { cadernos, avisos } = lerMarkdown("---\ntitulo: x\n---\n# Caderno: CST\n## Disciplina: PG\n### Sessão: PGUN1\n- [x] Vídeo\n* [ ] Ebook\n- Quiz\n");
  assert.deepEqual(avisos, []);
  const s = cadernos[0].disciplinas[0].sessoes[0];
  assert.equal(cadernos[0].nome, "CST");
  assert.equal(s.nome, "PGUN1");
  assert.deepEqual(s.materiais, [
    { nome: "Vídeo", feito: true },
    { nome: "Ebook", feito: false },
    { nome: "Quiz", feito: false },
  ]);
});

test("estrutura fora de ordem e modelo desconhecido viram aviso", () => {
  const { avisos } = lerMarkdown("## Sem caderno\n# C\n### Sem disciplina\n## D\nmodelo: xyz\n- solto\n");
  assert.equal(avisos.length, 4);
  assert.match(lerMarkdown("texto solto").avisos[0], /Nenhum caderno/);
});

test("importar mescla sem desfazer progresso, e o .md faz o caminho de volta", () => {
  const db = banco.abrirBanco(":memory:");
  const r1 = banco.importar(db, "ana", lerMarkdown(exemplo).cadernos);
  assert.equal(r1.cadernos.length, 2);
  const cst = banco.caderno(db, "ana", r1.cadernos[0]);
  assert.equal(cst.total, 6 * 9 + 6);
  assert.equal(cst.proximo.material.nome, "Gerar esqueleto");

  const primeiro = cst.disciplinas[0].sessoes[0].materiais[0];
  assert.ok(banco.alternarMaterial(db, "ana", primeiro.id));

  // Reimportar o mesmo arquivo, com "[ ]" no material concluído, não cria nada
  // nem desmarca.
  const r2 = banco.importar(db, "ana", lerMarkdown(exemplo).cadernos);
  assert.equal(r2.criados, 0);
  const depois = banco.caderno(db, "ana", r1.cadernos[0]);
  assert.equal(depois.feitos, 1);
  assert.equal(depois.proximo.material.nome, "Vídeo");

  // Ida e volta: o .md exportado, reimportado em outra conta, dá a mesma árvore.
  const md = escreverMarkdown(depois);
  assert.match(md, /- \[x\] Gerar esqueleto/);
  const r3 = banco.importar(db, "bia", lerMarkdown(md).cadernos);
  const copia = banco.caderno(db, "bia", r3.cadernos[0]);
  assert.equal(copia.total, depois.total);
  assert.equal(copia.feitos, 1);

  // Mesmo nome sem diferenciar maiúsculas: acrescenta ao caderno existente.
  const r4 = banco.importar(db, "ana", lerMarkdown("# cst\n## prática EM gestão\n### PGUN5\n- Vídeo\n").cadernos);
  assert.equal(r4.cadernos[0], r1.cadernos[0]);
  assert.equal(banco.caderno(db, "ana", r1.cadernos[0]).disciplinas[0].sessoes.length, 5);
});

test("ninguém alcança o caderno de outra pessoa", () => {
  const db = banco.abrirBanco(":memory:");
  const { cadernos } = banco.importar(db, "ana", lerMarkdown("# A\n## D\n### S\n- M\n").cadernos);
  const c = banco.caderno(db, "ana", cadernos[0]);
  const s = c.disciplinas[0].sessoes[0];
  const m = s.materiais[0];

  assert.equal(banco.caderno(db, "bia", c.id), null);
  assert.equal(banco.sessao(db, "bia", s.id), null);
  assert.equal(banco.alternarMaterial(db, "bia", m.id), null);
  assert.equal(banco.marcarSessao(db, "bia", s.id, true), 0);
  assert.equal(banco.excluirCaderno(db, "bia", c.id), false);
  assert.equal(banco.caderno(db, "ana", c.id).feitos, 0);

  assert.equal(banco.marcarSessao(db, "ana", s.id, true), 1);
  assert.ok(banco.sessao(db, "ana", s.id).sessao.concluido);
  assert.ok(banco.excluirCaderno(db, "ana", c.id));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM materiais").get().n, 0, "exclusão em cascata");
});

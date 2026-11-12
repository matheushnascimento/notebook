import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { lerMarkdown, escreverMarkdown, MODELOS } from "../src/markdown.js";
import * as banco from "../src/banco.js";

const exemplo = readFileSync(new URL("../exemplos/exemplo.md", import.meta.url), "utf8");

test("o exemplo lê sem avisos, com modelos expandidos", () => {
  const { cadernos, avisos } = lerMarkdown(exemplo);
  assert.deepEqual(avisos, []);
  assert.deepEqual(cadernos.map((c) => c.nome), ["Caderno A", "Caderno B"]);
  const pg = cadernos[0].disciplinas[0];
  assert.equal(pg.nome, "Disciplina 1");
  assert.equal(pg.sessoes.length, 4);
  assert.deepEqual(pg.sessoes[0].materiais.map((m) => m.nome), MODELOS.unidades);
  const ia = cadernos[0].disciplinas[2].sessoes[0];
  assert.equal(ia.materiais.length, 6, "lista própria vence o modelo");
  assert.deepEqual(cadernos[1].disciplinas[0].sessoes[0].materiais.map((m) => m.nome), MODELOS.submódulos);
});

test("checkbox, prefixos e frontmatter", () => {
  const { cadernos, avisos } = lerMarkdown("---\ntitulo: x\n---\n# Caderno: Caderno A\n## Disciplina: D1\n### Sessão: Sessão 1.1\n- [x] Vídeo\n* [ ] Ebook\n- Quiz\n");
  assert.deepEqual(avisos, []);
  const s = cadernos[0].disciplinas[0].sessoes[0];
  assert.equal(cadernos[0].nome, "Caderno A");
  assert.equal(s.nome, "Sessão 1.1");
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
  const caderno = banco.caderno(db, "ana", r1.cadernos[0]);
  assert.equal(caderno.total, 6 * 9 + 6);
  assert.equal(caderno.proximo.material.nome, "Gerar esqueleto");

  const primeiro = caderno.disciplinas[0].sessoes[0].materiais[0];
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
  const r4 = banco.importar(db, "ana", lerMarkdown("# caderno a\n## disciplina 1\n### Sessão 1.5\n- Vídeo\n").cadernos);
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

test("edição: montar um caderno inteiro sem .md", () => {
  const db = banco.abrirBanco(":memory:");
  const { id } = banco.criarCaderno(db, "ana", "  Caderno A  ");
  assert.ok(id);
  assert.match(banco.criarCaderno(db, "ana", "caderno a").erro, /Já existe/);
  assert.match(banco.criarCaderno(db, "ana", "   ").erro, /nome/);

  let r = banco.aplicarEdicao(db, "ana", id, [["novo:d", "Disciplina 1"]], "salvar:c:" + id, MODELOS);
  const d = banco.caderno(db, "ana", id).disciplinas[0];
  assert.equal(r.foco, `d-${d.id}`);

  r = banco.aplicarEdicao(db, "ana", id, [[`novo:s:${d.id}`, "Sessão 1.1"], [`modelo:s:${d.id}`, "unidades"]], `salvar:d:${d.id}`, MODELOS);
  banco.aplicarEdicao(db, "ana", id, [[`novo:s:${d.id}`, "Sessão 1.2"], [`modelo:s:${d.id}`, ""]], `salvar:d:${d.id}`, MODELOS);
  let c = banco.caderno(db, "ana", id);
  const [s1, s2] = c.disciplinas[0].sessoes;
  assert.deepEqual(s1.materiais.map((m) => m.nome), MODELOS.unidades);
  assert.equal(s2.materiais.length, 0);

  banco.aplicarEdicao(db, "ana", id, [[`novo:m:${s2.id}`, "Vídeo"]], `salvar:s:${s2.id}`, MODELOS);
  banco.aplicarEdicao(db, "ana", id, [[`novo:m:${s2.id}`, "Ebook"]], `salvar:s:${s2.id}`, MODELOS);

  // Renomear vários de uma vez e mover, num envio só.
  c = banco.caderno(db, "ana", id);
  const ebook = c.disciplinas[0].sessoes[1].materiais[1];
  r = banco.aplicarEdicao(db, "ana", id, [[`nome:c:${id}`, "Caderno 2026"], [`nome:s:${s2.id}`, "Sessão 1.2 - Unidade 2"], [`nome:m:${ebook.id}`, "Ebook 1/2"]], `subir:m:${ebook.id}`, MODELOS);
  assert.deepEqual(r.avisos, []);
  c = banco.caderno(db, "ana", id);
  assert.equal(c.nome, "Caderno 2026");
  assert.equal(c.disciplinas[0].sessoes[1].nome, "Sessão 1.2 - Unidade 2");
  assert.deepEqual(c.disciplinas[0].sessoes[1].materiais.map((m) => m.nome), ["Ebook 1/2", "Vídeo"]);

  // Subir o primeiro não faz nada; descer a sessão 1 troca com a 2.
  banco.aplicarEdicao(db, "ana", id, [], `subir:s:${s1.id}`, MODELOS);
  banco.aplicarEdicao(db, "ana", id, [], `descer:s:${s1.id}`, MODELOS);
  assert.deepEqual(banco.caderno(db, "ana", id).disciplinas[0].sessoes.map((s) => s.nome), ["Sessão 1.2 - Unidade 2", "Sessão 1.1"]);

  // Nome repetido vira aviso, sem derrubar o resto do envio.
  r = banco.aplicarEdicao(db, "ana", id, [[`nome:s:${s1.id}`, "sessão 1.2 - unidade 2"], [`novo:m:${s1.id}`, "Quiz"]], "salvar", MODELOS);
  assert.equal(r.avisos.length, 1);
  assert.ok(banco.caderno(db, "ana", id).disciplinas[0].sessoes[1].materiais.some((m) => m.nome === "Quiz"));
});

test("edição: excluir pede confirmação quando há conteúdo", () => {
  const db = banco.abrirBanco(":memory:");
  const { cadernos } = banco.importar(db, "ana", lerMarkdown("# A\n## D\n### S\n- M1\n- [x] M2\n## Vazia\n").cadernos);
  const id = cadernos[0];
  let c = banco.caderno(db, "ana", id);
  const [d, vazia] = c.disciplinas;
  const s = d.sessoes[0];

  // Material sai direto, e o foco volta pra sessão.
  let r = banco.aplicarEdicao(db, "ana", id, [], `excluir:m:${s.materiais[0].id}`, MODELOS);
  assert.equal(r.confirmar, null);
  assert.equal(r.foco, `s-${s.id}`);
  // Disciplina vazia sai direto; com conteúdo, pede confirmação e não apaga.
  assert.equal(banco.aplicarEdicao(db, "ana", id, [], `excluir:d:${vazia.id}`, MODELOS).confirmar, null);
  r = banco.aplicarEdicao(db, "ana", id, [], `excluir:d:${d.id}`, MODELOS);
  assert.deepEqual({ ...r.confirmar }, { tipo: "d", id: d.id, nome: "D", rotulo: "a disciplina", sessoes: 1, materiais: 1 });
  assert.equal(banco.caderno(db, "ana", id).disciplinas.length, 1);
  banco.aplicarEdicao(db, "ana", id, [], `confirmar:d:${d.id}`, MODELOS);
  assert.equal(banco.caderno(db, "ana", id).disciplinas.length, 0);

  // O caderno sempre pede confirmação.
  assert.ok(banco.aplicarEdicao(db, "ana", id, [], `excluir:c:${id}`, MODELOS).confirmar);
  assert.ok(banco.aplicarEdicao(db, "ana", id, [], `confirmar:c:${id}`, MODELOS).excluiuCaderno);
  assert.equal(banco.caderno(db, "ana", id), null);
});

test("edição: nada atravessa para outro caderno ou outra pessoa", () => {
  const db = banco.abrirBanco(":memory:");
  const [a, b] = banco.importar(db, "ana", lerMarkdown("# A\n## D\n### S\n- M\n# B\n## D\n### S\n- M\n").cadernos).cadernos;
  const outro = banco.importar(db, "bia", lerMarkdown("# X\n## D\n### S\n- M\n").cadernos).cadernos[0];
  const cb = banco.caderno(db, "ana", b);
  const cx = banco.caderno(db, "bia", outro);
  const mb = cb.disciplinas[0].sessoes[0].materiais[0];
  const mx = cx.disciplinas[0].sessoes[0].materiais[0];

  assert.equal(banco.aplicarEdicao(db, "bia", a, [], "salvar", MODELOS), null, "caderno de outra pessoa");
  // Pelo editor do caderno A, itens do B e da Bia são ignorados.
  banco.aplicarEdicao(
    db, "ana", a,
    [[`nome:m:${mb.id}`, "invadido"], [`nome:m:${mx.id}`, "invadido"], [`novo:m:${cx.disciplinas[0].sessoes[0].id}`, "invadido"]],
    `confirmar:m:${mx.id}`, MODELOS,
  );
  assert.equal(banco.caderno(db, "ana", b).disciplinas[0].sessoes[0].materiais[0].nome, "M");
  assert.deepEqual(banco.caderno(db, "bia", outro).disciplinas[0].sessoes[0].materiais.map((m) => m.nome), ["M"]);
});

test("o CSS tem a versão no nome, e as páginas apontam pra ele", async () => {
  const { CAMINHO_ESTILO, ESTILO, renderErro } = await import("../src/paginas.js");
  assert.match(CAMINHO_ESTILO, /^\/estilo\.[0-9a-f]{12}\.css$/);
  assert.ok(renderErro("x", "y").includes(`href="${CAMINHO_ESTILO}"`));
  assert.ok(ESTILO.includes(".linha-item"));
});

// --- Auditoria de segurança (#5) ---------------------------------------------

test("segurança: nomes do protótipo não quebram nada", () => {
  for (const m of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    const { avisos } = lerMarkdown(`# A\n## D\nmodelo: ${m}\n### S\n`);
    assert.match(avisos[0], /não existe/, m);
  }
  const db = banco.abrirBanco(":memory:");
  const id = banco.importar(db, "ana", lerMarkdown("# A\n## D\n### S\n- M\n").cadernos).cadernos[0];
  for (const tipo of ["__proto__", "constructor", "toString", "prototype"]) {
    assert.doesNotThrow(() => banco.aplicarEdicao(db, "ana", id, [[`nome:${tipo}:1`, "x"], [`novo:${tipo}:1`, "x"]], `excluir:${tipo}:1`, MODELOS), tipo);
    assert.equal(banco.cadernoDoItem(db, "ana", tipo, 1), null);
  }
  assert.doesNotThrow(() => banco.aplicarEdicao(db, "ana", id, [["novo:s:1", "S2"], ["modelo:s:1", "__proto__"]], "salvar", MODELOS));
  assert.equal(banco.caderno(db, "ana", id).disciplinas[0].sessoes[1].materiais.length, 0, "modelo inválido cria sessão vazia");
  assert.equal(banco.cadernoDoItem(db, "ana", "m", 1e20), null);
});

test("segurança: a leitura do .md é linear, sem travar com linha longa", () => {
  let t = Date.now();
  const r = lerMarkdown("# a" + " ".repeat(500_000) + "b");
  assert.match(r.avisos[0], /passa de 2000/);
  // O pior caso que ainda passa do limite de linha, repetido até os 512 KB.
  const linha = "# a" + " ".repeat(1990) + "b\n";
  lerMarkdown(linha.repeat(Math.floor((512 * 1024) / linha.length)));
  assert.ok(Date.now() - t < 1000, `levou ${Date.now() - t} ms`);
  // O "###" de fechamento sai; "C#" fica.
  assert.equal(lerMarkdown("# C# ###\n").cadernos[0].nome, "C#");
});

test("segurança: invisíveis e direção bidirecional saem dos nomes", () => {
  const { cadernos } = lerMarkdown("# A‮gnp.exe\u0007\n");
  assert.equal(cadernos[0].nome, "Agnp.exe");
  const db = banco.abrirBanco(":memory:");
  assert.equal(banco.caderno(db, "ana", banco.criarCaderno(db, "ana", "B\u0000⁦x").id).nome, "Bx");
  // Emoji compostos (com ZWJ) continuam inteiros.
  assert.equal(banco.caderno(db, "ana", banco.criarCaderno(db, "ana", "Estudo 👩‍💻").id).nome, "Estudo 👩‍💻");
});

test("segurança: tetos por arquivo e por conta, rápidos e sem gravar pela metade", () => {
  const db = banco.abrirBanco(":memory:");
  const arquivo = (titulo, n) => `# ${titulo}\n## D\n### S\n` + Array.from({ length: n }, (_, i) => `- M${i}`).join("\n");

  // Arquivo acima do teto: recusado antes de gravar, sem custo.
  let t = Date.now();
  assert.throws(() => banco.importar(db, "ana", lerMarkdown(arquivo("A", banco.LIMITE_IMPORTACAO)).cadernos), (e) => e.status === 413 && /por importação/.test(e.publico));
  assert.ok(Date.now() - t < 200, `recusa levou ${Date.now() - t} ms`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM materiais").get().n, 0);

  // Arquivos no teto, um depois do outro, até passar do teto da conta.
  const porArquivo = banco.LIMITE_IMPORTACAO - 4;
  const cabem = Math.floor(banco.LIMITE_ITENS / banco.LIMITE_IMPORTACAO);
  t = Date.now();
  for (let i = 0; i < cabem; i++) banco.importar(db, "ana", lerMarkdown(arquivo(`C${i}`, porArquivo)).cadernos);
  const porImportacao = (Date.now() - t) / cabem;
  assert.ok(porImportacao < 1000, `importação no teto levou ${porImportacao} ms`);
  const antes = db.prepare("SELECT COUNT(*) n FROM materiais").get().n;
  assert.throws(() => banco.importar(db, "ana", lerMarkdown(arquivo("Demais", porArquivo)).cadernos), (e) => e.status === 413 && /por conta/.test(e.publico));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM materiais").get().n, antes, "rollback");
  // Outra pessoa não é afetada pelo teto da Ana.
  assert.ok(banco.criarCaderno(db, "bia", "B").id);
  // Os cadernos avulsos também contam: completam as vagas e depois são recusados.
  const criados = Array.from({ length: 10 }, (_, i) => banco.criarCaderno(db, "ana", `Avulso ${i}`));
  assert.ok(criados.some((r) => r.id));
  assert.match(criados.at(-1).erro, /limite/);
});

// --- Concluir sem marcar todos os itens (#7) ---------------------------------

test("conclusão: sessão concluída a mão conta como 100% acima, e reabrir desfaz", () => {
  const db = banco.abrirBanco(":memory:");
  const id = banco.importar(db, "ana", lerMarkdown("# C\n## D\n### S1\n- a\n- b\n- c\n- d\n### S2\n- e\n- f\n- g\n- h\n").cadernos).cadernos[0];
  let c = banco.caderno(db, "ana", id);
  const [s1, s2] = c.disciplinas[0].sessoes;
  banco.alternarMaterial(db, "ana", s1.materiais[0].id);

  assert.deepEqual(banco.alternarConclusao(db, "ana", "s", s1.id), { cadernoId: id, tipo: "s", id: s1.id });
  c = banco.caderno(db, "ana", id);
  const [x1] = c.disciplinas[0].sessoes;
  assert.equal(x1.concluido, true);
  assert.equal(x1.manual, true);
  assert.equal(x1.feitosReais, 1, "os materiais não mudam");
  assert.equal(x1.feitos, 4, "conta como 4 de 4");
  assert.equal(c.disciplinas[0].feitos, 4, "a disciplina vê 4 de 8");
  assert.equal(c.disciplinas[0].sessoesConcluidas, 1);
  assert.equal(c.proximo.sessao.id, s2.id, "o continuar pula a sessão concluída");
  assert.equal(c.concluido, false);

  banco.alternarConclusao(db, "ana", "s", s1.id);
  c = banco.caderno(db, "ana", id);
  assert.equal(c.disciplinas[0].sessoes[0].concluido, false);
  assert.equal(c.disciplinas[0].feitos, 1);
  assert.equal(c.proximo.sessao.id, s1.id);
});

test("conclusão: disciplina e caderno concluem acima, e a automática continua valendo", () => {
  const db = banco.abrirBanco(":memory:");
  const id = banco.importar(db, "ana", lerMarkdown("# C\n## D1\n### S\n- a\n- b\n## D2\n### T\n- c\n### Vazia\n").cadernos).cadernos[0];
  let c = banco.caderno(db, "ana", id);
  const [d1, d2] = c.disciplinas;

  banco.alternarConclusao(db, "ana", "d", d1.id);
  c = banco.caderno(db, "ana", id);
  assert.equal(c.disciplinas[0].concluido, true);
  assert.equal(c.disciplinas[0].sessoesConcluidas, 1);
  assert.equal(c.feitos, 2, "D1 conta inteira");
  assert.equal(c.proximo.sessao.nome, "T");

  // Automática: com todos os materiais de T marcados e a sessão vazia concluída a mão, D2 conclui sozinha.
  banco.alternarMaterial(db, "ana", d2.sessoes[0].materiais[0].id);
  banco.alternarConclusao(db, "ana", "s", d2.sessoes[1].id);
  c = banco.caderno(db, "ana", id);
  assert.equal(c.disciplinas[1].concluido, true);
  assert.equal(c.disciplinas[1].manual, false);
  assert.equal(c.concluido, true, "todas as disciplinas concluídas");
  assert.equal(c.proximo, null);

  // Caderno concluído a mão, mesmo com algo reaberto dentro.
  banco.alternarConclusao(db, "ana", "d", d1.id);
  assert.equal(banco.caderno(db, "ana", id).concluido, false);
  banco.alternarConclusao(db, "ana", "c", id);
  c = banco.caderno(db, "ana", id);
  assert.equal(c.concluido, true);
  assert.equal(c.sessoesConcluidas, c.sessoesTotal);
  assert.equal(c.feitos, c.total);
});

test("conclusão: o .md leva e traz, e ninguém conclui o que não é seu", () => {
  const db = banco.abrirBanco(":memory:");
  const md = "# C\nconcluído: sim\n## D\nconcluida: s\n### S\nConcluído: sim\n- a\n### T\nconcluído: não\n- b\n";
  const lido = lerMarkdown(md);
  assert.deepEqual(lido.avisos, []);
  assert.equal(lido.cadernos[0].concluido, true);
  assert.equal(lido.cadernos[0].disciplinas[0].sessoes[1].concluido, false);
  assert.match(lerMarkdown("# C\nconcluído: talvez\n").avisos[0], /concluído: sim/);

  const id = banco.importar(db, "ana", lido.cadernos).cadernos[0];
  const c = banco.caderno(db, "ana", id);
  assert.ok(c.manual && c.disciplinas[0].manual && c.disciplinas[0].sessoes[0].manual);
  assert.equal(c.disciplinas[0].sessoes[1].manual, false);
  const volta = escreverMarkdown(c);
  assert.equal((volta.match(/concluído: sim/g) ?? []).length, 3);
  const copia = banco.caderno(db, "bia", banco.importar(db, "bia", lerMarkdown(volta).cadernos).cadernos[0]);
  assert.ok(copia.manual && copia.disciplinas[0].sessoes[0].manual);
  assert.equal(copia.disciplinas[0].sessoes[1].manual, false);

  // Reimportar sem a linha não reabre.
  banco.importar(db, "ana", lerMarkdown("# C\n## D\n### S\n- a\n").cadernos);
  assert.ok(banco.caderno(db, "ana", id).disciplinas[0].sessoes[0].manual);

  // Outra pessoa, material e tipos inválidos: nada.
  const s = c.disciplinas[0].sessoes[0];
  assert.equal(banco.alternarConclusao(db, "bia", "s", s.id), null);
  assert.equal(banco.alternarConclusao(db, "ana", "m", s.materiais[0].id), null);
  assert.equal(banco.alternarConclusao(db, "ana", "__proto__", 1), null);
  assert.ok(banco.caderno(db, "ana", id).disciplinas[0].sessoes[0].manual);
});

test("conclusão: banco de antes ganha a coluna sem perder nada", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const caminho = join(mkdtempSync(join(tmpdir(), "notebook-")), "velho.db");
  const velho = new DatabaseSync(caminho);
  velho.exec(`CREATE TABLE cadernos (id INTEGER PRIMARY KEY, usuario TEXT NOT NULL, nome TEXT NOT NULL COLLATE NOCASE, ordem INTEGER NOT NULL, UNIQUE (usuario, nome));
    CREATE TABLE disciplinas (id INTEGER PRIMARY KEY, caderno_id INTEGER NOT NULL REFERENCES cadernos(id) ON DELETE CASCADE, nome TEXT NOT NULL COLLATE NOCASE, ordem INTEGER NOT NULL, UNIQUE (caderno_id, nome));
    CREATE TABLE sessoes (id INTEGER PRIMARY KEY, disciplina_id INTEGER NOT NULL REFERENCES disciplinas(id) ON DELETE CASCADE, nome TEXT NOT NULL COLLATE NOCASE, ordem INTEGER NOT NULL, UNIQUE (disciplina_id, nome));
    CREATE TABLE materiais (id INTEGER PRIMARY KEY, sessao_id INTEGER NOT NULL REFERENCES sessoes(id) ON DELETE CASCADE, nome TEXT NOT NULL COLLATE NOCASE, ordem INTEGER NOT NULL, concluido_em TEXT, UNIQUE (sessao_id, nome));
    INSERT INTO cadernos VALUES (1, 'ana', 'Velho', 0); INSERT INTO disciplinas VALUES (1, 1, 'D', 0);
    INSERT INTO sessoes VALUES (1, 1, 'S', 0); INSERT INTO materiais VALUES (1, 1, 'M', 0, '2026-11-01T00:00:00Z');`);
  velho.close();
  const db = banco.abrirBanco(caminho);
  const c = banco.caderno(db, "ana", 1);
  assert.equal(c.disciplinas[0].sessoes[0].materiais[0].feito, true);
  assert.ok(banco.alternarConclusao(db, "ana", "c", 1));
  assert.ok(banco.abrirBanco(caminho), "abrir de novo não tenta criar a coluna outra vez");
});

// --- API JSON do editor (#9) -------------------------------------------------

test("api: as operações do editor devolvem a árvore nova", async () => {
  const { operar } = await import("../src/api.js");
  const db = banco.abrirBanco(":memory:");
  const { id } = banco.criarCaderno(db, "ana", "Caderno A");
  let r = operar(db, "ana", id, { op: "acrescentar", tipo: "d", nome: "PG" });
  const d = r.caderno.disciplinas[0];
  r = operar(db, "ana", id, { op: "acrescentar", tipo: "s", pai: d.id, nome: "Sessão 1.1", modelo: "submódulos" });
  const s = r.caderno.disciplinas[0].sessoes[0];
  assert.deepEqual(s.materiais.map((m) => m.nome), MODELOS.submódulos);
  assert.equal(r.caderno.modelos.unidades, MODELOS.unidades.length);

  r = operar(db, "ana", id, { op: "renomear", tipo: "s", id: s.id, nome: "Sessão 1.1 - Unidade 1" });
  assert.equal(r.caderno.disciplinas[0].sessoes[0].nome, "Sessão 1.1 - Unidade 1");
  r = operar(db, "ana", id, { op: "renomear", tipo: "c", nome: "Caderno 2026" });
  assert.equal(r.caderno.nome, "Caderno 2026");

  const [m0, , , m3] = s.materiais;
  r = operar(db, "ana", id, { op: "mover", tipo: "m", id: m3.id, indice: 0 });
  assert.deepEqual(r.caderno.disciplinas[0].sessoes[0].materiais.map((m) => m.nome), ["Quiz", "Gerar esqueleto", "Vídeo", "Ebook (só se ficou lacuna)"]);
  r = operar(db, "ana", id, { op: "mover", tipo: "m", id: m0.id, indice: 99 });
  assert.equal(r.caderno.disciplinas[0].sessoes[0].materiais.at(-1).id, m0.id);

  r = operar(db, "ana", id, { op: "marcar", id: m3.id });
  assert.equal(r.caderno.disciplinas[0].sessoes[0].feitosReais, 1);
  r = operar(db, "ana", id, { op: "concluir", tipo: "s", id: s.id });
  assert.equal(r.caderno.disciplinas[0].sessoes[0].manual, true);

  r = operar(db, "ana", id, { op: "excluir", tipo: "s", id: s.id });
  assert.equal(r.confirmar.materiais, 4);
  assert.equal(r.caderno.disciplinas[0].sessoes.length, 1, "pedir confirmação não apaga");
  r = operar(db, "ana", id, { op: "excluir", tipo: "s", id: s.id, confirmado: true });
  assert.equal(r.caderno.disciplinas[0].sessoes.length, 0);

  r = operar(db, "ana", id, { op: "acrescentar", tipo: "d", nome: "pg" });
  assert.equal(r.avisos.length, 1, "nome repetido vira aviso");
  assert.deepEqual(operar(db, "ana", id, { op: "excluir", tipo: "c", confirmado: true }), { excluido: true });
});

test("api: entrada inválida é 400, e nada atravessa contas ou cadernos", async () => {
  const { operar } = await import("../src/api.js");
  const db = banco.abrirBanco(":memory:");
  const [a, b] = banco.importar(db, "ana", lerMarkdown("# A\n## D\n### S\n- M\n# B\n## D\n### S\n- M\n").cadernos).cadernos;
  const x = banco.importar(db, "bia", lerMarkdown("# X\n## D\n### S\n- M\n").cadernos).cadernos[0];
  const mb = banco.caderno(db, "ana", b).disciplinas[0].sessoes[0].materiais[0];
  const mx = banco.caderno(db, "bia", x).disciplinas[0].sessoes[0].materiais[0];

  for (const corpo of [null, [], "x", { op: "apagar-tudo" }, { op: "renomear", tipo: "__proto__", id: 1, nome: "x" }, { op: "renomear", tipo: "m", id: "1", nome: "x" }, { op: "renomear", tipo: "m", id: 1, nome: 5 }, { op: "mover", tipo: "m", id: 1, indice: 1.5 }, { op: "acrescentar", tipo: "c", nome: "x" }, { op: "concluir", tipo: "m", id: 1 }]) {
    assert.throws(() => operar(db, "ana", a, corpo), (e) => e.status === 400, JSON.stringify(corpo));
  }
  assert.equal(operar(db, "bia", a, { op: "renomear", tipo: "c", nome: "x" }), null, "caderno de outra pessoa");
  // Pelo caderno A: material do B e da Bia não mudam.
  for (const id of [mb.id, mx.id]) {
    operar(db, "ana", a, { op: "renomear", tipo: "m", id, nome: "invadido" });
    operar(db, "ana", a, { op: "marcar", id });
    operar(db, "ana", a, { op: "mover", tipo: "m", id, indice: 0 });
    operar(db, "ana", a, { op: "excluir", tipo: "m", id, confirmado: true });
  }
  assert.deepEqual(banco.caderno(db, "ana", b).disciplinas[0].sessoes[0].materiais.map((m) => [m.nome, m.feito]), [["M", false]]);
  assert.deepEqual(banco.caderno(db, "bia", x).disciplinas[0].sessoes[0].materiais.map((m) => [m.nome, m.feito]), [["M", false]]);
});

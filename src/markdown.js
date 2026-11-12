// Leitura e escrita do formato .md do notebook.
//
//   # Caderno A                         caderno
//   ## Disciplina 1          disciplina
//   modelo: unidades                   (opcional) materiais padrão das sessões vazias
//   ### Sessão 1.1 - Unidade 1         sessão
//   - [ ] Vídeo                   material
//   - [x] Ebook 1/2               material já concluído
//
// "concluído: sim" logo abaixo de um título conclui aquele nível (caderno,
// disciplina ou sessão) mesmo com materiais em aberto.
//
// "modelo:" vale para o nível em que aparece (caderno, disciplina ou sessão) e
// para tudo que estiver abaixo dele. Uma sessão sem nenhum item de lista recebe
// os materiais do modelo mais próximo. Linhas que não são título, lista ou
// modelo são ignoradas, então dá para deixar anotações livres no arquivo.

import { semPrototipo, limparTexto } from "./texto.js";

// Dois modelos de passos: "unidades" (nove etapas, por unidade) e "submódulos" (quatro, por aula).
export const MODELOS = semPrototipo({
  unidades: [
    "Gerar esqueleto",
    "Vídeo",
    "Aula com docente",
    "Ebook",
    "Perguntas de recuperação",
    "Cartões didáticos",
    "Teste sem consulta (meta 70%)",
    "Revisão de memória",
    "Atividade no AVA",
  ],
  submódulos: ["Gerar esqueleto", "Vídeo", "Ebook (só se ficou lacuna)", "Quiz"],
});

export const LIMITE_BYTES = 512 * 1024;
// Linha maior que isso não é título nem material de verdade: vira aviso, e
// nenhum regex roda sobre ela.
export const LIMITE_LINHA = 2000;

const PREFIXOS = /^(caderno|disciplina|sess[aã]o)\s*:\s*/i;

// Sem regex sobre a linha inteira: a versão anterior, /\s+#+\s*$/, tinha custo
// quadrático numa sequência longa de espaços. Com 32 mil espaços num título,
// 1,2 s; com os 512 KB aceitos, minutos com o servidor parado (2026-11-12).
function nome(texto) {
  let t = limparTexto(texto);
  // O "###" de fechamento opcional dos títulos, só quando separado por espaço.
  let fim = t.length;
  while (fim > 0 && t[fim - 1] === "#") fim--;
  if (fim < t.length && fim > 0 && t[fim - 1] === " ") t = t.slice(0, fim);
  return limparTexto(t.replace(PREFIXOS, ""));
}

export function lerMarkdown(texto) {
  const cadernos = [];
  const avisos = [];
  let caderno = null;
  let disciplina = null;
  let sessao = null;

  const linhas = String(texto).replace(/^﻿/, "").split(/\r?\n/);
  let i = 0;
  // Frontmatter YAML no começo do arquivo é pulado.
  if (linhas[0]?.trim() === "---") {
    const fim = linhas.findIndex((l, j) => j > 0 && l.trim() === "---");
    if (fim > 0) i = fim + 1;
  }

  for (; i < linhas.length; i++) {
    const n = i + 1;
    if (linhas[i].length > LIMITE_LINHA) {
      avisos.push(`Linha ${n}: passa de ${LIMITE_LINHA} caracteres.`);
      continue;
    }
    const t = linhas[i].trim();
    if (!t) continue;
    let m;

    if ((m = t.match(/^#\s+(.+)$/))) {
      caderno = { nome: nome(m[1]), modelo: null, concluido: false, disciplinas: [] };
      cadernos.push(caderno);
      disciplina = sessao = null;
    } else if ((m = t.match(/^##\s+(.+)$/))) {
      if (!caderno) {
        avisos.push(`Linha ${n}: disciplina "${nome(m[1])}" fora de um caderno (falta um "# Caderno" antes).`);
        continue;
      }
      disciplina = { nome: nome(m[1]), modelo: null, concluido: false, sessoes: [] };
      caderno.disciplinas.push(disciplina);
      sessao = null;
    } else if ((m = t.match(/^###\s+(.+)$/))) {
      if (!disciplina) {
        avisos.push(`Linha ${n}: sessão "${nome(m[1])}" fora de uma disciplina (falta um "## Disciplina" antes).`);
        continue;
      }
      sessao = { nome: nome(m[1]), modelo: null, concluido: false, materiais: [] };
      disciplina.sessoes.push(sessao);
    } else if ((m = t.match(/^conclu[ií]d[oa]\s*:\s*(\S+)$/i))) {
      const alvo = sessao ?? disciplina ?? caderno;
      if (!alvo) continue;
      if (/^(sim|s|x)$/i.test(m[1])) alvo.concluido = true;
      else if (!/^(n[aã]o|n)$/i.test(m[1])) avisos.push(`Linha ${n}: use "concluído: sim" ou "concluído: não".`);
    } else if ((m = t.match(/^modelo\s*:\s*(\S+)/i))) {
      const chave = m[1].toLowerCase();
      if (!Object.hasOwn(MODELOS, chave)) {
        avisos.push(`Linha ${n}: modelo "${m[1]}" não existe. Use ${Object.keys(MODELOS).join(" ou ")}.`);
        continue;
      }
      const alvo = sessao ?? disciplina ?? caderno;
      if (alvo) alvo.modelo = chave;
    } else if ((m = t.match(/^[-*+]\s+(?:\[([ xX])\]\s*)?(.+)$/))) {
      if (!sessao) {
        avisos.push(`Linha ${n}: material "${nome(m[2])}" fora de uma sessão (falta um "### Sessão" antes).`);
        continue;
      }
      const material = nome(m[2]);
      if (material) sessao.materiais.push({ nome: material, feito: m[1]?.toLowerCase() === "x" });
    }
  }

  for (const c of cadernos) {
    for (const d of c.disciplinas) {
      for (const s of d.sessoes) {
        const modelo = s.modelo ?? d.modelo ?? c.modelo;
        if (!s.materiais.length && modelo) s.materiais = MODELOS[modelo].map((nome) => ({ nome, feito: false }));
        delete s.modelo;
      }
      delete d.modelo;
    }
    delete c.modelo;
  }
  if (!cadernos.length) avisos.push('Nenhum caderno encontrado. O arquivo precisa de pelo menos um título "# Caderno".');
  return { cadernos, avisos };
}

export function escreverMarkdown(caderno) {
  // Só a conclusão feita a mão vai pro arquivo: a automática se refaz sozinha
  // a partir dos materiais.
  const concluido = (no) => (no.manual ? ["concluído: sim"] : []);
  const partes = [`# ${caderno.nome}`, ...concluido(caderno)];
  for (const d of caderno.disciplinas) {
    partes.push("", `## ${d.nome}`, ...concluido(d));
    for (const s of d.sessoes) {
      partes.push("", `### ${s.nome}`, ...concluido(s), "");
      for (const m of s.materiais) partes.push(`- [${m.feito ? "x" : " "}] ${m.nome}`);
    }
  }
  return partes.join("\n") + "\n";
}

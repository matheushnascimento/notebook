// API JSON do editor em React (#9). É uma camada fina: cada operação vira uma
// chamada às mesmas funções do banco que o editor de formulário usa, com as
// mesmas checagens de dono, de caderno, de tipo e de teto (docs/seguranca.md).
//
//   GET  /api/caderno/:id          a árvore do caderno
//   POST /api/caderno/:id          uma operação, e devolve a árvore nova
//
// Operações (corpo JSON):
//   { op: "renomear",    tipo, id, nome }
//   { op: "acrescentar", tipo, pai, nome, modelo? }   tipo d, s ou m
//   { op: "mover",       tipo, id, indice }
//   { op: "excluir",     tipo, id, confirmado? }
//   { op: "concluir",    tipo, id }                   tipo c, d ou s
//   { op: "marcar",      id }                         material
//
// E a da página da sessão (#16):
//
//   GET  /api/sessao/:id           a sessão, os materiais e as vizinhas
//   POST /api/sessao/:id           uma operação, e devolve a sessão nova
//
//   { op: "marcar",  id }                              material desta sessão
//   { op: "concluir" }                                 conclui ou reabre
//   { op: "lote",    acao: "concluir" | "limpar" }     todos os materiais

import * as banco from "./banco.js";
import { MODELOS } from "./markdown.js";

const TIPOS = new Set(["c", "d", "s", "m"]);

// O que o navegador recebe: só o necessário pra desenhar a árvore.
const progresso = (no) => ({
  concluido: no.concluido,
  manual: no.manual ?? false,
  total: no.total,
  feitos: no.feitos,
  feitosReais: no.feitosReais ?? no.feitos,
  concluidoEm: no.concluidoEm ?? null,
});

// O próximo material em aberto, pro "Continuar" da página do caderno (#18).
const proximo = (p) =>
  p ? { sessao: { id: p.sessao.id, nome: p.sessao.nome, disciplina: p.sessao.disciplina }, material: { nome: p.material.nome } } : null;

export function arvoreJson(c) {
  return {
    id: c.id,
    nome: c.nome,
    ...progresso(c),
    modelos: Object.fromEntries(Object.entries(MODELOS).map(([nome, passos]) => [nome, passos.length])),
    sessoesConcluidas: c.sessoesConcluidas,
    sessoesTotal: c.sessoesTotal,
    proximo: proximo(c.proximo),
    disciplinas: c.disciplinas.map((d) => ({
      id: d.id,
      nome: d.nome,
      ...progresso(d),
      sessoesConcluidas: d.sessoesConcluidas,
      sessoes: d.sessoes.map((s) => ({
        id: s.id,
        nome: s.nome,
        ...progresso(s),
        materiais: s.materiais.map((m) => ({ id: m.id, nome: m.nome, feito: m.feito })),
      })),
    })),
  };
}

// O resumo de cada caderno, pros cartões da página de início (#20).
export function resumoJson(c) {
  return {
    id: c.id,
    nome: c.nome,
    ...progresso(c),
    quantasDisciplinas: c.disciplinas.length,
    sessoesConcluidas: c.sessoesConcluidas,
    sessoesTotal: c.sessoesTotal,
    proximo: proximo(c.proximo),
  };
}

// O que a página da sessão precisa, a partir de banco.sessao().
export function sessaoJson({ caderno: c, sessao: s, anterior, seguinte }) {
  const vizinha = (v) => (v ? { id: v.id, nome: v.nome } : null);
  return {
    caderno: { id: c.id, nome: c.nome },
    sessao: {
      id: s.id,
      nome: s.nome,
      disciplina: s.disciplina,
      ...progresso(s),
      materiais: s.materiais.map((m) => ({ id: m.id, nome: m.nome, feito: m.feito, feitoEm: m.feitoEm ?? null })),
    },
    anterior: vizinha(anterior),
    seguinte: vizinha(seguinte),
  };
}

const erro400 = (mensagem) => Object.assign(new Error(mensagem), { status: 400, publico: mensagem });

function inteiro(valor, campo) {
  if (!Number.isSafeInteger(valor)) throw erro400(`"${campo}" precisa ser um número inteiro.`);
  return valor;
}
function texto(valor, campo) {
  if (typeof valor !== "string" || valor.length > 1000) throw erro400(`"${campo}" precisa ser um texto.`);
  return valor;
}
function tipo(valor, permitidos = TIPOS) {
  if (typeof valor !== "string" || !permitidos.has(valor)) throw erro400("Tipo inválido.");
  return valor;
}

// Aplica uma operação no caderno. Devolve null se o caderno não é da pessoa.
export async function operar(db, usuario, cadernoId, corpo) {
  if ((await banco.cadernoDoItem(db, usuario, "c", cadernoId)) !== cadernoId) return null;
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) throw erro400("Corpo inválido.");

  const editar = (campos, acao) => banco.aplicarEdicao(db, usuario, cadernoId, campos, acao, MODELOS);
  let r = { avisos: [], confirmar: null, excluiuCaderno: false };

  switch (corpo.op) {
    case "renomear": {
      const t = tipo(corpo.tipo);
      const id = t === "c" ? cadernoId : inteiro(corpo.id, "id");
      r = await editar([[`nome:${t}:${id}`, texto(corpo.nome, "nome")]], "salvar");
      break;
    }
    case "acrescentar": {
      const t = tipo(corpo.tipo, new Set(["d", "s", "m"]));
      const pai = t === "d" ? cadernoId : inteiro(corpo.pai, "pai");
      const campos = [[`novo:${t}:${pai}`, texto(corpo.nome, "nome")]];
      if (t === "s" && corpo.modelo != null) campos.push([`modelo:s:${pai}`, texto(corpo.modelo, "modelo")]);
      r = await editar(campos, "salvar");
      break;
    }
    case "mover": {
      const t = tipo(corpo.tipo);
      const id = t === "c" ? cadernoId : inteiro(corpo.id, "id");
      await banco.moverPara(db, usuario, cadernoId, t, id, inteiro(corpo.indice, "indice"));
      break;
    }
    case "excluir": {
      const t = tipo(corpo.tipo);
      const id = t === "c" ? cadernoId : inteiro(corpo.id, "id");
      r = await editar([], `${corpo.confirmado === true ? "confirmar" : "excluir"}:${t}:${id}`);
      break;
    }
    case "concluir": {
      const t = tipo(corpo.tipo, new Set(["c", "d", "s"]));
      const id = t === "c" ? cadernoId : inteiro(corpo.id, "id");
      if ((await banco.cadernoDoItem(db, usuario, t, id)) === cadernoId) await banco.alternarConclusao(db, usuario, t, id);
      break;
    }
    case "marcar": {
      const id = inteiro(corpo.id, "id");
      if ((await banco.cadernoDoItem(db, usuario, "m", id)) === cadernoId) await banco.alternarMaterial(db, usuario, id);
      break;
    }
    default:
      throw erro400("Operação desconhecida.");
  }

  if (r.excluiuCaderno) return { excluido: true };
  const c = await banco.caderno(db, usuario, cadernoId);
  return { caderno: arvoreJson(c), avisos: r.avisos, confirmar: r.confirmar, foco: r.foco ?? null };
}

// Aplica uma operação na sessão. Devolve null se a sessão não é da pessoa. Um
// material de outra sessão não muda nada, como no editor.
export async function operarSessao(db, usuario, sessaoId, corpo) {
  const atual = await banco.sessao(db, usuario, sessaoId);
  if (!atual) return null;
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) throw erro400("Corpo inválido.");

  switch (corpo.op) {
    case "marcar": {
      const id = inteiro(corpo.id, "id");
      if (atual.sessao.materiais.some((m) => m.id === id)) await banco.alternarMaterial(db, usuario, id);
      break;
    }
    case "concluir":
      await banco.alternarConclusao(db, usuario, "s", sessaoId);
      break;
    case "lote": {
      if (corpo.acao !== "concluir" && corpo.acao !== "limpar") throw erro400('"acao" precisa ser "concluir" ou "limpar".');
      await banco.marcarSessao(db, usuario, sessaoId, corpo.acao === "concluir");
      break;
    }
    default:
      throw erro400("Operação desconhecida.");
  }
  return sessaoJson(await banco.sessao(db, usuario, sessaoId));
}

// Cria um caderno pelo nome (#20). Devolve { id } ou { erro } com a mesma
// mensagem do formulário: nome vazio, repetido ou acima do teto da conta.
export async function criarCaderno(db, usuario, corpo) {
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) throw erro400("Corpo inválido.");
  return banco.criarCaderno(db, usuario, texto(corpo.nome, "nome"));
}

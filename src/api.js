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
});

export function arvoreJson(c) {
  return {
    id: c.id,
    nome: c.nome,
    ...progresso(c),
    modelos: Object.fromEntries(Object.entries(MODELOS).map(([nome, passos]) => [nome, passos.length])),
    disciplinas: c.disciplinas.map((d) => ({
      id: d.id,
      nome: d.nome,
      ...progresso(d),
      sessoes: d.sessoes.map((s) => ({
        id: s.id,
        nome: s.nome,
        ...progresso(s),
        materiais: s.materiais.map((m) => ({ id: m.id, nome: m.nome, feito: m.feito })),
      })),
    })),
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
export function operar(db, usuario, cadernoId, corpo) {
  if (banco.cadernoDoItem(db, usuario, "c", cadernoId) !== cadernoId) return null;
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) throw erro400("Corpo inválido.");

  const editar = (campos, acao) => banco.aplicarEdicao(db, usuario, cadernoId, campos, acao, MODELOS);
  let r = { avisos: [], confirmar: null, excluiuCaderno: false };

  switch (corpo.op) {
    case "renomear": {
      const t = tipo(corpo.tipo);
      const id = t === "c" ? cadernoId : inteiro(corpo.id, "id");
      r = editar([[`nome:${t}:${id}`, texto(corpo.nome, "nome")]], "salvar");
      break;
    }
    case "acrescentar": {
      const t = tipo(corpo.tipo, new Set(["d", "s", "m"]));
      const pai = t === "d" ? cadernoId : inteiro(corpo.pai, "pai");
      const campos = [[`novo:${t}:${pai}`, texto(corpo.nome, "nome")]];
      if (t === "s" && corpo.modelo != null) campos.push([`modelo:s:${pai}`, texto(corpo.modelo, "modelo")]);
      r = editar(campos, "salvar");
      break;
    }
    case "mover": {
      const t = tipo(corpo.tipo);
      const id = t === "c" ? cadernoId : inteiro(corpo.id, "id");
      banco.moverPara(db, usuario, cadernoId, t, id, inteiro(corpo.indice, "indice"));
      break;
    }
    case "excluir": {
      const t = tipo(corpo.tipo);
      const id = t === "c" ? cadernoId : inteiro(corpo.id, "id");
      r = editar([], `${corpo.confirmado === true ? "confirmar" : "excluir"}:${t}:${id}`);
      break;
    }
    case "concluir": {
      const t = tipo(corpo.tipo, new Set(["c", "d", "s"]));
      const id = t === "c" ? cadernoId : inteiro(corpo.id, "id");
      if (banco.cadernoDoItem(db, usuario, t, id) === cadernoId) banco.alternarConclusao(db, usuario, t, id);
      break;
    }
    case "marcar": {
      const id = inteiro(corpo.id, "id");
      if (banco.cadernoDoItem(db, usuario, "m", id) === cadernoId) banco.alternarMaterial(db, usuario, id);
      break;
    }
    default:
      throw erro400("Operação desconhecida.");
  }

  if (r.excluiuCaderno) return { excluido: true };
  const c = banco.caderno(db, usuario, cadernoId);
  return { caderno: arvoreJson(c), avisos: r.avisos, confirmar: r.confirmar, foco: r.foco ?? null };
}

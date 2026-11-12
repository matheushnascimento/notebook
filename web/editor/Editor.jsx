// Editor do caderno em React (#9): a árvore em listas aninhadas, editada sem
// recarregar a página.
//
// - Renomear salva ao sair do campo ou com Enter; Esc desfaz.
// - Acrescentar mantém o foco no campo, pra digitar vários seguidos.
// - Arrastar pela alça (⠿) reordena dentro da lista. Pelo teclado: espaço na
//   alça, setas, espaço de novo.
// - Excluir algo com conteúdo pede confirmação na própria linha.
//
// Cada mudança vai pra API numa fila, uma por vez, e a resposta traz a árvore
// inteira de volta: o que aparece na tela é sempre o que o servidor gravou.
// Arrastar muda a tela na hora; se o servidor recusar, a árvore volta.
//
// Nada aqui usa dangerouslySetInnerHTML: todo texto é escapado pelo React.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { lerCaderno, operar } from "./api.js";

const Contexto = createContext(null);

const ROTULO = { c: "o caderno", d: "a disciplina", s: "a sessão", m: "o material" };

const plural = (n, um, varios) => (n === 1 ? `1 ${um}` : `${n} ${varios}`);

// Move um item de lugar na cópia local da árvore, pra o arrastar responder na hora.
function reordenar(caderno, tipo, paiId, de, para) {
  const mover = (lista) => arrayMove(lista, de, para);
  if (tipo === "d") return { ...caderno, disciplinas: mover(caderno.disciplinas) };
  return {
    ...caderno,
    disciplinas: caderno.disciplinas.map((d) =>
      tipo === "s"
        ? d.id === paiId
          ? { ...d, sessoes: mover(d.sessoes) }
          : d
        : { ...d, sessoes: d.sessoes.map((s) => (s.id === paiId ? { ...s, materiais: mover(s.materiais) } : s)) },
    ),
  };
}

export function Editor({ inicial }) {
  const [caderno, setCaderno] = useState(inicial);
  const [estado, setEstado] = useState({ tipo: "ok", texto: "Tudo salvo." });
  const [avisos, setAvisos] = useState([]);
  const [confirmar, setConfirmar] = useState(null);
  const fila = useRef(Promise.resolve());

  const enviar = useCallback(
    (operacao) => {
      setEstado({ tipo: "salvando", texto: "Salvando…" });
      const pedido = fila.current.then(async () => {
        try {
          const r = await operar(inicial.id, operacao);
          if (r.excluido) {
            window.location.assign("/");
            return r;
          }
          setCaderno(r.caderno);
          setAvisos(r.avisos ?? []);
          setConfirmar(r.confirmar ?? null);
          setEstado({ tipo: "ok", texto: r.avisos?.length ? "Salvo, com avisos." : "Tudo salvo." });
          return r;
        } catch (erro) {
          setEstado({ tipo: "erro", texto: erro.message });
          // Desfaz o que a tela mudou antes da resposta.
          try {
            setCaderno(await lerCaderno(inicial.id));
          } catch {
            // Sem conexão: fica a mensagem de erro.
          }
          return null;
        }
      });
      fila.current = pedido.catch(() => {});
      return pedido;
    },
    [inicial.id],
  );

  const contexto = { caderno, setCaderno, enviar, confirmar, setConfirmar };

  return (
    <Contexto.Provider value={contexto}>
      <div className="editor">
        <div className="barra-salvar">
          <h1>Editar</h1>
          <span className="em-lote">
            <span className={`estado estado-${estado.tipo}`} role="status" aria-live="polite">
              {estado.texto}
            </span>
            <a className="botao secundario" href={`/caderno/${caderno.id}`}>
              Concluir
            </a>
          </span>
        </div>

        {avisos.length > 0 && (
          <section className="alerta" role="alert">
            <ul>
              {avisos.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <label htmlFor="nome-caderno">Nome do caderno</label>
          <div className="linha-item">
            <CampoNome tipo="c" id={caderno.id} nome={caderno.nome} idCampo="nome-caderno" />
            <BotaoExcluir tipo="c" item={caderno} />
          </div>
          <Confirmacao tipo="c" id={caderno.id} />
        </section>

        <section>
          <h2>Disciplinas, sessões e materiais</h2>
          <p className="detalhe">Arraste pela alça ⠿ para mudar a ordem. Cada mudança é salva na hora.</p>
          <ol className="arvore">
            <Lista tipo="d" paiId={caderno.id} itens={caderno.disciplinas}>
              {(d) => (
                <Item key={d.id} tipo="d" item={d} rotulo="Nome da disciplina" classe="nivel-d">
                  <ol className="filhos">
                    <Lista tipo="s" paiId={d.id} itens={d.sessoes}>
                      {(s) => (
                        <Item
                          key={s.id}
                          tipo="s"
                          item={s}
                          rotulo={`Nome da sessão, em ${d.nome}`}
                          classe="nivel-s"
                          depois={<span className="contador">{`${s.feitosReais}/${s.total}`}</span>}
                        >
                          <ol className="filhos">
                            <Lista tipo="m" paiId={s.id} itens={s.materiais}>
                              {(m) => (
                                <Item
                                  key={m.id}
                                  tipo="m"
                                  item={m}
                                  rotulo={`Nome do material, em ${s.nome}`}
                                  classe="nivel-m"
                                  antes={<CaixaMaterial material={m} />}
                                />
                              )}
                            </Lista>
                            <Novo tipo="m" pai={s.id} texto="Novo material" rotulo={`Novo material em ${s.nome}`} />
                          </ol>
                        </Item>
                      )}
                    </Lista>
                    <Novo tipo="s" pai={d.id} texto="Nova sessão" rotulo={`Nova sessão em ${d.nome}`} comModelo />
                  </ol>
                </Item>
              )}
            </Lista>
            <Novo tipo="d" pai={caderno.id} texto="Nova disciplina" rotulo="Nova disciplina" />
          </ol>
        </section>
      </div>
    </Contexto.Provider>
  );
}

// --- Listas que se reordenam -------------------------------------------------

const instrucoes = {
  draggable: "Para mover, aperte espaço ou Enter na alça, use as setas para cima e para baixo, e aperte espaço de novo para soltar. Esc cancela.",
};
const anuncios = {
  onDragStart: () => "Item pego.",
  onDragOver: ({ over }) => (over ? "Nova posição escolhida." : "Fora da lista."),
  onDragEnd: ({ over }) => (over ? "Item solto na nova posição." : "Item solto no lugar de antes."),
  onDragCancel: () => "Movimento cancelado.",
};

function Lista({ tipo, paiId, itens, children }) {
  const { setCaderno, enviar } = useContext(Contexto);
  const sensores = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = itens.map((i) => `${tipo}-${i.id}`);

  function aoSoltar({ active, over }) {
    if (!over || active.id === over.id) return;
    const de = ids.indexOf(active.id);
    const para = ids.indexOf(over.id);
    if (de < 0 || para < 0) return;
    setCaderno((c) => reordenar(c, tipo, paiId, de, para));
    enviar({ op: "mover", tipo, id: itens[de].id, indice: para });
  }

  return (
    <DndContext
      sensors={sensores}
      collisionDetection={closestCenter}
      onDragEnd={aoSoltar}
      accessibility={{ screenReaderInstructions: instrucoes, announcements: anuncios }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {itens.map((item) => children(item))}
      </SortableContext>
    </DndContext>
  );
}

function Item({ tipo, item, rotulo, classe, antes, depois, children }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: `${tipo}-${item.id}`,
  });
  // O deslocamento durante o arraste vai por element.style (CSSOM), que a CSP
  // permite; style="" escrito no HTML ela recusaria.
  const estilo = { transform: CSS.Translate.toString(transform), transition };
  return (
    <li ref={setNodeRef} style={estilo} id={`${tipo}-${item.id}`} className={`${classe}${isDragging ? " arrastando" : ""}`}>
      <div className="linha-item">
        <button
          type="button"
          className="icone alca"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Mover ${item.nome}`}
          title="Arrastar para mudar a ordem"
        >
          ⠿
        </button>
        {antes}
        <CampoNome tipo={tipo} id={item.id} nome={item.nome} rotulo={rotulo} />
        {depois}
        <BotaoExcluir tipo={tipo} item={item} />
      </div>
      <Confirmacao tipo={tipo} id={item.id} />
      {children}
    </li>
  );
}

// --- Campos ------------------------------------------------------------------

function CampoNome({ tipo, id, nome, rotulo, idCampo }) {
  const { enviar } = useContext(Contexto);
  const [valor, setValor] = useState(nome);
  const cancelado = useRef(false);
  // Quando o servidor devolve outro nome (recusou, ou outro campo mudou), o
  // campo acompanha.
  useEffect(() => setValor(nome), [nome]);

  function salvar() {
    if (cancelado.current) {
      cancelado.current = false;
      setValor(nome);
      return;
    }
    const limpo = valor.trim();
    if (!limpo) return setValor(nome);
    if (limpo !== nome) enviar({ op: "renomear", tipo, id, nome: limpo });
  }

  return (
    <input
      id={idCampo}
      value={valor}
      maxLength={200}
      required
      aria-label={idCampo ? undefined : rotulo}
      onChange={(e) => setValor(e.target.value)}
      onBlur={salvar}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          cancelado.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function CaixaMaterial({ material }) {
  const { enviar } = useContext(Contexto);
  return (
    <button
      type="button"
      className="icone marcar"
      aria-pressed={material.feito}
      aria-label={`${material.feito ? "Desmarcar" : "Marcar"} ${material.nome}`}
      title={material.feito ? "Concluído" : "Em aberto"}
      onClick={() => enviar({ op: "marcar", id: material.id })}
    >
      <span className={`caixa${material.feito ? " marcada" : ""}`} aria-hidden="true" />
    </button>
  );
}

function Novo({ tipo, pai, texto, rotulo, comModelo = false }) {
  const { caderno, enviar } = useContext(Contexto);
  const [valor, setValor] = useState("");
  const [modelo, setModelo] = useState("");
  const campo = useRef(null);

  async function acrescentar(e) {
    e.preventDefault();
    const limpo = valor.trim();
    if (!limpo) return;
    setValor("");
    const r = await enviar({ op: "acrescentar", tipo, pai, nome: limpo, ...(comModelo && modelo ? { modelo } : {}) });
    // Recusado (nome repetido, teto): o texto volta pro campo.
    if (!r || r.avisos?.length) setValor(limpo);
    campo.current?.focus();
  }

  return (
    <li className="novo">
      <form className="linha-item" onSubmit={acrescentar}>
        <input ref={campo} value={valor} maxLength={200} placeholder={texto} aria-label={rotulo} onChange={(e) => setValor(e.target.value)} />
        {comModelo && (
          <select value={modelo} onChange={(e) => setModelo(e.target.value)} aria-label="Modelo da sessão nova">
            <option value="">vazia</option>
            {Object.keys(caderno.modelos).map((m) => (
              <option key={m} value={m}>{`modelo ${m}`}</option>
            ))}
          </select>
        )}
        <button type="submit" className="secundario">
          Acrescentar
        </button>
      </form>
    </li>
  );
}

// --- Excluir -----------------------------------------------------------------

function BotaoExcluir({ tipo, item }) {
  const { enviar } = useContext(Contexto);
  return (
    <button
      type="button"
      className="icone excluir"
      aria-label={`Excluir ${item.nome}`}
      title="Excluir"
      onClick={() => enviar({ op: "excluir", tipo, id: item.id })}
    >
      ×
    </button>
  );
}

function Confirmacao({ tipo, id }) {
  const { confirmar, setConfirmar, enviar } = useContext(Contexto);
  if (!confirmar || confirmar.tipo !== tipo || confirmar.id !== id) return null;
  const junto =
    tipo === "s"
      ? plural(confirmar.materiais, "material", "materiais")
      : `${plural(confirmar.sessoes, "sessão", "sessões")} e ${plural(confirmar.materiais, "material", "materiais")}`;
  return (
    <div className="confirmar-linha" role="alert">
      <p>
        Excluir {ROTULO[tipo]} <strong>{confirmar.nome}</strong>? Sai junto {junto}, com o progresso. Não dá para desfazer.
      </p>
      <span className="em-lote">
        <button type="button" className="perigo" onClick={() => enviar({ op: "excluir", tipo, id, confirmado: true })}>
          Excluir
        </button>
        <button type="button" className="secundario" onClick={() => setConfirmar(null)}>
          Cancelar
        </button>
      </span>
    </div>
  );
}

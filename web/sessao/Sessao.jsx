// Página da sessão em React (#16): marcar um material, concluir a sessão e os
// botões em lote, sem recarregar a página.
//
// Cada ação vai pra API numa fila, uma por vez, e a resposta traz a sessão
// inteira de volta: o que aparece na tela é sempre o que o servidor gravou.
// Marcar muda a caixa na hora; se o servidor recusar, a sessão volta.
//
// O desenho é o mesmo do HTML do servidor (src/paginas.js, renderSessao), com as
// mesmas classes, pra não mudar nada na tela quando o React assume.
import { useCallback, useRef, useState } from "react";

import { lerSessao, operarSessao } from "../comum/api.js";

const DATA = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });
const data = (quando) => DATA.format(new Date(quando));

const pct = (no) => (no.concluido ? 100 : no.total ? Math.round((no.feitos / no.total) * 100) : 0);
const plural = (n, um, varios) => (n === 1 ? `1 ${um}` : `${n} ${varios}`);

export function Sessao({ inicial }) {
  const [tela, setTela] = useState(inicial);
  const [estado, setEstado] = useState(null);
  const fila = useRef(Promise.resolve());
  const id = inicial.sessao.id;

  const enviar = useCallback(
    (operacao) => {
      setEstado({ tipo: "salvando", texto: "Salvando…" });
      const pedido = fila.current.then(async () => {
        try {
          setTela(await operarSessao(id, operacao));
          setEstado({ tipo: "ok", texto: "Salvo." });
        } catch (erro) {
          setEstado({ tipo: "erro", texto: erro.message });
          // Desfaz o que a tela mudou antes da resposta.
          try {
            setTela(await lerSessao(id));
          } catch {
            // Sem conexão: fica a mensagem de erro.
          }
        }
      });
      fila.current = pedido.catch(() => {});
      return pedido;
    },
    [id],
  );

  const marcar = (m) => {
    // A caixa responde na hora; o contador vem com a resposta.
    setTela((t) => ({
      ...t,
      sessao: {
        ...t.sessao,
        materiais: t.sessao.materiais.map((x) => (x.id === m.id ? { ...x, feito: !x.feito, feitoEm: x.feito ? null : new Date().toISOString() } : x)),
      },
    }));
    enviar({ op: "marcar", id: m.id });
  };

  const { caderno: c, sessao: s, anterior, seguinte } = tela;
  const max = s.total || 1;

  return (
    <>
      <span className="rotulo">{s.disciplina}</span>
      <div className="linha-titulo">
        <h1>{s.nome}</h1>
        <span className="contador">
          {s.feitosReais ?? s.feitos}/{s.total} · {s.concluido ? "concluída" : `${pct(s)}%`}
        </span>
      </div>
      <progress value={s.concluido ? max : s.feitos} max={max} aria-label={`Progresso de ${s.nome}`}>
        {pct(s)}%
      </progress>
      <Conclusao sessao={s} enviar={enviar} />
      <section>
        {s.materiais.length ? (
          <>
            <ul className="materiais">
              {s.materiais.map((m) => (
                <li key={m.id}>
                  <button type="button" className={`material${m.feito ? " feito" : ""}`} aria-pressed={m.feito} onClick={() => marcar(m)}>
                    <span className={`caixa${m.feito ? " marcada" : ""}`} aria-hidden="true" />
                    <span className="nome">{m.nome}</span>
                    {m.feito && m.feitoEm ? <span className="quando">{data(m.feitoEm)}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
            <div className="em-lote">
              <button type="button" className="secundario" onClick={() => enviar({ op: "lote", acao: "concluir" })}>
                Concluir todos
              </button>
              <button type="button" className="secundario" onClick={() => enviar({ op: "lote", acao: "limpar" })}>
                Desmarcar todos
              </button>
            </div>
          </>
        ) : (
          <p>Esta sessão ainda não tem materiais.</p>
        )}
      </section>
      {estado ? (
        <p className={`estado estado-${estado.tipo}`} role="status" aria-live="polite">
          {estado.texto}
        </p>
      ) : null}
      <p>
        <a href={`/caderno/${c.id}/editar?foco=s-${s.id}#s-${s.id}`}>Editar esta sessão</a>
      </p>
      <nav className="vizinhas" aria-label="Outras sessões">
        <Vizinha sessao={anterior} rotulo="Anterior" />
        <Vizinha sessao={seguinte} rotulo="Seguinte" />
      </nav>
    </>
  );
}

// Concluir ou reabrir a sessão, como conclusao() no servidor. Concluída sozinha,
// com todos os materiais marcados, não tem o que reabrir.
function Conclusao({ sessao: s, enviar }) {
  if (s.manual) {
    const faltam = s.total - s.feitosReais;
    return (
      <div className="conclusao">
        <span className="detalhe">
          Sessão concluída{s.concluidoEm ? ` em ${data(s.concluidoEm)}` : ""}
          {faltam > 0 ? `, com ${plural(faltam, "material", "materiais")} em aberto` : ""}.
        </span>
        <button type="button" className="secundario" onClick={() => enviar({ op: "concluir" })}>
          Reabrir sessão
        </button>
      </div>
    );
  }
  if (s.concluido) return <p className="detalhe">Sessão concluída: todos os materiais estão marcados.</p>;
  return (
    <div className="conclusao">
      <button type="button" className="secundario" onClick={() => enviar({ op: "concluir" })}>
        Concluir sessão
      </button>
    </div>
  );
}

function Vizinha({ sessao, rotulo }) {
  if (!sessao) return <span />;
  return (
    <a href={`/sessao/${sessao.id}`}>
      <span className="rotulo">{rotulo}</span>
      {sessao.nome}
    </a>
  );
}

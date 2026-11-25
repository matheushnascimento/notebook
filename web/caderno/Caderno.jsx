// Página do caderno em React (#18): concluir ou reabrir o caderno e as
// disciplinas, e excluir o caderno, sem recarregar a página.
//
// Usa a mesma API do editor (POST /api/caderno/:id), numa fila, uma ação por
// vez. A resposta traz a árvore inteira, e a tela só troca o estado.
//
// O desenho é o mesmo do HTML do servidor (src/paginas.js, renderCaderno), com
// as mesmas classes, pra não mudar nada na tela quando o React assume.
import { useCallback, useRef, useState } from "react";

import { lerCaderno, operar } from "../comum/api.js";
import { Barra, Conclusao, Contador } from "../comum/progresso.jsx";

export function Caderno({ inicial, aviso }) {
  const [c, setCaderno] = useState(inicial);
  const [estado, setEstado] = useState(null);
  const fila = useRef(Promise.resolve());
  const id = inicial.id;

  const enviar = useCallback(
    (operacao) => {
      setEstado({ tipo: "salvando", texto: "Salvando…" });
      const pedido = fila.current.then(async () => {
        try {
          const r = await operar(id, operacao);
          if (r.excluido) {
            window.location.assign("/");
            return;
          }
          setCaderno(r.caderno);
          setEstado({ tipo: "ok", texto: "Salvo." });
        } catch (erro) {
          setEstado({ tipo: "erro", texto: erro.message });
          try {
            setCaderno(await lerCaderno(id));
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

  const editar = `/caderno/${c.id}/editar`;

  return (
    <>
      {aviso ? (
        <p className="aviso-ok" role="status">
          {aviso}
        </p>
      ) : null}
      <div className="linha-titulo">
        <h1>{c.nome}</h1>
        <Contador no={c} tipo="c" />
      </div>
      <Barra no={c} rotulo={`Progresso de ${c.nome}`} />
      <div className="linha-titulo">
        <p className="detalhe">
          {c.sessoesConcluidas} de {c.sessoesTotal} sessões concluídas
        </p>
        <span className="em-lote">
          <Conclusao tipo="c" no={c} alternar={() => enviar({ op: "concluir", tipo: "c" })} />
          <a className="botao secundario" href={editar}>
            Editar
          </a>
        </span>
      </div>
      {estado ? (
        <p className={`estado estado-${estado.tipo}`} role="status" aria-live="polite">
          {estado.texto}
        </p>
      ) : null}
      {c.proximo ? (
        <a className="cartao destaque" href={`/sessao/${c.proximo.sessao.id}`}>
          <span className="rotulo">Continuar</span>
          <strong>{c.proximo.sessao.nome}</strong>
          <span className="detalhe">
            {c.proximo.sessao.disciplina} · próximo: {c.proximo.material.nome}
          </span>
        </a>
      ) : null}
      {c.disciplinas.length ? (
        c.disciplinas.map((d) => <Disciplina key={d.id} disciplina={d} enviar={enviar} />)
      ) : (
        <section>
          <p>Este caderno ainda não tem disciplinas.</p>
          <p>
            <a className="botao" href={editar}>
              Montar o caderno
            </a>
          </p>
        </section>
      )}
      <section className="acoes">
        <h2>Caderno</h2>
        <p>
          <a className="botao" href="/importar">
            Acrescentar por .md
          </a>{" "}
          <a href={`/caderno/${c.id}.md`}>Baixar como .md</a>
        </p>
        <p className="detalhe">O .md baixado volta com o progresso marcado em [x]. Edite e importe de novo para acrescentar sessões e materiais.</p>
        <details>
          <summary>Excluir este caderno</summary>
          <p>Apaga o caderno, as disciplinas, as sessões e todo o progresso. Não dá para desfazer.</p>
          <button type="button" className="perigo" onClick={() => enviar({ op: "excluir", tipo: "c", confirmado: true })}>
            Excluir {c.nome}
          </button>
        </details>
      </section>
    </>
  );
}

function Disciplina({ disciplina: d, enviar }) {
  return (
    <section id={`d-${d.id}`}>
      <div className="linha-titulo">
        <h2>{d.nome}</h2>
        <Contador no={d} tipo="d" />
      </div>
      <Barra no={d} rotulo={`Progresso de ${d.nome}`} />
      <div className="linha-titulo">
        <span className="detalhe">
          {d.sessoesConcluidas} de {d.sessoes.length} sessões concluídas
        </span>
        <Conclusao tipo="d" no={d} alternar={() => enviar({ op: "concluir", tipo: "d", id: d.id })} />
      </div>
      <ul className="sessoes">
        {d.sessoes.map((s) => (
          <li key={s.id}>
            <a href={`/sessao/${s.id}`} className={s.concluido ? "feito" : ""}>
              <span className="linha-titulo">
                <span className="nome">
                  {s.concluido ? <span className="caixa marcada" aria-hidden="true" /> : null}
                  {s.nome}
                </span>
                <Contador no={s} tipo="s" />
              </span>
              <Barra no={s} rotulo={`Progresso de ${s.nome}`} />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Página de início em React (#20): os cartões dos cadernos e o "Novo caderno".
//
// Criar leva ao editor do caderno novo, como o formulário. Um nome vazio ou
// repetido mostra o erro aqui mesmo, sem recarregar e sem perder o que foi
// digitado.
//
// O desenho é o mesmo do HTML do servidor (src/paginas.js, renderInicio), com as
// mesmas classes, pra não mudar nada na tela quando o React assume.
import { useState } from "react";

import { criarCaderno } from "../comum/api.js";
import { Barra, Contador } from "../comum/progresso.jsx";

export function Inicio({ cadernos, erroInicial, nomeInicial }) {
  const [nome, setNome] = useState(nomeInicial ?? "");
  const [erro, setErro] = useState(erroInicial ?? null);
  const [criando, setCriando] = useState(false);

  const criar = async (evento) => {
    evento.preventDefault();
    if (criando) return;
    setCriando(true);
    try {
      const { id } = await criarCaderno(nome);
      window.location.assign(`/caderno/${id}/editar`);
    } catch (falha) {
      setErro(falha.message);
      setCriando(false);
    }
  };

  return (
    <>
      <div className="linha-titulo">
        <h1>Seus cadernos</h1>
        <a className="botao" href="/importar">
          Importar .md
        </a>
      </div>
      {cadernos.length ? (
        cadernos.map((c) => <Cartao key={c.id} caderno={c} />)
      ) : (
        <section>
          <h2>Nenhum caderno ainda</h2>
          <p>Crie um caderno aqui embaixo e monte as disciplinas, as sessões e os materiais pela edição, ou traga tudo de uma vez num arquivo .md.</p>
          <p>
            <a className="botao" href="/importar">
              Importar um .md
            </a>{" "}
            <a href="/modelo.md">Baixar o exemplo</a>
          </p>
        </section>
      )}
      <form className="novo-caderno" method="post" action="/caderno/novo" onSubmit={criar}>
        <label htmlFor="novo-caderno">Novo caderno</label>
        <div className="linha-campo">
          <input
            id="novo-caderno"
            name="nome"
            required
            maxLength={200}
            placeholder="Caderno A, Caderno B..."
            value={nome}
            onChange={(e) => setNome(e.target.value)}
          />
          <button type="submit" disabled={criando}>
            Criar
          </button>
        </div>
        {erro ? (
          <p className="aviso" role="alert">
            {erro}
          </p>
        ) : null}
      </form>
    </>
  );
}

function Cartao({ caderno: c }) {
  return (
    <a className="cartao" href={`/caderno/${c.id}`}>
      <div className="linha-titulo">
        <h2>{c.nome}</h2>
        <Contador no={c} tipo="c" />
      </div>
      <Barra no={c} rotulo={`Progresso de ${c.nome}`} />
      <span className="detalhe">
        {c.quantasDisciplinas} {c.quantasDisciplinas === 1 ? "disciplina" : "disciplinas"} · {c.sessoesConcluidas} de {c.sessoesTotal} sessões concluídas
      </span>
      {c.concluido ? (
        <span className="selo">concluído</span>
      ) : c.proximo ? (
        <span className="detalhe">
          A seguir: {c.proximo.sessao.nome}, {c.proximo.material.nome}
        </span>
      ) : null}
    </a>
  );
}

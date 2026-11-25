// Contador, barra de progresso e conclusão, iguais aos de src/paginas.js
// (contador, barra e conclusao), pra a tela não mudar quando o React assume.
// Usados pela sessão (#16) e pelo caderno (#18).

const DATA = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });
export const data = (quando) => DATA.format(new Date(quando));

export const plural = (n, um, varios) => (n === 1 ? `1 ${um}` : `${n} ${varios}`);

export const pct = (no) => (no.concluido ? 100 : no.total ? Math.round((no.feitos / no.total) * 100) : 0);

// Gênero de cada nível, pros rótulos: "caderno concluído", "sessão concluída".
const NIVEL = {
  c: { nome: "caderno", concluido: "concluído" },
  d: { nome: "disciplina", concluido: "concluída" },
  s: { nome: "sessão", concluido: "concluída" },
};

// Os materiais marcados de fato. Concluído a mão com material em aberto aparece
// como "7/9 · concluída", e a barra cheia.
export function Contador({ no, tipo }) {
  return (
    <span className="contador">
      {no.feitosReais ?? no.feitos}/{no.total} · {no.concluido ? NIVEL[tipo].concluido : `${pct(no)}%`}
    </span>
  );
}

export function Barra({ no, rotulo }) {
  // Concluído, mesmo sem materiais, enche a barra.
  const max = no.total || 1;
  return (
    <progress value={no.concluido ? max : no.feitos} max={max} aria-label={rotulo}>
      {pct(no)}%
    </progress>
  );
}

// Concluir ou reabrir um nível. Concluído sozinho, com todos os filhos
// concluídos, não tem o que reabrir: aí não aparece nada.
export function Conclusao({ tipo, no, alternar }) {
  const { nome, concluido } = NIVEL[tipo];
  if (no.manual) {
    const faltam = no.total - no.feitosReais;
    return (
      <div className="conclusao">
        <span className="detalhe">
          {nome[0].toUpperCase()}
          {nome.slice(1)} {concluido}
          {no.concluidoEm ? ` em ${data(no.concluidoEm)}` : ""}
          {faltam > 0 ? `, com ${plural(faltam, "material", "materiais")} em aberto` : ""}.
        </span>
        <button type="button" className="secundario" onClick={alternar}>
          Reabrir {nome}
        </button>
      </div>
    );
  }
  if (no.concluido) return null;
  return (
    <div className="conclusao">
      <button type="button" className="secundario" onClick={alternar}>
        Concluir {nome}
      </button>
    </div>
  );
}

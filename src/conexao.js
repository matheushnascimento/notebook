// Conexão com o banco do notebook, o mesmo Postgres em dois lugares:
//
//   - um endereço postgres:// (DATABASE_URL): o Supabase, pelo pooler em modo
//     transação. É a produção, na Vercel.
//   - qualquer outra coisa: o PGlite, um Postgres embutido no próprio Node.
//     Uma pasta guarda os dados (modo local, Docker do preview); ":memory:" ou
//     nada é um banco descartável (testes).
//
// Os dois ficam atrás da mesma interface pequena, que é tudo o que banco.js usa:
//
//   consulta(sql, params)  as linhas, com $1, $2... nos parâmetros
//   executar(sql)          vários comandos de uma vez, sem parâmetros (o esquema)
//   transacao(fn)          fn(tx) numa transação; um erro desfaz tudo
//   tx.tentar(fn)          fn(tx) num savepoint: devolve false se der nome
//                          repetido (23505), e a transação segue
//   fechar()

import { ESQUEMA } from "./esquema.js";

const REPETIDO = "23505";

export const ehEnderecoPostgres = (destino) => /^postgres(ql)?:\/\//i.test(destino ?? "");

export async function conectar(destino) {
  return ehEnderecoPostgres(destino) ? conectarPostgres(destino) : conectarPglite(destino);
}

async function conectarPostgres(endereco) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(endereco, {
    // O pooler em modo transação não guarda consulta preparada entre pedidos.
    prepare: false,
    // Uma função da Vercel atende um pedido por vez: poucas conexões bastam, e
    // as ociosas fecham logo, pra não segurar vaga no pooler.
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
  const sobre = (executor) => ({
    consulta: (texto, params = []) => executor.unsafe(texto, params),
    executar: (texto) => executor.unsafe(texto).simple(),
    async tentar(fn) {
      try {
        await executor.savepoint((s) => fn(sobre(s)));
        return true;
      } catch (erro) {
        if (erro?.code === REPETIDO) return false;
        throw erro;
      }
    },
  });
  return {
    consulta: (texto, params = []) => sql.unsafe(texto, params),
    executar: (texto) => sql.unsafe(texto).simple(),
    transacao: (fn) => sql.begin((tx) => fn(sobre(tx))),
    fechar: () => sql.end({ timeout: 5 }),
  };
}

async function conectarPglite(pasta) {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = !pasta || pasta === ":memory:" ? new PGlite() : new PGlite(pasta);
  await pg.waitReady;
  // O PGlite é da própria máquina: o esquema é criado aqui mesmo. No Supabase,
  // quem cria é o scripts/copiar-para-supabase.js, uma vez.
  await pg.exec(ESQUEMA);
  let savepoints = 0;
  const sobre = (executor) => ({
    consulta: async (texto, params = []) => (await executor.query(texto, params)).rows,
    executar: (texto) => executor.exec(texto),
    async tentar(fn) {
      const nome = `sp${++savepoints}`;
      await executor.exec(`SAVEPOINT ${nome}`);
      try {
        await fn(sobre(executor));
        await executor.exec(`RELEASE SAVEPOINT ${nome}`);
        return true;
      } catch (erro) {
        await executor.exec(`ROLLBACK TO SAVEPOINT ${nome}`);
        if (erro?.code === REPETIDO) return false;
        throw erro;
      }
    },
  });
  return {
    consulta: async (texto, params = []) => (await pg.query(texto, params)).rows,
    executar: (texto) => pg.exec(texto),
    transacao: (fn) => pg.transaction((tx) => fn(sobre(tx))),
    fechar: () => pg.close(),
  };
}

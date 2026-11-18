// O banco de cada teste. Normalmente um PGlite em memória, novo a cada teste.
// Com BANCO_TESTE=postgres://..., os mesmos testes rodam num Postgres de verdade
// pelo postgres.js, o driver da produção: as tabelas são apagadas e criadas de
// novo a cada teste. Só pra um banco descartável.

import { conectar, ehEnderecoPostgres } from "../src/conexao.js";
import { ESQUEMA, TABELAS } from "../src/esquema.js";

const destino = process.env.BANCO_TESTE;
let aberto = null;

export async function novoBanco() {
  if (!ehEnderecoPostgres(destino)) return conectar(":memory:");
  aberto ??= await conectar(destino);
  await aberto.executar(`DROP TABLE IF EXISTS ${[...TABELAS].reverse().join(", ")} CASCADE;`);
  await aberto.executar(ESQUEMA);
  return aberto;
}

export async function fecharBancos() {
  if (aberto) await aberto.fechar();
  aberto = null;
}

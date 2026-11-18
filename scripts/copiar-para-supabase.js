// Copia o progresso do SQLite de antes (o notebook no Docker) pro Postgres do
// Supabase, com os mesmos ids. Roda no homeserver, uma vez antes do teste na
// Vercel e de novo na hora do corte, com --substituir.
//
//   node scripts/copiar-para-supabase.js                 do container notebook-notebook-1
//   node scripts/copiar-para-supabase.js --de x.db       de um arquivo SQLite
//   node scripts/copiar-para-supabase.js --substituir    apaga o que já está no destino
//
// O destino é a DATABASE_URL, do ambiente ou de ~/.config/notebook/supabase.env
// (uma linha DATABASE_URL=postgresql://...). O endereço e a senha nunca são
// impressos, nem os nomes dos cadernos: só as contagens.
//
// Tudo numa transação: com qualquer erro, o destino fica como estava.

import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { conectar, ehEnderecoPostgres } from "../src/conexao.js";
import { ESQUEMA, TABELAS, TRANCAR_SUPABASE } from "../src/esquema.js";

// As colunas de cada tabela, na ordem. concluido_em não existia em cadernos,
// disciplinas e sessoes nos bancos de antes do #7: lida como null.
const COLUNAS = {
  cadernos: { id: "int", usuario: "text", nome: "text", ordem: "int", concluido_em: "text" },
  disciplinas: { id: "int", caderno_id: "int", nome: "text", ordem: "int", concluido_em: "text" },
  sessoes: { id: "int", disciplina_id: "int", nome: "text", ordem: "int", concluido_em: "text" },
  materiais: { id: "int", sessao_id: "int", nome: "text", ordem: "int", concluido_em: "text" },
};
const LOTE = 1000;

export function lerSqlite(caminho) {
  const db = new DatabaseSync(caminho, { readOnly: true });
  try {
    const dados = {};
    for (const tabela of TABELAS) {
      const existentes = new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name));
      const colunas = Object.keys(COLUNAS[tabela]).map((c) => (existentes.has(c) ? c : `NULL AS ${c}`));
      dados[tabela] = db.prepare(`SELECT ${colunas.join(", ")} FROM ${tabela} ORDER BY id`).all();
    }
    return dados;
  } finally {
    db.close();
  }
}

async function contagens(c) {
  const r = {};
  for (const tabela of TABELAS) {
    const [linha] = await c.consulta(
      `SELECT COUNT(*)::int AS n, COUNT(concluido_em)::int AS feitos FROM ${tabela}`,
    );
    r[tabela] = linha;
  }
  return r;
}

// Copia `dados` (de lerSqlite) pra conexão `destino`. Devolve as contagens do
// destino, conferidas contra a origem.
export async function copiar(dados, destino, { substituir = false, supabase = false } = {}) {
  await destino.executar(ESQUEMA);
  if (supabase) await destino.executar(TRANCAR_SUPABASE);

  await destino.transacao(async (tx) => {
    const antes = await contagens(tx);
    const ocupado = TABELAS.some((t) => antes[t].n > 0);
    if (ocupado && !substituir) {
      throw new Error("o destino já tem dados: rode de novo com --substituir pra trocar pelo que está no SQLite");
    }
    if (ocupado) await tx.consulta(`TRUNCATE ${TABELAS.join(", ")} RESTART IDENTITY CASCADE`);

    // Na ordem das chaves estrangeiras: pai antes de filho.
    for (const tabela of TABELAS) {
      const colunas = COLUNAS[tabela];
      const nomes = Object.keys(colunas);
      const tipos = nomes.map((n) => `${n} ${colunas[n]}`).join(", ");
      const linhas = dados[tabela];
      for (let i = 0; i < linhas.length; i += LOTE) {
        const lote = linhas.slice(i, i + LOTE).map((l) => Object.fromEntries(nomes.map((n) => [n, l[n] ?? null])));
        await tx.consulta(
          `INSERT INTO ${tabela} (${nomes.join(", ")})
           SELECT ${nomes.join(", ")} FROM json_to_recordset($1::text::json) AS v(${tipos})`,
          [JSON.stringify(lote)],
        );
      }
      // Os ids vieram do SQLite: a próxima inserção começa depois do maior.
      await tx.consulta(
        `SELECT setval(pg_get_serial_sequence('${tabela}', 'id'), COALESCE((SELECT MAX(id) FROM ${tabela}), 0) + 1, false)`,
      );
    }

    const depois = await contagens(tx);
    for (const tabela of TABELAS) {
      const esperado = { n: dados[tabela].length, feitos: dados[tabela].filter((l) => l.concluido_em != null).length };
      if (depois[tabela].n !== esperado.n || depois[tabela].feitos !== esperado.feitos) {
        throw new Error(`${tabela}: o destino ficou com ${depois[tabela].n} (${depois[tabela].feitos} concluídos), e o SQLite tem ${esperado.n} (${esperado.feitos})`);
      }
    }
  });
  return contagens(destino);
}

function lerDestino() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const arquivo = join(homedir(), ".config/notebook/supabase.env");
  if (!existsSync(arquivo)) throw new Error(`sem DATABASE_URL no ambiente nem em ${arquivo}`);
  const linha = readFileSync(arquivo, "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="));
  const valor = linha?.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  if (!ehEnderecoPostgres(valor)) throw new Error(`${arquivo} não tem uma linha DATABASE_URL=postgresql://...`);
  return valor;
}

async function principal() {
  const args = process.argv.slice(2);
  const valor = (nome) => {
    const i = args.indexOf(nome);
    return i >= 0 ? args[i + 1] : null;
  };
  const substituir = args.includes("--substituir");
  const destinoUrl = lerDestino();

  let pasta = null;
  let origem = valor("--de");
  if (!origem) {
    // Cópia do volume inteiro (o .db e o -wal juntos), pra ler sem tocar no
    // banco que o container está usando.
    const container = valor("--container") ?? "notebook-notebook-1";
    pasta = mkdtempSync(join(tmpdir(), "notebook-copia-"));
    execFileSync("docker", ["cp", `${container}:/dados/.`, pasta], { stdio: ["ignore", "ignore", "inherit"] });
    origem = join(pasta, "notebook.db");
  }
  try {
    const dados = lerSqlite(origem);
    console.log(`origem: ${TABELAS.map((t) => `${dados[t].length} ${t}`).join(", ")}`);
    const destino = await conectar(destinoUrl);
    try {
      const r = await copiar(dados, destino, { substituir, supabase: true });
      console.log(`destino: ${TABELAS.map((t) => `${r[t].n} ${t} (${r[t].feitos} concluídos)`).join(", ")}`);
      console.log("cópia conferida: as contagens batem.");
    } finally {
      await destino.fechar();
    }
  } finally {
    if (pasta) rmSync(pasta, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  principal().catch((erro) => {
    // A mensagem do driver pode citar o host, nunca a senha; ainda assim, só a
    // mensagem curta e o código.
    console.error(`a cópia falhou: ${erro.code ?? ""} ${erro.message}`);
    process.exit(1);
  });
}

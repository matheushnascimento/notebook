// Utilidades de entrada compartilhadas pelo .md e pelo editor.

// Objeto sem protótipo: uma chave vinda de fora, como "__proto__" ou
// "constructor", não encontra nada herdado de Object.prototype. Em 2026-11-12,
// "modelo: __proto__" no .md derrubava a importação com 500.
export const semPrototipo = (objeto) => Object.freeze(Object.assign(Object.create(null), objeto));

// Caracteres de controle (C0, C1) e marcas de direção bidirecional
// (LRE..RLO, LRI..PDI): eles invertem ou escondem texto na tela.
const INVISIVEIS = /[\p{Cc}‪-‮⁦-⁩]/gu;

export const LIMITE_NOME = 200;

// Normaliza um nome: tira os invisíveis, junta espaços, apara e corta em 200.
// Corta primeiro num teto folgado, pra nenhum regex depois rodar sobre texto
// longo. Todas as expressões aqui são lineares.
export function limparTexto(valor) {
  return String(valor ?? "")
    .slice(0, LIMITE_NOME * 4)
    .replace(INVISIVEIS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITE_NOME)
    .trim();
}

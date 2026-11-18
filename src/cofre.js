// Cofre do painel: a sessão e o login em andamento viajam no próprio cookie,
// lacrados com AES-256-GCM (ADR-025). Sem estado no servidor, qualquer
// instância da função da Vercel abre o cookie de qualquer outra.
//
// O lacre cifra e autentica: o navegador guarda o cookie mas não lê o access
// token nem consegue alterar nada sem invalidar a etiqueta. O nome do cookie
// entra como dado associado, então um lacre de login não serve como sessão.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSAO = "v1";
// Cada cookie cabe em 4096 bytes contando nome e atributos. A sessão leva dois
// JWT do authentik e pode passar disso, então vai em pedaços de até 3800.
const TAMANHO_PEDACO = 3800;
export const MAX_PEDACOS = 3;

export function chaveDe(texto) {
  const chave = Buffer.from(texto ?? "", "base64url");
  if (chave.length !== 32) throw new Error("SEGREDO_SESSAO precisa ter 32 bytes em base64url");
  return chave;
}

export function lacrar(chave, nome, dado) {
  const iv = randomBytes(12);
  const cifra = createCipheriv("aes-256-gcm", chave, iv);
  cifra.setAAD(Buffer.from(nome));
  const corpo = Buffer.concat([cifra.update(JSON.stringify(dado), "utf8"), cifra.final()]);
  return [VERSAO, iv.toString("base64url"), corpo.toString("base64url"), cifra.getAuthTag().toString("base64url")].join(".");
}

// Devolve o dado, ou null se o lacre for de outra chave, de outro cookie,
// estiver truncado ou adulterado. Nunca lança: cookie ruim é só sem sessão.
export function abrir(chave, nome, lacre) {
  try {
    const [versao, iv, corpo, etiqueta] = (lacre ?? "").split(".");
    if (versao !== VERSAO || !iv || !corpo || !etiqueta) return null;
    // A etiqueta tem de ter os 16 bytes inteiros. Sem authTagLength o Node
    // aceita etiqueta truncada (até 4 bytes), e um lacre cortado no fim abriria.
    const decifra = createDecipheriv("aes-256-gcm", chave, Buffer.from(iv, "base64url"), { authTagLength: 16 });
    decifra.setAAD(Buffer.from(nome));
    decifra.setAuthTag(Buffer.from(etiqueta, "base64url"));
    const texto = Buffer.concat([decifra.update(Buffer.from(corpo, "base64url")), decifra.final()]).toString("utf8");
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

// O lacre em pedaços: nome, nome.1, nome.2. Os pedaços que sobram são
// apagados, para um lacre menor não herdar o fim de um maior.
export function emPedacos(nome, lacre) {
  const pedacos = [];
  for (let i = 0; i < lacre.length; i += TAMANHO_PEDACO) pedacos.push(lacre.slice(i, i + TAMANHO_PEDACO));
  if (pedacos.length > MAX_PEDACOS) throw new Error(`sessão grande demais: ${lacre.length} bytes`);
  return Array.from({ length: MAX_PEDACOS }, (_, i) => ({ nome: nomeDoPedaco(nome, i), valor: pedacos[i] ?? "" }));
}

export function juntarPedacos(cookies, nome) {
  let lacre = "";
  for (let i = 0; i < MAX_PEDACOS; i++) {
    const pedaco = cookies[nomeDoPedaco(nome, i)];
    if (!pedaco) break;
    lacre += pedaco;
  }
  return lacre || null;
}

export function nomeDoPedaco(nome, i) {
  return i === 0 ? nome : `${nome}.${i}`;
}

// Os arquivos do frontend em React (#9), gerados pelo Vite em dist/.
//
// Lidos uma vez, na partida, a partir do manifest do Vite: só os arquivos que
// ele lista, com o nome com hash que ele deu. Como as fontes e o logo, nenhuma
// parte da URL vira caminho de arquivo (docs/seguranca.md).
//
// Sem dist/ (rodando sem build), o notebook segue funcionando com o editor de
// formulário, sem JavaScript.

import { existsSync, readFileSync } from "node:fs";

const RAIZ = new URL("../dist/", import.meta.url);
const TIPOS = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

export const ARQUIVOS_APP = Object.create(null); // "/app/editor-abc.js" -> { tipo, conteudo }
export const SCRIPTS = Object.create(null); // "editor" -> "/app/editor-abc.js"

const manifesto = new URL(".vite/manifest.json", RAIZ);
if (existsSync(manifesto)) {
  const entradas = JSON.parse(readFileSync(manifesto, "utf8"));
  const guardar = (arquivo) => {
    // Só nomes que o próprio Vite gera: app/<nome>-<hash>.<js|css>.
    if (!/^app\/[\w-]+\.(js|css)$/.test(arquivo)) throw new Error(`arquivo inesperado no manifest: ${arquivo}`);
    const caminho = `/${arquivo}`;
    ARQUIVOS_APP[caminho] ??= { tipo: TIPOS[arquivo.slice(arquivo.lastIndexOf("."))], conteudo: readFileSync(new URL(arquivo, RAIZ)) };
    return caminho;
  };
  for (const entrada of Object.values(entradas)) {
    const caminho = guardar(entrada.file);
    for (const css of entrada.css ?? []) guardar(css);
    if (entrada.isEntry && entrada.name) SCRIPTS[entrada.name] = caminho;
  }
}

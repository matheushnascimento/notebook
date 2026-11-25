// Entrada da página da sessão em React (#16). A página chega do servidor com os
// formulários, que funcionam sem JavaScript. Quando a sessão carrega pela API, o
// React toma o lugar deles. Se algo falhar antes disso, os formulários ficam.
import { createRoot } from "react-dom/client";

import { Sessao } from "./Sessao.jsx";
import { lerSessao } from "../comum/api.js";

const raiz = document.getElementById("sessao-app");
const id = Number(raiz?.dataset.sessao);

if (raiz && Number.isSafeInteger(id)) {
  lerSessao(id)
    .then((inicial) => createRoot(raiz).render(<Sessao inicial={inicial} />))
    .catch(() => {
      // Ficam os formulários, que não dependem da API.
    });
}

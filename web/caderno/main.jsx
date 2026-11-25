// Entrada da página do caderno em React (#18). A página chega do servidor com os
// formulários, que funcionam sem JavaScript. Quando a árvore carrega pela API, o
// React toma o lugar deles. Se algo falhar antes disso, os formulários ficam.
import { createRoot } from "react-dom/client";

import { Caderno } from "./Caderno.jsx";
import { lerCaderno } from "../comum/api.js";

const raiz = document.getElementById("caderno-app");
const id = Number(raiz?.dataset.caderno);

if (raiz && Number.isSafeInteger(id)) {
  // O aviso da importação vem do servidor, já no HTML; o React só o repete.
  const aviso = raiz.dataset.aviso ?? null;
  lerCaderno(id)
    .then((caderno) => createRoot(raiz).render(<Caderno inicial={caderno} aviso={aviso} />))
    .catch(() => {
      // Ficam os formulários, que não dependem da API.
    });
}

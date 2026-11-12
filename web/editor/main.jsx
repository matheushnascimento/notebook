// Entrada do editor em React (#9). A página chega do servidor com o editor de
// formulário, que funciona sem JavaScript. Quando a árvore carrega pela API, o
// React toma o lugar dele. Se algo falhar antes disso, o formulário fica.
import { createRoot } from "react-dom/client";

import { Editor } from "./Editor.jsx";
import { lerCaderno } from "./api.js";

const raiz = document.getElementById("editor-app");
const id = Number(raiz?.dataset.caderno);

if (raiz && Number.isSafeInteger(id)) {
  lerCaderno(id)
    .then((caderno) => createRoot(raiz).render(<Editor inicial={caderno} />))
    .catch(() => {
      // Fica o editor de formulário, que não depende da API.
    });
}

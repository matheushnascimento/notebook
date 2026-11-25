// Entrada da página de início em React (#20). A página chega do servidor com o
// formulário, que funciona sem JavaScript. Quando a lista carrega pela API, o
// React toma o lugar dele. Se algo falhar antes disso, o formulário fica.
import { createRoot } from "react-dom/client";

import { Inicio } from "./Inicio.jsx";
import { lerCadernos } from "../comum/api.js";

const raiz = document.getElementById("inicio-app");

if (raiz) {
  // Um erro do formulário (422) e o nome digitado vêm do servidor, já no HTML.
  const { erro = null, nome = "" } = raiz.dataset;
  lerCadernos()
    .then((cadernos) => createRoot(raiz).render(<Inicio cadernos={cadernos} erroInicial={erro} nomeInicial={nome} />))
    .catch(() => {
      // Fica o formulário, que não depende da API.
    });
}

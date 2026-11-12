// Chamadas à API do notebook. Mesma origem, com o cookie da sessão, e sempre
// JSON: o servidor recusa outro tipo de conteúdo (docs/seguranca.md).

export class ErroApi extends Error {
  constructor(mensagem, status) {
    super(mensagem);
    this.status = status;
  }
}

async function pedir(caminho, opcoes = {}) {
  const resposta = await fetch(caminho, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(opcoes.body ? { "Content-Type": "application/json" } : {}) },
    ...opcoes,
  });
  let dado = null;
  try {
    dado = await resposta.json();
  } catch {
    // Resposta sem JSON (um 502 do túnel, por exemplo).
  }
  if (!resposta.ok) throw new ErroApi(dado?.erro ?? `Não deu para salvar (erro ${resposta.status}).`, resposta.status);
  return dado;
}

export async function lerCaderno(id) {
  return (await pedir(`/api/caderno/${id}`)).caderno;
}

export function operar(id, operacao) {
  return pedir(`/api/caderno/${id}`, { method: "POST", body: JSON.stringify(operacao) });
}

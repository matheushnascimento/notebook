# Decisões técnicas do notebook

Cada mudança de comportamento ganha um registro aqui, no mesmo PR.

## ADR-001: página da sessão em React, uma tela por PR

**Status:** aceito em 2026-11-25. O Matheus aprovou seguir o caminho do fim
("siga"), começando pela página da sessão.

**Contexto.** O editor do caderno já é uma ilha em React (#9), mas as outras
páginas são HTML do servidor com formulários, e marcar um material recarrega a
página da sessão inteira. É a página mais usada no dia a dia. O fim
(financa.mhdn.com.br) passou pela mesma migração, uma tela por PR.

**Decisão.**
- A página da sessão vira uma ilha em React, como o editor: o servidor continua
  mandando o HTML com os formulários, dentro de `#sessao-app`, e o React assume
  por cima quando a API responde. Sem JavaScript, nada muda.
- A API nova é `GET` e `POST /api/sessao/:id`, com as operações `marcar`,
  `concluir` e `lote`. Cada uma devolve a sessão inteira, e a tela só troca o
  estado.
- Marcar muda a caixa na hora; se o servidor recusar, a tela volta ao que está
  gravado.
- As chamadas à API ficam em `web/comum/api.js`, usadas pelas duas telas. O Vite
  separa o React num pedaço comum, que o navegador baixa uma vez.

**Consequências.**
- O início e a página do caderno seguem em HTML do servidor, cada uma para um PR
  próprio.
- A garantia de funcionar sem JavaScript continua valendo por enquanto. Se ela
  sair, como no fim, isso pede outro ADR.

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

## ADR-002: página do caderno em React, pela API do editor

**Status:** aceito em 2026-11-25. O Matheus pediu para seguir com a próxima
tela ("Seguir"), depois de aprovar a da sessão.

**Contexto.** A página do caderno recarrega ao concluir ou reabrir o caderno e
as disciplinas. As ações dela já existem na API do editor (`concluir` e
`excluir`), mas a árvore não trazia tudo o que a página mostra.

**Decisão.**
- A página do caderno vira uma ilha em React dentro de `#caderno-app`, como a
  sessão (ADR-001). Sem JavaScript, nada muda.
- Não há rota nova: a tela usa `GET` e `POST /api/caderno/:id`. A árvore
  (`arvoreJson`) ganha o próximo material, as sessões concluídas e as datas de
  conclusão de cada nível.
- O aviso da importação continua vindo do servidor, no atributo `data-aviso`,
  escapado.
- Contador, barra e conclusão ficam em `web/comum/progresso.jsx`, usados pela
  sessão e pelo caderno.
- Excluir o caderno pela tela volta para o início, sem pedir confirmação de
  novo: abrir o "Excluir este caderno" já é o passo de confirmação, como no
  formulário.

**Consequências.**
- Falta só a página de início, que fica para um PR próprio.
- O editor passa a receber campos que não usa (datas, próximo). São poucos
  bytes, e assim as três telas leem a mesma árvore.

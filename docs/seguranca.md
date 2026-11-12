# Segurança do notebook

Como cada entrada e cada arquivo é tratado, passo a passo. Auditoria de
2026-11-12 (#5). Os achados dela estão no fim, com o que foi corrigido e o que
fica como risco aceito.

## O que entra

Tudo o que vem de fora passa por um destes caminhos, e só por eles:

| Entrada | De onde | Tratado em |
| --- | --- | --- |
| Caminho da URL | qualquer pedido | `server.js`, roteamento |
| Cabeçalhos `Cookie`, `Origin` e `Host` | qualquer pedido | `server.js` |
| `?volta=` do `/entrar` | link de login | `caminhoSeguro()` |
| Formulários (urlencoded) | editor sem JavaScript, novo caderno, marcar, excluir | `lerCorpo()`, `aplicarEdicao()` |
| JSON da API (`/api/caderno/:id`) | editor em React | `lerJson()`, `operar()` em `src/api.js` |
| Arquivo `.md` (multipart) ou texto colado | importar | `lerCorpo()`, `lerMarkdown()`, `importar()` |
| Resposta do login (code, state) | Conta mhdn | `openid-client` |

## 1. Arquivos do servidor: o que é lido do disco

**Nenhuma parte da URL vira caminho de arquivo.** O servidor lê seis arquivos,
uma vez, na partida, por nomes escritos no código:

| Arquivo | Servido em |
| --- | --- |
| `src/fonts/eb-garamond-500.woff2`, `newsreader-400.woff2`, `newsreader-600.woff2` | `/fonts/<nome>.woff2` |
| `src/marca/logo.svg`, `favicon-livro-simples.svg` | `/marca/<nome>` |
| `exemplos/exemplo.md` | `/modelo.md` |

Eles ficam num mapa em memória (`ESTATICOS`), sem protótipo. Um pedido só é
atendido se o caminho for **exatamente** uma das chaves. Não existe `join`, nem
`readFile` com o caminho pedido, nem servidor de pasta. Por isso `/../`, `%2e%2e`,
`..%2f`, `/src/server.js`, `/.env` e `/dados/notebook.db` dão 404, todos testados.

O único outro arquivo é o **banco** (`/dados/notebook.db`). O caminho vem da
variável `BANCO`, definida no deploy, e nunca do pedido.

## 2. Upload de .md, passo a passo

1. **O tamanho é conferido enquanto chega.** `lerCorpo()` soma os pedaços e
   aborta com 413 ao passar de 576 KB (512 KB de arquivo mais folga do
   multipart), antes de guardar o resto. Isso vale para todo `POST`.
2. **O arquivo nunca toca o disco.** O multipart é lido em memória pelo `Request`
   do próprio Node. O nome e o tipo do arquivo enviado são **ignorados**. O
   `accept=".md"` do formulário é só conforto, e o servidor não confia nele.
3. **O conteúdo é lido como texto UTF-8.** Binário vira texto sem sentido, que
   não forma título nem lista e cai em "Nenhum caderno encontrado".
4. **Linha com mais de 2.000 caracteres é recusada** antes de qualquer regex.
5. **Cada linha passa por regex ancorados e lineares** (`^#\s+`, `^[-*+]\s+`,
   `^modelo:`). O nome é limpo por `limparTexto()`: corta em 800 caracteres,
   tira os invisíveis, junta espaços, apara e corta em 200.
6. **`modelo:` só aceita `unidades` ou `submódulos`**, conferido com `Object.hasOwn` num
   objeto sem protótipo. `__proto__` e `constructor` viram aviso.
7. **Com qualquer aviso, nada é gravado.** A página volta com a lista de linhas
   problemáticas.
8. **Teto antes de gravar:** mais de 5.000 itens num arquivo é recusado de
   imediato (413).
9. **Gravação numa transação só,** com consultas preparadas e parâmetros. No fim,
   o teto da conta (20.000 itens) é conferido, e se passar há `ROLLBACK`: nada
   fica pela metade.

## 3. Campos do editor, passo a passo

O editor é um formulário com campos `nome:<tipo>:<id>`, `novo:<tipo>:<id>`,
`modelo:s:<id>` e um botão `acao=<verbo>:<tipo>:<id>`.

1. **O tipo vem de uma lista fechada:** `c`, `d`, `s`, `m`. A lista é um objeto
   sem protótipo, consultada com `Object.hasOwn`. Qualquer outro tipo é ignorado.
2. **O id precisa ser inteiro seguro** (`Number.isSafeInteger`). Texto, `NaN` e
   `1e20` são ignorados.
3. **Toda edição confere o dono e o caderno.** `cadernoDoItem()` sobe do item até
   o caderno com `JOIN` e exige `c.usuario = <sub de quem está logado>` **e** que
   o caderno seja o da URL. Um id de outra pessoa, ou de outro caderno seu, não
   faz nada. Isso tem teste.
4. **Os nomes são limpos** por `limparTexto()`: sem caracteres de controle nem de
   direção bidirecional, com no máximo 200 caracteres. Nome vazio não apaga o
   item; é ignorado.
5. **Nome repetido no mesmo lugar** esbarra no `UNIQUE` do banco e vira aviso. O
   resto do envio é gravado.
6. **O modelo da sessão nova** passa pela mesma checagem `Object.hasOwn`. Um modelo
   inválido cria a sessão vazia.
7. **Excluir algo com conteúdo pede confirmação,** e o caderno sempre pede. A
   confirmação é outro envio, com o mesmo dono conferido de novo.
8. **Tudo numa transação,** com o teto da conta no fim.

## 3b. API JSON do editor em React (#9), passo a passo

1. **Só `Content-Type: application/json`**, ou 415. Um formulário de outro site
   não consegue mandar JSON sem passar pelo CORS, que o notebook não libera.
2. **`Origin` igual ao do notebook**, ou 403, como em todo `POST`.
3. **No máximo 64 KB** por pedido, contados enquanto chegam. JSON que não lê dá 400.
4. **Cada campo tem o tipo conferido:** `op` numa lista fechada, `tipo` em `c d s
   m` (com `Set`, sem protótipo), ids e índice inteiros seguros, e nomes como
   texto de até 1.000 caracteres antes da limpeza. Fora disso, 400.
5. **Cada operação chama as mesmas funções do banco do formulário**, com as
   mesmas checagens de dono e de caderno, os mesmos tetos e a mesma transação. A
   única função nova é `moverPara()`, que confere dono e caderno do mesmo jeito.
6. **Sem sessão, 401 em JSON.** Não há redirecionamento, porque quem chama é o
   script.
7. **A resposta é a árvore do caderno**, só com nome, id e progresso: nada de
   `sub` nem de datas.

## 4. SQL

**Nenhum texto do pedido entra no SQL.** Os valores vão sempre como parâmetros
(`?`). Os nomes de tabela e de coluna aparecem montados no texto da consulta,
mas vêm só das constantes `NIVEIS` e `CADERNO_DE`, escolhidas pelo tipo depois
da checagem do passo 3.1. As consultas ficam preparadas e reaproveitadas.

## 4b. Os arquivos do React

- **São gerados pelo Vite no build**, dentro do Docker, e não no servidor em
  produção. A imagem final não tem Vite, React nem dnd-kit instalados, só os
  arquivos gerados em `dist/`.
- **São lidos na partida a partir do manifest do Vite.** Só entram nomes no
  formato `app/<nome>-<hash>.<js|css>`; qualquer outro derruba a partida, em vez
  de servir algo inesperado. Como as fontes, nenhuma parte da URL vira caminho.
- **O nome tem hash, então o cache é imutável:** script novo é endereço novo, e o
  cache do Cloudflare não serve versão velha.
- **O build sai sem `eval` nem `new Function`** (conferido) e sem script inline
  (`modulePreload: false`), por isso a CSP fica só com `script-src 'self'`.
- **O React escapa todo texto.** `dangerouslySetInnerHTML` não é usado. O arraste
  move os itens por `element.style`, que a CSP permite, e não por `style=""` no
  HTML, que ela recusaria.

## 5. O que sai: HTML e downloads

- **Todo texto vindo do banco ou do .md passa por `esc()`**, que troca
  `& < > " '`. Isso vale para conteúdo e para atributos (`value`, `aria-label`).
  Números (ids, contagens) e constantes do código entram sem escape.
- **CSP:** `default-src 'none'`. `script-src 'self'` aceita só os arquivos do
  React servidos pelo próprio notebook: nada inline, nada de `eval`, nada de
  outro domínio. `connect-src 'self'` limita o `fetch` à própria API. CSS, fontes e
  imagens só do próprio site, `form-action` só para o próprio site e a Conta mhdn,
  `frame-ancestors 'none'`. Um texto que escapasse como HTML não viraria script,
  porque script inline é recusado.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` e
  `Cache-Control: private, no-store` nas páginas.
- **No download do .md,** o nome do arquivo é reduzido a letras, números, `-` e
  espaço, então não injeta cabeçalho. O conteúdo é gerado do banco e vai como
  `attachment`.

## 6. Sessão, login e pedidos forjados

- **Login pela Conta mhdn** com `openid-client`: Authorization Code, PKCE
  **S256** forçado, `state` e `nonce` conferidos, ID token validado pela
  biblioteca. O login pendente vale 10 minutos e é usado uma vez só.
- **Sessão:** id aleatório de 256 bits, guardado só em memória, num cookie
  `__Host-notebook` com `HttpOnly`, `Secure` e `SameSite=Lax`. Dura 7 dias, e o
  token de acesso não é guardado.
- **CSRF:** todo `POST` exige `Origin` igual ao endereço do app, além do
  `SameSite`. Sem `Origin`, a resposta é 403.
- **Redirecionamento aberto:** o `?volta=` só aceita caminho local
  (`/^\/(?!\/)[\w\-./]*$/`). `//outro.site` volta para `/`.
- **Modo local** (`AUTENTICACAO=local`, sem login): ouve só em `127.0.0.1`, na
  porta 19400, longe da de produção (9400). Ele responde 421 a qualquer `Host`
  que não seja `localhost` ou `127.0.0.1`, então nem o túnel o publica.
- **Log:** só método, caminho e mensagem de erro. Nunca token, nome ou IP.

## 7. Container

Sem root (`USER node`), sistema de arquivos **só leitura** (`read_only`), sem
capabilities (`cap_drop: ALL`), `no-new-privileges`. O único lugar gravável é o
volume `/dados`. A porta é só `127.0.0.1:9400`, e quem publica é o túnel.

## Achados desta auditoria

| # | Achado | Gravidade | Situação |
| --- | --- | --- | --- |
| 1 | **Regex quadrático no nome dos títulos** (`/\s+#+\s*$/`). 32 mil espaços levavam 1,2 s; os 512 KB aceitos levariam minutos com o servidor parado para todos. | Alta: qualquer conta da Conta mhdn entra no app. | Corrigido: corte por caractere, linha de no máximo 2.000 caracteres e corte do nome antes de qualquer regex. 500 mil espaços agora levam 29 ms. |
| 2 | **Inserção quadrática.** Cada item novo calculava a posição varrendo os irmãos, e 20 mil itens numa sessão levavam 86 s. | Alta, pelo mesmo motivo. | Corrigido: índices `(pai, ordem)`, consultas preparadas e teto de 5.000 itens por arquivo. Uma importação no teto leva cerca de 190 ms. |
| 3 | **Chaves do protótipo** (`__proto__`, `constructor`) passavam pelas checagens de tipo e de modelo e davam 500. | Baixa: sem injeção, só a queda daquele pedido. | Corrigido: objetos sem protótipo e `Object.hasOwn`. |
| 4 | **Sem teto de itens por conta.** Envios repetidos enchiam o disco. | Média. | Corrigido: 20.000 itens por conta, com `ROLLBACK`. |
| 5 | **Busca do modelo O(n²)** no número de campos do editor. | Baixa. | Corrigido: índice dos campos montado uma vez. |
| 6 | **Caracteres de controle e de direção bidirecional** nos nomes, que invertem ou escondem texto. | Baixa: a pessoa só vê o próprio caderno. | Corrigido: removidos na entrada. Emoji com ZWJ continuam inteiros. |
| 7 | O **modo local** ocupou a porta de produção e foi publicado pelo túnel sem login (2026-11-12, cerca de 15 minutos, só dados de exemplo). | Alta, no momento. | Corrigido no PR #2: porta 19400, filtro de `Host` e só loopback. |

Cada achado tem teste em `test/notebook.test.js`, nos testes "segurança: ...".

## Riscos aceitos e pendências

- **Sem limite de taxa.** Um usuário logado pode repetir pedidos. Os tetos acima
  limitam o custo de cada pedido e o espaço total, mas não a frequência. O
  Cloudflare pode limitar na frente, se preciso.
- **Quem entra:** qualquer conta da Conta mhdn, porque a aplicação não tem
  binding de política (ADR-017 da central-contas). Para fechar a um grupo,
  basta o primeiro binding.
- **Backup:** o volume `notebook_dados` não tem backup automático.
- **Repositório público:** não tem segredo nem dado. O logo da mhdn fica à vista.
- **HSTS** fica com o Cloudflare, na frente do app.

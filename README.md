# notebook mhdn

O acompanhamento de estudos em cadernos, em
**`https://notebook.mhdn.com.br`**, atrás da Conta mhdn.

```
Cadernos → disciplinas → sessões → materiais
Caderno A        Disciplina 1  Sessão 1.1     Vídeo, Ebook, Cartões...
Caderno B   Disciplina 2                Sessão 2.1     Vídeo, Quiz...
```

Cada nível mostra o contador de progresso (feitos/total e %) e a barra. Os
materiais são marcados como concluídos ou não concluídos, e o caderno mostra o
próximo material em aberto ("Continuar").

**Sessão, disciplina e caderno também se concluem sozinhos, sem marcar todos os
materiais** ("Concluir sessão", "Concluir disciplina", "Concluir caderno"). Serve
para o Ebook que só entra se ficou lacuna, ou para a aula que não aconteceu.
- O que foi concluído a mão conta como 100% no nível de cima, e o "Continuar" pula.
- O contador continua mostrando os materiais marcados de fato, por exemplo
  "7/9 · concluída".
- Quando todos os filhos estão concluídos, o nível se conclui sozinho.
- "Reabrir" desfaz a conclusão feita a mão.

## Editar pela interface

"Novo caderno", no início, e "Editar", no caderno, abrem a árvore inteira em
listas aninhadas: disciplinas, dentro delas as sessões, e dentro delas os
materiais. Em cada item dá para renomear no próprio campo, subir (↑), descer (↓)
e excluir (×). No fim de cada lista há um campo para acrescentar. Uma sessão nova
pode vir vazia ou já com os materiais do modelo `unidades` ou `submódulos`.

O editor é em **React** e não recarrega a página:
- Renomear salva ao sair do campo ou com Enter, e Esc desfaz.
- Acrescentar mantém o foco no campo, para digitar vários seguidos.
- **Arrastar pela alça ⠿** reordena dentro de cada lista. Pelo teclado: espaço
  na alça, setas e espaço de novo.
- A caixa ao lado de cada material marca e desmarca.
- Excluir um material, ou um item vazio, é direto. Excluir algo com conteúdo
  mostra quanto sai junto e pede confirmação na própria linha. O caderno sempre
  pede.
- No topo, "Salvando…" ou "Tudo salvo" mostra o estado.

Sem JavaScript, ou se o script falhar, a mesma página continua funcionando como
formulário, com setas no lugar de arrastar.

O .md continua servindo para montar muita coisa de uma vez e como backup.

## O formato .md

```markdown
# Caderno A                    ← caderno
## Disciplina 1     ← disciplina
modelo: unidades              ← opcional
### Sessão 1.1 - Unidade 1    ← sessão
- [ ] Vídeo              ← material
- [x] Ebook 1/2          ← material concluído
### Sessão 1.2 - Unidade 2
concluído: sim           ← sessão concluída a mão
```

- Uma sessão **sem itens de lista** recebe os materiais do `modelo:` mais próximo
  (sessão, disciplina ou caderno). Os modelos seguem o método de estudo:
  - `unidades`: Gerar esqueleto, Vídeo, Aula com docente, Ebook, Perguntas de
    recuperação, Cartões didáticos, Teste sem consulta (meta 70%), Revisão de
    memória, Atividade no AVA.
  - `submódulos`: Gerar esqueleto, Vídeo, Ebook (só se ficou lacuna), Quiz.
- `concluído: sim` logo abaixo de um título conclui aquele nível. O .md baixado
  traz essa linha nas conclusões feitas a mão, e reimportar sem ela não reabre.
- Os prefixos `Caderno:`, `Disciplina:` e `Sessão:` nos títulos são aceitos e
  removidos. Frontmatter e texto livre são ignorados.
- **Importar mescla.** O que tem o mesmo nome (sem diferenciar maiúsculas) é
  reaproveitado, nada é apagado e um `[ ]` não desmarca o que já foi concluído.
  Com qualquer erro de estrutura, nada é gravado e a página aponta a linha.
- **Baixar como .md** devolve o caderno com o progresso em `[x]`: serve de
  backup e de ponto de partida pra editar e reimportar.

O exemplo completo está em [`exemplos/exemplo.md`](exemplos/exemplo.md) (e em
`/modelo.md` no próprio app).

## Como é feito

O mesmo molde do painel da Conta mhdn (`central-contas/painel`):

| Peça | Escolha |
| --- | --- |
| Servidor | Node 24, sem framework. Páginas geradas no servidor. |
| Frontend | **React 19 só no editor**, como ilha: monta por cima do formulário, que segue funcionando sem JavaScript. Build com Vite, arrastar e soltar com dnd-kit. A API JSON está em `src/api.js`. |
| Login | OIDC na Conta mhdn, Authorization Code + PKCE S256, cliente público, pelo `openid-client` 6.8.8. Escopo `openid profile`. |
| Dados | Postgres: o Supabase em produção, pelo pooler em modo transação (`postgres` 3.4.9), e o PGlite, um Postgres embutido, na máquina e nos testes (`src/conexao.js`). Tudo é guardado pelo `sub`: toda consulta filtra pelo dono. |
| Sessão | Cookie `__Host-notebook`, `HttpOnly`, `Secure`, `SameSite=Lax`, 7 dias, lacrado com AES-256-GCM (`src/cofre.js`, cópia do painel). Nada fica na memória do servidor. |
| Hospedagem | Vercel, região `gru1`: `src/app.js` exporta `tratar(req, res)`, `api/index.js` é a função e `src/server.js` a põe atrás de um servidor no Docker e na máquina. |
| CSRF | Todo `POST` confere a `Origin`, além do `SameSite`. |
| CSP | `script-src 'self'`, sem inline e sem `eval`; `connect-src 'self'`; CSS, fontes e imagens só do próprio site. |
| Marca | Tokens do brandbook mhdn (papel/noite), EB Garamond nos títulos, Newsreader no texto, logo e favicon copiados de `central-contas/infra/marca`. |
| Container | Sem root, só leitura, sem capabilities. Só o volume `/dados` é gravável. |

Como cada entrada e cada arquivo é tratado, com a auditoria de 2026-11-12, está em
[`docs/seguranca.md`](docs/seguranca.md).

Por que não o **portão** da central-contas: ele só repassa `GET` a páginas
estáticas e não diz ao app quem entrou. Aqui há formulários e progresso por
pessoa.

## Rodar na máquina

```bash
npm install
```

```bash
npm run local
```

Gera o frontend (`vite build`, em `dist/`) e sobe o servidor.

Abre em `http://localhost:19400`, **sem login** (`AUTENTICACAO=local`, um usuário
só), com o banco num PGlite em `./dados/pglite/`. Sem `dist/`, o app roda do mesmo jeito, só que
com o editor de formulário.

O modo local fica de propósito **fora da porta de produção** (9400) e só atende
pedidos com `Host` `localhost` ou `127.0.0.1`. Em 2026-11-12 ele ocupou a 9400, e
o túnel do Cloudflare, que aponta pra `localhost:9400`, o publicou em
`notebook.mhdn.com.br` sem login. Agora, um pedido que chega pelo túnel recebe
421.

```bash
npm test
```

Os testes rodam num PGlite em memória. Pra rodar os do banco no driver da
produção (`postgres.js`), contra um Postgres descartável:

```bash
BANCO_TESTE=postgres://postgres:teste@127.0.0.1:55432/postgres node --test --test-concurrency=1 test/notebook.test.js test/copia.test.js
```

As tabelas desse banco são apagadas a cada teste.

## Produção

O notebook roda na **Vercel** (projeto `notebook`, região `gru1`), com o
progresso no **Postgres do Supabase** (região São Paulo). Cada merge na `main`
publica sozinho, pela integração com o GitHub, e cada PR ganha um deploy de
teste no endereço da branch. O deploy de teste não tem login: a Conta mhdn só
aceita retorno em `notebook.mhdn.com.br` (ADR-029 da central-contas). Ele serve
pra conferir sem login; o login se testa com `npm run local` ou em produção.

1. **Registrar o app na Conta mhdn.** O registro vive na central-contas:
   `infra/blueprints/50-app-notebook.yaml` e ADR-017
   ([central-contas#19](https://github.com/matheushnascimento/central-contas/pull/19)).
   Sem ele aplicado em produção, o login falha.
2. **Na Vercel**, as variáveis, diferentes entre teste e produção:
   - `SEGREDO_SESSAO`: a chave do lacre, 32 bytes em base64url.
   - `DATABASE_URL`: a string do *transaction pooler* do Supabase (porta 6543).
     Sem ela, a função não sobe.

   `BASE_URL` não se define na Vercel: o endereço é `notebook.mhdn.com.br` em
   produção (e o `VERCEL_BRANCH_URL` nos testes, que não têm login).
3. **O esquema e a cópia do progresso.** `node scripts/copiar-para-supabase.js`
   cria as tabelas no Supabase (com RLS ligada e sem acesso pela chave pública)
   e copia um SQLite de antes, com os mesmos ids, numa transação, conferindo as
   contagens. Lê a `DATABASE_URL` de `~/.config/notebook/supabase.env`. Com
   dados no destino, recusa, e `--substituir` troca tudo pelo que está no
   SQLite. Já rodou: a cópia final foi no corte, em 2026-11-19. Sem o container
   de antes, a origem é um arquivo (`--de notebook.db`), e `--substituir` apaga
   o que foi feito depois no Supabase.

Backup: baixar cada caderno como .md, ou o backup diário do Supabase.

| Variável | Padrão | Pra quê |
| --- | --- | --- |
| `EMISSOR` | `https://conta.mhdn.com.br/application/o/notebook/` | emissor OIDC da aplicação |
| `CONTA` | `https://conta.mhdn.com.br` | origem da Conta, pra CSP do Sair |
| `BASE_URL` | o endereço da branch nos testes, senão `https://notebook.mhdn.com.br` | endereço público |
| `DATABASE_URL` | nenhum | o Supabase; obrigatória na Vercel |
| `BANCO` | `/dados/pglite` | pasta do PGlite, quando não há `DATABASE_URL` |
| `SEGREDO_SESSAO` | sorteada na partida (fora da Vercel) | chave do lacre da sessão |
| `AUTENTICACAO` | (vazio) | `local` desliga o login |
| `PORTA_NOTEBOOK` | `9400` | porta no loopback do host, no Docker |

O **Docker** (`compose.yml`) fica pra quem quiser rodar na máquina, com o PGlite
no volume `notebook_dados`. O container de antes foi desligado no corte, em
2026-11-19, e o volume ficou: o `notebook.db` dele é o progresso até o corte,
guardado como backup. Subir o compose de novo cria um PGlite vazio ao lado,
sem tocar no `notebook.db`.

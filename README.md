# notebook mhdn

O acompanhamento do modelo de estudo (CST e MBA FM2S), em
**`https://notebook.mhdn.com.br`**, atrás da Conta mhdn.

```
Cadernos → disciplinas → sessões → materiais
CST        Prática em gestão  PGUN1     Vídeo, Ebook, Cartões...
MBA FM2S   BPM                BPM01     Vídeo, Quiz...
```

Cada nível mostra o contador de progresso (feitos/total e %) e a barra. Os
materiais são marcados como concluídos ou não concluídos, e o caderno mostra o
próximo material em aberto ("Continuar").

## Editar pela interface

"Novo caderno", no início, e "Editar", no caderno, abrem a árvore inteira em
listas aninhadas: disciplinas, dentro delas as sessões, e dentro delas os
materiais. Em cada item dá para renomear no próprio campo, subir (↑), descer (↓)
e excluir (×). No fim de cada lista há um campo para acrescentar. Uma sessão nova
pode vir vazia ou já com os materiais do modelo `cst` ou `mba`.

- É um formulário só: qualquer botão salva tudo o que foi digitado antes de fazer
  a sua ação, e Enter salva.
- Excluir um material, ou um item vazio, é direto. Excluir algo com conteúdo
  mostra quanto sai junto e pede confirmação. O caderno sempre pede.
- Sem JavaScript, como o resto do app. Por isso as setas ficam no lugar de
  arrastar e soltar.

O .md continua servindo para montar muita coisa de uma vez e como backup.

## O formato .md

```markdown
# CST                    ← caderno
## Prática em gestão     ← disciplina
modelo: cst              ← opcional
### PGUN1 - Unidade 1    ← sessão
- [ ] Vídeo              ← material
- [x] Ebook 1/2          ← material concluído
```

- Uma sessão **sem itens de lista** recebe os materiais do `modelo:` mais próximo
  (sessão, disciplina ou caderno). Os modelos seguem o método de estudo:
  - `cst`: Gerar esqueleto, Vídeo, Aula com docente, Ebook, Perguntas de
    recuperação, Cartões didáticos, Teste sem consulta (meta 70%), Revisão de
    memória, Atividade no AVA.
  - `mba`: Gerar esqueleto, Vídeo, Ebook (só se ficou lacuna), Quiz.
- Os prefixos `Caderno:`, `Disciplina:` e `Sessão:` nos títulos são aceitos e
  removidos. Frontmatter e texto livre são ignorados.
- **Importar mescla.** O que tem o mesmo nome (sem diferenciar maiúsculas) é
  reaproveitado, nada é apagado e um `[ ]` não desmarca o que já foi concluído.
  Com qualquer erro de estrutura, nada é gravado e a página aponta a linha.
- **Baixar como .md** devolve o caderno com o progresso em `[x]`: serve de
  backup e de ponto de partida pra editar e reimportar.

O exemplo completo está em [`exemplos/cst-mba.md`](exemplos/cst-mba.md) (e em
`/modelo.md` no próprio app).

## Como é feito

O mesmo molde do painel da Conta mhdn (`central-contas/painel`):

| Peça | Escolha |
| --- | --- |
| Servidor | Node 24, sem framework. Páginas geradas no servidor, **sem JavaScript no navegador**: marcar um material é um formulário. |
| Login | OIDC na Conta mhdn, Authorization Code + PKCE S256, cliente público, pelo `openid-client` 6.8.8. Escopo `openid profile`. |
| Dados | SQLite embutido no Node (`node:sqlite`), um arquivo no volume `/dados`. Tudo é guardado pelo `sub`: toda consulta filtra pelo dono. |
| Sessão | Cookie `__Host-notebook`, `HttpOnly`, `Secure`, `SameSite=Lax`, 7 dias, só em memória. Reiniciar desloga, e entrar de novo é um redirecionamento. |
| CSRF | Todo `POST` confere a `Origin`, além do `SameSite`. |
| CSP | Sem script; só o próprio CSS, fontes e imagens. |
| Marca | Tokens do brandbook mhdn (papel/noite), EB Garamond nos títulos, Newsreader no texto, logo e favicon copiados de `central-contas/infra/marca`. |
| Container | Sem root, só leitura, sem capabilities. Só o volume `/dados` é gravável. |

Por que não o **portão** da central-contas: ele só repassa `GET` a páginas
estáticas e não diz ao app quem entrou. Aqui há formulários e progresso por
pessoa.

## Rodar na máquina

```bash
npm run local
```

Abre em `http://localhost:19400`, **sem login** (`AUTENTICACAO=local`, um usuário
só), com o banco em `./dados/`. Não precisa de `npm install`: o `openid-client`
só é carregado com login ligado.

O modo local fica de propósito **fora da porta de produção** (9400) e só atende
pedidos com `Host` `localhost` ou `127.0.0.1`. Em 2026-11-12 ele ocupou a 9400, e
o túnel do Cloudflare, que aponta pra `localhost:9400`, o publicou em
`notebook.mhdn.com.br` sem login. Agora, um pedido que chega pelo túnel recebe
421.

```bash
npm test
```

## Produção

1. **Registrar o app na Conta mhdn.** O registro vive na central-contas:
   `infra/blueprints/50-app-notebook.yaml` e ADR-017
   ([central-contas#19](https://github.com/matheushnascimento/central-contas/pull/19)).
   Sem esse blueprint aplicado em produção, o login falha.
2. Subir: `docker compose up -d --build --wait`. Escuta só em `127.0.0.1:9400`
   (9100 é o painel, 9200 o portão, 9300 o futuro-eu).
3. No Cloudflare Zero Trust, criar o Public Hostname `notebook.mhdn.com.br` →
   `http://localhost:9400`.
4. Conferir: `curl -I https://notebook.mhdn.com.br/` responde `303` para
   `/entrar`.

O progresso mora no volume `notebook_dados`. O compose fixa o nome do projeto
(`name: notebook`), então o volume tem esse nome em qualquer pasta. Backup é copiar
`/dados/notebook.db` (ou baixar cada caderno como .md).

| Variável | Padrão | Pra quê |
| --- | --- | --- |
| `EMISSOR` | `https://conta.mhdn.com.br/application/o/notebook/` | emissor OIDC da aplicação |
| `CONTA` | `https://conta.mhdn.com.br` | origem da Conta, pra CSP do Sair |
| `BASE_URL` | `https://notebook.mhdn.com.br` | endereço público |
| `BANCO` | `/dados/notebook.db` | arquivo SQLite |
| `AUTENTICACAO` | (vazio) | `local` desliga o login |
| `PORTA_NOTEBOOK` | `9400` | porta no loopback do host |

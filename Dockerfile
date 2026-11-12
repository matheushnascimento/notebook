# notebook mhdn. Versão do Node fixada, nunca flutuante (mesma do painel da
# Conta mhdn).
FROM node:24.18.0-alpine

WORKDIR /app
COPY package.json package-lock.json ./
# npm ci instala exatamente o que está no package-lock: openid-client 6.8.8 e as
# duas dependências dele, nada mais. O banco é o node:sqlite, embutido.
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY exemplos ./exemplos

# O banco mora no volume /dados, do usuário node.
RUN mkdir -p /dados && chown node:node /dados
USER node
ENV NODE_ENV=production PORTA=3000 BANCO=/dados/notebook.db
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/saude || exit 1
CMD ["node", "src/server.js"]

// O notebook no Docker e na máquina: o mesmo app da Vercel (src/app.js) atrás
// de um servidor HTTP do Node.

import { createServer } from "node:http";

import { tratar, CONFIG } from "./app.js";

// No modo local, só loopback ou o IP da tailnet (ver CONFIG.escuta).
createServer(tratar).listen(CONFIG.porta, CONFIG.local ? CONFIG.escuta : undefined, () =>
  console.log(`notebook ouvindo em ${CONFIG.local ? `${CONFIG.escuta}:` : "porta "}${CONFIG.porta}${CONFIG.local ? " (modo local, sem login)" : ""}`),
);

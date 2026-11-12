// Build do frontend em React (#9). Só gera arquivos: quem serve é o próprio
// servidor do notebook, que lê dist/ na partida por lista fechada (o manifest).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // O manifest diz ao servidor quais arquivos existem e com que hash.
    manifest: true,
    // Sem o polyfill de modulepreload, que viria como script inline (a CSP
    // do notebook não aceita script inline).
    modulePreload: false,
    assetsDir: "app",
    sourcemap: false,
    rollupOptions: {
      input: { editor: "web/editor/main.jsx" },
      output: {
        entryFileNames: "app/[name]-[hash].js",
        chunkFileNames: "app/[name]-[hash].js",
        assetFileNames: "app/[name]-[hash][extname]",
      },
    },
  },
});

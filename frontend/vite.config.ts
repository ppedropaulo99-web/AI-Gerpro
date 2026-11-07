import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// O navegador só conversa com /api deste servidor; o Vite repassa ao backend.
// O Ollama nunca é exposto ao navegador.
const backendUrl = process.env["BACKEND_URL"] ?? "http://127.0.0.1:3001";
const proxy = { "/api": { target: backendUrl, changeOrigin: true } };

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: { __AI_GERPRO_VERSION__: JSON.stringify(version) },
  build: {
    rollupOptions: {
      input: {
        // Página hospedeira de exemplo com o painel lateral (widget)
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        // Chat em página inteira (interface da Etapa 1)
        pagina: fileURLToPath(new URL("./pagina.html", import.meta.url)),
      },
    },
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy },
  preview: { host: "127.0.0.1", port: 4173, proxy },
});

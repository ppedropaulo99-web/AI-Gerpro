/**
 * Build do widget embutível (IIFE): gera um único arquivo, dist-widget/ai-gerpro.js, que qualquer
 * página HTML pode incluir. React e o CSS vão embutidos; o CSS é injetado no Shadow DOM do widget.
 */
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production"), __AI_GERPRO_VERSION__: JSON.stringify(version) },
  build: {
    outDir: "dist-widget",
    emptyOutDir: true,
    lib: {
      entry: "src/embed.tsx",
      name: "AIGerproWidget",
      formats: ["iife"],
      fileName: () => "ai-gerpro.js",
    },
  },
});

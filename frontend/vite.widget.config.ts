/**
 * Build do widget embutível (IIFE): gera dist-widget/ai-gerpro.js + ai-gerpro.css,
 * que qualquer página HTML pode incluir (React vai embutido no bundle).
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist-widget",
    emptyOutDir: true,
    lib: {
      entry: "src/embed.tsx",
      name: "AIGerproWidget",
      formats: ["iife"],
      fileName: () => "ai-gerpro.js",
      cssFileName: "ai-gerpro",
    },
  },
});

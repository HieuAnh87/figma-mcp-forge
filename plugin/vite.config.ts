import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  define: {
    "import.meta.env.FORGE_VERSION": JSON.stringify(
      JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version
    ),
  },
  plugins: [react(), viteSingleFile()],
  root: "./src/ui",
  build: {
    target: "es2015",
    cssCodeSplit: false,
    outDir: "../../dist",
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    emptyOutDir: true,
  },
});

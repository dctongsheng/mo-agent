import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  base: "./",
  resolve: {
    alias: {
      "@store": path.resolve(__dirname, "store"),
      "@ui": path.resolve(__dirname, "ui"),
      "@services": path.resolve(__dirname, "services"),
      "@styles": path.resolve(__dirname, "styles"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
});

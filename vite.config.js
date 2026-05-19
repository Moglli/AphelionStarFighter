import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "./",
  publicDir: "public",
  build: {
    outDir: "dist",
    assetsDir: "assets",
    target: "es2020",
    sourcemap: true,
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
  },
});

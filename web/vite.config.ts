import { resolve } from "node:path"
import { defineConfig } from "vite"

// Served from GitHub Pages at https://0xmago77.github.io/Mirrorlease/
export default defineConfig({
  root: resolve(import.meta.dirname),
  base: "/Mirrorlease/",
  publicDir: resolve(import.meta.dirname, "public"),
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 700,
  },
})

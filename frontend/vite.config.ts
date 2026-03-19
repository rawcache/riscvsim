import { resolve } from "node:path";
import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        landing: resolve(__dirname, "landing.html")
      }
    }
  },
  server: {
    fs: {
      allow: [".."]
    }
  },
  optimizeDeps: {
    exclude: ["./src/pkg/riscvsim_core.js"]
  }
});

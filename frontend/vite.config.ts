import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

function landingAsRoot(): Plugin {
  let outDir = "";

  return {
    name: "landing-as-root",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle() {
      const landingPath = resolve(outDir, "landing.html");
      const indexPath = resolve(outDir, "index.html");
      if (!existsSync(landingPath)) {
        return;
      }
      copyFileSync(landingPath, indexPath);
    },
  };
}

export default defineConfig({
  plugins: [landingAsRoot(), wasm(), topLevelAwait()],
  build: {
    rollupOptions: {
      input: {
        landing: resolve(__dirname, "landing.html"),
        terms: resolve(__dirname, "terms/index.html"),
        privacy: resolve(__dirname, "privacy/index.html"),
        termsOfUse: resolve(__dirname, "terms-of-use/index.html"),
        privacyPolicy: resolve(__dirname, "privacy-policy/index.html"),
        doNotSell: resolve(__dirname, "do-not-sell/index.html"),
        simulator: resolve(__dirname, "simulator/index.html"),
      },
    },
  },
  server: {
    fs: {
      allow: [".."],
    },
  },
  optimizeDeps: {
    exclude: ["./src/pkg/riscvsim_core.js"],
  },
});

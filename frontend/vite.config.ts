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
        riscvSimulator: resolve(__dirname, "riscv-simulator/index.html"),
        learnRiscv: resolve(__dirname, "learn-riscv/index.html"),
        riscvAssemblyTutorial: resolve(__dirname, "riscv-assembly-tutorial/index.html"),
        riscvInstructions: resolve(__dirname, "riscv-instructions/index.html"),
        problems: resolve(__dirname, "problems/index.html"),
        learn: resolve(__dirname, "learn/index.html"),
        quiz: resolve(__dirname, "quiz/index.html"),
        labs: resolve(__dirname, "labs/index.html"),
        leaderboard: resolve(__dirname, "leaderboard/index.html"),
        challenges: resolve(__dirname, "challenges/index.html"),
        checkpoints: resolve(__dirname, "checkpoints/index.html"),
        profile: resolve(__dirname, "profile/index.html"),
        groups: resolve(__dirname, "groups/index.html"),
        about: resolve(__dirname, "about/index.html"),
        docs: resolve(__dirname, "docs/index.html"),
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

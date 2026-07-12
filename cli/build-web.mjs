// Generates cli/web/index.html — the simulator UI embedded in the riscvsim
// binary for `riscvsim serve`. It is built from the SAME sources as the
// hosted studyriscv.com/simulator/ page (frontend/simulator/index.html +
// frontend/src/pipeline-sim.ts), with the engine switched to remote mode so
// the page talks to the local server instead of loading WASM.
//
// Run from the repo root (or anywhere):  node cli/build-web.mjs
// Re-run whenever the simulator page or pipeline-sim.ts changes, then
// rebuild the CLI.

import { build } from "../frontend/node_modules/esbuild/lib/main.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

const result = await build({
  entryPoints: [resolve(repo, "frontend/src/pipeline-sim.ts")],
  bundle: true,
  format: "esm",
  minify: true,
  write: false,
  // WASM is never loaded in remote mode; keep the import specifier external
  // so the bundle stays self-contained.
  external: ["./pkg/riscvsim_core.js"],
});

const bundle = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

let html = readFileSync(resolve(repo, "frontend/simulator/index.html"), "utf8");

// Point site links at the hosted site (this copy is served from localhost).
html = html
  .replace('href="/"', 'href="https://studyriscv.com/"')
  .replace('href="/learn/"', 'href="https://studyriscv.com/learn/"')
  .replace(/<link rel="icon"[^>]*>\n?/g, "")
  .replace(/<link rel="canonical"[^>]*>\n?/, "");

// Swap the module script for the inlined remote-mode bundle.
const scriptTag = '<script type="module" src="../src/pipeline-sim.ts"></script>';
if (!html.includes(scriptTag)) {
  throw new Error("simulator/index.html script tag not found — update build-web.mjs");
}
html = html.replace(
  scriptTag,
  `<script>window.__RISCVSIM_REMOTE__ = true;</script>\n<script type="module">${bundle}</script>`,
);

mkdirSync(resolve(here, "web"), { recursive: true });
writeFileSync(resolve(here, "web/index.html"), html);
console.log(`✓ wrote cli/web/index.html (${(html.length / 1024).toFixed(1)} kB)`);

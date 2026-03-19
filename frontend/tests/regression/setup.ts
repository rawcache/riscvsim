import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const originalFetch = globalThis.fetch?.bind(globalThis);

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = resolveUrl(input);

  if (url?.protocol === "file:") {
    const bytes = await readFile(fileURLToPath(url));
    const headers = new Headers();
    if (extname(url.pathname) === ".wasm") {
      headers.set("Content-Type", "application/wasm");
    }
    return new Response(bytes, {
      status: 200,
      statusText: "OK",
      headers,
    });
  }

  if (!originalFetch) {
    throw new Error(`No fetch implementation available for ${String(input)}`);
  }

  return originalFetch(input, init);
};

function resolveUrl(input: RequestInfo | URL): URL | null {
  if (input instanceof URL) {
    return input;
  }

  if (typeof input === "string") {
    try {
      return new URL(input);
    } catch {
      return null;
    }
  }

  return new URL(input.url);
}

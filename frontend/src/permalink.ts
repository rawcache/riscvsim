const HASH_PREFIX = "#p=";
const URL_SAFE_PATTERN = /^[A-Za-z0-9_-]*$/;

type BufferLike = {
  from(input: Uint8Array | string, encoding?: string): { toString(encoding: string): string } | Uint8Array;
};

function getBufferLike(): BufferLike | null {
  const bufferLike = (globalThis as { Buffer?: BufferLike }).Buffer;
  return bufferLike ?? null;
}

function toBase64(bytes: Uint8Array): string {
  const bufferLike = getBufferLike();
  if (bufferLike) {
    return (bufferLike.from(bytes) as { toString(encoding: string): string }).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const bufferLike = getBufferLike();
  if (bufferLike) {
    return Uint8Array.from(bufferLike.from(base64, "base64") as Uint8Array);
  }

  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return fromBase64(normalized + padding);
}

async function maybeCompress(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    return bytes;
  }

  const stream = new Blob([Uint8Array.from(bytes).buffer]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function maybeDecompress(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    return bytes;
  }

  const stream = new Blob([Uint8Array.from(bytes).buffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

export async function encodeProgram(source: string): Promise<string> {
  const encoded = new TextEncoder().encode(source);
  const compressed = await maybeCompress(encoded);
  return toBase64Url(compressed);
}

export async function decodeProgram(encoded: string): Promise<string | null> {
  if (!encoded || !URL_SAFE_PATTERN.test(encoded)) {
    return null;
  }

  try {
    const bytes = fromBase64Url(encoded);
    const decompressed = await maybeDecompress(bytes);
    return new TextDecoder().decode(decompressed);
  } catch {
    return null;
  }
}

export async function pushToUrl(source: string): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }

  const encoded = await encodeProgram(source);
  window.location.hash = encoded ? `p=${encoded}` : "";
}

export async function readFromUrl(): Promise<string | null> {
  if (typeof window === "undefined") {
    return null;
  }

  if (!window.location.hash.startsWith(HASH_PREFIX)) {
    return null;
  }

  return decodeProgram(window.location.hash.slice(HASH_PREFIX.length));
}

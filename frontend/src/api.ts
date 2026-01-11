import type { ApiResponse } from "./types";

function resolveApiBase(): string {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("api");
  if (fromQuery) return fromQuery.replace(/\/$/, "");

  const fromEnv = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
  return fromEnv.replace(/\/$/, "");
}

function nonJsonError(status: number, text: string): string {
  if (status === 404 && text.includes("<!DOCTYPE")) {
    return "Backend endpoint not found (got HTML). Start the backend (see README) or set VITE_API_BASE or ?api= to your backend URL.";
  }
  const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  return `Non-JSON response (${status}): ${snippet}`;
}

export function createApiClient() {
  const base = resolveApiBase();
  const api = (path: string) => `${base}${path}`;

  async function postJson(path: string, payload: unknown): Promise<ApiResponse> {
    const res = await fetch(api(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    const contentType = res.headers.get("Content-Type") ?? "";

    let data: ApiResponse;
    if (contentType.includes("application/json")) {
      try {
        data = JSON.parse(text) as ApiResponse;
      } catch {
        throw new Error(`Non-JSON response (${res.status}): ${text}`);
      }
    } else {
      throw new Error(nonJsonError(res.status, text));
    }

    if (!res.ok) {
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    return data;
  }

  return { postJson };
}

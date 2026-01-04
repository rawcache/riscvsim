import type { ApiResponse } from "./types";

async function postJson(path: string, body: any): Promise<ApiResponse> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = (await res.json()) as ApiResponse;
  if (!res.ok) return data;
  return data;
}

export async function createSession(source: string): Promise<ApiResponse> {
  return postJson("/simulate", { code: source });
}

export async function assemble(sessionId: string, source: string): Promise<ApiResponse> {
  return postJson("/api/assemble", { sessionId, source });
}

export async function reset(sessionId: string): Promise<ApiResponse> {
  return postJson("/api/reset", { sessionId });
}

export async function step(sessionId: string): Promise<ApiResponse> {
  return postJson("/api/step", { sessionId });
}

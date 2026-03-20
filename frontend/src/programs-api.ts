import { getSession } from "./auth";

const DEFAULT_API_ENDPOINT = "https://hsyyxozom8.execute-api.us-east-1.amazonaws.com";
const API_ENDPOINT = (import.meta.env.VITE_API_ENDPOINT ?? DEFAULT_API_ENDPOINT).replace(/\/+$/g, "");

export interface SavedProgram {
  programId: string;
  name: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProgramsResponse {
  programs: SavedProgram[];
  tier: "pro" | "free";
  count: number;
}

export class AuthRequiredError extends Error {
  constructor(message = "Sign in required.") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export class LimitReachedError extends Error {
  limit: number;

  constructor(message: string, limit: number) {
    super(message);
    this.name = "LimitReachedError";
    this.limit = limit;
  }
}

export class NotFoundError extends Error {
  constructor(message = "Program not found.") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type ErrorPayload = {
  error?: string;
  limit?: number;
  message?: string;
};

async function authorizedRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const session = await getSession();
  if (!session) {
    throw new AuthRequiredError();
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.idToken}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  try {
    return await fetch(`${API_ENDPOINT}${path}`, {
      ...init,
      headers,
    });
  } catch {
    throw new ApiError("Unable to reach the saved programs service.", 0);
  }
}

async function parseError(response: Response): Promise<never> {
  let payload: ErrorPayload = {};
  try {
    payload = (await response.json()) as ErrorPayload;
  } catch {
    payload = {};
  }

  if (response.status === 401) {
    throw new AuthRequiredError();
  }

  if (response.status === 403 && payload.error === "LIMIT_REACHED") {
    throw new LimitReachedError(
      payload.message ?? "Free accounts can save up to 3 programs. Upgrade to Pro for unlimited saves.",
      typeof payload.limit === "number" ? payload.limit : 3
    );
  }

  if (response.status === 404) {
    throw new NotFoundError(payload.message ?? "Program not found.");
  }

  throw new ApiError(payload.message ?? "Request failed.", response.status);
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    await parseError(response);
  }

  return (await response.json()) as T;
}

export async function getPrograms(): Promise<ProgramsResponse> {
  const response = await authorizedRequest("/programs");
  return parseJsonResponse<ProgramsResponse>(response);
}

export async function saveProgram(name: string, source: string): Promise<SavedProgram> {
  const response = await authorizedRequest("/programs", {
    method: "POST",
    body: JSON.stringify({
      name: name.trim(),
      source,
    }),
  });

  return parseJsonResponse<SavedProgram>(response);
}

export async function updateProgram(programId: string, name?: string, source?: string): Promise<SavedProgram> {
  const body: { name?: string; source?: string } = {};
  if (name !== undefined) {
    body.name = name.trim();
  }
  if (source !== undefined) {
    body.source = source;
  }

  const response = await authorizedRequest(`/programs/${encodeURIComponent(programId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

  return parseJsonResponse<SavedProgram>(response);
}

export async function deleteProgram(programId: string): Promise<void> {
  const response = await authorizedRequest(`/programs/${encodeURIComponent(programId)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    await parseError(response);
  }
}

import type { Problem, ProblemProgress, ProblemSubmission, ProblemVerdict } from "./problem-data";

const PROBLEM_PROGRESS_STORAGE_KEY = "problems_progress";
const ID_TOKEN_KEY = "studyriscv_id_token";
const DEFAULT_API_ENDPOINT = "https://api.studyriscv.com";
const API_ENDPOINT = (import.meta.env.VITE_API_ENDPOINT as string | undefined)?.trim() || DEFAULT_API_ENDPOINT;

type ProgressEnvelope = {
  problemProgress?: unknown;
};

type ApiSubmissionPayload = Omit<ProblemSubmission, "code"> & {
  code?: string;
};

function decodeJwtUserId(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) {
      return null;
    }

    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    const maybeBuffer = (globalThis as typeof globalThis & {
      Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } };
    }).Buffer;
    const json =
      typeof atob === "function"
        ? atob(padded)
        : maybeBuffer?.from(padded, "base64").toString("utf8") ?? "";
    const payload = JSON.parse(json) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub.trim().length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

function currentProblemUserId(): string | null {
  if (typeof localStorage === "undefined" || typeof sessionStorage === "undefined") {
    return null;
  }

  const token = localStorage.getItem(ID_TOKEN_KEY) ?? sessionStorage.getItem(ID_TOKEN_KEY);
  return token ? decodeJwtUserId(token) : null;
}

function toIsoOrNow(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value : new Date().toISOString();
}

function toVerdict(value: unknown): ProblemVerdict {
  switch (value) {
    case "Accepted":
    case "Wrong Answer":
    case "Runtime Error":
    case "Time Limit Exceeded":
    case "Assembly Error":
      return value;
    default:
      return "Wrong Answer";
  }
}

function normalizeSubmission(input: unknown): ProblemSubmission | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const raw = input as Partial<ProblemSubmission>;
  if (typeof raw.problemId !== "string") {
    return null;
  }

  return {
    id:
      typeof raw.id === "string" && raw.id.trim().length > 0
        ? raw.id
        : `${raw.problemId}-${toIsoOrNow(raw.submittedAt)}`,
    problemId: raw.problemId,
    code: typeof raw.code === "string" ? raw.code : "",
    verdict: toVerdict(raw.verdict),
    passedCases: typeof raw.passedCases === "number" && Number.isFinite(raw.passedCases) ? Math.max(0, raw.passedCases) : 0,
    totalCases: typeof raw.totalCases === "number" && Number.isFinite(raw.totalCases) ? Math.max(0, raw.totalCases) : 0,
    stepsTaken: typeof raw.stepsTaken === "number" && Number.isFinite(raw.stepsTaken) ? Math.max(0, raw.stepsTaken) : 0,
    submittedAt: toIsoOrNow(raw.submittedAt),
    failedCaseId: typeof raw.failedCaseId === "string" ? raw.failedCaseId : undefined,
    errorMessage: typeof raw.errorMessage === "string" ? raw.errorMessage : undefined,
    elapsedMs: typeof raw.elapsedMs === "number" && Number.isFinite(raw.elapsedMs) ? Math.max(0, raw.elapsedMs) : undefined,
  };
}

function dedupeSubmissions(submissions: ProblemSubmission[]): ProblemSubmission[] {
  const seen = new Set<string>();
  const deduped: ProblemSubmission[] = [];

  for (const submission of submissions) {
    const key = submission.id || [
      submission.problemId,
      submission.submittedAt,
      submission.verdict,
      submission.passedCases,
      submission.totalCases,
      submission.stepsTaken,
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(submission);
  }

  deduped.sort((left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt));
  return deduped;
}

function normalizeStatus(value: unknown): "solved" | "attempted" | "unsolved" {
  switch (value) {
    case "solved":
    case "attempted":
    case "unsolved":
      return value;
    default:
      return "unsolved";
  }
}

function deriveStatus(submissions: ProblemSubmission[], fallback: "solved" | "attempted" | "unsolved"): "solved" | "attempted" | "unsolved" {
  if (submissions.some((submission) => submission.verdict === "Accepted")) {
    return "solved";
  }
  if (submissions.length > 0) {
    return "attempted";
  }
  return fallback;
}

function stripProgressForApi(progress: ProblemProgress): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(progress).map(([problemId, entry]) => [
      problemId,
      {
        status: entry.status,
        submissions: entry.submissions.map<ApiSubmissionPayload>((submission) => ({
          id: submission.id,
          problemId: submission.problemId,
          verdict: submission.verdict,
          passedCases: submission.passedCases,
          totalCases: submission.totalCases,
          stepsTaken: submission.stepsTaken,
          submittedAt: submission.submittedAt,
          failedCaseId: submission.failedCaseId,
          errorMessage: submission.errorMessage,
          elapsedMs: submission.elapsedMs,
        })),
        lastSavedAt: entry.lastSavedAt,
        hintsRevealed: entry.hintsRevealed ?? 0,
      },
    ])
  );
}

export function emptyProblemProgress(): ProblemProgress {
  return {};
}

export function normalizeProblemProgress(input: unknown): ProblemProgress {
  if (!input || typeof input !== "object") {
    return emptyProblemProgress();
  }

  const normalized: ProblemProgress = {};

  for (const [problemId, value] of Object.entries(input as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const raw = value as {
      status?: unknown;
      submissions?: unknown;
      lastCode?: unknown;
      lastSavedAt?: unknown;
      hintsRevealed?: unknown;
    };

    const submissions = Array.isArray(raw.submissions)
      ? dedupeSubmissions(raw.submissions.map(normalizeSubmission).filter((submission): submission is ProblemSubmission => submission !== null))
      : [];

    normalized[problemId] = {
      status: deriveStatus(submissions, normalizeStatus(raw.status)),
      submissions,
      lastCode: typeof raw.lastCode === "string" ? raw.lastCode : undefined,
      lastSavedAt: typeof raw.lastSavedAt === "string" && raw.lastSavedAt.trim().length > 0 ? raw.lastSavedAt : undefined,
      hintsRevealed:
        typeof raw.hintsRevealed === "number" && Number.isFinite(raw.hintsRevealed)
          ? Math.max(0, raw.hintsRevealed)
          : 0,
    };
  }

  return normalized;
}

function readStoredProgress(storageKey: string): ProblemProgress {
  if (typeof localStorage === "undefined") {
    return emptyProblemProgress();
  }

  const stored = localStorage.getItem(storageKey);
  if (!stored) {
    return emptyProblemProgress();
  }

  try {
    return normalizeProblemProgress(JSON.parse(stored) as unknown);
  } catch {
    return emptyProblemProgress();
  }
}

export function getProblemProgressStorageKey(userId?: string | null): string {
  const scopedUserId = userId === undefined ? currentProblemUserId() : userId;
  return scopedUserId ? `${PROBLEM_PROGRESS_STORAGE_KEY}:${scopedUserId}` : PROBLEM_PROGRESS_STORAGE_KEY;
}

export function loadProblemProgressForUser(userId?: string | null): ProblemProgress {
  return readStoredProgress(getProblemProgressStorageKey(userId));
}

export function loadProblemProgress(): ProblemProgress {
  return loadProblemProgressForUser(undefined);
}

export function saveProblemProgressForUser(progress: ProblemProgress, userId?: string | null): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(getProblemProgressStorageKey(userId), JSON.stringify(normalizeProblemProgress(progress)));
}

export function saveProblemProgress(progress: ProblemProgress): void {
  saveProblemProgressForUser(progress, undefined);
}

export function getProblemCodeStorageKey(problemId: string): string {
  return `problems_code_${problemId}`;
}

export function loadProblemCode(problemId: string): string | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  return localStorage.getItem(getProblemCodeStorageKey(problemId));
}

export function saveProblemCode(problemId: string, code: string): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(getProblemCodeStorageKey(problemId), code);
}

function laterIso(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function mergeProblemProgress(localProgress: ProblemProgress, apiProgress: ProblemProgress): ProblemProgress {
  const merged: ProblemProgress = {};
  const problemIds = new Set([...Object.keys(localProgress), ...Object.keys(apiProgress)]);

  for (const problemId of problemIds) {
    const localEntry = localProgress[problemId];
    const apiEntry = apiProgress[problemId];

    if (!localEntry && apiEntry) {
      merged[problemId] = apiEntry;
      continue;
    }
    if (!apiEntry && localEntry) {
      merged[problemId] = localEntry;
      continue;
    }
    if (!localEntry || !apiEntry) {
      continue;
    }

    const submissions = dedupeSubmissions([...localEntry.submissions, ...apiEntry.submissions]);
    const status =
      localEntry.status === "solved" || apiEntry.status === "solved" || submissions.some((submission) => submission.verdict === "Accepted")
        ? "solved"
        : localEntry.status === "attempted" || apiEntry.status === "attempted" || submissions.length > 0
          ? "attempted"
          : "unsolved";

    merged[problemId] = {
      status,
      submissions,
      lastCode: localEntry.lastCode ?? apiEntry.lastCode,
      lastSavedAt: laterIso(localEntry.lastSavedAt, apiEntry.lastSavedAt),
      hintsRevealed: Math.max(localEntry.hintsRevealed ?? 0, apiEntry.hintsRevealed ?? 0),
    };
  }

  return merged;
}

export function ensureProblemEntry(
  progress: ProblemProgress,
  problem: Problem
): NonNullable<ProblemProgress[string]> {
  const existing = progress[problem.id];
  if (existing) {
    return existing;
  }

  const created = {
    status: "unsolved" as const,
    submissions: [],
    hintsRevealed: 0,
  };
  progress[problem.id] = created;
  return created;
}

export async function syncProblemProgressToApi(progress: ProblemProgress, idToken: string): Promise<void> {
  if (!idToken || !API_ENDPOINT) {
    return;
  }

  try {
    await fetch(`${API_ENDPOINT}/progress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        problemProgress: stripProgressForApi(normalizeProblemProgress(progress)),
      }),
    });
  } catch {
    // Do not block local persistence on sync failures.
  }
}

export async function loadProblemProgressFromApi(idToken: string): Promise<ProblemProgress | null> {
  if (!idToken || !API_ENDPOINT) {
    return null;
  }

  try {
    const response = await fetch(`${API_ENDPOINT}/progress`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    const raw = (await response.json()) as unknown;
    const payload =
      raw && typeof raw === "object" && "problemProgress" in (raw as ProgressEnvelope)
        ? (raw as ProgressEnvelope).problemProgress
        : raw;
    return normalizeProblemProgress(payload);
  } catch {
    return null;
  }
}

export async function saveProblemSubmissionToApi(submission: ProblemSubmission, idToken: string): Promise<void> {
  if (!idToken || !API_ENDPOINT) {
    return;
  }

  try {
    await fetch(`${API_ENDPOINT}/submissions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        problemId: submission.problemId,
        verdict: submission.verdict,
        stepsTaken: submission.stepsTaken,
        passedCases: submission.passedCases,
        totalCases: submission.totalCases,
        submittedAt: submission.submittedAt,
        failedCaseId: submission.failedCaseId,
        errorMessage: submission.errorMessage,
        elapsedMs: submission.elapsedMs,
      }),
    });
  } catch {
    // Submission sync is best-effort.
  }
}

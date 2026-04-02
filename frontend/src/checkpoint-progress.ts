import type {
  CheckpointProgress,
  CheckpointProblem,
  CheckpointSubmission,
  Verdict,
} from "./checkpoint-data";

const CHECKPOINT_PROGRESS_STORAGE_KEY = "studyriscv_cp_progress";
const ID_TOKEN_KEY = "studyriscv_id_token";
const DEFAULT_API_ENDPOINT = "https://api.studyriscv.com";
const API_ENDPOINT = (import.meta.env.VITE_API_ENDPOINT as string | undefined)?.trim() || DEFAULT_API_ENDPOINT;

type ProgressEnvelope = {
  checkpointProgress?: unknown;
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

function currentCheckpointUserId(): string | null {
  if (typeof localStorage === "undefined" || typeof sessionStorage === "undefined") {
    return null;
  }
  const token = localStorage.getItem(ID_TOKEN_KEY) ?? sessionStorage.getItem(ID_TOKEN_KEY);
  return token ? decodeJwtUserId(token) : null;
}

function toIsoOrNow(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value : new Date().toISOString();
}

function toVerdict(value: unknown): Verdict {
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

function submissionRank(verdict: Verdict): number {
  switch (verdict) {
    case "Accepted":
      return 5;
    case "Wrong Answer":
      return 4;
    case "Time Limit Exceeded":
      return 3;
    case "Runtime Error":
      return 2;
    case "Assembly Error":
      return 1;
  }
}

function compareSubmissionPriority(left: CheckpointSubmission, right: CheckpointSubmission): number {
  const leftRank = submissionRank(left.verdict);
  const rightRank = submissionRank(right.verdict);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  if (left.passedCases !== right.passedCases) {
    return left.passedCases - right.passedCases;
  }
  if (left.totalCases !== right.totalCases) {
    return left.totalCases - right.totalCases;
  }
  if (left.executionSteps !== right.executionSteps) {
    return right.executionSteps - left.executionSteps;
  }
  return Date.parse(left.submittedAt) - Date.parse(right.submittedAt);
}

function normalizeSubmission(input: unknown): CheckpointSubmission | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const raw = input as Partial<CheckpointSubmission>;
  if (typeof raw.problemId !== "string" || typeof raw.code !== "string") {
    return null;
  }

  return {
    problemId: raw.problemId,
    code: raw.code,
    verdict: toVerdict(raw.verdict),
    passedCases: typeof raw.passedCases === "number" && Number.isFinite(raw.passedCases) ? Math.max(0, raw.passedCases) : 0,
    totalCases: typeof raw.totalCases === "number" && Number.isFinite(raw.totalCases) ? Math.max(0, raw.totalCases) : 0,
    executionSteps:
      typeof raw.executionSteps === "number" && Number.isFinite(raw.executionSteps)
        ? Math.max(0, raw.executionSteps)
        : 0,
    submittedAt: toIsoOrNow(raw.submittedAt),
    failedCaseId: typeof raw.failedCaseId === "string" ? raw.failedCaseId : undefined,
    errorMessage: typeof raw.errorMessage === "string" ? raw.errorMessage : undefined,
    elapsedSeconds:
      typeof raw.elapsedSeconds === "number" && Number.isFinite(raw.elapsedSeconds)
        ? Math.max(0, raw.elapsedSeconds)
        : undefined,
  };
}

function dedupeSubmissions(submissions: CheckpointSubmission[]): CheckpointSubmission[] {
  const seen = new Set<string>();
  const deduped: CheckpointSubmission[] = [];

  for (const submission of submissions) {
    const key = [
      submission.problemId,
      submission.submittedAt,
      submission.verdict,
      submission.passedCases,
      submission.totalCases,
      submission.executionSteps,
      submission.code,
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

export function emptyCheckpointProgress(): CheckpointProgress {
  return {};
}

export function normalizeCheckpointProgress(input: unknown): CheckpointProgress {
  if (!input || typeof input !== "object") {
    return emptyCheckpointProgress();
  }

  const normalized: CheckpointProgress = {};

  for (const [problemId, value] of Object.entries(input as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const raw = value as {
      completed?: unknown;
      bestSubmission?: unknown;
      allSubmissions?: unknown;
      hintsRevealed?: unknown;
      startedAt?: unknown;
      completedAt?: unknown;
    };

    const allSubmissions = Array.isArray(raw.allSubmissions)
      ? dedupeSubmissions(raw.allSubmissions.map(normalizeSubmission).filter((submission): submission is CheckpointSubmission => submission !== null))
      : [];
    const bestCandidate = normalizeSubmission(raw.bestSubmission);
    const bestSubmission = bestCandidate
      ? [...allSubmissions, bestCandidate].sort((left, right) => compareSubmissionPriority(right, left))[0]
      : allSubmissions.slice().sort((left, right) => compareSubmissionPriority(right, left))[0];
    const completedFromBest = bestSubmission?.verdict === "Accepted";

    normalized[problemId] = {
      completed: raw.completed === true || completedFromBest,
      bestSubmission,
      allSubmissions,
      hintsRevealed:
        typeof raw.hintsRevealed === "number" && Number.isFinite(raw.hintsRevealed)
          ? Math.max(0, raw.hintsRevealed)
          : 0,
      startedAt: toIsoOrNow(raw.startedAt),
      completedAt:
        typeof raw.completedAt === "string" && raw.completedAt.trim().length > 0
          ? raw.completedAt
          : completedFromBest
            ? bestSubmission?.submittedAt
            : undefined,
    };
  }

  return normalized;
}

function readStoredProgress(storageKey: string): CheckpointProgress {
  if (typeof localStorage === "undefined") {
    return emptyCheckpointProgress();
  }

  const stored = localStorage.getItem(storageKey);
  if (!stored) {
    return emptyCheckpointProgress();
  }

  try {
    return normalizeCheckpointProgress(JSON.parse(stored) as unknown);
  } catch {
    return emptyCheckpointProgress();
  }
}

export function getCheckpointProgressStorageKey(userId?: string | null): string {
  const scopedUserId = userId === undefined ? currentCheckpointUserId() : userId;
  return scopedUserId ? `${CHECKPOINT_PROGRESS_STORAGE_KEY}:${scopedUserId}` : CHECKPOINT_PROGRESS_STORAGE_KEY;
}

export function loadCheckpointProgressForUser(userId?: string | null): CheckpointProgress {
  return readStoredProgress(getCheckpointProgressStorageKey(userId));
}

export function loadCheckpointProgress(): CheckpointProgress {
  return loadCheckpointProgressForUser(undefined);
}

export function saveCheckpointProgressForUser(progress: CheckpointProgress, userId?: string | null): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(getCheckpointProgressStorageKey(userId), JSON.stringify(normalizeCheckpointProgress(progress)));
}

export function saveCheckpointProgress(progress: CheckpointProgress): void {
  saveCheckpointProgressForUser(progress, undefined);
}

export function getCheckpointCodeStorageKey(problemId: string): string {
  return `studyriscv_cp_code_${problemId}`;
}

export function loadCheckpointCode(problemId: string): string | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  return localStorage.getItem(getCheckpointCodeStorageKey(problemId));
}

export function saveCheckpointCode(problemId: string, code: string): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(getCheckpointCodeStorageKey(problemId), code);
}

function earlierIso(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function laterIso(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function pickBestSubmission(
  left?: CheckpointSubmission,
  right?: CheckpointSubmission
): CheckpointSubmission | undefined {
  if (!left) return right;
  if (!right) return left;
  return compareSubmissionPriority(left, right) >= 0 ? left : right;
}

export function mergeCheckpointProgress(localProgress: CheckpointProgress, apiProgress: CheckpointProgress): CheckpointProgress {
  const merged: CheckpointProgress = {};
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

    const allSubmissions = dedupeSubmissions([...localEntry.allSubmissions, ...apiEntry.allSubmissions]);
    const bestSubmission = [localEntry.bestSubmission, apiEntry.bestSubmission, ...allSubmissions]
      .filter((submission): submission is CheckpointSubmission => submission !== undefined)
      .sort((left, right) => compareSubmissionPriority(right, left))[0];
    const completed = localEntry.completed || apiEntry.completed || bestSubmission?.verdict === "Accepted";

    merged[problemId] = {
      completed,
      bestSubmission: pickBestSubmission(bestSubmission, undefined),
      allSubmissions,
      hintsRevealed: Math.max(localEntry.hintsRevealed, apiEntry.hintsRevealed),
      startedAt: earlierIso(localEntry.startedAt, apiEntry.startedAt) ?? new Date().toISOString(),
      completedAt:
        completed
          ? earlierIso(
              earlierIso(localEntry.completedAt, apiEntry.completedAt),
              bestSubmission?.verdict === "Accepted" ? bestSubmission.submittedAt : undefined
            )
          : laterIso(localEntry.completedAt, apiEntry.completedAt),
    };
  }

  return merged;
}

export function ensureCheckpointEntry(
  progress: CheckpointProgress,
  problem: CheckpointProblem
): NonNullable<CheckpointProgress[string]> {
  const existing = progress[problem.id];
  if (existing) {
    return existing;
  }

  const created = {
    completed: false,
    allSubmissions: [],
    hintsRevealed: 0,
    startedAt: new Date().toISOString(),
  };
  progress[problem.id] = created;
  return created;
}

export async function syncCheckpointProgressToApi(progress: CheckpointProgress, idToken: string): Promise<void> {
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
        checkpointProgress: normalizeCheckpointProgress(progress),
      }),
    });
  } catch {
    // Do not block checkpoint interactions on sync failures.
  }
}

export async function loadCheckpointProgressFromApi(idToken: string): Promise<CheckpointProgress | null> {
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
      raw && typeof raw === "object" && "checkpointProgress" in (raw as ProgressEnvelope)
        ? (raw as ProgressEnvelope).checkpointProgress
        : raw;
    return normalizeCheckpointProgress(payload);
  } catch {
    return null;
  }
}

import "./auth-page";
import { getSession, type UserSession } from "./auth";
import { show as showAuthModal } from "./auth-page";
import { initFooter } from "./footer";
import { escapeHtml } from "./format";
import { getEditorCode as readEditorCode, initRiscvEditor } from "./monaco-riscv";
import { initNav } from "./nav";
import type {
  Difficulty,
  Problem,
  ProblemProgress,
  ProblemSubmission,
  ProblemTag,
  ProblemTestCase,
  ProblemVerdict,
} from "./problem-data";
import { getProblem, getProblems } from "./problem-data";
import {
  ensureProblemEntry,
  loadProblemCode,
  loadProblemProgressForUser,
  loadProblemProgressFromApi,
  mergeProblemProgress,
  saveProblemCode,
  saveProblemProgressForUser,
  saveProblemSubmissionToApi,
  syncProblemProgressToApi,
} from "./problem-progress";
import { formatProblemDiffValue, runAll, runTestCase, type RunResult, type RunSummary } from "./problem-runner";
import { WasmRuntime } from "./wasm-runtime";

export { escapeHtml };

type LeftTab = "description" | "result" | "hints" | "editorial" | "submissions";
type BottomTab = "testcase" | "result";
type SubmissionTone = "accepted" | "wrong" | "error" | "tle";
type ResultStatus = "accepted" | "wrong_answer" | "assembly_error" | "runtime_error" | "tle";
type CustomCaseField =
  | "label"
  | "description"
  | "initialRegistersText"
  | "initialMemoryText"
  | "expectedRegistersText"
  | "expectedMemoryText"
  | "stepLimitText";

type MonacoEditorInstance = {
  getValue(): string;
  setValue(value: string): void;
  updateOptions(options: Record<string, unknown>): void;
  focus(): void;
  dispose(): void;
  onDidChangeModelContent(listener: () => void): { dispose(): void };
};

type EditorWindow = Window &
  typeof globalThis & {
    __editorInstance?: MonacoEditorInstance | null;
    __editorFallback?: HTMLTextAreaElement | null;
  };

type FilterState = {
  search: string;
  difficulty: "" | Difficulty;
  status: "" | "solved" | "attempted" | "unsolved";
  tag: "" | ProblemTag;
};

type CustomCaseDraft = {
  id: string;
  label: string;
  description: string;
  initialRegistersText: string;
  initialMemoryText: string;
  expectedRegistersText: string;
  expectedMemoryText: string;
  stepLimitText: string;
  createdAt: string;
};

type WorkspaceCase = {
  id: string;
  label: string;
  description: string;
  custom: boolean;
  readonly: boolean;
  draft?: CustomCaseDraft;
  testCase?: ProblemTestCase;
};

type WorkspaceCaseResult = {
  caseId: string;
  label: string;
  custom: boolean;
  visible: boolean;
  sourceCase: ProblemTestCase;
  result: RunResult;
};

type WorkspaceResultBase = {
  kind: "run" | "submit";
  verdict: ProblemVerdict;
  status: ResultStatus;
  durationMs: number;
  passed: number;
  total: number;
  totalSteps: number;
  caseResults: WorkspaceCaseResult[];
  createdAt: string;
  logs: string[];
  codeSnapshot: string;
  selectedCaseId: string | null;
  memoryBytes?: number;
};

type WorkspaceRunResultState = WorkspaceResultBase & {
  kind: "run";
};

type WorkspaceSubmitResultState = WorkspaceResultBase & {
  kind: "submit";
  id: string;
};

type ProblemViewState = {
  currentProblemId: string;
  currentCode: string;
  activeLeftTab: LeftTab;
  activeBottomTab: BottomTab;
  activeCaseId: string;
  customCases: CustomCaseDraft[];
  lastRunResult: WorkspaceRunResultState | null;
  lastSubmitResult: WorkspaceSubmitResultState | null;
  latestExecution: "run" | "submit" | null;
  submissions: WorkspaceSubmitResultState[];
  selectedSubmissionId: string | null;
  testcaseError: string | null;
  resultNotice: string | null;
};

type ParseRegistersResult = {
  value: Partial<Record<string, number>>;
  errors: string[];
};

type ParseMemoryResult = {
  value: Array<{ address: number; value: number; size: "byte" | "half" | "word" }>;
  errors: string[];
};

type CustomCaseParseResult = {
  testCase: ProblemTestCase | null;
  errors: string[];
};

export const MONACO_THEME_NAME = "riscv-dark";
export const MONACO_LIGHT_THEME_NAME = "studyriscv-light";
export const RISCV_LANGUAGE_ID = "riscv";

export const RISCV_KEYWORDS = [
  "add", "sub", "sll", "slt", "sltu", "xor", "srl", "sra",
  "or", "and",
  "mul", "mulh", "mulhsu", "mulhu", "div", "divu",
  "rem", "remu",
  "addi", "slti", "sltiu", "xori", "ori", "andi",
  "slli", "srli", "srai",
  "lb", "lh", "lw", "lbu", "lhu",
  "sb", "sh", "sw",
  "beq", "bne", "blt", "bge", "bltu", "bgeu",
  "jalr", "jal",
  "lui", "auipc",
  "ecall", "ebreak", "fence",
  "li", "la", "mv", "nop", "ret", "call", "tail",
  "j", "jr", "not", "neg", "seqz", "snez", "sltz", "sgtz",
  "beqz", "bnez", "blez", "bgez", "bltz", "bgtz",
  "bgt", "ble", "bgtu", "bleu",
];

export const RISCV_REGISTERS = [
  "x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7",
  "x8", "x9", "x10", "x11", "x12", "x13", "x14", "x15",
  "x16", "x17", "x18", "x19", "x20", "x21", "x22", "x23",
  "x24", "x25", "x26", "x27", "x28", "x29", "x30", "x31",
  "zero", "ra", "sp", "gp", "tp",
  "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7",
  "t0", "t1", "t2", "t3", "t4", "t5", "t6",
  "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11",
  "fp", "pc",
];

const RISCV_DIRECTIVES = [
  ".text", ".data", ".word", ".byte", ".half",
  ".ascii", ".asciz", ".space", ".align", ".globl",
  ".section", ".string",
];

const KEYWORD_SET = new Set(RISCV_KEYWORDS);
const REGISTER_SET = new Set(RISCV_REGISTERS);
const DIRECTIVE_SET = new Set(RISCV_DIRECTIVES);

const DEFAULT_FILTERS: FilterState = {
  search: "",
  difficulty: "",
  status: "",
  tag: "",
};

const FILTER_STORAGE_KEY = "problems_filters";
const LIST_SCROLL_STORAGE_KEY = "problems_list_scroll";
const PANEL_SPLIT_STORAGE_KEY = "problems_panel_split";
const CONSOLE_HEIGHT_STORAGE_KEY = "problems_console_height";
const FULLSCREEN_STORAGE_KEY = "problems_fullscreen";
const AUTO_SAVE_DELAY_MS = 1500;
const DEFAULT_LEFT_RATIO = 0.4;
const DEFAULT_CONSOLE_HEIGHT = 200;
const MIN_LEFT_WIDTH = 280;
const MAX_LEFT_RATIO = 0.65;
const MIN_EDITOR_HEIGHT = 120;
const MIN_CONSOLE_HEIGHT = 80;
const CUSTOM_CASES_PREFIX = "problems_custom_cases_";
const SUBMISSION_DETAILS_PREFIX = "problems_submission_details_";

export function buildRiscvLanguageDefinition(): Record<string, unknown> {
  return {
    defaultToken: "",
    tokenPostfix: ".riscv",
    keywords: RISCV_KEYWORDS,
    registers: RISCV_REGISTERS,
    directives: RISCV_DIRECTIVES,
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/[a-zA-Z_][a-zA-Z0-9_]*(?=\s*:)/, "type.identifier"],
        [/\.[a-zA-Z][a-zA-Z0-9_]*/, "keyword.directive"],
        [/0[xX][0-9a-fA-F]+/, "number.hex"],
        [/-?[0-9]+/, "number"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/[ \t\r\n]+/, "white"],
        [
          /[a-zA-Z_][a-zA-Z0-9_]*/,
          {
            cases: {
              "@registers": "variable.register",
              "@keywords": "keyword",
              "@default": "identifier",
            },
          },
        ],
        [/[(),:]/, "delimiter"],
      ],
    },
  };
}

export function formatHex(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

export function formatTimerValue(totalSeconds: number): string {
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function getCurrentProblemId(
  search = typeof window !== "undefined" ? window.location.search : "",
  pathname = typeof window !== "undefined" ? window.location.pathname : "",
): string | null {
  const queryId = new URLSearchParams(search).get("id");
  if (queryId) {
    return queryId;
  }

  const match = pathname.match(/^\/problems\/([^/?#]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function getCurrentProblem(
  search = typeof window !== "undefined" ? window.location.search : "",
  pathname = typeof window !== "undefined" ? window.location.pathname : "",
): Problem | null {
  return getProblem(getCurrentProblemId(search, pathname)) ?? null;
}

function getCurrentTagFilter(search = typeof window !== "undefined" ? window.location.search : ""): ProblemTag | "" {
  const tag = new URLSearchParams(search).get("tag");
  if (
    tag &&
    [
      "Arithmetic",
      "Control Flow",
      "Memory",
      "Loops",
      "Functions",
      "Bit Manipulation",
      "Arrays",
      "Strings",
      "Stack",
      "Sorting",
    ].includes(tag)
  ) {
    return tag as ProblemTag;
  }
  return "";
}

export function clampPanelSplit(requestedWidth: number, totalWidth: number): number {
  return Math.max(MIN_LEFT_WIDTH, Math.min(totalWidth * MAX_LEFT_RATIO, requestedWidth));
}

function clampEditorHeight(requestedHeight: number, rightHeight: number): number {
  const dividerHeight = 5;
  const maxEditorHeight = rightHeight - MIN_CONSOLE_HEIGHT - dividerHeight;
  return Math.max(MIN_EDITOR_HEIGHT, Math.min(maxEditorHeight, requestedHeight));
}

export function spawnConfetti(parent: ParentNode = document.body): HTMLElement {
  const container = document.createElement("div");
  container.className = "pv-confetti";

  const colors = ["#22c55e", "#eab308", "#f97316", "#ef4444", "#10b981", "#ffffff"];
  for (let index = 0; index < 24; index += 1) {
    const piece = document.createElement("div");
    piece.className = "pv-confetti-piece";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.top = `${Math.random() * 30}%`;
    piece.style.background = colors[index % colors.length] ?? colors[0];
    piece.style.setProperty("--d", `${1 + Math.random() * 1.2}s`);
    piece.style.setProperty("--delay", `${Math.random() * 600}ms`);
    container.appendChild(piece);
  }

  parent.appendChild(container);
  window.setTimeout(() => container.remove(), 2500);
  return container;
}

export function renderVerdictBanner(
  banner: HTMLElement,
  content: HTMLElement,
  summary: RunSummary
): void {
  banner.className = "pv-verdict";

  if (summary.verdict === "Accepted") {
    banner.classList.add("pv-verdict--accepted");
    content.innerHTML = `
      <div class="pv-verdict__title">✓ Accepted</div>
      <div class="pv-verdict__sub">Passed ${summary.passedCount}/${summary.totalCount} test cases</div>
      <div class="pv-verdict__detail">${summary.totalSteps} total steps · ${Math.round(summary.totalTimeMs)}ms</div>
    `;
    if (typeof document !== "undefined" && document.body) {
      spawnConfetti(document.body);
    }
  } else if (summary.verdict === "Wrong Answer") {
    banner.classList.add("pv-verdict--wrong");
    const diff = summary.firstFailedResult?.diff[0];
    content.innerHTML = `
      <div class="pv-verdict__title">✗ Wrong Answer</div>
      <div class="pv-verdict__sub">Failed on ${escapeHtml(summary.firstFailedResult?.label ?? "a test case")} · ${summary.passedCount}/${summary.totalCount} passed</div>
      ${diff
        ? `<div class="pv-verdict__detail">Expected ${escapeHtml(diff.key)} = ${formatProblemDiffValue(diff.expected)} · Got ${formatProblemDiffValue(diff.actual)}</div>`
        : ""}
    `;
  } else if (summary.verdict === "Assembly Error") {
    banner.classList.add("pv-verdict--error");
    content.innerHTML = `
      <div class="pv-verdict__title">✗ Assembly Error</div>
      <div class="pv-verdict__sub">${escapeHtml(summary.firstFailedResult?.errorMessage ?? "The assembler rejected the source.")}</div>
    `;
  } else if (summary.verdict === "Time Limit Exceeded") {
    banner.classList.add("pv-verdict--tle");
    content.innerHTML = `
      <div class="pv-verdict__title">⏱ Time Limit Exceeded</div>
      <div class="pv-verdict__sub">Exceeded the step limit · Try a more efficient approach.</div>
    `;
  } else {
    banner.classList.add("pv-verdict--error");
    content.innerHTML = `
      <div class="pv-verdict__title">⚠ Runtime Error</div>
      <div class="pv-verdict__sub">${escapeHtml(summary.firstFailedResult?.errorMessage ?? "Execution failed.")}</div>
    `;
  }

  banner.hidden = false;
}

export function bindVerdictClose(closeButton: HTMLButtonElement, banner: HTMLElement): void {
  closeButton.addEventListener("click", () => {
    banner.hidden = true;
  });
}

function safeLocalStorageGet(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
    }
  } catch {
    // Ignore storage failures.
  }
}

function safeLocalStorageRemove(key: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage failures.
  }
}

function safeSessionStorageGet(key: string): string | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSessionStorageSet(key: string, value: string): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(key, value);
    }
  } catch {
    // Ignore storage failures.
  }
}

function readStoredNumber(raw: string | null, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function formatRelativeDate(iso: string): string {
  const submittedAt = Date.parse(iso);
  if (!Number.isFinite(submittedAt)) {
    return iso;
  }

  const deltaMs = Date.now() - submittedAt;
  const deltaMinutes = Math.floor(deltaMs / 60000);
  if (deltaMinutes < 1) {
    return "just now";
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 7) {
    return `${deltaDays}d ago`;
  }

  return new Date(submittedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatSignedValue(value: number, size: "byte" | "half" | "word" = "word"): string {
  const normalized = value >>> 0;
  const masked = size === "byte" ? normalized & 0xff : size === "half" ? normalized & 0xffff : normalized;
  const width = size === "byte" ? 2 : size === "half" ? 4 : 8;
  return `0x${masked.toString(16).padStart(width, "0")} (${masked >> 0})`;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function loadFilters(): FilterState {
  const raw = safeSessionStorageGet(FILTER_STORAGE_KEY);
  if (!raw) {
    return { ...DEFAULT_FILTERS };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<FilterState>;
    return {
      search: typeof parsed.search === "string" ? parsed.search : "",
      difficulty:
        parsed.difficulty === "Easy" || parsed.difficulty === "Medium" || parsed.difficulty === "Hard"
          ? parsed.difficulty
          : "",
      status:
        parsed.status === "solved" || parsed.status === "attempted" || parsed.status === "unsolved"
          ? parsed.status
          : "",
      tag:
        parsed.tag &&
        [
          "Arithmetic",
          "Control Flow",
          "Memory",
          "Loops",
          "Functions",
          "Bit Manipulation",
          "Arrays",
          "Strings",
          "Stack",
          "Sorting",
        ].includes(parsed.tag)
          ? (parsed.tag as ProblemTag)
          : "",
    };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

function saveFilters(filters: FilterState): void {
  safeSessionStorageSet(FILTER_STORAGE_KEY, JSON.stringify(filters));
}

function customCasesStorageKey(problemId: string): string {
  return `${CUSTOM_CASES_PREFIX}${problemId}`;
}

function submissionDetailsStorageKey(problemId: string): string {
  return `${SUBMISSION_DETAILS_PREFIX}${problemId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function verdictToStatus(verdict: ProblemVerdict): ResultStatus {
  switch (verdict) {
    case "Accepted":
      return "accepted";
    case "Wrong Answer":
      return "wrong_answer";
    case "Assembly Error":
      return "assembly_error";
    case "Time Limit Exceeded":
      return "tle";
    default:
      return "runtime_error";
  }
}

function resultStatusLabel(status: ResultStatus): string {
  switch (status) {
    case "accepted":
      return "Accepted";
    case "wrong_answer":
      return "Wrong Answer";
    case "assembly_error":
      return "Compile Error";
    case "runtime_error":
      return "Runtime Error";
    case "tle":
      return "Time Limit Exceeded";
  }
}

function resultToneFromStatus(status: ResultStatus): SubmissionTone {
  switch (status) {
    case "accepted":
      return "accepted";
    case "wrong_answer":
      return "wrong";
    case "tle":
      return "tle";
    default:
      return "error";
  }
}

function summarizeResults(results: RunResult[]): RunSummary {
  const firstFailedResult = results.find((result) => !result.passed);
  return {
    verdict: firstFailedResult?.verdict ?? "Accepted",
    passedCount: results.filter((result) => result.passed).length,
    totalCount: results.length,
    results,
    firstFailedResult,
    totalSteps: results.reduce((sum, result) => sum + result.stepsTaken, 0),
    totalTimeMs: results.reduce((sum, result) => sum + result.executionTimeMs, 0),
  };
}

function parseNumericLiteral(raw: string): number | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }

  if (/^-?0x[0-9a-f]+$/iu.test(value)) {
    const negative = value.startsWith("-");
    const normalized = value.replace(/^-?0x/iu, "");
    const parsed = Number.parseInt(normalized, 16);
    return negative ? -parsed : parsed;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return null;
  }
  return parsed;
}

function parseRegistersText(text: string): ParseRegistersResult {
  const value: Partial<Record<string, number>> = {};
  const errors: string[] = [];
  const lines = text.split(/\r?\n/u);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const separator = trimmed.includes("=") ? "=" : trimmed.includes(":") ? ":" : null;
    if (!separator) {
      errors.push(`Register line ${index + 1} must use "name = value".`);
      return;
    }

    const [rawRegister, rawValue] = trimmed.split(separator, 2);
    const registerName = rawRegister?.trim() ?? "";
    const parsedValue = parseNumericLiteral(rawValue ?? "");
    if (!registerName || !/^[A-Za-z][A-Za-z0-9]*$/u.test(registerName)) {
      errors.push(`Register line ${index + 1} has an invalid register name.`);
      return;
    }
    if (parsedValue === null) {
      errors.push(`Register line ${index + 1} has an invalid numeric value.`);
      return;
    }
    value[registerName] = parsedValue;
  });

  return { value, errors };
}

function parseMemoryText(text: string): ParseMemoryResult {
  const value: Array<{ address: number; value: number; size: "byte" | "half" | "word" }> = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/u);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    if (!trimmed.includes("=")) {
      errors.push(`Memory line ${index + 1} must use "address[:size] = value".`);
      return;
    }

    const [lhs, rhs] = trimmed.split("=", 2);
    const [rawAddress, rawSize] = lhs.trim().split(":", 2);
    const address = parseNumericLiteral(rawAddress ?? "");
    const parsedValue = parseNumericLiteral(rhs ?? "");
    const size = rawSize?.trim() ? rawSize.trim().toLowerCase() : "word";
    if (address === null) {
      errors.push(`Memory line ${index + 1} has an invalid address.`);
      return;
    }
    if (parsedValue === null) {
      errors.push(`Memory line ${index + 1} has an invalid value.`);
      return;
    }
    if (size !== "byte" && size !== "half" && size !== "word") {
      errors.push(`Memory line ${index + 1} must use byte, half, or word.`);
      return;
    }
    value.push({ address, value: parsedValue, size });
  });

  return { value, errors };
}

function serializeRegisters(registers: Partial<Record<string, number>>): string {
  return Object.entries(registers)
    .map(([registerName, value]) => `${registerName} = ${(value ?? 0) >> 0}`)
    .join("\n");
}

function serializeMemory(entries: NonNullable<ProblemTestCase["initialMemory"]> | NonNullable<ProblemTestCase["expectedMemory"]>): string {
  return entries
    .map((entry) => `${formatHex(entry.address)}:${entry.size ?? "word"} = ${(entry.value ?? 0) >> 0}`)
    .join("\n");
}

function buildCustomCaseDraft(problem: Problem, index: number, seed?: ProblemTestCase | CustomCaseDraft): CustomCaseDraft {
  if (seed && "initialRegistersText" in seed) {
    return {
      ...seed,
      id: `custom-${problem.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label: `${seed.label} Copy`,
      createdAt: nowIso(),
    };
  }

  const sourceCase = seed && "initialRegisters" in seed ? seed : problem.testCases.find((candidate) => candidate.visible) ?? problem.testCases[0];
  return {
    id: `custom-${problem.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: sourceCase ? `Custom ${index + 1}` : `Custom ${index + 1}`,
    description: sourceCase?.description ?? "Custom testcase",
    initialRegistersText: sourceCase ? serializeRegisters(sourceCase.initialRegisters) : "",
    initialMemoryText: sourceCase?.initialMemory?.length ? serializeMemory(sourceCase.initialMemory) : "",
    expectedRegistersText: sourceCase ? serializeRegisters(sourceCase.expectedRegisters) : "",
    expectedMemoryText: sourceCase?.expectedMemory?.length ? serializeMemory(sourceCase.expectedMemory) : "",
    stepLimitText: sourceCase?.stepLimit ? String(sourceCase.stepLimit) : "",
    createdAt: nowIso(),
  };
}

function parseCustomCaseDraft(draft: CustomCaseDraft): CustomCaseParseResult {
  const registers = parseRegistersText(draft.initialRegistersText);
  const memory = parseMemoryText(draft.initialMemoryText);
  const expectedRegisters = parseRegistersText(draft.expectedRegistersText);
  const expectedMemory = parseMemoryText(draft.expectedMemoryText);
  const errors = [...registers.errors, ...memory.errors, ...expectedRegisters.errors, ...expectedMemory.errors];

  let stepLimit: number | undefined;
  if (draft.stepLimitText.trim()) {
    const parsedStepLimit = parseNumericLiteral(draft.stepLimitText);
    if (parsedStepLimit === null || parsedStepLimit <= 0) {
      errors.push("Step limit must be a positive integer.");
    } else {
      stepLimit = parsedStepLimit;
    }
  }

  if (errors.length > 0) {
    return { testCase: null, errors };
  }

  return {
    testCase: {
      id: draft.id,
      label: draft.label.trim() || "Custom Case",
      visible: true,
      description: draft.description.trim() || "Custom testcase",
      initialRegisters: registers.value,
      initialMemory: memory.value,
      expectedRegisters: expectedRegisters.value,
      expectedMemory: expectedMemory.value,
      stepLimit,
    },
    errors: [],
  };
}

function loadCustomCases(problem: Problem): CustomCaseDraft[] {
  const raw = safeLocalStorageGet(customCasesStorageKey(problem.id));
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown[];
    return parsed
      .map((item, index) => {
        if (!item || typeof item !== "object") {
          return buildCustomCaseDraft(problem, index);
        }
        const draft = item as Partial<CustomCaseDraft>;
        return {
          id: typeof draft.id === "string" ? draft.id : `custom-${problem.id}-${index}`,
          label: typeof draft.label === "string" ? draft.label : `Custom ${index + 1}`,
          description: typeof draft.description === "string" ? draft.description : "Custom testcase",
          initialRegistersText: typeof draft.initialRegistersText === "string" ? draft.initialRegistersText : "",
          initialMemoryText: typeof draft.initialMemoryText === "string" ? draft.initialMemoryText : "",
          expectedRegistersText: typeof draft.expectedRegistersText === "string" ? draft.expectedRegistersText : "",
          expectedMemoryText: typeof draft.expectedMemoryText === "string" ? draft.expectedMemoryText : "",
          stepLimitText: typeof draft.stepLimitText === "string" ? draft.stepLimitText : "",
          createdAt: typeof draft.createdAt === "string" ? draft.createdAt : nowIso(),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function saveCustomCases(problemId: string, customCases: CustomCaseDraft[]): void {
  if (customCases.length === 0) {
    safeLocalStorageRemove(customCasesStorageKey(problemId));
    return;
  }
  safeLocalStorageSet(customCasesStorageKey(problemId), JSON.stringify(customCases));
}

function loadSubmissionDetails(problemId: string): WorkspaceSubmitResultState[] {
  const raw = safeLocalStorageGet(submissionDetailsStorageKey(problemId));
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as WorkspaceSubmitResultState[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item) => item && item.kind === "submit" && typeof item.id === "string");
  } catch {
    return [];
  }
}

function saveSubmissionDetails(problemId: string, submissions: WorkspaceSubmitResultState[]): void {
  safeLocalStorageSet(submissionDetailsStorageKey(problemId), JSON.stringify(submissions.slice(0, 20)));
}

function mapCaseResults(
  results: RunResult[],
  casesById: Map<string, ProblemTestCase>,
  customCaseIds: Set<string>
): WorkspaceCaseResult[] {
  return results
    .map((result) => {
      const sourceCase = casesById.get(result.caseId);
      if (!sourceCase) {
        return null;
      }
      return {
        caseId: result.caseId,
        label: result.label,
        custom: customCaseIds.has(result.caseId),
        visible: sourceCase.visible,
        sourceCase,
        result,
      };
    })
    .filter((value): value is WorkspaceCaseResult => Boolean(value));
}

function buildRunState(
  summary: RunSummary,
  caseResults: WorkspaceCaseResult[],
  codeSnapshot: string
): WorkspaceRunResultState {
  return {
    kind: "run",
    verdict: summary.verdict,
    status: verdictToStatus(summary.verdict),
    durationMs: Math.round(summary.totalTimeMs),
    passed: summary.passedCount,
    total: summary.totalCount,
    totalSteps: summary.totalSteps,
    caseResults,
    createdAt: nowIso(),
    logs: [`Ran ${summary.totalCount} debugging case${summary.totalCount === 1 ? "" : "s"}.`],
    codeSnapshot,
    selectedCaseId: summary.firstFailedResult?.caseId ?? caseResults[0]?.caseId ?? null,
  };
}

function buildSubmitState(
  summary: RunSummary,
  caseResults: WorkspaceCaseResult[],
  codeSnapshot: string,
  id: string
): WorkspaceSubmitResultState {
  return {
    id,
    kind: "submit",
    verdict: summary.verdict,
    status: verdictToStatus(summary.verdict),
    durationMs: Math.round(summary.totalTimeMs),
    passed: summary.passedCount,
    total: summary.totalCount,
    totalSteps: summary.totalSteps,
    caseResults,
    createdAt: nowIso(),
    logs: [`Submitted against ${summary.totalCount} official test case${summary.totalCount === 1 ? "" : "s"}.`],
    codeSnapshot,
    selectedCaseId: summary.firstFailedResult?.caseId ?? caseResults[0]?.caseId ?? null,
  };
}

function buildMinimalSubmission(problemId: string, summary: RunSummary, code: string): ProblemSubmission {
  return {
    id: `${problemId}-${Date.now()}`,
    problemId,
    code,
    verdict: summary.verdict,
    passedCases: summary.passedCount,
    totalCases: summary.totalCount,
    stepsTaken: summary.totalSteps,
    submittedAt: nowIso(),
    failedCaseId: summary.firstFailedResult?.caseId,
    errorMessage: summary.firstFailedResult?.errorMessage,
    elapsedMs: Math.round(summary.totalTimeMs),
  };
}

function highlightRiscvLine(line: string): string {
  const commentIndex = line.indexOf("#");
  const comment = commentIndex >= 0 ? line.slice(commentIndex) : "";
  const codePart = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const tokens = codePart.match(/0x[0-9a-fA-F]+|-?[0-9]+|[A-Za-z_.][A-Za-z0-9_.]*|[,:()[\]]|\s+|./g) ?? [];
  const rendered = tokens
    .map((token) => {
      if (/^\s+$/u.test(token)) {
        return token.replace(/ /gu, "&nbsp;").replace(/\t/gu, "&nbsp;&nbsp;");
      }
      if (/^[A-Za-z_][A-Za-z0-9_.]*:$/u.test(token)) {
        return `<span class="pv-code-token pv-code-token--label">${escapeHtml(token)}</span>`;
      }
      if (DIRECTIVE_SET.has(token)) {
        return `<span class="pv-code-token pv-code-token--directive">${escapeHtml(token)}</span>`;
      }
      if (KEYWORD_SET.has(token)) {
        return `<span class="pv-code-token pv-code-token--keyword">${escapeHtml(token)}</span>`;
      }
      if (REGISTER_SET.has(token)) {
        return `<span class="pv-code-token pv-code-token--register">${escapeHtml(token)}</span>`;
      }
      if (/^-?(0x[0-9a-fA-F]+|[0-9]+)$/u.test(token)) {
        return `<span class="pv-code-token pv-code-token--number">${escapeHtml(token)}</span>`;
      }
      if (/^[,:()[\]]$/u.test(token)) {
        return `<span class="pv-code-token pv-code-token--operator">${escapeHtml(token)}</span>`;
      }
      return escapeHtml(token);
    })
    .join("");

  const renderedComment = comment
    ? `<span class="pv-code-token pv-code-token--comment">${escapeHtml(comment)}</span>`
    : "";
  return `${rendered}${renderedComment}`;
}

function renderCodePreview(code: string): string {
  const lines = code.split(/\r?\n/u);
  return `
    <pre class="pv-code-preview__body"><code>${lines
      .map(
        (line, index) => `
          <span class="pv-code-line">
            <span class="pv-code-line__no">${index + 1}</span>
            <span class="pv-code-line__content">${highlightRiscvLine(line)}</span>
          </span>
        `
      )
      .join("")}</code></pre>
  `;
}

function renderResultCaseInput(caseResult: WorkspaceCaseResult): string {
  const source = caseResult.sourceCase;
  const initialRegisters = Object.entries(source.initialRegisters)
    .map(([registerName, value]) => `<div class="pv-detail-row"><span class="pv-detail-key">${escapeHtml(registerName)}</span><span class="pv-detail-value">${formatProblemDiffValue(value ?? 0)}</span></div>`)
    .join("");
  const initialMemory = (source.initialMemory ?? [])
    .map((entry) => `<div class="pv-detail-row"><span class="pv-detail-key">mem[${formatHex(entry.address)}]</span><span class="pv-detail-value">${formatSignedValue(entry.value, entry.size ?? "word")}</span></div>`)
    .join("");
  const expectedRegisters = Object.entries(caseResult.result.expectedRegisters)
    .map(([registerName, value]) => `<div class="pv-detail-row"><span class="pv-detail-key">${escapeHtml(registerName)}</span><span class="pv-detail-value">${formatProblemDiffValue(value ?? 0)}</span></div>`)
    .join("");
  const actualRegisters = Object.entries(caseResult.result.actualRegisters)
    .filter(([registerName]) => registerName in caseResult.result.expectedRegisters)
    .map(([registerName, value]) => `<div class="pv-detail-row"><span class="pv-detail-key">${escapeHtml(registerName)}</span><span class="pv-detail-value">${formatProblemDiffValue(value ?? 0)}</span></div>`)
    .join("");
  const expectedMemory = caseResult.result.expectedMemory
    .map((entry) => `<div class="pv-detail-row"><span class="pv-detail-key">mem[${formatHex(entry.address)}]</span><span class="pv-detail-value">${formatProblemDiffValue(entry.value)}</span></div>`)
    .join("");
  const actualMemory = caseResult.result.actualMemory
    .filter((entry) => caseResult.result.expectedMemory.some((expected) => expected.address === entry.address))
    .map((entry) => `<div class="pv-detail-row"><span class="pv-detail-key">mem[${formatHex(entry.address)}]</span><span class="pv-detail-value">${formatProblemDiffValue(entry.value)}</span></div>`)
    .join("");
  const diffRows = caseResult.result.diff
    .map(
      (diff) => `
        <div class="pv-diff-row">
          <span class="pv-diff-label">${escapeHtml(diff.key)}</span>
          <span class="pv-diff-expected">${escapeHtml(formatProblemDiffValue(diff.expected))}</span>
          <span class="pv-diff-actual">${escapeHtml(formatProblemDiffValue(diff.actual))}</span>
        </div>
      `
    )
    .join("");

  return `
    <div class="pv-result-detail-grid">
      <section class="pv-detail-card">
        <div class="pv-section-head">Input</div>
        ${initialRegisters || initialMemory
          ? `${initialRegisters}${initialMemory}`
          : `<div class="pv-console-empty">No explicit input registers.</div>`}
      </section>
      <section class="pv-detail-card">
        <div class="pv-section-head">Expected</div>
        ${expectedRegisters || expectedMemory
          ? `${expectedRegisters}${expectedMemory}`
          : `<div class="pv-console-empty">No expected output recorded.</div>`}
      </section>
      <section class="pv-detail-card">
        <div class="pv-section-head">Actual</div>
        ${actualRegisters || actualMemory
          ? `${actualRegisters}${actualMemory}`
          : `<div class="pv-console-empty">No actual output captured.</div>`}
      </section>
      <section class="pv-detail-card">
        <div class="pv-section-head">Diff</div>
        ${caseResult.result.errorMessage
          ? `<div class="pv-asm-error"><div class="pv-asm-error__line">${caseResult.result.timedOut ? "Time Limit" : escapeHtml(resultStatusLabel(verdictToStatus(caseResult.result.verdict)))}</div><div class="pv-asm-error__msg">${escapeHtml(caseResult.result.errorMessage)}</div></div>`
          : diffRows || `<div class="pv-all-pass-banner">Expected output matched exactly.</div>`}
      </section>
    </div>
  `;
}

function monacoHost(): EditorWindow {
  return window as EditorWindow;
}

class ProblemsPageApp {
  private readonly problems = getProblems();
  private readonly body = document.body;
  private readonly nav = document.getElementById("site-nav") as HTMLElement;
  private readonly footer = document.getElementById("site-footer") as HTMLElement;
  private readonly listLayout = document.getElementById("pl-layout") as HTMLElement;
  private readonly searchInput = document.getElementById("pl-search") as HTMLInputElement;
  private readonly difficultyFilter = document.getElementById("pl-difficulty") as HTMLSelectElement;
  private readonly statusFilter = document.getElementById("pl-status") as HTMLSelectElement;
  private readonly tagFilter = document.getElementById("pl-tag") as HTMLSelectElement;
  private readonly clearFiltersButton = document.getElementById("pl-clear") as HTMLButtonElement;
  private readonly tableBody = document.getElementById("pl-tbody") as HTMLElement;
  private readonly solvedCount = document.getElementById("pl-solved-count") as HTMLElement;
  private readonly resultCount = document.getElementById("pl-result-count") as HTMLElement;
  private readonly tagStrip = document.getElementById("pl-tagstrip") as HTMLElement | null;
  private readonly sidebarProgress = document.getElementById("pl-sidebar-progress") as HTMLElement | null;
  private readonly progressRingArc = document.getElementById("pl-ring-arc") as SVGCircleElement | null;
  private readonly progressRingSolved = document.getElementById("pl-ring-solved") as HTMLElement | null;
  private readonly easySolvedCount = document.getElementById("pl-easy-solved") as HTMLElement | null;
  private readonly mediumSolvedCount = document.getElementById("pl-medium-solved") as HTMLElement | null;
  private readonly hardSolvedCount = document.getElementById("pl-hard-solved") as HTMLElement | null;
  private readonly pickRandomButton = document.getElementById("pl-pick-random") as HTMLButtonElement | null;
  private readonly pickEasyButton = document.getElementById("pl-pick-easy") as HTMLButtonElement | null;

  private readonly problemLayout = document.getElementById("pv-layout") as HTMLElement;
  private readonly backLink = document.getElementById("pv-back-link") as HTMLAnchorElement;
  private readonly crumbDifficulty = document.getElementById("pv-crumb-difficulty") as HTMLElement;
  private readonly crumbTitle = document.getElementById("pv-crumb-title") as HTMLElement;
  private readonly prevButton = document.getElementById("pv-prev") as HTMLButtonElement;
  private readonly nextButton = document.getElementById("pv-next") as HTMLButtonElement;
  private readonly timer = document.getElementById("pv-timer") as HTMLElement;
  private readonly fullscreenButton = document.getElementById("pv-fullscreen-btn") as HTMLButtonElement;
  private readonly resultTabButton = document.getElementById("pv-result-tab") as HTMLButtonElement | null;

  private readonly main = document.getElementById("pv-main") as HTMLElement;
  private readonly leftPanel = document.getElementById("pv-left") as HTMLElement;
  private readonly leftBody = document.getElementById("pv-left-body") as HTMLElement;
  private readonly hintsBadge = document.getElementById("pv-hints-badge") as HTMLElement;
  private readonly verticalDivider = document.getElementById("pv-divider-v") as HTMLElement;

  private readonly rightPanel = document.getElementById("pv-right") as HTMLElement;
  private readonly editorSection = document.getElementById("pv-editor-section") as HTMLElement;
  private readonly editorHeader = document.getElementById("pv-editor-header") as HTMLElement;
  private readonly monacoContainer = document.getElementById("pv-monaco") as HTMLElement;
  private readonly editorHost = document.getElementById("pv-editor") as HTMLElement;
  private readonly monacoLoading = document.getElementById("pv-monaco-loading") as HTMLElement;
  private readonly langPill = document.getElementById("pv-lang-pill") as HTMLElement | null;
  private readonly resetButton = document.getElementById("pv-reset-btn") as HTMLButtonElement;
  private readonly runButton = document.getElementById("pv-run-btn") as HTMLButtonElement;
  private readonly submitButton = document.getElementById("pv-submit-btn") as HTMLButtonElement;
  private readonly horizontalDivider = document.getElementById("pv-divider-h") as HTMLElement;
  private readonly consoleTabs = document.getElementById("pv-console-tabs") as HTMLElement;
  private readonly consoleBody = document.getElementById("pv-console-body") as HTMLElement;
  private readonly consoleClearButton = document.getElementById("pv-console-clear") as HTMLButtonElement;
  private readonly verdict = document.getElementById("pv-verdict") as HTMLElement;
  private readonly verdictClose = document.getElementById("pv-verdict-close") as HTMLButtonElement;
  private readonly resetConfirm = document.getElementById("pv-reset-confirm") as HTMLElement;
  private readonly resetCancelButton = document.getElementById("pv-reset-cancel") as HTMLButtonElement;
  private readonly resetOkButton = document.getElementById("pv-reset-ok") as HTMLButtonElement;

  private filters: FilterState = loadFilters();
  private session: UserSession | null = null;
  private progress: ProblemProgress = loadProblemProgressForUser(null);
  private currentProblem: Problem | null = null;
  private viewState: ProblemViewState | null = null;
  private openHintIndices = new Set<number>();
  private searchTimer: number | null = null;
  private autosaveTimer: number | null = null;
  private timerInterval: number | null = null;
  private timerSeconds = 0;
  private timerProblemId: string | null = null;
  private editor: MonacoEditorInstance | null = null;
  private editorFallback: HTMLTextAreaElement | null = null;
  private editorChangeSubscription: { dispose(): void } | null = null;
  private runtimePromise: Promise<WasmRuntime> | null = null;
  private running = false;
  private fullscreen = safeLocalStorageGet(FULLSCREEN_STORAGE_KEY) === "1";

  async init(): Promise<void> {
    console.log("Problems loaded:", this.problems.length);

    try {
      initNav({ activePage: "problems" });
    } catch (error) {
      console.error("Problems nav failed to initialize.", error);
    }

    try {
      initFooter();
    } catch (error) {
      console.error("Problems footer failed to initialize.", error);
    }

    bindVerdictClose(this.verdictClose, this.verdict);

    const urlTag = getCurrentTagFilter();
    if (urlTag) {
      this.filters.tag = urlTag;
    }
    this.applyFilterControls();
    this.bindEvents();
    this.renderList();

    const id = getCurrentProblemId();
    const problem = id ? getProblem(id) : null;
    const mode = problem ? "problem" : "list";
    console.log("MODE:", mode);
    console.log("Problem ID:", id);

    if (!id || !problem) {
      this.showListView(false);
      if (id && !problem) {
        window.history.replaceState({}, "", "/problems/");
      }
      void this.refreshSessionState();
      return;
    }

    try {
      await this.showProblemView(problem.id, false);
    } catch (error) {
      console.error("Problem workspace failed to initialize. Falling back to list view.", error);
      this.showListView(false);
    }

    void this.refreshSessionState();
  }

  private get state(): ProblemViewState | null {
    return this.viewState;
  }

  private bindEvents(): void {
    this.searchInput.addEventListener("input", () => {
      if (this.searchTimer) {
        window.clearTimeout(this.searchTimer);
      }
      this.searchTimer = window.setTimeout(() => {
        this.filters.search = this.searchInput.value.trim();
        this.handleFiltersChanged();
      }, 150);
    });

    this.difficultyFilter.addEventListener("change", () => {
      this.filters.difficulty = this.difficultyFilter.value as FilterState["difficulty"];
      this.handleFiltersChanged();
    });

    this.statusFilter.addEventListener("change", () => {
      this.filters.status = this.statusFilter.value as FilterState["status"];
      this.handleFiltersChanged();
    });

    this.tagFilter.addEventListener("change", () => {
      this.filters.tag = this.tagFilter.value as FilterState["tag"];
      this.handleFiltersChanged();
    });

    this.clearFiltersButton.addEventListener("click", () => {
      this.filters = { ...DEFAULT_FILTERS };
      this.applyFilterControls();
      this.handleFiltersChanged();
    });

    this.tagStrip?.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest<HTMLButtonElement>("[data-tag]");
      if (!button) {
        return;
      }
      event.preventDefault();
      const nextTag = (button.dataset.tag ?? "") as FilterState["tag"];
      this.filters.tag = this.filters.tag === nextTag ? "" : nextTag;
      this.handleFiltersChanged();
    });

    this.listLayout.querySelectorAll<HTMLAnchorElement>(".pl-sidebar-link[data-tag]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const nextTag = (link.dataset.tag ?? "") as FilterState["tag"];
        this.filters.tag = nextTag;
        this.handleFiltersChanged();
      });
    });

    this.pickRandomButton?.addEventListener("click", () => {
      this.openRandomProblem();
    });

    this.pickEasyButton?.addEventListener("click", () => {
      this.openRandomProblem("Easy");
    });

    this.tableBody.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const clearButton = target?.closest<HTMLButtonElement>(".pl-empty-clear");
      if (clearButton) {
        event.preventDefault();
        this.clearFiltersButton.click();
        return;
      }

      const row = target?.closest<HTMLTableRowElement>("[data-problem-id]");
      if (!row) {
        return;
      }

      event.preventDefault();
      const problemId = row.dataset.problemId;
      if (!problemId) {
        return;
      }
      this.saveListScroll();
      window.location.href = `/problems/?id=${encodeURIComponent(problemId)}`;
    });

    this.tableBody.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement | null;
      const row = target?.closest<HTMLTableRowElement>("[data-problem-id]");
      if (!row) {
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      const problemId = row.dataset.problemId;
      if (!problemId) {
        return;
      }
      this.saveListScroll();
      window.location.href = `/problems/?id=${encodeURIComponent(problemId)}`;
    });

    this.leftPanel.querySelectorAll<HTMLButtonElement>(".pv-tab").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.dataset.tab as LeftTab | undefined;
        if (!tab || !this.currentProblem || !this.state) {
          return;
        }
        this.state.activeLeftTab = tab;
        this.renderWorkspace();
      });
    });

    this.consoleTabs.querySelectorAll<HTMLButtonElement>(".pv-console-tab").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.dataset.ctab as BottomTab | undefined;
        if (!tab || !this.currentProblem || !this.state) {
          return;
        }
        this.state.activeBottomTab = tab;
        this.renderConsoleBody();
      });
    });

    this.backLink.addEventListener("click", (event) => {
      event.preventDefault();
      window.location.href = "/problems/";
    });

    this.prevButton.addEventListener("click", () => {
      this.navigateRelative(-1);
    });
    this.nextButton.addEventListener("click", () => {
      this.navigateRelative(1);
    });

    this.fullscreenButton.addEventListener("click", () => {
      this.fullscreen = !this.fullscreen;
      safeLocalStorageSet(FULLSCREEN_STORAGE_KEY, this.fullscreen ? "1" : "0");
      this.applyWorkspaceLayout();
    });

    this.resetButton.addEventListener("click", () => {
      this.resetConfirm.hidden = false;
    });
    this.resetCancelButton.addEventListener("click", () => {
      this.resetConfirm.hidden = true;
    });
    this.resetOkButton.addEventListener("click", () => {
      this.restoreStarterCode();
    });

    this.runButton.addEventListener("click", () => {
      void this.executeRun();
    });
    this.submitButton.addEventListener("click", () => {
      void this.executeSubmit();
    });

    this.consoleClearButton.addEventListener("click", () => {
      if (!this.state) {
        return;
      }
      this.state.resultNotice = null;
      this.state.lastRunResult = null;
      this.state.latestExecution = this.state.lastSubmitResult ? "submit" : null;
      this.renderConsoleBody();
    });

    this.leftBody.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const hintButton = target?.closest<HTMLButtonElement>("[data-hint-index]");
      if (hintButton && this.currentProblem) {
        const hintIndex = Number.parseInt(hintButton.dataset.hintIndex ?? "-1", 10);
        if (hintIndex >= 0) {
          void this.toggleHint(hintIndex);
        }
        return;
      }

      const signInButton = target?.closest<HTMLButtonElement>("[data-action='signin']");
      if (signInButton) {
        showAuthModal({ allowClose: true });
        return;
      }

      const submissionRow = target?.closest<HTMLTableRowElement>("[data-submission-id]");
      if (submissionRow && this.state) {
        this.state.selectedSubmissionId = submissionRow.dataset.submissionId ?? null;
        this.state.activeLeftTab = "result";
        this.renderWorkspace();
        return;
      }

      const restoreButton = target?.closest<HTMLButtonElement>("[data-action='restore-submission-code']");
      if (restoreButton && this.state) {
        const submissionId = restoreButton.dataset.submissionId ?? "";
        const submission = this.state.submissions.find((candidate) => candidate.id === submissionId);
        if (submission) {
          this.setEditorCode(submission.codeSnapshot);
          this.state.currentCode = submission.codeSnapshot;
          this.persistCurrentCode();
        }
      }
    });

    this.consoleBody.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (!this.currentProblem || !this.state || !target) {
        return;
      }

      const actionButton = target.closest<HTMLElement>("[data-action]");
      if (actionButton) {
        const action = actionButton.dataset.action;
        if (action === "select-case") {
          this.state.activeCaseId = actionButton.dataset.caseId ?? this.state.activeCaseId;
          this.state.testcaseError = null;
          this.renderConsoleBody();
          return;
        }
        if (action === "add-case") {
          this.addCustomCase();
          return;
        }
        if (action === "duplicate-case") {
          this.duplicateActiveCase();
          return;
        }
        if (action === "delete-case") {
          this.deleteActiveCustomCase();
          return;
        }
        if (action === "reset-case") {
          this.resetActiveCustomCase();
          return;
        }
        if (action === "run-debug") {
          void this.executeRun();
          return;
        }
        if (action === "select-result-case") {
          const caseId = actionButton.dataset.caseId ?? null;
          this.selectResultCase(caseId);
          return;
        }
      }
    });

    this.consoleBody.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) || !this.state) {
        return;
      }

      const customCaseId = target.dataset.customCaseId;
      const field = target.dataset.field as CustomCaseField | undefined;
      if (!customCaseId || !field) {
        return;
      }

      const draft = this.state.customCases.find((candidate) => candidate.id === customCaseId);
      if (!draft) {
        return;
      }

      draft[field] = target.value;
      this.state.testcaseError = null;
      saveCustomCases(this.currentProblem!.id, this.state.customCases);
    });

    window.addEventListener("popstate", () => {
      const problemId = getCurrentProblemId();
      if (problemId && getProblem(problemId)) {
        void this.showProblemView(problemId, false);
      } else {
        this.filters.tag = getCurrentTagFilter();
        this.applyFilterControls();
        this.renderList();
        this.showListView(false);
      }
    });

    window.addEventListener("resize", () => {
      if (this.currentProblem) {
        this.applyWorkspaceLayout();
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (!this.currentProblem || this.timerProblemId !== this.currentProblem.id) {
        return;
      }
      if (document.hidden) {
        this.saveTimer();
      }
    });

    window.addEventListener("studyriscv-auth-changed", () => {
      void this.refreshSessionState();
    });

    document.addEventListener("keydown", (event) => {
      if (this.problemLayout.hidden) {
        return;
      }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.runButton.click();
        return;
      }
      if (modifier && event.shiftKey && event.key === "Enter") {
        event.preventDefault();
        this.submitButton.click();
        return;
      }
      if (event.key === "Escape") {
        this.verdict.hidden = true;
        this.resetConfirm.hidden = true;
      }
    });

    this.verticalDivider.addEventListener("mousedown", (event) => {
      if (this.fullscreen || window.innerWidth < 768 || !this.currentProblem) {
        return;
      }
      event.preventDefault();
      this.startVerticalDrag();
    });

    this.horizontalDivider.addEventListener("mousedown", (event) => {
      if (window.innerWidth < 768 || !this.currentProblem) {
        return;
      }
      event.preventDefault();
      this.startHorizontalDrag();
    });
  }

  private async refreshSessionState(): Promise<void> {
    try {
      this.session = await getSession();
      const guestProgress = loadProblemProgressForUser(null);
      if (this.session) {
        const scoped = loadProblemProgressForUser(this.session.userId);
        const remote = await loadProblemProgressFromApi(this.session.idToken);
        this.progress = mergeProblemProgress(mergeProblemProgress(guestProgress, scoped), remote ?? {});
        saveProblemProgressForUser(this.progress, this.session.userId);
        void syncProblemProgressToApi(this.progress, this.session.idToken);
      } else {
        this.progress = guestProgress;
      }
    } catch (error) {
      console.error("Failed to refresh problem progress.", error);
      this.session = null;
      this.progress = loadProblemProgressForUser(null);
    } finally {
      this.renderList();
      if (this.currentProblem) {
        this.renderWorkspace();
      }
    }
  }

  private getFilteredProblems(): Problem[] {
    return this.problems.filter((problem) => this.matchesFilters(problem));
  }

  private renderList(): void {
    const filteredProblems = this.getFilteredProblems();
    const solvedProblems = this.problems.filter((problem) => this.problemStatus(problem.id) === "solved");
    const easySolved = solvedProblems.filter((problem) => problem.difficulty === "Easy").length;
    const mediumSolved = solvedProblems.filter((problem) => problem.difficulty === "Medium").length;
    const hardSolved = solvedProblems.filter((problem) => problem.difficulty === "Hard").length;
    const solvedCount = solvedProblems.length;
    const circumference = 163;
    const pct = this.problems.length > 0 ? solvedCount / this.problems.length : 0;

    this.solvedCount.textContent = String(solvedCount);
    this.resultCount.textContent = `${filteredProblems.length} problem${filteredProblems.length === 1 ? "" : "s"}`;
    if (this.sidebarProgress) {
      this.sidebarProgress.hidden = !this.session;
    }
    this.progressRingSolved?.replaceChildren(document.createTextNode(String(solvedCount)));
    this.easySolvedCount?.replaceChildren(document.createTextNode(String(easySolved)));
    this.mediumSolvedCount?.replaceChildren(document.createTextNode(String(mediumSolved)));
    this.hardSolvedCount?.replaceChildren(document.createTextNode(String(hardSolved)));
    if (this.progressRingArc) {
      this.progressRingArc.style.strokeDasharray = String(circumference);
      this.progressRingArc.style.strokeDashoffset = String(circumference * (1 - pct));
    }
    this.updateFilterUi();

    if (filteredProblems.length === 0) {
      this.tableBody.innerHTML = `
        <tr class="pl-empty-row">
          <td colspan="6">
            <div class="pl-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                <circle cx="11" cy="11" r="7"></circle>
                <path d="m20 20-3.5-3.5"></path>
                <path d="M5 5 19 19"></path>
              </svg>
              <p>No problems match your filters.</p>
              <button class="pl-empty-clear" type="button">Clear filters</button>
            </div>
            </td>
          </tr>
      `;
      return;
    }

    this.tableBody.innerHTML = filteredProblems
      .map((problem) => {
        const status = this.problemStatus(problem.id);
        return `
          <tr
            class="pl-row"
            data-problem-id="${escapeHtml(problem.id)}"
            tabindex="0"
            role="link"
            aria-label="Open problem ${problem.number}: ${escapeHtml(problem.title)}"
          >
            <td class="pl-td pl-td--status">
              ${status === "solved"
                ? `<span class="pl-status-icon pl-status-solved" aria-label="Solved">✓</span>`
                : status === "attempted"
                  ? `<span class="pl-status-icon pl-status-attempted" aria-label="Attempted">−</span>`
                  : `<span class="pl-status-icon" aria-hidden="true"></span>`}
            </td>
            <td class="pl-td pl-td--num">${problem.number}</td>
            <td class="pl-td pl-td--title">
              <a class="pl-title-link" href="/problems/?id=${encodeURIComponent(problem.id)}">${escapeHtml(problem.title)}</a>
              <div class="pl-tags">
                ${problem.tags.map((tag) => `<span class="pl-tag">${escapeHtml(tag)}</span>`).join("")}
              </div>
            </td>
            <td class="pl-td pl-td--acceptance">${problem.acceptanceRate.toFixed(1)}%</td>
            <td class="pl-td pl-td--difficulty">
              <span class="pl-difficulty pl-difficulty--${problem.difficulty.toLowerCase()}">${escapeHtml(problem.difficulty)}</span>
            </td>
            <td class="pl-td pl-td--freq">—</td>
          </tr>
        `;
      })
      .join("");
  }

  private matchesFilters(problem: Problem): boolean {
    const search = this.filters.search.toLowerCase();
    if (search) {
      const haystack = [problem.title, ...problem.tags].join(" ").toLowerCase();
      if (!haystack.includes(search)) {
        return false;
      }
    }

    if (this.filters.difficulty && problem.difficulty !== this.filters.difficulty) {
      return false;
    }

    if (this.filters.status && this.problemStatus(problem.id) !== this.filters.status) {
      return false;
    }

    if (this.filters.tag && !problem.tags.includes(this.filters.tag)) {
      return false;
    }

    return true;
  }

  private problemStatus(problemId: string): "solved" | "attempted" | "unsolved" {
    return this.progress[problemId]?.status ?? "unsolved";
  }

  private handleFiltersChanged(): void {
    saveFilters(this.filters);
    this.applyFilterControls();
    this.syncListUrl();
    this.renderList();
  }

  private applyFilterControls(): void {
    this.searchInput.value = this.filters.search;
    this.difficultyFilter.value = this.filters.difficulty;
    this.statusFilter.value = this.filters.status;
    this.tagFilter.value = this.filters.tag;
  }

  private updateFilterUi(): void {
    const hasFilters = Boolean(this.filters.search || this.filters.difficulty || this.filters.status || this.filters.tag);
    this.clearFiltersButton.hidden = !hasFilters;
    [this.difficultyFilter, this.statusFilter, this.tagFilter].forEach((select) => {
      select.classList.toggle("is-active", Boolean(select.value));
    });
    this.tagStrip?.querySelectorAll<HTMLElement>("[data-tag]").forEach((element) => {
      const elementTag = element.dataset.tag ?? "";
      const active = this.filters.tag ? elementTag === this.filters.tag : elementTag === "";
      element.classList.toggle("pl-tagchip--active", element.classList.contains("pl-tagchip") && active);
    });
    this.listLayout.querySelectorAll<HTMLElement>(".pl-sidebar-link[data-tag]").forEach((element) => {
      const elementTag = element.dataset.tag ?? "";
      const active = this.filters.tag ? elementTag === this.filters.tag : elementTag === "";
      element.classList.toggle("pl-sidebar-link--active", active);
    });
  }

  private syncListUrl(): void {
    if (!this.problemLayout.hidden) {
      return;
    }

    const url = new URL(window.location.href);
    if (this.filters.tag) {
      url.searchParams.set("tag", this.filters.tag);
    } else {
      url.searchParams.delete("tag");
    }
    url.searchParams.delete("id");
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, "", nextUrl || "/problems/");
  }

  private openRandomProblem(difficulty?: Difficulty): void {
    const candidates = this.getFilteredProblems().filter((problem) => !difficulty || problem.difficulty === difficulty);
    if (candidates.length === 0) {
      return;
    }
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    if (!target) {
      return;
    }
    this.saveListScroll();
    window.location.href = `/problems/?id=${encodeURIComponent(target.id)}`;
  }

  private saveListScroll(): void {
    safeSessionStorageSet(LIST_SCROLL_STORAGE_KEY, String(window.scrollY));
  }

  private restoreListScroll(): void {
    const value = readStoredNumber(safeSessionStorageGet(LIST_SCROLL_STORAGE_KEY), 0);
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: value, behavior: "auto" });
    });
  }

  private showListView(pushHistory: boolean): void {
    if (this.currentProblem) {
      this.persistCurrentCode();
    }

    this.disposeEditor();
    this.stopTimer();
    this.currentProblem = null;
    this.viewState = null;
    this.problemLayout.hidden = true;
    this.listLayout.hidden = false;
    (document.getElementById("problem-workspace-view") as HTMLElement | null)?.setAttribute("hidden", "");
    (document.getElementById("problems-list-view") as HTMLElement | null)?.removeAttribute("hidden");
    this.nav.hidden = false;
    this.footer.hidden = false;
    this.body.classList.remove("pv-body");
    this.verdict.hidden = true;
    this.resetConfirm.hidden = true;
    this.updateLanguagePill("idle");
    document.title = "Problems - StudyRISC-V";

    if (pushHistory) {
      window.history.pushState({}, "", "/problems/");
    }

    this.restoreListScroll();
  }

  private async showProblemView(problemId: string, pushHistory: boolean): Promise<void> {
    const problem = getProblem(problemId);
    if (!problem) {
      this.showListView(pushHistory);
      return;
    }

    if (this.currentProblem) {
      this.persistCurrentCode();
    }
    this.disposeEditor();

    this.currentProblem = problem;
    this.openHintIndices.clear();
    const entry = ensureProblemEntry(this.progress, problem);
    for (let index = 0; index < (entry.hintsRevealed ?? 0); index += 1) {
      this.openHintIndices.add(index);
    }

    const customCases = loadCustomCases(problem);
    const submissions = loadSubmissionDetails(problem.id);
    const firstVisibleCase = problem.testCases.find((candidate) => candidate.visible)?.id ?? problem.testCases[0]?.id ?? "";
    const initialCaseId = customCases[0]?.id ?? firstVisibleCase;
    const savedCode = loadProblemCode(problem.id) ?? entry.lastCode ?? problem.starterCode;

    this.viewState = {
      currentProblemId: problem.id,
      currentCode: savedCode,
      activeLeftTab: "description",
      activeBottomTab: "testcase",
      activeCaseId: initialCaseId,
      customCases,
      lastRunResult: null,
      lastSubmitResult: submissions[0] ?? null,
      latestExecution: null,
      submissions,
      selectedSubmissionId: null,
      testcaseError: null,
      resultNotice: null,
    };

    this.listLayout.hidden = true;
    this.problemLayout.hidden = false;
    (document.getElementById("problems-list-view") as HTMLElement | null)?.setAttribute("hidden", "");
    (document.getElementById("problem-workspace-view") as HTMLElement | null)?.removeAttribute("hidden");
    this.nav.hidden = false;
    this.footer.hidden = true;
    this.body.classList.add("pv-body");
    this.verdict.hidden = true;
    this.resetConfirm.hidden = true;

    this.crumbDifficulty.textContent = problem.difficulty;
    this.crumbDifficulty.dataset.val = problem.difficulty;
    this.crumbTitle.textContent = problem.title;
    this.updateLanguagePill("idle");
    this.hintsBadge.textContent = String(problem.hints.length);
    this.prevButton.disabled = problem.number <= 1;
    this.nextButton.disabled = problem.number >= this.problems.length;
    document.title = `${problem.number}. ${problem.title} - StudyRISC-V`;

    this.renderWorkspace();

    if (pushHistory) {
      window.history.pushState({ id: problem.id }, "", `/problems/?id=${encodeURIComponent(problem.id)}`);
    }

    await nextFrame();
    this.restoreVerticalSplit();
    await nextFrame();
    this.restoreHorizontalSplit();
    this.applyWorkspaceLayout();
    this.startTimer(problem.id);

    void this.ensureRuntime();
    await this.ensureEditor(savedCode);
  }

  private renderWorkspace(): void {
    if (!this.currentProblem || !this.state) {
      return;
    }

    this.updateResultTab();
    this.renderLeftBody();
    this.renderConsoleBody();
  }

  private updateResultTab(): void {
    if (!this.currentProblem || !this.state || !this.resultTabButton) {
      return;
    }

    const activeResult = this.getLeftPanelResult();
    if (!activeResult) {
      this.resultTabButton.hidden = true;
      if (this.state.activeLeftTab === "result") {
        this.state.activeLeftTab = "description";
      }
      return;
    }

    this.resultTabButton.hidden = false;
    this.resultTabButton.textContent = resultStatusLabel(activeResult.status);
    this.resultTabButton.classList.toggle("pv-tab--accepted", activeResult.status === "accepted");
    this.resultTabButton.classList.toggle("pv-tab--error", activeResult.status !== "accepted");
  }

  private getLeftPanelResult(): WorkspaceRunResultState | WorkspaceSubmitResultState | null {
    if (!this.state) {
      return null;
    }
    if (this.state.selectedSubmissionId) {
      return this.state.submissions.find((submission) => submission.id === this.state!.selectedSubmissionId) ?? null;
    }
    return this.state.lastSubmitResult ?? this.state.lastRunResult;
  }

  private getBottomResult(): WorkspaceRunResultState | WorkspaceSubmitResultState | null {
    if (!this.state) {
      return null;
    }
    if (this.state.latestExecution === "submit") {
      return this.state.lastSubmitResult;
    }
    if (this.state.latestExecution === "run") {
      return this.state.lastRunResult;
    }
    return this.state.lastSubmitResult ?? this.state.lastRunResult;
  }

  private renderLeftBody(): void {
    if (!this.currentProblem || !this.state) {
      return;
    }

    this.leftPanel.querySelectorAll<HTMLButtonElement>(".pv-tab").forEach((button) => {
      const active = !button.hidden && button.dataset.tab === this.state!.activeLeftTab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });

    switch (this.state.activeLeftTab) {
      case "description":
        this.leftBody.innerHTML = this.renderDescription(this.currentProblem);
        break;
      case "result":
        this.leftBody.innerHTML = this.renderResultPanel(this.currentProblem);
        break;
      case "hints":
        this.leftBody.innerHTML = this.renderHints(this.currentProblem);
        break;
      case "editorial":
        this.leftBody.innerHTML = this.renderEditorial(this.currentProblem);
        break;
      case "submissions":
        this.leftBody.innerHTML = this.renderSubmissions(this.currentProblem);
        break;
    }
  }

  private renderDescription(problem: Problem): string {
    const summary =
      this.state?.latestExecution === "run"
        ? this.state.lastRunResult ?? this.state.lastSubmitResult
        : this.state?.lastSubmitResult ?? this.state?.lastRunResult;
    return `
      <div class="pv-problem-num">${problem.number}.</div>
      <h2 class="pv-problem-title">${escapeHtml(problem.title)}</h2>

      <div class="pv-problem-meta">
        <span class="pv-difficulty-badge pv-difficulty-badge--${problem.difficulty.toLowerCase()}">${escapeHtml(problem.difficulty)}</span>
        ${problem.tags.map((tag) => `<span class="pv-tag">${escapeHtml(tag)}</span>`).join("")}
        <span class="pv-meta-acceptance">${problem.acceptanceRate.toFixed(1)}% acceptance</span>
      </div>

      ${summary
        ? `
            <section class="pv-inline-summary pv-inline-summary--${resultToneFromStatus(summary.status)}">
              <div class="pv-inline-summary__title">${summary.kind === "submit" ? "Last submit" : "Last run"}: ${escapeHtml(resultStatusLabel(summary.status))}</div>
              <div class="pv-inline-summary__meta">${summary.passed}/${summary.total} cases · ${summary.durationMs} ms · ${summary.totalSteps} steps</div>
            </section>
          `
        : ""}

      <div class="pv-prose">${problem.description}</div>

      <section class="pv-examples">
        <div class="pv-section-head">Examples</div>
        ${problem.examples
          .map(
            (example, index) => `
              <article class="pv-example">
                <div class="pv-example__head">Example ${index + 1}</div>
                <div class="pv-example__body">
                  <div class="pv-example__row">
                    <span class="pv-example__key">Input</span>
                    <span class="pv-example__val">${escapeHtml(example.input)}</span>
                  </div>
                  <div class="pv-example__row">
                    <span class="pv-example__key">Output</span>
                    <span class="pv-example__val">${escapeHtml(example.output)}</span>
                  </div>
                  ${example.explanation ? `<div class="pv-example__explanation">${escapeHtml(example.explanation)}</div>` : ""}
                  ${example.registerTable && example.registerTable.length > 0
                    ? `
                        <table class="pv-register-table">
                          <thead>
                            <tr>
                              <th>Register</th>
                              <th>Before</th>
                              <th>After</th>
                            </tr>
                          </thead>
                          <tbody>
                            ${example.registerTable
                              .map(
                                (row) => `
                                  <tr>
                                    <td class="pv-reg-name">${escapeHtml(row.name)}</td>
                                    <td class="pv-reg-val">${escapeHtml(row.before)}</td>
                                    <td class="pv-reg-val">${escapeHtml(row.after)}</td>
                                  </tr>
                                `
                              )
                              .join("")}
                          </tbody>
                        </table>
                      `
                    : ""}
                </div>
              </article>
            `
          )
          .join("")}
      </section>

      <section class="pv-constraints">
        <div class="pv-section-head">Constraints</div>
        <ul class="pv-constraint-list">
          ${problem.constraints.map((constraint) => `<li>${escapeHtml(constraint)}</li>`).join("")}
        </ul>
      </section>

      ${problem.companies?.length
        ? `
            <section class="pv-related">
              <div class="pv-section-head">Related To</div>
              <div class="pv-problem-meta">
                ${problem.companies.map((company) => `<span class="pv-tag">${escapeHtml(company)}</span>`).join("")}
              </div>
            </section>
          `
        : ""}
    `;
  }

  private renderResultPanel(problem: Problem): string {
    const result = this.getLeftPanelResult();
    if (!result) {
      return `
        <div class="pv-submissions-empty">
          <p>No run or submit result yet.</p>
          <p>Run the visible cases to debug, or submit to judge the full problem.</p>
        </div>
      `;
    }

    const selectedCase =
      result.caseResults.find((caseResult) => caseResult.caseId === result.selectedCaseId) ??
      result.caseResults[0] ??
      null;
    const summaryLine =
      result.kind === "submit"
        ? `${result.passed}/${result.total} official testcases passed`
        : `${result.passed}/${result.total} debugging case${result.total === 1 ? "" : "s"} passed`;
    const timestamp = formatRelativeDate(result.createdAt);

    return `
      <section class="pv-result-view">
        <div class="pv-result-hero pv-result-hero--${resultToneFromStatus(result.status)}">
          <div class="pv-result-hero__eyebrow">${result.kind === "submit" ? "Submission Result" : "Run Result"}</div>
          <h3 class="pv-result-hero__title">${escapeHtml(resultStatusLabel(result.status))}</h3>
          <p class="pv-result-hero__summary">${escapeHtml(summaryLine)}</p>
          <div class="pv-result-metrics">
            <div class="pv-result-metric">
              <span class="pv-result-metric__label">Runtime</span>
              <span class="pv-result-metric__value">${result.durationMs} ms</span>
            </div>
            <div class="pv-result-metric">
              <span class="pv-result-metric__label">Steps</span>
              <span class="pv-result-metric__value">${result.totalSteps}</span>
            </div>
            <div class="pv-result-metric">
              <span class="pv-result-metric__label">Updated</span>
              <span class="pv-result-metric__value">${escapeHtml(timestamp)}</span>
            </div>
          </div>
        </div>

        ${
          selectedCase
            ? `
                <section class="pv-result-case">
                  <div class="pv-section-head">${escapeHtml(selectedCase.label)}</div>
                  ${renderResultCaseInput(selectedCase)}
                </section>
              `
            : ""
        }

        <details class="pv-code-preview">
          <summary>Code snapshot</summary>
          ${renderCodePreview(result.codeSnapshot)}
        </details>

        ${
          problem.relatedProblems?.length
            ? `
                <section class="pv-related">
                  <div class="pv-section-head">Related Problems</div>
                  <div class="pv-problem-meta">
                    ${problem.relatedProblems
                      .map((problemId) => {
                        const related = getProblem(problemId);
                        if (!related) {
                          return "";
                        }
                        return `<a class="pv-tag" href="/problems/?id=${encodeURIComponent(related.id)}">${related.number}. ${escapeHtml(related.title)}</a>`;
                      })
                      .join("")}
                  </div>
                </section>
              `
            : ""
        }

        ${
          result.kind === "submit"
            ? `<button class="pv-submissions-action" type="button" data-action="restore-submission-code" data-submission-id="${escapeHtml(result.id)}">Load this code in editor</button>`
            : ""
        }
      </section>
    `;
  }

  private renderHints(problem: Problem): string {
    const entry = ensureProblemEntry(this.progress, problem);
    const revealed = entry.hintsRevealed ?? 0;

    return `
      <div class="pv-hints-intro">Hints are optional. Reveal them one at a time when you need a nudge.</div>
      ${problem.hints
        .map((hint, index) => {
          const unlocked = index < revealed;
          const canReveal = index === revealed;
          const open = this.openHintIndices.has(index);
          if (!unlocked && !canReveal) {
            return `
              <div class="pv-hint-locked">
                <span>🔒</span>
                <span>Reveal Hint ${index + 1} after opening the previous hint.</span>
              </div>
            `;
          }

          return `
            <div class="pv-hint-item ${open ? "is-open" : ""}">
              <button class="pv-hint-toggle" data-hint-index="${index}" type="button">
                <span class="pv-hint-toggle__label">${unlocked ? `Hint ${index + 1}` : `Show Hint ${index + 1}`}</span>
                <span class="pv-hint-toggle__chevron">›</span>
              </button>
              <div class="pv-hint-body">
                <div class="pv-hint-text">${escapeHtml(hint)}</div>
              </div>
            </div>
          `;
        })
        .join("")}
    `;
  }

  private renderEditorial(problem: Problem): string {
    if (!problem.editorial) {
      return `
        <div class="pv-submissions-empty">
          <p>Editorial coming soon.</p>
          <p>Solve the problem first. This tab will hold the walkthrough later.</p>
        </div>
      `;
    }

    if (this.problemStatus(problem.id) !== "solved") {
      return `
        <div class="pv-submissions-empty">
          <p>Solve the problem to unlock the editorial.</p>
        </div>
      `;
    }

    return `<div class="pv-prose">${problem.editorial}</div>`;
  }

  private renderSubmissions(_problem: Problem): string {
    const submissions = [...(this.state?.submissions ?? [])].sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
    );
    if (submissions.length === 0) {
      return `
        <div class="pv-submissions-empty">
          <p>No submissions yet.</p>
          <p>Submit to save a result snapshot for this problem.</p>
        </div>
      `;
    }

    return `
      <table class="pv-submissions-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Runtime</th>
            <th>Cases</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          ${submissions
            .map(
              (submission) => `
                <tr data-submission-id="${escapeHtml(submission.id)}">
                  <td><span class="pv-submission-verdict pv-submission-verdict--${resultToneFromStatus(submission.status)}">${escapeHtml(resultStatusLabel(submission.status))}</span></td>
                  <td>${submission.durationMs} ms</td>
                  <td>${submission.passed}/${submission.total}</td>
                  <td>${escapeHtml(formatRelativeDate(submission.createdAt))}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    `;
  }

  private renderConsoleBody(): void {
    if (!this.currentProblem || !this.state) {
      this.consoleBody.innerHTML = "";
      return;
    }

    this.consoleTabs.querySelectorAll<HTMLButtonElement>(".pv-console-tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.ctab === this.state!.activeBottomTab);
    });

    if (this.state.activeBottomTab === "testcase") {
      this.consoleBody.innerHTML = this.renderTestcasePanel(this.currentProblem);
      return;
    }

    this.consoleBody.innerHTML = this.renderBottomResultPanel();
  }

  private getWorkspaceCases(): WorkspaceCase[] {
    if (!this.currentProblem || !this.state) {
      return [];
    }

    const official = this.currentProblem.testCases
      .filter((candidate) => candidate.visible)
      .map<WorkspaceCase>((testCase) => ({
        id: testCase.id,
        label: testCase.label,
        description: testCase.description,
        custom: false,
        readonly: true,
        testCase,
      }));
    const custom = this.state.customCases.map<WorkspaceCase>((draft) => ({
      id: draft.id,
      label: draft.label || "Custom Case",
      description: draft.description,
      custom: true,
      readonly: false,
      draft,
    }));
    return [...official, ...custom];
  }

  private getSelectedWorkspaceCase(): WorkspaceCase | null {
    const cases = this.getWorkspaceCases();
    if (cases.length === 0 || !this.state) {
      return null;
    }
    return cases.find((candidate) => candidate.id === this.state!.activeCaseId) ?? cases[0] ?? null;
  }

  private renderTestcasePanel(_problem: Problem): string {
    const cases = this.getWorkspaceCases();
    const selected = this.getSelectedWorkspaceCase();
    if (!selected || !this.state) {
      return `<div class="pv-console-empty">No visible testcases.</div>`;
    }

    const readonly = selected.readonly;
    const draft = selected.draft;
    const sourceCase = selected.testCase;
    const initialRegistersText = draft?.initialRegistersText ?? (sourceCase ? serializeRegisters(sourceCase.initialRegisters) : "");
    const initialMemoryText = draft?.initialMemoryText ?? (sourceCase?.initialMemory?.length ? serializeMemory(sourceCase.initialMemory) : "");
    const expectedRegistersText = draft?.expectedRegistersText ?? (sourceCase ? serializeRegisters(sourceCase.expectedRegisters) : "");
    const expectedMemoryText = draft?.expectedMemoryText ?? (sourceCase?.expectedMemory?.length ? serializeMemory(sourceCase.expectedMemory) : "");
    const stepLimitText = draft?.stepLimitText ?? (sourceCase?.stepLimit ? String(sourceCase.stepLimit) : "");

    return `
      <section class="pv-testcase-panel">
        <div class="pv-case-toolbar">
          <div class="pv-case-tabs">
            ${cases
              .map(
                (candidate) => `
                  <button
                    class="pv-case-tab ${candidate.id === selected.id ? "active" : ""} ${candidate.custom ? "pv-case-tab--custom" : ""}"
                    data-action="select-case"
                    data-case-id="${escapeHtml(candidate.id)}"
                    type="button"
                  >
                    ${escapeHtml(candidate.label)}
                    ${candidate.custom ? `<span class="pv-case-pill">Custom</span>` : ""}
                  </button>
                `
              )
              .join("")}
          </div>
          <div class="pv-case-toolbar__actions">
            <button class="pv-case-action-btn" type="button" data-action="add-case">+ Add Case</button>
          </div>
        </div>

        <div class="pv-testcase-callout">
          Run checks every visible official testcase plus every custom testcase shown here. Submit always uses the full official judge suite.
        </div>

        ${this.state.testcaseError ? `<div class="pv-testcase-error">${escapeHtml(this.state.testcaseError)}</div>` : ""}

        <div class="pv-testcase-form">
          <label class="pv-field">
            <span class="pv-field__label">Case Label</span>
            <input
              class="pv-field__input"
              type="text"
              value="${escapeHtml(selected.label)}"
              ${readonly ? "readonly" : ""}
              data-custom-case-id="${draft?.id ?? ""}"
              data-field="label"
            />
          </label>

          <label class="pv-field">
            <span class="pv-field__label">Notes</span>
            <textarea
              class="pv-field__textarea pv-field__textarea--sm"
              ${readonly ? "readonly" : ""}
              data-custom-case-id="${draft?.id ?? ""}"
              data-field="description"
            >${escapeHtml(draft?.description ?? sourceCase?.description ?? "")}</textarea>
          </label>

          <div class="pv-testcase-grid">
            <label class="pv-field">
              <span class="pv-field__label">Initial Registers</span>
              <textarea
                class="pv-field__textarea"
                ${readonly ? "readonly" : ""}
                data-custom-case-id="${draft?.id ?? ""}"
                data-field="initialRegistersText"
              >${escapeHtml(initialRegistersText)}</textarea>
            </label>

            <label class="pv-field">
              <span class="pv-field__label">Initial Memory</span>
              <textarea
                class="pv-field__textarea"
                ${readonly ? "readonly" : ""}
                data-custom-case-id="${draft?.id ?? ""}"
                data-field="initialMemoryText"
              >${escapeHtml(initialMemoryText)}</textarea>
            </label>

            <label class="pv-field">
              <span class="pv-field__label">Expected Registers</span>
              <textarea
                class="pv-field__textarea"
                ${readonly ? "readonly" : ""}
                data-custom-case-id="${draft?.id ?? ""}"
                data-field="expectedRegistersText"
              >${escapeHtml(expectedRegistersText)}</textarea>
            </label>

            <label class="pv-field">
              <span class="pv-field__label">Expected Memory</span>
              <textarea
                class="pv-field__textarea"
                ${readonly ? "readonly" : ""}
                data-custom-case-id="${draft?.id ?? ""}"
                data-field="expectedMemoryText"
              >${escapeHtml(expectedMemoryText)}</textarea>
            </label>
          </div>

          <label class="pv-field pv-field--inline">
            <span class="pv-field__label">Step Limit</span>
            <input
              class="pv-field__input pv-field__input--xs"
              type="text"
              value="${escapeHtml(stepLimitText)}"
              ${readonly ? "readonly" : ""}
              data-custom-case-id="${draft?.id ?? ""}"
              data-field="stepLimitText"
            />
          </label>

          <div class="pv-case-actions">
            <button class="pv-case-action-btn pv-case-action-btn--primary" type="button" data-action="run-debug">Run visible + custom cases</button>
            <button class="pv-case-action-btn" type="button" data-action="duplicate-case">Duplicate Case</button>
            ${selected.custom ? `<button class="pv-case-action-btn" type="button" data-action="reset-case">Reset Case</button>` : ""}
            ${selected.custom ? `<button class="pv-case-action-btn pv-case-action-btn--danger" type="button" data-action="delete-case">Delete Case</button>` : ""}
          </div>
        </div>
      </section>
    `;
  }

  private renderBottomResultPanel(): string {
    if (!this.state) {
      return `<div class="pv-console-empty">Run your code to see output.</div>`;
    }

    const result = this.getBottomResult();
    if (!result) {
      if (this.state.resultNotice) {
        return `<div class="pv-console-empty" style="text-align:left">${escapeHtml(this.state.resultNotice)}</div>`;
      }
      return `<div class="pv-console-empty">Run your code to see output.</div>`;
    }

    const selected = result.caseResults.find((caseResult) => caseResult.caseId === result.selectedCaseId) ?? result.caseResults[0] ?? null;
    return `
      <section class="pv-test-result">
        <div class="pv-test-result__summary pv-test-result__summary--${resultToneFromStatus(result.status)}">
          <div class="pv-test-result__title">${escapeHtml(resultStatusLabel(result.status))}</div>
          <div class="pv-test-result__meta">${result.passed}/${result.total} cases · ${result.durationMs} ms · ${result.totalSteps} steps</div>
        </div>

        <div class="pv-result-list">
          ${result.caseResults
            .map(
              (caseResult) => `
                <button
                  class="pv-result-item ${caseResult.result.passed ? "pass" : "fail"} ${caseResult.caseId === selected?.caseId ? "is-active" : ""}"
                  data-action="select-result-case"
                  data-case-id="${escapeHtml(caseResult.caseId)}"
                  type="button"
                >
                  <span class="pv-result-icon ${caseResult.result.passed ? "pass" : "fail"}">${caseResult.result.passed ? "✓" : "✗"}</span>
                  <span class="pv-result-label">${escapeHtml(caseResult.label)}</span>
                  <span class="pv-result-steps">${caseResult.result.executionTimeMs.toFixed(2)} ms · ${caseResult.result.stepsTaken} steps</span>
                </button>
              `
            )
            .join("")}
        </div>

        ${
          selected
            ? `
                <section class="pv-result-detail">
                  <div class="pv-section-head">${escapeHtml(selected.label)} Detail</div>
                  ${renderResultCaseInput(selected)}
                </section>
              `
            : ""
        }
      </section>
    `;
  }

  private updateLanguagePill(state: "idle" | "active" | "error", label = "RISC-V Assembly"): void {
    if (!this.langPill) {
      return;
    }
    this.langPill.textContent = label;
    this.langPill.classList.remove("pv-lang-pill--active", "pv-lang-pill--error");
    if (state === "active") {
      this.langPill.classList.add("pv-lang-pill--active");
    } else if (state === "error") {
      this.langPill.classList.add("pv-lang-pill--error");
    }
  }

  private async ensureRuntime(): Promise<WasmRuntime> {
    this.runtimePromise ??= WasmRuntime.create();
    return this.runtimePromise;
  }

  private async ensureEditor(code: string): Promise<void> {
    this.monacoLoading.hidden = false;
    this.updateLanguagePill("idle");
    this.editorHost.innerHTML = "";
    delete this.editorHost.dataset.editorFallback;

    await nextFrame();
    this.ensureEditorContainerHeight();
    await nextFrame();
    this.ensureEditorContainerHeight();

    await new Promise<void>((resolve) => {
      initRiscvEditor({
        containerId: "pv-editor",
        starterCode: code,
        problemId: this.currentProblem?.id,
        onReady: (editor) => {
          this.editor = editor as MonacoEditorInstance;
          this.editorFallback = null;
          this.editorChangeSubscription?.dispose();
          this.editorChangeSubscription = this.editor.onDidChangeModelContent(() => {
            if (this.state) {
              this.state.currentCode = this.editor?.getValue() ?? "";
            }
          });
          this.updateLanguagePill("active");
          this.monacoLoading.hidden = true;
          this.editor.focus();
          resolve();
        },
        onError: () => {
          this.editorChangeSubscription?.dispose();
          this.editorChangeSubscription = null;
          this.editor = null;
          this.updateLanguagePill("error", "Editor failed");
          this.monacoLoading.hidden = true;
          window.setTimeout(() => {
            this.editorFallback = monacoHost().__editorFallback ?? null;
            if (this.editorFallback) {
              this.bindFallbackAutosave(this.editorFallback);
            }
          }, 0);
          resolve();
        },
      });
    });
  }

  private bindFallbackAutosave(textarea: HTMLTextAreaElement): void {
    textarea.oninput = () => {
      if (this.state) {
        this.state.currentCode = textarea.value;
      }
      if (this.autosaveTimer) {
        window.clearTimeout(this.autosaveTimer);
      }
      this.autosaveTimer = window.setTimeout(() => {
        this.persistCurrentCode();
      }, AUTO_SAVE_DELAY_MS);
    };
  }

  private disposeEditor(): void {
    this.editorChangeSubscription?.dispose();
    this.editorChangeSubscription = null;
    this.editor?.dispose();
    this.editor = null;
    this.editorFallback = null;
    if (this.autosaveTimer) {
      window.clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    monacoHost().__editorInstance = null;
    monacoHost().__editorFallback = null;
    this.editorHost.innerHTML = "";
    this.monacoLoading.hidden = false;
  }

  private persistCurrentCode(): void {
    if (!this.currentProblem || !this.state) {
      return;
    }

    const code = this.getEditorCode();
    this.state.currentCode = code;
    saveProblemCode(this.currentProblem.id, code);
    const entry = ensureProblemEntry(this.progress, this.currentProblem);
    entry.lastCode = code;
    entry.lastSavedAt = nowIso();
    saveProblemProgressForUser(this.progress, this.session?.userId ?? null);
    if (this.session) {
      void syncProblemProgressToApi(this.progress, this.session.idToken);
    }
  }

  private getEditorCode(): string {
    return readEditorCode();
  }

  private setEditorCode(code: string): void {
    if (this.state) {
      this.state.currentCode = code;
    }
    if (this.editor) {
      this.editor.setValue(code);
      return;
    }
    if (this.editorFallback) {
      this.editorFallback.value = code;
      return;
    }
    const fallback = monacoHost().__editorFallback;
    if (fallback) {
      fallback.value = code;
    }
  }

  private setEditorReadOnly(readOnly: boolean): void {
    if (this.editor) {
      this.editor.updateOptions({ readOnly });
    }
    if (this.editorFallback) {
      this.editorFallback.readOnly = readOnly;
    }
    const fallback = monacoHost().__editorFallback;
    if (fallback) {
      fallback.readOnly = readOnly;
    }
  }

  private async executeRun(): Promise<void> {
    if (!this.currentProblem || !this.state || this.running) {
      return;
    }

    const source = this.getEditorCode();
    if (!source.trim()) {
      this.state.resultNotice = null;
      this.state.testcaseError = "Editor is empty.";
      this.renderConsoleBody();
      return;
    }

    const officialCases = this.currentProblem.testCases.filter((candidate) => candidate.visible);
    const parsedCustomCases = this.state.customCases.map((draft) => ({ draft, parsed: parseCustomCaseDraft(draft) }));
    const customErrors = parsedCustomCases.flatMap(({ parsed }) => parsed.errors);
    if (customErrors.length > 0) {
      this.state.testcaseError = customErrors[0] ?? "Custom testcase is invalid.";
      this.state.activeBottomTab = "testcase";
      this.renderConsoleBody();
      return;
    }

    const customCases = parsedCustomCases.map((item) => item.parsed.testCase).filter((value): value is ProblemTestCase => Boolean(value));
    const casesToRun = [...officialCases, ...customCases];
    if (casesToRun.length === 0) {
      this.state.testcaseError = "No testcase is available to run.";
      this.renderConsoleBody();
      return;
    }

    let runtime: WasmRuntime;
    try {
      runtime = await this.ensureRuntime();
    } catch (error) {
      this.state.resultNotice = error instanceof Error ? error.message : "Runtime not ready.";
      this.state.activeBottomTab = "result";
      this.renderConsoleBody();
      return;
    }

    this.running = true;
    this.runButton.classList.add("is-loading");
    this.submitButton.classList.add("is-loading");
    this.setEditorReadOnly(true);
    this.state.testcaseError = null;
    this.state.resultNotice = `Running ${casesToRun.length} debugging case${casesToRun.length === 1 ? "" : "s"}...`;
    this.state.activeBottomTab = "result";
    this.renderConsoleBody();

    try {
      const results: RunResult[] = [];
      for (const testCase of casesToRun) {
        results.push(await runTestCase(source, testCase, runtime));
      }
      const summary = summarizeResults(results);
      const casesById = new Map(casesToRun.map((testCase) => [testCase.id, testCase]));
      const customCaseIds = new Set(customCases.map((testCase) => testCase.id));
      const caseResults = mapCaseResults(results, casesById, customCaseIds);
      this.state.lastRunResult = buildRunState(summary, caseResults, source);
      this.state.latestExecution = "run";
      this.state.resultNotice = null;
      this.state.selectedSubmissionId = null;
      this.renderWorkspace();
    } catch (error) {
      this.state.resultNotice = error instanceof Error ? error.message : "Execution failed.";
      this.renderConsoleBody();
    } finally {
      this.running = false;
      this.runButton.classList.remove("is-loading");
      this.submitButton.classList.remove("is-loading");
      this.setEditorReadOnly(false);
    }
  }

  private async executeSubmit(): Promise<void> {
    if (!this.currentProblem || !this.state || this.running) {
      return;
    }

    const source = this.getEditorCode();
    if (!source.trim()) {
      this.state.activeLeftTab = "result";
      this.state.resultNotice = "Editor is empty.";
      this.renderWorkspace();
      return;
    }

    let runtime: WasmRuntime;
    try {
      runtime = await this.ensureRuntime();
    } catch (error) {
      this.state.activeLeftTab = "result";
      this.state.resultNotice = error instanceof Error ? error.message : "Runtime not ready.";
      this.renderWorkspace();
      return;
    }

    this.running = true;
    this.runButton.classList.add("is-loading");
    this.submitButton.classList.add("is-loading");
    this.setEditorReadOnly(true);
    this.state.resultNotice = "Submitting against the full judge...";
    this.state.activeBottomTab = "result";
    this.renderConsoleBody();

    try {
      const summary = await runAll(source, this.currentProblem, runtime);
      const casesById = new Map(this.currentProblem.testCases.map((testCase) => [testCase.id, testCase]));
      const submissionId = `${this.currentProblem.id}-${Date.now()}`;
      const submissionDetail = buildSubmitState(summary, mapCaseResults(summary.results, casesById, new Set()), source, submissionId);
      this.state.lastSubmitResult = submissionDetail;
      this.state.submissions = [submissionDetail, ...this.state.submissions.filter((item) => item.id !== submissionId)].slice(0, 20);
      this.state.latestExecution = "submit";
      this.state.selectedSubmissionId = null;
      this.state.activeLeftTab = "result";
      this.state.resultNotice = null;
      saveSubmissionDetails(this.currentProblem.id, this.state.submissions);
      this.persistCurrentCode();
      this.saveSubmission(summary, source, submissionDetail);
      if (summary.verdict === "Accepted") {
        this.stopTimer();
      }
      this.renderWorkspace();
    } catch (error) {
      this.state.activeLeftTab = "result";
      this.state.resultNotice = error instanceof Error ? error.message : "Submission failed.";
      this.renderWorkspace();
    } finally {
      this.running = false;
      this.runButton.classList.remove("is-loading");
      this.submitButton.classList.remove("is-loading");
      this.setEditorReadOnly(false);
    }
  }

  private saveSubmission(summary: RunSummary, source: string, detail: WorkspaceSubmitResultState): void {
    if (!this.currentProblem || !this.state) {
      return;
    }

    const entry = ensureProblemEntry(this.progress, this.currentProblem);
    const submission = buildMinimalSubmission(this.currentProblem.id, summary, source);
    submission.id = detail.id;
    submission.submittedAt = detail.createdAt;
    submission.elapsedMs = detail.durationMs;

    entry.status = summary.verdict === "Accepted" ? "solved" : "attempted";
    entry.submissions = [submission, ...entry.submissions.filter((item) => item.id !== submission.id)].slice(0, 20);
    entry.lastCode = source;
    entry.lastSavedAt = submission.submittedAt;
    saveProblemCode(this.currentProblem.id, source);
    saveProblemProgressForUser(this.progress, this.session?.userId ?? null);

    if (this.session) {
      void syncProblemProgressToApi(this.progress, this.session.idToken);
      void saveProblemSubmissionToApi(submission, this.session.idToken);
    }

    this.renderList();
  }

  private async toggleHint(index: number): Promise<void> {
    if (!this.currentProblem) {
      return;
    }

    const entry = ensureProblemEntry(this.progress, this.currentProblem);
    const revealed = entry.hintsRevealed ?? 0;
    if (index > revealed) {
      return;
    }

    if (index === revealed) {
      entry.hintsRevealed = revealed + 1;
      saveProblemProgressForUser(this.progress, this.session?.userId ?? null);
      if (this.session) {
        void syncProblemProgressToApi(this.progress, this.session.idToken);
      }
      this.openHintIndices.add(index);
    } else if (this.openHintIndices.has(index)) {
      this.openHintIndices.delete(index);
    } else {
      this.openHintIndices.add(index);
    }

    this.renderLeftBody();
  }

  private addCustomCase(): void {
    if (!this.currentProblem || !this.state) {
      return;
    }
    const draft = buildCustomCaseDraft(this.currentProblem, this.state.customCases.length, this.getSelectedWorkspaceCase()?.draft ?? this.getSelectedWorkspaceCase()?.testCase);
    this.state.customCases = [...this.state.customCases, draft];
    this.state.activeCaseId = draft.id;
    this.state.testcaseError = null;
    saveCustomCases(this.currentProblem.id, this.state.customCases);
    this.renderConsoleBody();
  }

  private duplicateActiveCase(): void {
    if (!this.currentProblem || !this.state) {
      return;
    }
    const selected = this.getSelectedWorkspaceCase();
    if (!selected) {
      return;
    }
    const draft = buildCustomCaseDraft(
      this.currentProblem,
      this.state.customCases.length,
      selected.draft ?? selected.testCase
    );
    this.state.customCases = [...this.state.customCases, draft];
    this.state.activeCaseId = draft.id;
    this.state.testcaseError = null;
    saveCustomCases(this.currentProblem.id, this.state.customCases);
    this.renderConsoleBody();
  }

  private deleteActiveCustomCase(): void {
    if (!this.currentProblem || !this.state) {
      return;
    }
    const selected = this.getSelectedWorkspaceCase();
    if (!selected?.custom) {
      return;
    }
    this.state.customCases = this.state.customCases.filter((draft) => draft.id !== selected.id);
    const nextCase = this.getWorkspaceCases().find((candidate) => candidate.id !== selected.id) ?? this.currentProblem.testCases.find((candidate) => candidate.visible);
    this.state.activeCaseId = nextCase?.id ?? this.currentProblem.testCases[0]?.id ?? "";
    this.state.testcaseError = null;
    saveCustomCases(this.currentProblem.id, this.state.customCases);
    this.renderConsoleBody();
  }

  private resetActiveCustomCase(): void {
    if (!this.currentProblem || !this.state) {
      return;
    }
    const selected = this.getSelectedWorkspaceCase();
    if (!selected?.custom || !selected.draft) {
      return;
    }
    const replacement = buildCustomCaseDraft(this.currentProblem, 0);
    replacement.id = selected.draft.id;
    replacement.label = selected.draft.label;
    const index = this.state.customCases.findIndex((draft) => draft.id === selected.id);
    if (index >= 0) {
      this.state.customCases.splice(index, 1, replacement);
      saveCustomCases(this.currentProblem.id, this.state.customCases);
      this.state.testcaseError = null;
      this.renderConsoleBody();
    }
  }

  private selectResultCase(caseId: string | null): void {
    if (!caseId || !this.state) {
      return;
    }
    const bottomResult = this.getBottomResult();
    if (bottomResult) {
      bottomResult.selectedCaseId = caseId;
    }
    const leftResult = this.getLeftPanelResult();
    if (leftResult) {
      leftResult.selectedCaseId = caseId;
    }
    this.renderWorkspace();
  }

  private restoreStarterCode(): void {
    if (!this.currentProblem || !this.state) {
      return;
    }
    this.setEditorCode(this.currentProblem.starterCode);
    this.state.currentCode = this.currentProblem.starterCode;
    safeLocalStorageSet(`problems_code_${this.currentProblem.id}`, this.currentProblem.starterCode);
    this.persistCurrentCode();
    this.resetConfirm.hidden = true;
  }

  private navigateRelative(offset: number): void {
    if (!this.currentProblem) {
      return;
    }
    const nextIndex = this.currentProblem.number - 1 + offset;
    if (nextIndex < 0 || nextIndex >= this.problems.length) {
      return;
    }
    const target = this.problems[nextIndex];
    if (!target) {
      return;
    }
    void this.showProblemView(target.id, true);
  }

  private startTimer(problemId: string): void {
    this.stopTimer();
    this.timerProblemId = problemId;
    this.timerSeconds = Math.max(0, Number.parseInt(safeSessionStorageGet(`problems_timer_${problemId}`) ?? "0", 10) || 0);
    this.updateTimerDisplay();

    this.timerInterval = window.setInterval(() => {
      if (document.hidden) {
        return;
      }
      this.timerSeconds += 1;
      this.saveTimer();
      this.updateTimerDisplay();
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timerInterval) {
      window.clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    this.saveTimer();
    this.timerProblemId = this.currentProblem?.id ?? null;
  }

  private saveTimer(): void {
    if (!this.timerProblemId) {
      return;
    }
    safeSessionStorageSet(`problems_timer_${this.timerProblemId}`, String(this.timerSeconds));
  }

  private updateTimerDisplay(): void {
    this.timer.textContent = formatTimerValue(this.timerSeconds);
  }

  private restoreVerticalSplit(): void {
    if (window.innerWidth < 768 || this.fullscreen) {
      this.leftPanel.style.width = "";
      this.leftPanel.style.flex = "";
      return;
    }
    const mainWidth = this.main.getBoundingClientRect().width;
    const saved = readStoredNumber(safeLocalStorageGet(PANEL_SPLIT_STORAGE_KEY), DEFAULT_LEFT_RATIO);
    const width = clampPanelSplit(saved * mainWidth, mainWidth);
    this.leftPanel.style.width = `${width}px`;
    this.leftPanel.style.flex = "none";
  }

  private restoreHorizontalSplit(): void {
    if (window.innerWidth < 768) {
      this.editorSection.style.height = "";
      this.editorSection.style.flex = "";
      return;
    }
    const rightHeight = this.rightPanel.getBoundingClientRect().height;
    if (rightHeight === 0) {
      return;
    }
    const savedConsoleHeight = readStoredNumber(safeLocalStorageGet(CONSOLE_HEIGHT_STORAGE_KEY), DEFAULT_CONSOLE_HEIGHT);
    const editorHeight = clampEditorHeight(rightHeight - savedConsoleHeight - this.horizontalDivider.offsetHeight, rightHeight);
    this.editorSection.style.height = `${editorHeight}px`;
    this.editorSection.style.flex = "none";
  }

  private applyWorkspaceLayout(): void {
    if (!this.currentProblem) {
      return;
    }

    if (this.fullscreen) {
      this.leftPanel.style.display = "none";
      this.verticalDivider.style.display = "none";
    } else {
      this.leftPanel.style.display = "";
      this.verticalDivider.style.display = "";
      if (window.innerWidth >= 768) {
        this.restoreVerticalSplit();
      }
    }

    if (window.innerWidth < 768) {
      this.leftPanel.style.width = "";
      this.leftPanel.style.flex = "";
      this.editorSection.style.height = "";
      this.editorSection.style.flex = "";
    } else {
      this.restoreHorizontalSplit();
    }

    this.ensureEditorContainerHeight();
    this.syncVerdictOffset();
  }

  private ensureEditorContainerHeight(): void {
    const editorSectionRect = this.editorSection.getBoundingClientRect();
    const editorHeaderRect = this.editorHeader.getBoundingClientRect();
    const height = Math.max(MIN_EDITOR_HEIGHT, Math.floor(editorSectionRect.height - editorHeaderRect.height));
    this.monacoContainer.style.height = `${height}px`;
    this.editorHost.style.height = `${height}px`;
  }

  private syncVerdictOffset(): void {
    if (this.problemLayout.hidden) {
      return;
    }
    if (window.innerWidth < 768 || this.fullscreen || this.leftPanel.style.display === "none") {
      this.verdict.style.left = "0px";
      return;
    }
    const offset = this.leftPanel.offsetWidth + this.verticalDivider.offsetWidth;
    this.verdict.style.left = `${offset}px`;
  }

  private startVerticalDrag(): void {
    this.verticalDivider.classList.add("dragging");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    this.setMonacoPointerEvents(false);

    const onMove = (event: MouseEvent): void => {
      const mainRect = this.main.getBoundingClientRect();
      const requestedWidth = event.clientX - mainRect.left;
      const width = clampPanelSplit(requestedWidth, mainRect.width);
      this.leftPanel.style.width = `${width}px`;
      this.leftPanel.style.flex = "none";
      safeLocalStorageSet(PANEL_SPLIT_STORAGE_KEY, String(width / mainRect.width));
      this.ensureEditorContainerHeight();
      this.syncVerdictOffset();
    };

    const onUp = (): void => {
      this.verticalDivider.classList.remove("dragging");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      this.setMonacoPointerEvents(true);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  private startHorizontalDrag(): void {
    this.horizontalDivider.classList.add("dragging");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    this.setMonacoPointerEvents(false);

    const onMove = (event: MouseEvent): void => {
      const rightRect = this.rightPanel.getBoundingClientRect();
      const requestedHeight = event.clientY - rightRect.top;
      const editorHeight = clampEditorHeight(requestedHeight, rightRect.height);
      this.editorSection.style.height = `${editorHeight}px`;
      this.editorSection.style.flex = "none";
      const consoleHeight = Math.max(MIN_CONSOLE_HEIGHT, Math.floor(rightRect.height - editorHeight - this.horizontalDivider.offsetHeight));
      safeLocalStorageSet(CONSOLE_HEIGHT_STORAGE_KEY, String(consoleHeight));
      this.ensureEditorContainerHeight();
    };

    const onUp = (): void => {
      this.horizontalDivider.classList.remove("dragging");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      this.setMonacoPointerEvents(true);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  private setMonacoPointerEvents(enabled: boolean): void {
    const monacoIframe = this.monacoContainer.querySelector("iframe") as HTMLElement | null;
    if (monacoIframe) {
      monacoIframe.style.pointerEvents = enabled ? "" : "none";
    }
  }
}

function bootProblemsPage(): void {
  const listLayout = document.getElementById("pl-layout");
  const problemLayout = document.getElementById("pv-layout");
  if (!listLayout || !problemLayout) {
    return;
  }

  try {
    const app = new ProblemsPageApp();
    void app.init().catch((error) => {
      console.error("Problems page initialization failed.", error);
      document.body.classList.remove("pv-body");
      listLayout.hidden = false;
      problemLayout.hidden = true;
      const nav = document.getElementById("site-nav");
      const footer = document.getElementById("site-footer");
      if (nav) {
        (nav as HTMLElement).hidden = false;
      }
      if (footer) {
        (footer as HTMLElement).hidden = false;
      }
    });
  } catch (error) {
    console.error("Problems page boot crashed.", error);
    document.body.classList.remove("pv-body");
    listLayout.hidden = false;
    problemLayout.hidden = true;
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootProblemsPage, { once: true });
  } else {
    bootProblemsPage();
  }
}

import "./auth-page";
import { getSession, type UserSession } from "./auth";
import { show as showAuthModal } from "./auth-page";
import { initFooter } from "./footer";
import { escapeHtml } from "./format";
import { initNav } from "./nav";
import type {
  Difficulty,
  Problem,
  ProblemProgress,
  ProblemSubmission,
  ProblemTag,
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
import { formatProblemDiffValue, runAll, runVisible, type RunResult, type RunSummary } from "./problem-runner";
import { WasmRuntime } from "./wasm-runtime";

export { escapeHtml };

type LeftTab = "description" | "hints" | "editorial" | "submissions";
type ConsoleTab = "testcase" | "result";

type MonacoEditorInstance = {
  getValue(): string;
  setValue(value: string): void;
  updateOptions(options: Record<string, unknown>): void;
  layout(): void;
  focus(): void;
  dispose(): void;
  onDidChangeModelContent(listener: () => void): { dispose(): void };
};

type MonacoApi = {
  languages: {
    register(configuration: { id: string }): void;
    setMonarchTokensProvider(languageId: string, provider: Record<string, unknown>): void;
    setLanguageConfiguration(languageId: string, configuration: Record<string, unknown>): void;
  };
  editor: {
    create(container: HTMLElement, options: Record<string, unknown>): MonacoEditorInstance;
    defineTheme(name: string, theme: Record<string, unknown>): void;
    setTheme(name: string): void;
  };
};

type MonacoRequire = {
  (modules: string[], onLoad: () => void, onError?: (error: unknown) => void): void;
  config(config: { paths: Record<string, string> }): void;
};

type FilterState = {
  search: string;
  difficulty: "" | Difficulty;
  status: "" | "solved" | "attempted" | "unsolved";
  tag: "" | ProblemTag;
};

type SubmissionTone = "accepted" | "wrong" | "error" | "tle";

const MONACO_CDN =
  "https://cdnjs.cloudflare.com/ajax/libs/" +
  "monaco-editor/0.44.0/min/vs";

export const MONACO_THEME_NAME = "riscv-dark";
export const RISCV_LANGUAGE_ID = "riscv";

export const RISCV_KEYWORDS = [
  "add", "addi", "sub", "lui", "auipc",
  "and", "andi", "or", "ori", "xor", "xori",
  "sll", "slli", "srl", "srli", "sra", "srai",
  "slt", "slti", "sltu", "sltiu",
  "lw", "lh", "lb", "lhu", "lbu",
  "sw", "sh", "sb",
  "beq", "bne", "blt", "bge", "bltu", "bgeu",
  "jal", "jalr",
  "mul", "mulh", "mulhu", "mulhsu",
  "div", "divu", "rem", "remu",
  "ecall", "ebreak",
  "li", "mv", "la", "nop", "j", "ret", "call",
  "neg", "not", "seqz", "snez", "sltz", "sgtz",
];

export const RISCV_REGISTERS = [
  "x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7",
  "x8", "x9", "x10", "x11", "x12", "x13", "x14", "x15",
  "x16", "x17", "x18", "x19", "x20", "x21", "x22", "x23",
  "x24", "x25", "x26", "x27", "x28", "x29", "x30", "x31",
  "zero", "ra", "sp", "gp", "tp",
  "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7",
  "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11",
  "t0", "t1", "t2", "t3", "t4", "t5", "t6",
  "fp",
];

const RISCV_DIRECTIVES = [
  ".text", ".data", ".word", ".byte", ".half",
  ".ascii", ".asciz", ".space", ".align", ".globl",
  ".section", ".string",
];

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
const VERDICT_DISMISS_MS = 8000;
const DEFAULT_LEFT_RATIO = 0.4;
const DEFAULT_CONSOLE_HEIGHT = 200;
const MIN_LEFT_WIDTH = 280;
const MAX_LEFT_RATIO = 0.65;
const MIN_EDITOR_HEIGHT = 120;
const MIN_CONSOLE_HEIGHT = 80;

export function buildRiscvLanguageDefinition(): Record<string, unknown> {
  return {
    defaultToken: "",
    keywords: RISCV_KEYWORDS,
    registers: RISCV_REGISTERS,
    directives: RISCV_DIRECTIVES,
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/^[A-Za-z_][A-Za-z0-9_.]*(?=\s*:)/, "type"],
        [/[A-Za-z_][A-Za-z0-9_.]*(?=\s*:)/, "type"],
        [
          /\.[a-z]+/,
          {
            cases: {
              "@directives": "string",
              "@default": "string",
            },
          },
        ],
        [
          /[A-Za-z_][A-Za-z0-9_.]*/,
          {
            cases: {
              "@keywords": "keyword",
              "@registers": "variable",
              "@default": "identifier",
            },
          },
        ],
        [/0x[0-9a-fA-F]+/, "number"],
        [/-?[0-9]+/, "number"],
        [/[,:()[\]]/, "operator"],
        [/\s+/, ""],
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

export function getCurrentProblemId(search = typeof window !== "undefined" ? window.location.search : ""): string | null {
  return new URLSearchParams(search).get("id");
}

export function getCurrentProblem(search = typeof window !== "undefined" ? window.location.search : ""): Problem | null {
  return getProblem(getCurrentProblemId(search)) ?? null;
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

  const colors = ["#2D6BE4", "#22c55e", "#f59e0b", "#a855f7", "#ef4444", "#06b6d4"];
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

let monacoPromise: Promise<MonacoApi> | null = null;
let riscLanguageDefined = false;

function monacoHost(): Window & { monaco?: MonacoApi; require?: MonacoRequire } {
  return window as Window & { monaco?: MonacoApi; require?: MonacoRequire };
}

function defineMonacoTheme(monaco: MonacoApi): void {
  monaco.editor.defineTheme(MONACO_THEME_NAME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6a9955", fontStyle: "italic" },
      { token: "keyword", foreground: "569cd6", fontStyle: "bold" },
      { token: "variable", foreground: "9cdcfe" },
      { token: "number", foreground: "b5cea8" },
      { token: "type", foreground: "4ec9b0" },
      { token: "string", foreground: "ce9178" },
      { token: "operator", foreground: "d4d4d4" },
    ],
    colors: {
      "editor.background": "#1e1e1e",
      "editor.foreground": "#d4d4d4",
      "editor.lineHighlightBackground": "#2a2d2e",
      "editor.lineHighlightBorder": "#282828",
      "editorLineNumber.foreground": "#858585",
      "editorLineNumber.activeForeground": "#c6c6c6",
      "editor.selectionBackground": "#264f78",
      "editor.inactiveSelectionBackground": "#3a3d41",
      "editorCursor.foreground": "#aeafad",
      "editorCursor.background": "#000000",
      "editor.findMatchBackground": "#515c6a",
      "editorBracketMatch.background": "#0064001a",
      "editorBracketMatch.border": "#888888",
      "editorGutter.background": "#1e1e1e",
      "scrollbar.shadow": "#000000",
      "scrollbarSlider.background": "#79797966",
      "scrollbarSlider.hoverBackground": "#646464b3",
      "scrollbarSlider.activeBackground": "#bfbfbf66",
    },
  });
}

function defineRISCVLanguage(monaco: MonacoApi): void {
  if (riscLanguageDefined) {
    return;
  }

  monaco.languages.register({ id: RISCV_LANGUAGE_ID });
  monaco.languages.setMonarchTokensProvider(RISCV_LANGUAGE_ID, buildRiscvLanguageDefinition());
  monaco.languages.setLanguageConfiguration(RISCV_LANGUAGE_ID, {
    comments: {
      lineComment: "#",
    },
    brackets: [
      ["(", ")"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
    ],
    surroundingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
    ],
  });

  riscLanguageDefined = true;
}

function loadMonaco(): Promise<MonacoApi> {
  const host = monacoHost();

  if (host.monaco) {
    defineMonacoTheme(host.monaco);
    defineRISCVLanguage(host.monaco);
    return Promise.resolve(host.monaco);
  }

  if (monacoPromise) {
    return monacoPromise;
  }

  monacoPromise = new Promise<MonacoApi>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Monaco load timeout"));
    }, 15000);

    const onLoad = (): void => {
      const requireJs = host.require;
      if (!requireJs) {
        window.clearTimeout(timeout);
        reject(new Error("Monaco AMD loader unavailable"));
        return;
      }

      requireJs.config({
        paths: { vs: MONACO_CDN },
      });

      requireJs(
        ["vs/editor/editor.main"],
        () => {
          window.clearTimeout(timeout);
          if (!host.monaco) {
            reject(new Error("Monaco failed to expose the editor API"));
            return;
          }
          defineMonacoTheme(host.monaco);
          defineRISCVLanguage(host.monaco);
          resolve(host.monaco);
        },
        (error) => {
          window.clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    };

    const existingLoader = document.querySelector<HTMLScriptElement>("script[data-monaco-loader='1']");
    if (existingLoader) {
      if (host.require) {
        onLoad();
      } else {
        existingLoader.addEventListener("load", onLoad, { once: true });
      }
      return;
    }

    const script = document.createElement("script");
    script.src = `${MONACO_CDN}/loader.js`;
    script.async = true;
    script.dataset.monacoLoader = "1";
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener(
      "error",
      () => {
        window.clearTimeout(timeout);
        reject(new Error("Monaco CDN load failed"));
      },
      { once: true }
    );
    document.head.appendChild(script);
  });

  return monacoPromise;
}

function createMonacoEditor(monaco: MonacoApi, container: HTMLElement, code: string): MonacoEditorInstance {
  monaco.editor.setTheme(MONACO_THEME_NAME);
  return monaco.editor.create(container, {
    value: code,
    language: RISCV_LANGUAGE_ID,
    theme: MONACO_THEME_NAME,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Geist Mono', 'Cascadia Code', monospace",
    fontLigatures: true,
    fontSize: 14,
    lineHeight: 22,
    tabSize: 2,
    insertSpaces: true,
    detectIndentation: false,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: "all",
    cursorBlinking: "blink",
    cursorStyle: "line",
    cursorWidth: 2,
    smoothScrolling: true,
    automaticLayout: true,
    padding: { top: 16, bottom: 20 },
    lineNumbers: "on",
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: false,
    renderWhitespace: "none",
    wordWrap: "off",
    scrollbar: {
      vertical: "auto",
      horizontal: "auto",
      verticalScrollbarSize: 6,
      horizontalScrollbarSize: 6,
    },
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    matchBrackets: "always",
    bracketPairColorization: { enabled: false },
    contextmenu: true,
    quickSuggestions: false,
    parameterHints: { enabled: false },
    suggestOnTriggerCharacters: false,
    acceptSuggestionOnEnter: "off",
    tabCompletion: "off",
    wordBasedSuggestions: "off",
  });
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
  private readonly solvedStat = document.getElementById("pl-stat-solved") as HTMLElement;
  private readonly attemptedStat = document.getElementById("pl-stat-attempted") as HTMLElement;
  private readonly totalStat = document.getElementById("pl-stat-total") as HTMLElement;

  private readonly problemLayout = document.getElementById("pv-layout") as HTMLElement;
  private readonly backLink = document.getElementById("pv-back-link") as HTMLAnchorElement;
  private readonly crumbDifficulty = document.getElementById("pv-crumb-difficulty") as HTMLElement;
  private readonly crumbTitle = document.getElementById("pv-crumb-title") as HTMLElement;
  private readonly prevButton = document.getElementById("pv-prev") as HTMLButtonElement;
  private readonly nextButton = document.getElementById("pv-next") as HTMLButtonElement;
  private readonly timer = document.getElementById("pv-timer") as HTMLElement;
  private readonly fullscreenButton = document.getElementById("pv-fullscreen-btn") as HTMLButtonElement;

  private readonly main = document.getElementById("pv-main") as HTMLElement;
  private readonly leftPanel = document.getElementById("pv-left") as HTMLElement;
  private readonly leftBody = document.getElementById("pv-left-body") as HTMLElement;
  private readonly hintsBadge = document.getElementById("pv-hints-badge") as HTMLElement;
  private readonly verticalDivider = document.getElementById("pv-divider-v") as HTMLElement;

  private readonly rightPanel = document.getElementById("pv-right") as HTMLElement;
  private readonly editorSection = document.getElementById("pv-editor-section") as HTMLElement;
  private readonly editorHeader = document.getElementById("pv-editor-header") as HTMLElement;
  private readonly monacoContainer = document.getElementById("pv-monaco") as HTMLElement;
  private readonly monacoLoading = document.getElementById("pv-monaco-loading") as HTMLElement;
  private readonly resetButton = document.getElementById("pv-reset-btn") as HTMLButtonElement;
  private readonly runButton = document.getElementById("pv-run-btn") as HTMLButtonElement;
  private readonly submitButton = document.getElementById("pv-submit-btn") as HTMLButtonElement;
  private readonly horizontalDivider = document.getElementById("pv-divider-h") as HTMLElement;
  private readonly consoleTabs = document.getElementById("pv-console-tabs") as HTMLElement;
  private readonly consoleBody = document.getElementById("pv-console-body") as HTMLElement;
  private readonly consoleClearButton = document.getElementById("pv-console-clear") as HTMLButtonElement;
  private readonly verdict = document.getElementById("pv-verdict") as HTMLElement;
  private readonly verdictContent = document.getElementById("pv-verdict-content") as HTMLElement;
  private readonly verdictClose = document.getElementById("pv-verdict-close") as HTMLButtonElement;
  private readonly resetConfirm = document.getElementById("pv-reset-confirm") as HTMLElement;
  private readonly resetCancelButton = document.getElementById("pv-reset-cancel") as HTMLButtonElement;
  private readonly resetOkButton = document.getElementById("pv-reset-ok") as HTMLButtonElement;

  private filters: FilterState = loadFilters();
  private session: UserSession | null = null;
  private progress: ProblemProgress = loadProblemProgressForUser(null);
  private currentProblem: Problem | null = null;
  private leftTab: LeftTab = "description";
  private consoleTab: ConsoleTab = "testcase";
  private activeVisibleCaseIndex = 0;
  private latestSummary: RunSummary | null = null;
  private expandedResultCaseId: string | null = null;
  private openHintIndices = new Set<number>();
  private searchTimer: number | null = null;
  private autosaveTimer: number | null = null;
  private verdictTimer: number | null = null;
  private timerInterval: number | null = null;
  private timerSeconds = 0;
  private timerProblemId: string | null = null;
  private monaco: MonacoApi | null = null;
  private editor: MonacoEditorInstance | null = null;
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

    this.totalStat.textContent = String(this.problems.length);
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
        if (!tab || !this.currentProblem) {
          return;
        }
        this.leftTab = tab;
        this.renderLeftBody();
      });
    });

    this.consoleTabs.querySelectorAll<HTMLButtonElement>(".pv-console-tab").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.dataset.ctab as ConsoleTab | undefined;
        if (!tab || !this.currentProblem) {
          return;
        }
        this.consoleTab = tab;
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
      void this.executeRun(false);
    });
    this.submitButton.addEventListener("click", () => {
      void this.executeRun(true);
    });

    this.consoleClearButton.addEventListener("click", () => {
      this.latestSummary = null;
      this.expandedResultCaseId = null;
      this.consoleTab = "result";
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
      if (submissionRow) {
        const submissionId = submissionRow.dataset.submissionId;
        this.loadSubmissionById(submissionId ?? "");
      }
    });

    this.consoleBody.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const caseTab = target?.closest<HTMLButtonElement>(".pv-case-tab");
      if (caseTab && this.currentProblem && this.consoleTab === "testcase") {
        const caseIndex = Number.parseInt(caseTab.dataset.ci ?? "0", 10);
        this.activeVisibleCaseIndex = Number.isFinite(caseIndex) ? caseIndex : 0;
        this.renderConsoleBody();
        return;
      }

      const resultItem = target?.closest<HTMLElement>("[data-case-id]");
      if (resultItem && this.consoleTab === "result") {
        const caseId = resultItem.dataset.caseId ?? null;
        this.expandedResultCaseId = this.expandedResultCaseId === caseId ? null : caseId;
        this.renderConsoleBody();
      }
    });

    window.addEventListener("popstate", () => {
      const problemId = getCurrentProblemId();
      if (problemId) {
        void this.showProblemView(problemId, false);
      } else {
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
        this.renderLeftBody();
      }
    }
  }

  private renderList(): void {
    const filteredProblems = this.problems.filter((problem) => this.matchesFilters(problem));
    this.solvedStat.textContent = String(this.problems.filter((problem) => this.problemStatus(problem.id) === "solved").length);
    this.attemptedStat.textContent = String(this.problems.filter((problem) => this.problemStatus(problem.id) === "attempted").length);
    this.totalStat.textContent = String(this.problems.length);
    this.updateFilterUi();

    if (filteredProblems.length === 0) {
      this.tableBody.innerHTML = `
        <tr class="pl-empty-row">
          <td colspan="5">
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
    if (this.currentProblem && this.editor) {
      this.persistCurrentCode();
    }

    this.stopTimer();
    this.currentProblem = null;
    this.latestSummary = null;
    this.problemLayout.hidden = true;
    this.listLayout.hidden = false;
    (document.getElementById("problem-workspace-view") as HTMLElement | null)?.setAttribute("hidden", "");
    (document.getElementById("problems-list-view") as HTMLElement | null)?.removeAttribute("hidden");
    this.nav.hidden = false;
    this.footer.hidden = false;
    this.body.classList.remove("pv-body");
    this.verdict.hidden = true;
    this.resetConfirm.hidden = true;
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

    if (this.currentProblem && this.editor) {
      this.persistCurrentCode();
    }

    this.currentProblem = problem;
    this.leftTab = "description";
    this.consoleTab = "testcase";
    this.activeVisibleCaseIndex = 0;
    this.latestSummary = null;
    this.expandedResultCaseId = null;
    this.openHintIndices.clear();

    const entry = ensureProblemEntry(this.progress, problem);
    for (let index = 0; index < (entry.hintsRevealed ?? 0); index += 1) {
      this.openHintIndices.add(index);
    }

    this.listLayout.hidden = true;
    this.problemLayout.hidden = false;
    (document.getElementById("problems-list-view") as HTMLElement | null)?.setAttribute("hidden", "");
    (document.getElementById("problem-workspace-view") as HTMLElement | null)?.removeAttribute("hidden");
    this.nav.hidden = true;
    this.footer.hidden = true;
    this.body.classList.add("pv-body");
    this.verdict.hidden = true;
    this.resetConfirm.hidden = true;

    this.crumbDifficulty.textContent = problem.difficulty;
    this.crumbDifficulty.dataset.val = problem.difficulty;
    this.crumbTitle.textContent = problem.title;
    this.hintsBadge.textContent = String(problem.hints.length);
    this.prevButton.disabled = problem.number <= 1;
    this.nextButton.disabled = problem.number >= this.problems.length;
    document.title = `${problem.number}. ${problem.title} - StudyRISC-V`;

    this.renderLeftBody();
    this.renderConsoleBody();

    if (pushHistory) {
      window.history.pushState({ id: problem.id }, "", `/problems/?id=${encodeURIComponent(problem.id)}`);
    }

    await nextFrame();
    this.restoreVerticalSplit();
    await nextFrame();
    this.restoreHorizontalSplit();
    this.applyWorkspaceLayout();
    this.startTimer(problem.id);

    const code = loadProblemCode(problem.id) ?? entry.lastCode ?? problem.starterCode;
    void this.ensureRuntime();
    await this.ensureEditor(code);
  }

  private async ensureRuntime(): Promise<WasmRuntime> {
    this.runtimePromise ??= WasmRuntime.create();
    return this.runtimePromise;
  }

  private async ensureEditor(code: string): Promise<void> {
    this.monacoLoading.hidden = false;

    try {
      this.monaco ??= await loadMonaco();
      await nextFrame();
      this.ensureEditorContainerHeight();

      if (!this.editor) {
        this.editor = createMonacoEditor(this.monaco, this.monacoContainer, code);
        this.bindEditorAutosave();
      } else {
        this.editor.setValue(code);
        this.editor.updateOptions({ readOnly: false });
      }

      this.monacoLoading.remove();
      this.editor.layout();
      this.editor.focus();
    } catch (error) {
      console.error("Failed to initialize Monaco.", error);
      this.monacoLoading.innerHTML = `<span style="color:var(--pv-danger)">Editor failed to load: ${escapeHtml(error instanceof Error ? error.message : String(error))}</span>`;
    }
  }

  private bindEditorAutosave(): void {
    if (!this.editor || !this.currentProblem) {
      return;
    }

    this.editorChangeSubscription?.dispose();
    this.editorChangeSubscription = this.editor.onDidChangeModelContent(() => {
      if (this.autosaveTimer) {
        window.clearTimeout(this.autosaveTimer);
      }
      this.autosaveTimer = window.setTimeout(() => {
        this.persistCurrentCode();
      }, AUTO_SAVE_DELAY_MS);
    });
  }

  private persistCurrentCode(): void {
    if (!this.currentProblem || !this.editor) {
      return;
    }

    const code = this.editor.getValue();
    saveProblemCode(this.currentProblem.id, code);
    const entry = ensureProblemEntry(this.progress, this.currentProblem);
    entry.lastCode = code;
    entry.lastSavedAt = new Date().toISOString();
    saveProblemProgressForUser(this.progress, this.session?.userId ?? null);
    if (this.session) {
      void syncProblemProgressToApi(this.progress, this.session.idToken);
    }
  }

  private renderLeftBody(): void {
    if (!this.currentProblem) {
      return;
    }

    this.leftPanel.querySelectorAll<HTMLButtonElement>(".pv-tab").forEach((button) => {
      const active = button.dataset.tab === this.leftTab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });

    if (this.leftTab === "description") {
      this.leftBody.innerHTML = this.renderDescription(this.currentProblem);
      return;
    }

    if (this.leftTab === "hints") {
      this.leftBody.innerHTML = this.renderHints(this.currentProblem);
      return;
    }

    if (this.leftTab === "editorial") {
      this.leftBody.innerHTML = this.renderEditorial(this.currentProblem);
      return;
    }

    this.leftBody.innerHTML = this.renderSubmissions(this.currentProblem);
  }

  private renderDescription(problem: Problem): string {
    return `
      <div class="pv-problem-num">${problem.number}.</div>
      <h2 class="pv-problem-title">${escapeHtml(problem.title)}</h2>

      <div class="pv-problem-meta">
        <span class="pv-difficulty-badge pv-difficulty-badge--${problem.difficulty.toLowerCase()}">${escapeHtml(problem.difficulty)}</span>
        ${problem.tags.map((tag) => `<span class="pv-tag">${escapeHtml(tag)}</span>`).join("")}
        <span class="pv-meta-acceptance">${problem.acceptanceRate.toFixed(1)}% acceptance</span>
      </div>

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

  private renderHints(problem: Problem): string {
    const entry = ensureProblemEntry(this.progress, problem);
    const revealed = entry.hintsRevealed ?? 0;

    return `
      <div class="pv-hints-intro">Hints are optional. Use them when you need to unblock yourself, not before.</div>
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
          <p>Try the problem first. This space will hold the walkthrough later.</p>
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

  private renderSubmissions(problem: Problem): string {
    if (!this.session) {
      return `
        <div class="pv-submissions-empty">
          <p>Sign in to save your submissions.</p>
          <button class="pv-submissions-action" type="button" data-action="signin">Sign in</button>
          <p>You can still run and submit locally.</p>
        </div>
      `;
    }

    const entry = this.progress[problem.id];
    const submissions = [...(entry?.submissions ?? [])].sort((left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt));
    if (submissions.length === 0) {
      return `
        <div class="pv-submissions-empty">
          <p>No submissions yet.</p>
          <p>Run and submit to start building a history.</p>
        </div>
      `;
    }

    return `
      <table class="pv-submissions-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Runtime</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          ${submissions
            .map(
              (submission) => `
                <tr data-submission-id="${escapeHtml(submission.id)}">
                  <td><span class="pv-submission-verdict pv-submission-verdict--${this.submissionTone(submission.verdict)}">${escapeHtml(this.submissionLabel(submission.verdict))}</span></td>
                  <td>${escapeHtml(`${submission.stepsTaken} steps`)}</td>
                  <td>${escapeHtml(formatRelativeDate(submission.submittedAt))}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    `;
  }

  private renderConsoleBody(): void {
    if (!this.currentProblem) {
      this.consoleBody.innerHTML = "";
      return;
    }

    this.consoleTabs.querySelectorAll<HTMLButtonElement>(".pv-console-tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.ctab === this.consoleTab);
    });

    if (this.consoleTab === "testcase") {
      this.consoleBody.innerHTML = this.renderTestcaseConsole(this.currentProblem);
      return;
    }

    if (!this.latestSummary) {
      this.consoleBody.innerHTML = `<div class="pv-console-empty">Run your code to see output.</div>`;
      return;
    }

    this.consoleBody.innerHTML = this.renderResultsConsole(this.latestSummary);
  }

  private renderTestcaseConsole(problem: Problem): string {
    const visibleCases = problem.testCases.filter((testCase) => testCase.visible);
    const activeCase = visibleCases[this.activeVisibleCaseIndex] ?? visibleCases[0];
    if (!activeCase) {
      return `<div class="pv-console-empty">No visible test cases.</div>`;
    }

    const showExpected = Boolean(this.latestSummary);
    return `
      <div class="pv-case-tabs">
        ${visibleCases
          .map(
            (testCase, index) => `
              <button class="pv-case-tab ${index === this.activeVisibleCaseIndex ? "active" : ""}" data-ci="${index}" type="button">
                ${escapeHtml(testCase.label)}
              </button>
            `
          )
          .join("")}
      </div>
      ${visibleCases
        .map(
          (testCase, index) => `
            <div class="pv-case-content ${index === this.activeVisibleCaseIndex ? "active" : ""}" data-ci="${index}">
              <table class="pv-register-table">
                <thead>
                  <tr>
                    <th>Register</th>
                    <th>Initial Value</th>
                  </tr>
                </thead>
                <tbody>
                  ${Object.entries(testCase.initialRegisters)
                    .map(
                      ([registerName, value]) => `
                        <tr>
                          <td class="pv-reg-name">${escapeHtml(registerName)}</td>
                          <td class="pv-reg-val">${formatHex(value ?? 0)}<span class="pv-reg-dec">(${(value ?? 0) >> 0})</span></td>
                        </tr>
                      `
                    )
                    .join("")}
                  ${(testCase.initialMemory ?? [])
                    .map(
                      (entry) => `
                        <tr>
                          <td class="pv-reg-name">mem[${formatHex(entry.address)}]</td>
                          <td class="pv-reg-val">${formatSignedValue(entry.value, entry.size ?? "word")}</td>
                        </tr>
                      `
                    )
                    .join("")}
                </tbody>
              </table>
              ${showExpected
                ? `
                    <div class="pv-section-head">Expected Output</div>
                    <table class="pv-register-table">
                      <thead>
                        <tr>
                          <th>Register</th>
                          <th>Expected Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${Object.entries(testCase.expectedRegisters)
                          .map(
                            ([registerName, value]) => `
                              <tr>
                                <td class="pv-reg-name">${escapeHtml(registerName)}</td>
                                <td class="pv-reg-val">${formatHex(value ?? 0)}<span class="pv-reg-dec">(${(value ?? 0) >> 0})</span></td>
                              </tr>
                            `
                          )
                          .join("")}
                        ${(testCase.expectedMemory ?? [])
                          .map(
                            (entry) => `
                              <tr>
                                <td class="pv-reg-name">mem[${formatHex(entry.address)}]</td>
                                <td class="pv-reg-val">${formatSignedValue(entry.value, entry.size ?? "word")}</td>
                              </tr>
                            `
                          )
                          .join("")}
                      </tbody>
                    </table>
                  `
                : ""}
            </div>
          `
        )
        .join("")}
    `;
  }

  private renderResultsConsole(summary: RunSummary): string {
    const caseMap = new Map(this.currentProblem?.testCases.map((testCase) => [testCase.id, testCase]) ?? []);

    return `
      ${summary.verdict === "Accepted"
        ? `<div class="pv-all-pass-banner">✓ Passed ${summary.passedCount}/${summary.totalCount} test cases</div>`
        : ""}
      <div class="pv-result-list">
        ${summary.results
          .map((result) => {
            const visible = caseMap.get(result.caseId)?.visible ?? true;
            const expanded = this.expandedResultCaseId === result.caseId;
            const diffMarkup = this.renderResultDiff(result, visible, expanded);
            return `
              <div class="pv-result-item ${result.passed ? "pass" : "fail"}" data-case-id="${escapeHtml(result.caseId)}">
                <span class="pv-result-icon ${result.passed ? "pass" : "fail"}">${result.passed ? "✓" : "✗"}</span>
                <span class="pv-result-label">${escapeHtml(result.label)}</span>
                <span class="pv-result-steps">${escapeHtml(`${result.stepsTaken} steps`)}</span>
              </div>
              ${diffMarkup}
            `;
          })
          .join("")}
      </div>
    `;
  }

  private renderResultDiff(result: RunResult, visible: boolean, expanded: boolean): string {
    const classes = `pv-result-diff${expanded ? " is-open" : ""}`;
    if (result.passed) {
      return `<div class="${classes}"></div>`;
    }

    if (!visible) {
      return `
        <div class="${classes}">
          <div class="pv-error-block">
            Hidden test case feedback is withheld on submit. Use the visible cases to debug, then try again.
          </div>
        </div>
      `;
    }

    if (result.errorMessage) {
      const label = result.timedOut ? "Time Limit" : result.verdict === "Assembly Error" ? "Assembly Error" : "Runtime Error";
      return `
        <div class="${classes}">
          <div class="pv-asm-error">
            <div class="pv-asm-error__line">${escapeHtml(label)}</div>
            <div class="pv-asm-error__msg">${escapeHtml(result.errorMessage)}</div>
          </div>
        </div>
      `;
    }

    return `
      <div class="${classes}">
        <div class="pv-diff-row">
          <span class="pv-diff-label"></span>
          <span class="pv-text-caption">Expected</span>
          <span class="pv-text-caption">Actual</span>
        </div>
        ${result.diff
          .map(
            (diff) => `
              <div class="pv-diff-row">
                <span class="pv-diff-label">${escapeHtml(diff.key)}</span>
                <span class="pv-diff-expected">${escapeHtml(formatProblemDiffValue(diff.expected))}</span>
                <span class="pv-diff-actual">${escapeHtml(formatProblemDiffValue(diff.actual))}</span>
              </div>
            `
          )
          .join("")}
      </div>
    `;
  }

  private clearConsole(): void {
    this.consoleBody.innerHTML = "";
  }

  private showConsoleStatus(message: string): void {
    this.consoleTab = "result";
    this.consoleBody.innerHTML = `<div class="pv-console-empty" style="text-align:left">${escapeHtml(message)}</div>`;
    this.consoleTabs.querySelectorAll<HTMLButtonElement>(".pv-console-tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.ctab === "result");
    });
  }

  private showConsoleError(message: string): void {
    this.consoleTab = "result";
    this.consoleTabs.querySelectorAll<HTMLButtonElement>(".pv-console-tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.ctab === "result");
    });
    this.consoleBody.innerHTML = `
      <div class="pv-asm-error">
        <div class="pv-asm-error__line">Error</div>
        <div class="pv-asm-error__msg">${escapeHtml(message)}</div>
      </div>
    `;
  }

  private async executeRun(isSubmit: boolean): Promise<void> {
    if (!this.currentProblem || !this.editor || this.running) {
      return;
    }

    const source = this.editor.getValue();
    if (!source.trim()) {
      this.showConsoleError("Editor is empty.");
      return;
    }

    let runtime: WasmRuntime;
    try {
      runtime = await this.ensureRuntime();
    } catch (error) {
      this.showConsoleError(error instanceof Error ? error.message : "Runtime not ready. Please wait.");
      return;
    }

    this.running = true;
    this.runButton.classList.add("is-loading");
    this.submitButton.classList.add("is-loading");
    this.editor.updateOptions({ readOnly: true });
    this.resetConfirm.hidden = true;
    this.clearConsole();
    this.showConsoleStatus(isSubmit ? "Running all test cases..." : "Running visible test cases...");

    try {
      const summary = isSubmit
        ? await runAll(source, this.currentProblem, runtime)
        : await runVisible(source, this.currentProblem, runtime);

      this.latestSummary = summary;
      this.expandedResultCaseId = summary.firstFailedResult?.caseId ?? null;
      this.consoleTab = "result";
      this.renderConsoleBody();

      if (isSubmit) {
        this.persistCurrentCode();
        this.saveSubmission(summary, source);
        this.showVerdict(summary);
        if (summary.verdict === "Accepted") {
          this.stopTimer();
        }
      }
    } catch (error) {
      this.showConsoleError(error instanceof Error ? error.message : "Execution failed.");
    } finally {
      this.running = false;
      this.runButton.classList.remove("is-loading");
      this.submitButton.classList.remove("is-loading");
      this.editor.updateOptions({ readOnly: false });
    }
  }

  private saveSubmission(summary: RunSummary, source: string): void {
    if (!this.currentProblem) {
      return;
    }

    const entry = ensureProblemEntry(this.progress, this.currentProblem);
    const submission: ProblemSubmission = {
      id: `${this.currentProblem.id}-${Date.now()}`,
      problemId: this.currentProblem.id,
      code: source,
      verdict: summary.verdict,
      passedCases: summary.passedCount,
      totalCases: summary.totalCount,
      stepsTaken: summary.totalSteps,
      submittedAt: new Date().toISOString(),
      failedCaseId: summary.firstFailedResult?.caseId,
      errorMessage: summary.firstFailedResult?.errorMessage,
      elapsedMs: this.timerSeconds * 1000,
    };

    entry.status = summary.verdict === "Accepted" ? "solved" : "attempted";
    entry.submissions = [submission, ...entry.submissions];
    entry.lastCode = source;
    entry.lastSavedAt = submission.submittedAt;
    saveProblemCode(this.currentProblem.id, source);
    saveProblemProgressForUser(this.progress, this.session?.userId ?? null);

    if (this.session) {
      void syncProblemProgressToApi(this.progress, this.session.idToken);
      void saveProblemSubmissionToApi(submission, this.session.idToken);
    }

    if (this.leftTab === "submissions") {
      this.renderLeftBody();
    }
    this.renderList();
  }

  private showVerdict(summary: RunSummary): void {
    renderVerdictBanner(this.verdict, this.verdictContent, summary);
    this.syncVerdictOffset();
    if (this.verdictTimer) {
      window.clearTimeout(this.verdictTimer);
    }
    this.verdictTimer = window.setTimeout(() => {
      this.verdict.hidden = true;
    }, VERDICT_DISMISS_MS);
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

  private loadSubmissionById(submissionId: string): void {
    if (!this.currentProblem || !this.editor || !submissionId) {
      return;
    }

    const entry = this.progress[this.currentProblem.id];
    const submission = entry?.submissions.find((candidate) => candidate.id === submissionId);
    if (!submission || !submission.code.trim()) {
      return;
    }

    const confirmed = window.confirm("Load this submission? Your current code will be replaced.");
    if (!confirmed) {
      return;
    }

    this.editor.setValue(submission.code);
    this.persistCurrentCode();
  }

  private submissionTone(verdict: ProblemVerdict): SubmissionTone {
    switch (verdict) {
      case "Accepted":
        return "accepted";
      case "Wrong Answer":
        return "wrong";
      case "Time Limit Exceeded":
        return "tle";
      default:
        return "error";
    }
  }

  private submissionLabel(verdict: ProblemVerdict): string {
    switch (verdict) {
      case "Accepted":
        return "Accepted";
      case "Wrong Answer":
        return "Wrong Answer";
      case "Runtime Error":
        return "Runtime Error";
      case "Time Limit Exceeded":
        return "Time Limit";
      case "Assembly Error":
        return "Assembly Error";
    }
  }

  private restoreStarterCode(): void {
    if (!this.currentProblem || !this.editor) {
      return;
    }

    this.editor.setValue(this.currentProblem.starterCode);
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
    this.editor?.layout();
  }

  private ensureEditorContainerHeight(): void {
    const editorSectionRect = this.editorSection.getBoundingClientRect();
    const editorHeaderRect = this.editorHeader.getBoundingClientRect();
    const height = Math.max(MIN_EDITOR_HEIGHT, Math.floor(editorSectionRect.height - editorHeaderRect.height));
    this.monacoContainer.style.height = `${height}px`;
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
      this.editor?.layout();
    };

    const onUp = (): void => {
      this.verticalDivider.classList.remove("dragging");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      this.setMonacoPointerEvents(true);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      this.editor?.layout();
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
      this.editor?.layout();
    };

    const onUp = (): void => {
      this.horizontalDivider.classList.remove("dragging");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      this.setMonacoPointerEvents(true);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      this.editor?.layout();
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

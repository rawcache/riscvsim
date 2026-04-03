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
import { formatProblemDiffValue, runAll, runVisible, type RunResult, type RunSummary } from "./problem-runner";
import { WasmRuntime } from "./wasm-runtime";

type LeftTab = "description" | "hints" | "editorial" | "submissions";
type ConsoleTab = "testcase" | "result";

type MonacoEditorInstance = {
  getValue(): string;
  setValue(value: string): void;
  updateOptions(options: Record<string, unknown>): void;
  layout(): void;
  focus?(): void;
  dispose(): void;
  onDidChangeModelContent(listener: () => void): { dispose(): void };
};

type MonacoApi = {
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

type TimerState = {
  elapsedMs: number;
  runningSince: number | null;
  stopped: boolean;
};

const DEFAULT_FILTER_STATE: FilterState = {
  search: "",
  difficulty: "",
  status: "",
  tag: "",
};

const MONACO_CDN =
  "https://cdnjs.cloudflare.com/ajax/libs/" +
  "monaco-editor/0.44.0/min/vs";

const FILTER_STORAGE_KEY = "problems_filters";
const LIST_SCROLL_STORAGE_KEY = "problems_list_scroll";
const PANEL_SPLIT_STORAGE_KEY = "problems_panel_split";
const CONSOLE_HEIGHT_STORAGE_KEY = "problems_console_height";
const FULLSCREEN_STORAGE_KEY = "problems_fullscreen";
const SHORTCUTS_SEEN_STORAGE_KEY = "problems_shortcuts_seen";
const AUTO_SAVE_DELAY_MS = 2000;
const BANNER_DISMISS_MS = 6000;

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

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

function runShortcutLabel(): string {
  return isMacPlatform() ? "⌘↵" : "Ctrl+↵";
}

function submitShortcutLabel(): string {
  return isMacPlatform() ? "⌘⇧↵" : "Ctrl+Shift+↵";
}

function prevShortcutLabel(): string {
  return isMacPlatform() ? "⌘[" : "Ctrl+[";
}

function nextShortcutLabel(): string {
  return isMacPlatform() ? "⌘]" : "Ctrl+]";
}

function consoleShortcutLabel(): string {
  return isMacPlatform() ? "⌘J" : "Ctrl+J";
}

function monacoWindow(): Window & { monaco?: MonacoApi; require?: MonacoRequire } {
  return window as Window & { monaco?: MonacoApi; require?: MonacoRequire };
}

function toUint32(value: number): number {
  return value >>> 0;
}

function signed32(value: number): number {
  return value >> 0;
}

function formatValue(value: number, size: "byte" | "half" | "word" = "word"): string {
  const normalized = toUint32(value);
  const masked = size === "byte" ? normalized & 0xff : size === "half" ? normalized & 0xffff : normalized;
  const width = size === "byte" ? 2 : size === "half" ? 4 : 8;
  return `0x${masked.toString(16).padStart(width, "0")} (${signed32(masked)})`;
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

function formatTimer(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatElapsedCompact(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function cssColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function rgba(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    const normalized =
      color.length === 4
        ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
        : color;
    const red = Number.parseInt(normalized.slice(1, 3), 16);
    const green = Number.parseInt(normalized.slice(3, 5), 16);
    const blue = Number.parseInt(normalized.slice(5, 7), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  const match = color.match(/(\d+)\D+(\d+)\D+(\d+)/u);
  if (match) {
    return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
  }

  return color;
}

function loadTimerState(problemId: string): TimerState {
  if (typeof sessionStorage === "undefined") {
    return {
      elapsedMs: 0,
      runningSince: Date.now(),
      stopped: false,
    };
  }

  const raw = safeSessionStorageGet(`problems_timer_${problemId}`);
  if (!raw) {
    return {
      elapsedMs: 0,
      runningSince: document.visibilityState === "hidden" ? null : Date.now(),
      stopped: false,
    };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<TimerState>;
    return {
      elapsedMs: typeof parsed.elapsedMs === "number" && Number.isFinite(parsed.elapsedMs) ? Math.max(0, parsed.elapsedMs) : 0,
      runningSince:
        typeof parsed.runningSince === "number" && Number.isFinite(parsed.runningSince) ? parsed.runningSince : document.visibilityState === "hidden" ? null : Date.now(),
      stopped: parsed.stopped === true,
    };
  } catch {
    return {
      elapsedMs: 0,
      runningSince: document.visibilityState === "hidden" ? null : Date.now(),
      stopped: false,
    };
  }
}

function saveTimerState(problemId: string, timerState: TimerState): void {
  safeSessionStorageSet(`problems_timer_${problemId}`, JSON.stringify(timerState));
}

function timerElapsedMs(timerState: TimerState): number {
  return timerState.elapsedMs + (timerState.runningSince ? Date.now() - timerState.runningSince : 0);
}

function pauseTimer(problemId: string, timerState: TimerState): void {
  if (timerState.runningSince) {
    timerState.elapsedMs += Date.now() - timerState.runningSince;
    timerState.runningSince = null;
    saveTimerState(problemId, timerState);
  }
}

function resumeTimer(problemId: string, timerState: TimerState): void {
  if (!timerState.runningSince && !timerState.stopped) {
    timerState.runningSince = Date.now();
    saveTimerState(problemId, timerState);
  }
}

function stopTimer(problemId: string, timerState: TimerState): void {
  pauseTimer(problemId, timerState);
  timerState.stopped = true;
  saveTimerState(problemId, timerState);
}

function loadFilterState(): FilterState {
  if (typeof sessionStorage === "undefined") {
    return { ...DEFAULT_FILTER_STATE };
  }

  const raw = safeSessionStorageGet(FILTER_STORAGE_KEY);
  if (!raw) {
    return { ...DEFAULT_FILTER_STATE };
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
    return { ...DEFAULT_FILTER_STATE };
  }
}

function saveFilterState(filters: FilterState): void {
  safeSessionStorageSet(FILTER_STORAGE_KEY, JSON.stringify(filters));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function problemFromUrl(): Problem | null {
  if (typeof window === "undefined") {
    return null;
  }
  return getProblem(new URL(window.location.href).searchParams.get("id")) ?? null;
}

function activeVisibleCases(problem: Problem): ProblemTestCase[] {
  return problem.testCases.filter((testCase) => testCase.visible);
}

function difficultyClass(difficulty: Difficulty): string {
  return difficulty.toLowerCase();
}

function verdictText(verdict: ProblemVerdict): string {
  switch (verdict) {
    case "Accepted":
      return "✓ Accepted";
    case "Wrong Answer":
      return "✗ Wrong Answer";
    case "Runtime Error":
      return "⚠ Runtime Error";
    case "Time Limit Exceeded":
      return "⏱ Time Limit";
    case "Assembly Error":
      return "✗ Assembly Error";
  }
}

let monacoPromise: Promise<MonacoApi> | null = null;

function loadMonaco(): Promise<MonacoApi> {
  const monacoHost = monacoWindow();

  if (monacoHost.monaco) {
    return Promise.resolve(monacoHost.monaco);
  }
  if (monacoPromise) {
    return monacoPromise;
  }

  monacoPromise = new Promise<MonacoApi>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Monaco failed to load within 10 seconds."));
    }, 10000);

    const onReady = (): void => {
      window.clearTimeout(timeout);
      if (!monacoHost.monaco) {
        reject(new Error("Monaco loaded without exposing the editor API."));
        return;
      }
      resolve(monacoHost.monaco);
    };

    const bootstrap = (): void => {
      const requireJs = monacoHost.require;
      if (!requireJs) {
        reject(new Error("Monaco AMD loader was not available."));
        return;
      }
      requireJs.config({
        paths: { vs: MONACO_CDN },
      });
      requireJs(
        ["vs/editor/editor.main"],
        () => onReady(),
        (error) => {
          window.clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    };

    const existingLoader = document.querySelector<HTMLScriptElement>("script[data-monaco-loader='1']");
    if (existingLoader) {
      if (monacoHost.require) {
        bootstrap();
      } else {
        existingLoader.addEventListener("load", () => bootstrap(), { once: true });
      }
      return;
    }

    const script = document.createElement("script");
    script.src = `${MONACO_CDN}/loader.min.js`;
    script.async = true;
    script.dataset.monacoLoader = "1";
    script.addEventListener("load", () => bootstrap(), { once: true });
    script.addEventListener(
      "error",
      () => {
        window.clearTimeout(timeout);
        reject(new Error("Failed to load Monaco AMD loader."));
      },
      { once: true }
    );
    document.head.appendChild(script);
  });

  return monacoPromise;
}

function applyMonacoTheme(monaco: MonacoApi): void {
  const dark = document.documentElement.dataset.theme === "dark";
  monaco.editor.defineTheme("studyriscv-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": cssColor("--bg-base"),
      "editor.foreground": cssColor("--text-primary"),
      "editor.lineHighlightBackground": cssColor("--bg-surface"),
      "editorLineNumber.foreground": cssColor("--text-muted"),
      "editorLineNumber.activeForeground": cssColor("--text-secondary"),
      "editor.selectionBackground": rgba(cssColor("--accent"), 0.25),
      "editor.inactiveSelectionBackground": rgba(cssColor("--accent"), 0.14),
      "editorCursor.foreground": cssColor("--accent"),
      "editorGutter.background": cssColor("--bg-base"),
    },
  });
  monaco.editor.setTheme(dark ? "studyriscv-dark" : "vs");
}

function initEditor(container: HTMLElement, monaco: MonacoApi, code: string): MonacoEditorInstance {
  applyMonacoTheme(monaco);
  return monaco.editor.create(container, {
    value: code,
    language: "plaintext",
    theme: document.documentElement.dataset.theme === "dark" ? "studyriscv-dark" : "vs",
    fontFamily: "'Geist Mono', 'Fira Code', monospace",
    fontSize: 14,
    lineHeight: 22,
    tabSize: 2,
    insertSpaces: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: "all",
    cursorBlinking: "smooth",
    smoothScrolling: true,
    automaticLayout: true,
    padding: { top: 16, bottom: 16 },
    lineNumbers: "on",
    glyphMargin: false,
    folding: false,
    renderWhitespace: "selection",
    wordWrap: "off",
  });
}

function initFallbackEditor(container: HTMLElement, code: string): MonacoEditorInstance {
  container.innerHTML = "";
  const textarea = document.createElement("textarea");
  textarea.className = "pv-editor-fallback";
  textarea.spellcheck = false;
  textarea.value = code;
  container.appendChild(textarea);

  const listeners = new Set<() => void>();
  const notify = (): void => {
    listeners.forEach((listener) => listener());
  };

  textarea.addEventListener("input", notify);

  return {
    getValue(): string {
      return textarea.value;
    },
    setValue(value: string): void {
      textarea.value = value;
    },
    updateOptions(options: Record<string, unknown>): void {
      if ("readOnly" in options) {
        textarea.readOnly = options.readOnly === true;
      }
    },
    layout(): void {
      // Native textarea handles layout through CSS sizing.
    },
    focus(): void {
      textarea.focus();
    },
    dispose(): void {
      textarea.removeEventListener("input", notify);
      textarea.remove();
      listeners.clear();
    },
    onDidChangeModelContent(listener: () => void): { dispose(): void } {
      listeners.add(listener);
      return {
        dispose(): void {
          listeners.delete(listener);
        },
      };
    },
  };
}

class ProblemsApp {
  private readonly listView = document.getElementById("problems-list-view") as HTMLElement;
  private readonly footer = document.getElementById("site-footer") as HTMLElement;
  private readonly solvedStat = document.getElementById("pl-stat-solved") as HTMLElement;
  private readonly attemptedStat = document.getElementById("pl-stat-attempted") as HTMLElement;
  private readonly totalStat = document.getElementById("pl-stat-total") as HTMLElement;
  private readonly searchInput = document.getElementById("pl-search") as HTMLInputElement;
  private readonly difficultyFilter = document.getElementById("pl-difficulty") as HTMLSelectElement;
  private readonly statusFilter = document.getElementById("pl-status") as HTMLSelectElement;
  private readonly tagFilter = document.getElementById("pl-tag") as HTMLSelectElement;
  private readonly clearFiltersButton = document.getElementById("pl-clear") as HTMLButtonElement;
  private readonly tableBody = document.getElementById("pl-tbody") as HTMLElement;

  private readonly problemView = document.getElementById("pv-layout") as HTMLElement;
  private readonly panels = document.getElementById("pv-panels") as HTMLElement;
  private readonly leftPanel = document.getElementById("pv-left") as HTMLElement;
  private readonly rightPanel = document.getElementById("pv-right") as HTMLElement;
  private readonly dividerV = document.getElementById("pv-divider-v") as HTMLElement;
  private readonly dividerH = document.getElementById("pv-divider-h") as HTMLElement;
  private readonly topbarNum = document.getElementById("pv-topbar-num") as HTMLElement;
  private readonly topbarTitle = document.getElementById("pv-topbar-title") as HTMLElement;
  private readonly topbarDifficulty = document.getElementById("pv-topbar-difficulty") as HTMLElement;
  private readonly topbarTags = document.getElementById("pv-topbar-tags") as HTMLElement;
  private readonly timerValue = document.getElementById("pv-timer") as HTMLElement;
  private readonly backButton = document.getElementById("pv-back-btn") as HTMLButtonElement;
  private readonly prevButton = document.getElementById("pv-prev-btn") as HTMLButtonElement;
  private readonly nextButton = document.getElementById("pv-next-btn") as HTMLButtonElement;
  private readonly shortcutsButton = document.getElementById("pv-shortcuts-btn") as HTMLButtonElement;
  private readonly shortcutsPopover = document.getElementById("pv-shortcuts-popover") as HTMLElement;
  private readonly leftContent = document.getElementById("pv-left-content") as HTMLElement;
  private readonly hintCount = document.getElementById("pv-hint-count") as HTMLElement;
  private readonly editorRoot = document.getElementById("pv-editor") as HTMLElement;
  private readonly editorStage = document.getElementById("pv-editor-stage") as HTMLElement;
  private readonly editorLoading = document.getElementById("pv-editor-loading") as HTMLElement;
  private readonly autosaveIndicator = document.getElementById("pv-autosave-indicator") as HTMLElement;
  private readonly resetButton = document.getElementById("pv-reset-btn") as HTMLButtonElement;
  private readonly resetConfirm = document.getElementById("pv-reset-confirm") as HTMLElement;
  private readonly resetCancelButton = document.getElementById("pv-reset-cancel") as HTMLButtonElement;
  private readonly resetOkButton = document.getElementById("pv-reset-ok") as HTMLButtonElement;
  private readonly fullscreenButton = document.getElementById("pv-fullscreen-btn") as HTMLButtonElement;
  private readonly fullscreenIcon = document.querySelector("#pv-fullscreen-icon") as SVGSVGElement;
  private readonly openSimulatorButton = document.getElementById("pv-open-sim-btn") as HTMLButtonElement;
  private readonly loadBanner = document.getElementById("pv-load-banner") as HTMLElement;
  private readonly consoleElement = document.getElementById("pv-console") as HTMLElement;
  private readonly consoleContent = document.getElementById("pv-console-content") as HTMLElement;
  private readonly consoleToggle = document.getElementById("pv-console-toggle") as HTMLButtonElement;
  private readonly runButton = document.getElementById("pv-run-btn") as HTMLButtonElement;
  private readonly submitButton = document.getElementById("pv-submit-btn") as HTMLButtonElement;
  private readonly verdictLayer = document.getElementById("pv-verdict-layer") as HTMLElement;

  private readonly problems = getProblems();
  private readonly themeObserver = new MutationObserver(() => {
    if (this.monaco) {
      applyMonacoTheme(this.monaco);
    }
  });

  private session: UserSession | null = null;
  private progress: ProblemProgress = loadProblemProgressForUser(null);
  private filters: FilterState = loadFilterState();
  private searchTimer: number | null = null;
  private autosaveTimer: number | null = null;
  private autosaveIndicatorTimer: number | null = null;
  private verdictDismissTimer: number | null = null;
  private currentProblem: Problem | null = null;
  private timerState: TimerState | null = null;
  private leftTab: LeftTab = "description";
  private consoleTab: ConsoleTab = "testcase";
  private activeVisibleCaseIndex = 0;
  private latestSummary: RunSummary | null = null;
  private expandedResultCaseId: string | null = null;
  private consoleOpen = false;
  private fullscreen = safeLocalStorageGet(FULLSCREEN_STORAGE_KEY) === "1";
  private verticalSplit = clamp(
    Number(safeLocalStorageGet(PANEL_SPLIT_STORAGE_KEY)) || 42,
    28,
    65
  );
  private consoleHeight = Number(safeLocalStorageGet(CONSOLE_HEIGHT_STORAGE_KEY)) || 220;
  private running = false;
  private monaco: MonacoApi | null = null;
  private editor: MonacoEditorInstance | null = null;
  private usingFallbackEditor = false;
  private runtimePromise: Promise<WasmRuntime> | null = null;
  private pendingSubmissionToLoad: ProblemSubmission | null = null;
  private openHints = new Set<number>();

  async init(): Promise<void> {
    initNav({ activePage: "problems" });
    initFooter();
    this.totalStat.textContent = String(this.problems.length);
    this.applyFilterControls();
    this.renderList();
    this.bindEvents();
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const initialProblem = problemFromUrl();
    if (initialProblem) {
      await this.openProblem(initialProblem.id, false);
    } else {
      this.showListView(false);
      this.restoreListScroll();
    }
    void this.refreshSessionState();
    this.startTimerTicker();
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
      this.filters = { search: "", difficulty: "", status: "", tag: "" };
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
      void this.openProblem(problemId, true);
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
      void this.openProblem(problemId, true);
    });

    document.querySelectorAll<HTMLButtonElement>("[data-left-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        this.leftTab = button.dataset.leftTab as LeftTab;
        this.renderLeftContent();
      });
    });

    document.querySelectorAll<HTMLButtonElement>("[data-console-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        this.consoleTab = button.dataset.consoleTab as ConsoleTab;
        this.renderConsoleContent();
      });
    });

    this.backButton.addEventListener("click", () => {
      if (window.history.state && typeof window.history.state === "object" && "problemId" in window.history.state) {
        window.history.back();
      } else {
        this.showListView(true);
      }
    });

    this.prevButton.addEventListener("click", () => {
      this.navigateRelative(-1);
    });
    this.nextButton.addEventListener("click", () => {
      this.navigateRelative(1);
    });

    this.shortcutsButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleShortcutsPopover();
    });

    this.resetButton.addEventListener("click", () => {
      this.resetConfirm.hidden = !this.resetConfirm.hidden;
    });
    this.resetCancelButton.addEventListener("click", () => {
      this.resetConfirm.hidden = true;
    });
    this.resetOkButton.addEventListener("click", () => {
      this.restoreStarterCode();
      this.resetConfirm.hidden = true;
    });

    this.fullscreenButton.addEventListener("click", () => {
      this.fullscreen = !this.fullscreen;
      safeLocalStorageSet(FULLSCREEN_STORAGE_KEY, this.fullscreen ? "1" : "0");
      this.applyProblemLayout();
    });

    this.openSimulatorButton.addEventListener("click", () => {
      if (!this.editor) {
        return;
      }
      const encoded = encodeURIComponent(btoa(encodeURIComponent(this.editor.getValue())));
      window.open(`/simulator/?code=${encoded}`, "_blank", "noopener");
    });

    this.consoleToggle.addEventListener("click", () => {
      this.consoleOpen = !this.consoleOpen;
      this.renderConsoleVisibility();
      this.applyProblemLayout();
    });

    this.runButton.addEventListener("click", () => {
      void this.execute("run");
    });
    this.submitButton.addEventListener("click", () => {
      void this.execute("submit");
    });

    this.leftContent.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const hintButton = target?.closest<HTMLButtonElement>("[data-hint-index]");
      if (hintButton && this.currentProblem) {
        const hintIndex = Number(hintButton.dataset.hintIndex ?? "-1");
        if (Number.isFinite(hintIndex) && hintIndex >= 0) {
          void this.toggleHint(hintIndex);
        }
        return;
      }

      const signinButton = target?.closest<HTMLButtonElement>("#pv-signin-prompt");
      if (signinButton) {
        showAuthModal({ allowClose: true });
        return;
      }

      const submissionRow = target?.closest<HTMLElement>("[data-load-submission-id]");
      if (submissionRow && this.currentProblem) {
        const submissionId = submissionRow.dataset.loadSubmissionId;
        if (!submissionId) {
          return;
        }
        const entry = this.progress[this.currentProblem.id];
        const submission = entry?.submissions.find((candidate) => candidate.id === submissionId);
        if (submission) {
          this.pendingSubmissionToLoad = submission;
          this.renderLoadBanner();
        }
      }
    });

    this.loadBanner.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".pv-load-banner__cancel")) {
        this.pendingSubmissionToLoad = null;
        this.renderLoadBanner();
        return;
      }
      if (target?.closest(".pv-load-banner__ok")) {
        this.applyPendingSubmissionLoad();
      }
    });

    this.consoleContent.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const caseButton = target?.closest<HTMLButtonElement>("[data-visible-case-index]");
      if (caseButton) {
        this.activeVisibleCaseIndex = Number(caseButton.dataset.visibleCaseIndex ?? "0");
        this.renderConsoleContent();
        return;
      }

      const resultRow = target?.closest<HTMLElement>("[data-result-case-id]");
      if (resultRow) {
        const caseId = resultRow.dataset.resultCaseId ?? null;
        this.expandedResultCaseId = this.expandedResultCaseId === caseId ? null : caseId;
        this.renderConsoleContent();
      }
    });

    this.verdictLayer.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".pv-verdict__close")) {
        this.hideVerdict();
      }
    });

    document.addEventListener("click", (event) => {
      const target = event.target as Node | null;
      if (
        target &&
        !this.shortcutsPopover.hidden &&
        !this.shortcutsPopover.contains(target) &&
        !this.shortcutsButton.contains(target)
      ) {
        this.toggleShortcutsPopover(false);
      }
    });

    window.addEventListener("popstate", () => {
      const problem = problemFromUrl();
      if (problem) {
        void this.openProblem(problem.id, false);
      } else {
        this.showListView(false);
      }
    });

    window.addEventListener("resize", () => {
      this.applyProblemLayout();
    });

    document.addEventListener("visibilitychange", () => {
      if (!this.currentProblem || !this.timerState) {
        return;
      }
      if (document.visibilityState === "hidden") {
        pauseTimer(this.currentProblem.id, this.timerState);
      } else {
        resumeTimer(this.currentProblem.id, this.timerState);
      }
    });

    window.addEventListener("studyriscv-auth-changed", () => {
      void this.refreshSessionState();
    });

    document.addEventListener("keydown", (event) => {
      if (!this.problemView.hidden) {
        const meta = event.metaKey || event.ctrlKey;
        if (meta && event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          void this.execute("run");
          return;
        }
        if (meta && event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          void this.execute("submit");
          return;
        }
        if (meta && event.key === "[") {
          event.preventDefault();
          this.navigateRelative(-1);
          return;
        }
        if (meta && event.key === "]") {
          event.preventDefault();
          this.navigateRelative(1);
          return;
        }
        if (meta && (event.key === "j" || event.key === "J")) {
          event.preventDefault();
          this.consoleToggle.click();
          return;
        }
        if (event.key === "?") {
          event.preventDefault();
          this.toggleShortcutsPopover();
          return;
        }
        if (event.key === "Escape") {
          if (!this.shortcutsPopover.hidden) {
            this.toggleShortcutsPopover(false);
            return;
          }
          if (this.verdictLayer.childElementCount > 0) {
            this.hideVerdict();
            return;
          }
          if (this.leftTab === "hints" && this.openHints.size > 0) {
            this.openHints.clear();
            this.renderLeftContent();
          }
        }
      }
    });

    this.dividerV.addEventListener("mousedown", (event) => {
      if (this.fullscreen || window.innerWidth < 768) {
        return;
      }
      event.preventDefault();
      this.startVerticalDrag(event.clientX);
    });

    this.dividerH.addEventListener("mousedown", (event) => {
      if (!this.consoleOpen || window.innerWidth < 768) {
        return;
      }
      event.preventDefault();
      this.startHorizontalDrag(event.clientY);
    });
  }

  private async refreshSessionState(): Promise<void> {
    try {
      this.session = await getSession();
      const guestProgress = loadProblemProgressForUser(null);

      if (this.session) {
        const scopedProgress = loadProblemProgressForUser(this.session.userId);
        const apiProgress = await loadProblemProgressFromApi(this.session.idToken);
        this.progress = mergeProblemProgress(mergeProblemProgress(guestProgress, scopedProgress), apiProgress ?? {});
        saveProblemProgressForUser(this.progress, this.session.userId);
        void syncProblemProgressToApi(this.progress, this.session.idToken);
      } else {
        this.progress = guestProgress;
      }
    } catch (error) {
      console.error("Failed to refresh problem session state.", error);
      this.session = null;
      this.progress = loadProblemProgressForUser(null);
    } finally {
      this.renderList();
      if (this.currentProblem) {
        this.renderLeftContent();
        this.renderTopbar();
      }
    }
  }

  private renderList(): void {
    const filteredProblems = this.problems.filter((problem) => this.matchesFilters(problem));
    this.solvedStat.textContent = String(this.problems.filter((problem) => this.problemStatus(problem.id) === "solved").length);
    this.attemptedStat.textContent = String(this.problems.filter((problem) => this.problemStatus(problem.id) === "attempted").length);
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
            data-difficulty="${escapeHtml(problem.difficulty)}"
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
              <span class="pl-difficulty pl-difficulty--${difficultyClass(problem.difficulty)}">${escapeHtml(problem.difficulty)}</span>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  private matchesFilters(problem: Problem): boolean {
    const search = this.filters.search.trim().toLowerCase();
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
    saveFilterState(this.filters);
    this.applyFilterControls();
    this.renderList();
  }

  private applyFilterControls(): void {
    this.searchInput.value = this.filters.search;
    this.difficultyFilter.value =
      this.filters.difficulty === "Easy" || this.filters.difficulty === "Medium" || this.filters.difficulty === "Hard"
        ? this.filters.difficulty
        : "";
    this.statusFilter.value = this.filters.status;
    this.tagFilter.value = this.filters.tag;
  }

  private updateFilterUi(): void {
    const hasActiveFilters = Boolean(this.filters.search || this.filters.difficulty || this.filters.status || this.filters.tag);
    this.clearFiltersButton.hidden = !hasActiveFilters;
    [this.difficultyFilter, this.statusFilter, this.tagFilter].forEach((element) => {
      element.classList.toggle("is-active", Boolean(element.value));
    });
  }

  private saveListScroll(): void {
    safeSessionStorageSet(LIST_SCROLL_STORAGE_KEY, String(window.scrollY));
  }

  private restoreListScroll(): void {
    const raw = Number(safeSessionStorageGet(LIST_SCROLL_STORAGE_KEY));
    if (Number.isFinite(raw)) {
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: raw, behavior: "auto" });
      });
    }
  }

  private showListView(pushHistory: boolean): void {
    this.problemView.hidden = true;
    this.listView.hidden = false;
    this.footer.hidden = false;
    document.body.classList.remove("problems-view-active");
    document.title = "Problems - StudyRISC-V";
    this.currentProblem = null;
    this.latestSummary = null;
    this.pendingSubmissionToLoad = null;
    this.hideVerdict();
    this.renderLoadBanner();
    if (pushHistory) {
      window.history.pushState({}, "", "/problems/");
    }
    this.restoreListScroll();
  }

  private async openProblem(problemId: string, pushHistory: boolean): Promise<void> {
    const problem = getProblem(problemId);
    if (!problem) {
      this.showListView(pushHistory);
      return;
    }

    if (this.currentProblem && this.editor) {
      this.persistCurrentCode();
    }

    this.currentProblem = problem;
    this.timerState = loadTimerState(problem.id);
    if (!this.timerState.stopped && document.visibilityState !== "hidden") {
      resumeTimer(problem.id, this.timerState);
    }
    saveTimerState(problem.id, this.timerState);

    this.leftTab = "description";
    this.consoleTab = "testcase";
    this.activeVisibleCaseIndex = 0;
    this.latestSummary = null;
    this.expandedResultCaseId = null;
    this.pendingSubmissionToLoad = null;
    this.consoleOpen = false;
    this.openHints = new Set<number>();

    const entry = ensureProblemEntry(this.progress, problem);
    for (let index = 0; index < (entry.hintsRevealed ?? 0); index += 1) {
      this.openHints.add(index);
    }

    this.listView.hidden = true;
    this.problemView.hidden = false;
    this.footer.hidden = true;
    document.body.classList.add("problems-view-active");
    document.title = `${problem.title} - StudyRISC-V`;
    this.hideVerdict();
    this.renderLoadBanner();
    this.renderTopbar();
    this.renderLeftContent();
    this.renderConsoleVisibility();
    this.renderConsoleContent();
    if (pushHistory) {
      window.history.pushState({ problemId }, "", `/problems/?id=${encodeURIComponent(problem.id)}`);
    }
    await this.ensureEditor(problem);
    this.applyProblemLayout();
    if (!safeLocalStorageGet(SHORTCUTS_SEEN_STORAGE_KEY)) {
      this.toggleShortcutsPopover(true);
      safeLocalStorageSet(SHORTCUTS_SEEN_STORAGE_KEY, "1");
    }
  }

  private renderTopbar(): void {
    if (!this.currentProblem || !this.timerState) {
      return;
    }
    this.topbarNum.textContent = `${this.currentProblem.number}.`;
    this.topbarTitle.textContent = this.currentProblem.title;
    this.topbarDifficulty.textContent = this.currentProblem.difficulty;
    this.topbarDifficulty.className = `pv-topbar__difficulty pv-topbar__difficulty--${difficultyClass(this.currentProblem.difficulty)}`;
    this.topbarTags.innerHTML = this.currentProblem.tags
      .slice(0, 3)
      .map((tag) => `<span class="pv-topbar__tag">${escapeHtml(tag)}</span>`)
      .join("");
    this.timerValue.textContent = formatTimer(timerElapsedMs(this.timerState));
    this.prevButton.disabled = this.currentProblem.number <= 1;
    this.nextButton.disabled = this.currentProblem.number >= this.problems.length;
    this.hintCount.textContent = String(this.currentProblem.hints.length);
    (document.getElementById("pv-shortcut-run") as HTMLElement).textContent = runShortcutLabel();
    (document.getElementById("pv-shortcut-submit") as HTMLElement).textContent = submitShortcutLabel();
    (document.getElementById("pv-shortcut-prev") as HTMLElement).textContent = prevShortcutLabel();
    (document.getElementById("pv-shortcut-next") as HTMLElement).textContent = nextShortcutLabel();
    (document.getElementById("pv-shortcut-console") as HTMLElement).textContent = consoleShortcutLabel();
  }

  private async ensureEditor(problem: Problem): Promise<void> {
    const code = loadProblemCode(problem.id) ?? ensureProblemEntry(this.progress, problem).lastCode ?? problem.starterCode;

    try {
      this.monaco = this.monaco ?? (await loadMonaco());
      applyMonacoTheme(this.monaco);

      if (!this.editor || this.usingFallbackEditor) {
        this.editor?.dispose();
        this.editorRoot.innerHTML = "";
        this.editor = initEditor(this.editorRoot, this.monaco, code);
        this.usingFallbackEditor = false;
        this.bindEditorAutosave();
      } else {
        this.editor.setValue(code);
        this.editor.updateOptions({ readOnly: false });
      }
    } catch (error) {
      console.error("Failed to initialize Monaco editor. Falling back to textarea editor.", error);
      if (!this.editor || !this.usingFallbackEditor) {
        this.editor?.dispose();
        this.editor = initFallbackEditor(this.editorRoot, code);
        this.usingFallbackEditor = true;
        this.bindEditorAutosave();
      } else {
        this.editor.setValue(code);
        this.editor.updateOptions({ readOnly: false });
      }
      this.flashAutosaveIndicator("Basic editor loaded");
    }

    this.applyProblemLayout();
    this.editor.focus?.();
  }

  private bindEditorAutosave(): void {
    if (!this.editor) {
      return;
    }
    this.editor.onDidChangeModelContent(() => {
      if (this.autosaveTimer) {
        window.clearTimeout(this.autosaveTimer);
      }
      this.autosaveTimer = window.setTimeout(() => {
        this.persistCurrentCode();
        this.flashAutosaveIndicator("Auto-saved");
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

  private flashAutosaveIndicator(message: string): void {
    this.autosaveIndicator.textContent = message;
    this.autosaveIndicator.classList.add("is-visible");
    if (this.autosaveIndicatorTimer) {
      window.clearTimeout(this.autosaveIndicatorTimer);
    }
    this.autosaveIndicatorTimer = window.setTimeout(() => {
      this.autosaveIndicator.classList.remove("is-visible");
    }, 1000);
  }

  private renderLeftContent(): void {
    if (!this.currentProblem) {
      return;
    }

    document.querySelectorAll<HTMLButtonElement>("[data-left-tab]").forEach((button) => {
      button.classList.toggle("active", button.dataset.leftTab === this.leftTab);
    });

    if (this.leftTab === "description") {
      this.leftContent.innerHTML = this.renderDescriptionTab(this.currentProblem);
      return;
    }

    if (this.leftTab === "hints") {
      this.leftContent.innerHTML = this.renderHintsTab(this.currentProblem);
      return;
    }

    if (this.leftTab === "editorial") {
      this.leftContent.innerHTML = this.renderEditorialTab(this.currentProblem);
      return;
    }

    this.leftContent.innerHTML = this.renderSubmissionsTab(this.currentProblem);
  }

  private renderDescriptionTab(problem: Problem): string {
    const tagMarkup = problem.tags.map((tag) => `<span class="pv-meta-tag">${escapeHtml(tag)}</span>`).join("");
    const companiesMarkup =
      problem.companies && problem.companies.length > 0
        ? `
            <div class="pv-constraints">
              <h3 class="pv-section-title">Used In</h3>
              <div class="pv-problem-meta">
                ${problem.companies.map((company) => `<span class="pv-meta-tag">${escapeHtml(company)}</span>`).join("")}
              </div>
            </div>
          `
        : "";

    return `
      <div class="pv-problem-header">
        <h2 class="pv-problem-title">${problem.number}. ${escapeHtml(problem.title)}</h2>
        <div class="pv-problem-meta">
          <span class="pv-badge pv-badge--${difficultyClass(problem.difficulty)}">${escapeHtml(problem.difficulty)}</span>
          ${tagMarkup}
          <span class="pv-acceptance">${problem.acceptanceRate.toFixed(1)}% acceptance</span>
        </div>
      </div>

      <div class="pv-problem-body">${problem.description}</div>

      <div class="pv-examples">
        <h3 class="pv-section-title">Examples</h3>
        ${problem.examples
          .map(
            (example, index) => `
              <div class="pv-example">
                <div class="pv-example__label">Example ${index + 1}:</div>
                <div class="pv-example__block">
                  <div class="pv-example__row">
                    <span class="pv-example__key">Input:</span>
                    <code class="pv-example__val">${escapeHtml(example.input)}</code>
                  </div>
                  <div class="pv-example__row">
                    <span class="pv-example__key">Output:</span>
                    <code class="pv-example__val">${escapeHtml(example.output)}</code>
                  </div>
                  ${example.explanation ? `<div class="pv-example__explanation">${escapeHtml(example.explanation)}</div>` : ""}
                </div>
                ${example.registerTable && example.registerTable.length > 0
                  ? `
                      <table class="pv-reg-table">
                        <thead>
                          <tr><th>Register</th><th>Before</th><th>After</th></tr>
                        </thead>
                        <tbody>
                          ${example.registerTable
                            .map(
                              (row) => `
                                <tr>
                                  <td>${escapeHtml(row.name)}</td>
                                  <td>${escapeHtml(row.before)}</td>
                                  <td>${escapeHtml(row.after)}</td>
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
      </div>

      <div class="pv-constraints">
        <h3 class="pv-section-title">Constraints</h3>
        <ul class="pv-constraints-list">
          ${problem.constraints.map((constraint) => `<li>${escapeHtml(constraint)}</li>`).join("")}
        </ul>
      </div>

      ${companiesMarkup}
    `;
  }

  private renderHintsTab(problem: Problem): string {
    const entry = ensureProblemEntry(this.progress, problem);
    return `
      <p class="pv-hints-intro">Hints are free — use them without guilt.</p>
      ${problem.hints
        .map((hint, index) => {
          const unlocked = index < (entry.hintsRevealed ?? 0);
          const availableToReveal = index === (entry.hintsRevealed ?? 0);
          const open = this.openHints.has(index);
          return `
            <div class="pv-hint-item ${open ? "is-open" : ""}" data-index="${index}">
              <div class="pv-case-label">Hint ${index + 1} of ${problem.hints.length}</div>
              <button class="pv-hint-reveal" data-hint-index="${index}" type="button" ${!unlocked && !availableToReveal ? "disabled" : ""}>
                <span>${unlocked ? `Hint ${index + 1}` : `Show Hint ${index + 1}`}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                  <path d="m9 6 6 6-6 6"></path>
                </svg>
              </button>
              ${open ? `<div class="pv-hint-content">${escapeHtml(hint)}</div>` : ""}
            </div>
          `;
        })
        .join("")}
    `;
  }

  private renderEditorialTab(problem: Problem): string {
    if (!problem.editorial) {
      return `
        <div class="pv-editorial-placeholder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v20H7.5A2.5 2.5 0 0 0 5 24"></path>
            <path d="M5 4.5v17"></path>
            <path d="M9 7h7M9 11h7M9 15h5"></path>
          </svg>
          <strong>Editorial coming soon.</strong>
          <p>Check back after you've tried the problem.</p>
        </div>
      `;
    }

    if (this.problemStatus(problem.id) !== "solved") {
      return `
        <div class="pv-editorial-placeholder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2"></rect>
            <path d="M8 11V8a4 4 0 1 1 8 0v3"></path>
          </svg>
          <strong>Solve to unlock.</strong>
          <p>Try the problem first. The editorial appears after an accepted submission.</p>
        </div>
      `;
    }

    return `<div class="pv-problem-body">${problem.editorial}</div>`;
  }

  private renderSubmissionsTab(problem: Problem): string {
    const entry = this.progress[problem.id];
    if (!this.session) {
      return `
        <div class="pv-submissions-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"></path>
            <circle cx="9.5" cy="7" r="3.5"></circle>
            <path d="m17 8 4 4"></path>
            <path d="m21 8-4 4"></path>
          </svg>
          <p>Sign in to save your submissions.</p>
          <button class="pv-signin-inline" id="pv-signin-prompt" type="button">Sign in</button>
          <p class="pv-submissions-note">You can still run and submit — results just won't be synced across devices.</p>
        </div>
      `;
    }

    const submissions = [...(entry?.submissions ?? [])].sort((left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt));
    if (submissions.length === 0) {
      return `
        <div class="pv-submissions-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M4 7h16"></path>
            <path d="M5 7.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5"></path>
            <path d="M9 11h6"></path>
            <path d="M9 15h6"></path>
            <path d="M9 3h6v4H9z"></path>
          </svg>
          <p>No submissions yet.</p>
          <p>Write your solution and click Submit.</p>
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
                <tr class="pv-submission-row" data-load-submission-id="${escapeHtml(submission.id)}">
                  <td><span class="pv-submission-status pv-submission-status--${this.submissionTone(submission.verdict)}">${escapeHtml(verdictText(submission.verdict))}</span></td>
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

  private submissionTone(verdict: ProblemVerdict): string {
    switch (verdict) {
      case "Accepted":
        return "accepted";
      case "Wrong Answer":
        return "wrong";
      case "Assembly Error":
        return "assembly";
      case "Runtime Error":
        return "runtime";
      case "Time Limit Exceeded":
        return "tle";
    }
  }

  private renderConsoleVisibility(): void {
    this.consoleElement.hidden = !this.consoleOpen;
    this.dividerH.hidden = !this.consoleOpen;
    this.consoleToggle.classList.toggle("is-active", this.consoleOpen);
  }

  private renderConsoleContent(): void {
    if (!this.currentProblem) {
      return;
    }

    document.querySelectorAll<HTMLButtonElement>("[data-console-tab]").forEach((button) => {
      button.classList.toggle("active", button.dataset.consoleTab === this.consoleTab);
    });

    if (this.consoleTab === "testcase") {
      this.consoleContent.innerHTML = this.renderTestcaseTab(this.currentProblem);
      return;
    }

    this.consoleContent.innerHTML = this.renderResultTab();
  }

  private renderTestcaseTab(problem: Problem): string {
    const visibleCases = activeVisibleCases(problem);
    const activeCase = visibleCases[this.activeVisibleCaseIndex] ?? visibleCases[0];
    if (!activeCase) {
      return "<div class='pv-submissions-empty'><p>No visible test cases.</p></div>";
    }

    const showExpected = Boolean(this.latestSummary);
    return `
      <div class="pv-case-tabs">
        ${visibleCases
          .map(
            (testCase, index) => `
              <button class="pv-case-tab ${index === this.activeVisibleCaseIndex ? "is-active" : ""}" data-visible-case-index="${index}" type="button">
                ${escapeHtml(testCase.label)}
              </button>
            `
          )
          .join("")}
      </div>
      <div class="pv-case-section">
        <div class="pv-case-label">Initial State</div>
        ${this.renderCaseRegisterTable(activeCase.initialRegisters)}
      </div>
      ${activeCase.initialMemory && activeCase.initialMemory.length > 0
        ? `
            <div class="pv-case-section pv-case-memory">
              <div class="pv-case-label">Memory</div>
              ${activeCase.initialMemory
                .map(
                  (entry) => `
                    <div class="pv-case-memory-row">
                      <span class="pv-case-memory-label">${escapeHtml(entry.label ?? formatValue(entry.address))}</span>
                      <span>${escapeHtml(formatValue(entry.value, entry.size ?? "word"))}</span>
                    </div>
                  `
                )
                .join("")}
            </div>
          `
        : ""}
      ${showExpected
        ? `
            <div class="pv-case-section pv-case-expected">
              <div class="pv-case-label">Expected Output</div>
              ${this.renderCaseRegisterTable(activeCase.expectedRegisters)}
              ${activeCase.expectedMemory && activeCase.expectedMemory.length > 0
                ? activeCase.expectedMemory
                    .map(
                      (entry) => `
                        <div class="pv-case-memory-row">
                          <span class="pv-case-memory-label">${escapeHtml(formatValue(entry.address))}</span>
                          <span>${escapeHtml(formatValue(entry.value, entry.size ?? "word"))}</span>
                        </div>
                      `
                    )
                    .join("")
                : ""}
            </div>
          `
        : ""}
    `;
  }

  private renderCaseRegisterTable(registers: Partial<Record<string, number>>): string {
    const entries = Object.entries(registers);
    if (entries.length === 0) {
      return `<div class="pv-case-memory-row"><span class="pv-case-memory-label">No register assertions</span><span>—</span></div>`;
    }

    return `
      <table class="pv-case-table">
        <tbody>
          ${entries
            .map(
              ([registerName, value]) => `
                <tr>
                  <td class="pv-case-reg">${escapeHtml(registerName)}</td>
                  <td class="pv-case-val">${escapeHtml(formatValue(value ?? 0))}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    `;
  }

  private renderResultTab(): string {
    if (!this.latestSummary) {
      return `
        <div class="pv-submissions-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <rect x="3" y="4" width="18" height="14" rx="2"></rect>
            <path d="M7 20h10"></path>
            <path d="m8 9 2 2 4-4"></path>
          </svg>
          <p>Run your code to see testcase results.</p>
        </div>
      `;
    }

    const passed = this.latestSummary.verdict === "Accepted";
    return `
      <div class="pv-result-summary pv-result-summary--${passed ? "passed" : "failed"}">
        ${escapeHtml(`${this.latestSummary.passedCount}/${this.latestSummary.totalCount} test cases passed${passed ? "" : ` · ${this.latestSummary.verdict}`}`)}
      </div>
      ${this.latestSummary.results
        .map((result) => {
          const expanded = this.expandedResultCaseId === result.caseId;
          return `
            <div class="pv-result-item ${expanded ? "is-expanded" : ""}">
              <div class="pv-result-row pv-result-row--${result.passed ? "pass" : "fail"}" data-result-case-id="${escapeHtml(result.caseId)}">
                <div class="pv-result-row__icon">${result.passed ? "✓" : "✗"}</div>
                <div class="pv-result-row__label">${escapeHtml(result.label)}</div>
                <div class="pv-result-row__expand">▾</div>
              </div>
              ${expanded ? this.renderResultDetails(result) : ""}
            </div>
          `;
        })
        .join("")}
    `;
  }

  private renderResultDetails(result: RunResult): string {
    if (result.verdict === "Assembly Error" || result.verdict === "Runtime Error" || result.verdict === "Time Limit Exceeded") {
      return `
        <div class="pv-result-details">
          <div class="pv-result-error">
            <div class="pv-result-error__label">Error</div>
            <pre class="pv-result-error__msg">${escapeHtml(result.errorMessage ?? result.verdict)}</pre>
          </div>
        </div>
      `;
    }

    const diffEntries =
      result.diff.length > 0
        ? result.diff
        : [
            ...Object.entries(result.expectedRegisters).map(([registerName, expected]) => ({
              key: registerName,
              expected: expected ?? 0,
              actual: result.actualRegisters[registerName] ?? 0,
            })),
            ...result.expectedMemory.map((entry) => ({
              key: `mem[0x${entry.address.toString(16).padStart(8, "0")}]`,
              expected: entry.value,
              actual: result.actualMemory.find((candidate) => candidate.address === entry.address)?.value ?? 0,
            })),
          ];

    return `
      <div class="pv-result-details">
        <table class="pv-diff-table">
          <thead>
            <tr>
              <th>Register</th>
              <th>Expected</th>
              <th>Actual</th>
            </tr>
          </thead>
          <tbody>
            ${diffEntries
              .map(
                (entry) => `
                  <tr class="${entry.expected === entry.actual ? "match" : "mismatch"}">
                    <td>${escapeHtml(entry.key)}</td>
                    <td>${escapeHtml(formatProblemDiffValue(entry.expected))}</td>
                    <td class="${entry.expected === entry.actual ? "correct" : "wrong"}">${escapeHtml(formatProblemDiffValue(entry.actual))}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderLoadBanner(): void {
    if (!this.pendingSubmissionToLoad) {
      this.loadBanner.hidden = true;
      this.loadBanner.innerHTML = "";
      return;
    }

    const codeAvailable = this.pendingSubmissionToLoad.code.trim().length > 0;
    this.loadBanner.hidden = false;
    this.loadBanner.innerHTML = `
      <div class="pv-load-banner__text">
        ${escapeHtml(codeAvailable ? "Load this submission? Your current code will be replaced." : "This submission was synced without source code and can't be loaded on this device.")}
      </div>
      <div class="pv-load-banner__actions">
        <button class="pv-load-banner__cancel" type="button">Cancel</button>
        ${codeAvailable ? `<button class="pv-load-banner__ok" type="button">Load</button>` : ""}
      </div>
    `;
  }

  private applyPendingSubmissionLoad(): void {
    if (!this.pendingSubmissionToLoad || !this.editor || !this.currentProblem) {
      return;
    }
    this.editor.setValue(this.pendingSubmissionToLoad.code);
    this.persistCurrentCode();
    this.pendingSubmissionToLoad = null;
    this.renderLoadBanner();
    this.flashAutosaveIndicator("Submission loaded");
  }

  private async toggleHint(hintIndex: number): Promise<void> {
    if (!this.currentProblem) {
      return;
    }

    const entry = ensureProblemEntry(this.progress, this.currentProblem);
    const revealed = entry.hintsRevealed ?? 0;
    if (hintIndex > revealed) {
      return;
    }

    if (hintIndex === revealed) {
      entry.hintsRevealed = revealed + 1;
      saveProblemProgressForUser(this.progress, this.session?.userId ?? null);
      if (this.session) {
        void syncProblemProgressToApi(this.progress, this.session.idToken);
      }
      this.openHints.add(hintIndex);
    } else if (this.openHints.has(hintIndex)) {
      this.openHints.delete(hintIndex);
    } else {
      this.openHints.add(hintIndex);
    }

    this.renderLeftContent();
  }

  private restoreStarterCode(): void {
    if (!this.currentProblem || !this.editor) {
      return;
    }
    this.editor.setValue(this.currentProblem.starterCode);
    this.persistCurrentCode();
    this.flashAutosaveIndicator("Starter restored");
  }

  private toggleShortcutsPopover(force?: boolean): void {
    const open = force ?? this.shortcutsPopover.hidden;
    this.shortcutsPopover.hidden = !open;
    this.shortcutsButton.setAttribute("aria-expanded", String(open));
  }

  private async execute(mode: "run" | "submit"): Promise<void> {
    if (!this.currentProblem || !this.editor || this.running) {
      return;
    }

    this.running = true;
    this.runButton.classList.toggle("is-loading", mode === "run");
    this.submitButton.classList.toggle("is-loading", mode === "submit");
    this.editor.updateOptions({ readOnly: true });
    this.editorLoading.hidden = false;
    this.resetConfirm.hidden = true;

    const runtime = (this.runtimePromise ??= WasmRuntime.create());
    const source = this.editor.getValue();

    if (mode === "submit") {
      this.persistCurrentCode();
    }

    try {
      const summary = mode === "submit"
        ? await runAll(source, this.currentProblem, await runtime)
        : await runVisible(source, this.currentProblem, await runtime);

      this.latestSummary = summary;
      this.consoleOpen = true;
      this.consoleTab = "result";
      this.expandedResultCaseId = summary.firstFailedResult?.caseId ?? summary.results[0]?.caseId ?? null;
      this.renderConsoleVisibility();
      this.renderConsoleContent();

      const elapsedMs = this.timerState ? timerElapsedMs(this.timerState) : 0;
      if (mode === "submit") {
        this.recordSubmission(summary, source, elapsedMs);
      }

      if (summary.verdict === "Accepted" && this.currentProblem && this.timerState) {
        stopTimer(this.currentProblem.id, this.timerState);
      }

      this.showVerdict(summary, elapsedMs);
    } catch (error) {
      this.showVerdict(
        {
          verdict: "Runtime Error",
          passedCount: 0,
          totalCount: 0,
          results: [],
          totalSteps: 0,
          totalTimeMs: 0,
          firstFailedResult: undefined,
        },
        this.timerState ? timerElapsedMs(this.timerState) : 0,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.running = false;
      this.runButton.classList.remove("is-loading");
      this.submitButton.classList.remove("is-loading");
      this.editor.updateOptions({ readOnly: false });
      this.editorLoading.hidden = true;
      this.applyProblemLayout();
    }
  }

  private recordSubmission(summary: RunSummary, source: string, elapsedMs: number): void {
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
      elapsedMs,
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
      this.renderLeftContent();
    }
    this.renderList();
  }

  private showVerdict(summary: RunSummary, elapsedMs: number, fallbackError?: string): void {
    const firstFailed = summary.firstFailedResult;
    const firstDiff = firstFailed?.diff[0];
    const confettiColors = ["var(--accent)", "#22c55e", "var(--warning)", "var(--danger)", "var(--text-secondary)"];

    let toneClass = "pv-verdict--accepted";
    let icon = "✓";
    let title = "Accepted";
    let sub = `Passed ${summary.passedCount}/${summary.totalCount} test cases · ${summary.totalSteps} steps · Time: ${formatElapsedCompact(elapsedMs)}`;
    let diff = "";
    let mono = "";
    let confetti = Array.from({ length: 20 }, (_, index) => ({
      left: `${Math.random() * 100}%`,
      delay: `${Math.floor(Math.random() * 600)}ms`,
      duration: `${1000 + Math.floor(Math.random() * 800)}ms`,
      color: confettiColors[index % confettiColors.length]!,
    }));

    if (summary.verdict === "Wrong Answer") {
      toneClass = "pv-verdict--wrong";
      icon = "✗";
      title = "Wrong Answer";
      sub = `Failed on ${firstFailed?.label ?? "a testcase"}`;
      diff = firstDiff
        ? `Expected ${firstDiff.key} = ${formatProblemDiffValue(firstDiff.expected)} · Got ${formatProblemDiffValue(firstDiff.actual)}`
        : "";
      confetti = [];
    } else if (summary.verdict === "Runtime Error") {
      toneClass = "pv-verdict--error";
      icon = "⚠";
      title = "Runtime Error";
      sub = firstFailed?.label ?? "Execution stopped";
      mono = firstFailed?.errorMessage ?? fallbackError ?? "Execution failed.";
      confetti = [];
    } else if (summary.verdict === "Time Limit Exceeded") {
      toneClass = "pv-verdict--tle";
      icon = "⏱";
      title = "Time Limit Exceeded";
      sub = firstFailed?.errorMessage ?? "Exceeded the step limit. Try a more efficient approach.";
      confetti = [];
    } else if (summary.verdict === "Assembly Error") {
      toneClass = "pv-verdict--assembly";
      icon = "✗";
      title = "Assembly Error";
      sub = "Fix the assembly error and try again.";
      mono = firstFailed?.errorMessage ?? fallbackError ?? "Assembly failed.";
      confetti = [];
    }

    if (this.verdictDismissTimer) {
      window.clearTimeout(this.verdictDismissTimer);
    }

    this.verdictLayer.innerHTML = `
      <div class="pv-verdict ${toneClass}">
        ${confetti
          .map(
            (piece) => `
              <span
                class="pv-confetti-piece"
                style="left:${piece.left}; --delay:${piece.delay}; --duration:${piece.duration}; --piece-color:${piece.color};"
                aria-hidden="true"
              ></span>
            `
          )
          .join("")}
        <div class="pv-verdict__left">
          <span class="pv-verdict__icon">${icon}</span>
          <div>
            <div class="pv-verdict__title">${escapeHtml(title)}</div>
            <div class="pv-verdict__sub">${escapeHtml(sub)}</div>
            ${diff ? `<div class="pv-verdict__diff">${escapeHtml(diff)}</div>` : ""}
            ${mono ? `<div class="pv-verdict__diff">${escapeHtml(mono)}</div>` : ""}
          </div>
        </div>
        <button class="pv-verdict__close" type="button" aria-label="Close banner">×</button>
      </div>
    `;

    const banner = this.verdictLayer.querySelector<HTMLElement>(".pv-verdict");
    if (banner) {
      window.requestAnimationFrame(() => {
        banner.classList.add("is-visible");
      });
    }

    this.verdictDismissTimer = window.setTimeout(() => {
      this.hideVerdict();
    }, BANNER_DISMISS_MS);
  }

  private hideVerdict(): void {
    if (this.verdictDismissTimer) {
      window.clearTimeout(this.verdictDismissTimer);
      this.verdictDismissTimer = null;
    }
    this.verdictLayer.innerHTML = "";
  }

  private navigateRelative(direction: -1 | 1): void {
    if (!this.currentProblem) {
      return;
    }
    const nextIndex = this.currentProblem.number - 1 + direction;
    if (nextIndex < 0 || nextIndex >= this.problems.length) {
      return;
    }
    const nextProblem = this.problems[nextIndex];
    if (nextProblem) {
      void this.openProblem(nextProblem.id, true);
    }
  }

  private renderTick(): void {
    if (!this.currentProblem || !this.timerState) {
      return;
    }
    this.timerValue.textContent = formatTimer(timerElapsedMs(this.timerState));
    saveTimerState(this.currentProblem.id, this.timerState);
  }

  private startTimerTicker(): void {
    window.setInterval(() => this.renderTick(), 1000);
  }

  private startVerticalDrag(startX: number): void {
    const bounds = this.panels.getBoundingClientRect();
    const onMove = (event: MouseEvent): void => {
      const ratio = ((event.clientX - bounds.left) / bounds.width) * 100;
      const minPercent = (300 / bounds.width) * 100;
      this.verticalSplit = clamp(ratio, Math.max(28, minPercent), 65);
      this.dividerV.classList.add("is-dragging");
      this.setMonacoPointerEvents(false);
      this.applyProblemLayout();
    };

    const onUp = (): void => {
      this.dividerV.classList.remove("is-dragging");
      this.setMonacoPointerEvents(true);
      safeLocalStorageSet(PANEL_SPLIT_STORAGE_KEY, String(this.verticalSplit));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    onMove(new MouseEvent("mousemove", { clientX: startX }));
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
  }

  private startHorizontalDrag(startY: number): void {
    const bounds = this.rightPanel.getBoundingClientRect();
    const onMove = (event: MouseEvent): void => {
      const rawHeight = bounds.bottom - event.clientY - 48;
      this.consoleHeight = clamp(rawHeight, 120, bounds.height * 0.5);
      this.dividerH.classList.add("is-dragging");
      this.setMonacoPointerEvents(false);
      this.applyProblemLayout();
    };

    const onUp = (): void => {
      this.dividerH.classList.remove("is-dragging");
      this.setMonacoPointerEvents(true);
      safeLocalStorageSet(CONSOLE_HEIGHT_STORAGE_KEY, String(this.consoleHeight));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    onMove(new MouseEvent("mousemove", { clientY: startY }));
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
  }

  private setMonacoPointerEvents(enabled: boolean): void {
    this.editorStage.querySelectorAll("iframe").forEach((frame) => {
      (frame as HTMLElement).style.pointerEvents = enabled ? "" : "none";
    });
  }

  private applyProblemLayout(): void {
    if (this.problemView.hidden) {
      return;
    }

    if (this.fullscreen) {
      this.leftPanel.hidden = true;
      this.dividerV.hidden = true;
      this.leftPanel.style.width = "";
      this.fullscreenIcon.innerHTML = `<path d="M9 3H4v5M20 9V4h-5M15 20h5v-5M4 15v5h5"></path>`;
    } else {
      this.leftPanel.hidden = false;
      this.dividerV.hidden = false;
      this.leftPanel.style.width = `${this.verticalSplit}%`;
      this.fullscreenIcon.innerHTML = `<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"></path>`;
    }

    const rightHeight = this.rightPanel.clientHeight;
    const toolbarHeight = this.rightPanel.querySelector<HTMLElement>(".pv-editor-toolbar")?.offsetHeight ?? 40;
    const loadBannerHeight = this.loadBanner.hidden ? 0 : this.loadBanner.offsetHeight + 10;
    const actionBarHeight = this.rightPanel.querySelector<HTMLElement>(".pv-action-bar")?.offsetHeight ?? 48;
    const dividerHeight = this.consoleOpen ? (this.dividerH.offsetHeight || 4) : 0;
    const maxConsoleHeight = this.rightPanel.clientHeight * 0.5;

    if (this.consoleOpen) {
      this.consoleHeight = clamp(this.consoleHeight, 120, maxConsoleHeight);
      this.consoleElement.style.height = `${this.consoleHeight}px`;
      this.consoleElement.hidden = false;
    } else {
      this.consoleElement.style.height = "0px";
      this.consoleElement.hidden = true;
    }

    const editorHeight = Math.max(
      220,
      rightHeight - toolbarHeight - loadBannerHeight - actionBarHeight - (this.consoleOpen ? this.consoleHeight + dividerHeight : 0)
    );
    this.editorRoot.style.height = `${editorHeight}px`;
    this.editor?.layout();
  }
}

const app = new ProblemsApp();
void app.init();

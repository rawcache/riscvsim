import { getSession, type UserSession } from "./auth";
import { show as showAuthModal } from "./auth-page";
import type { CheckpointProblem, CheckpointSubmission, TestCase } from "./checkpoint-data";
import { CHECKPOINT_PROBLEMS, getCheckpointProblem, getCheckpointProblems } from "./checkpoint-data";
import {
  checkpointXp,
  countCompletedRequiredLessons,
  formatLessonRange,
  getCheckpointAcceptanceRate,
  getCheckpointAllSubmissions,
  getCheckpointBestSubmission,
  getCheckpointCardState,
  getCurrentCheckpointTier,
  getLessonIdForNumber,
  isCheckpointCompleted,
} from "./checkpoint-logic";
import { formatCheckpointDiffValue, runAll, runVisible, type RunResult, type RunSummary } from "./checkpoint-runner";
import {
  ensureCheckpointEntry,
  loadCheckpointCode,
  loadCheckpointProgressForUser,
  loadCheckpointProgressFromApi,
  mergeCheckpointProgress,
  normalizeCheckpointProgress,
  saveCheckpointCode,
  saveCheckpointProgressForUser,
  syncCheckpointProgressToApi,
} from "./checkpoint-progress";
import { escapeHtml } from "./format";
import {
  loadProgress,
  loadProgressFromApi,
  saveProgress,
  type UserProgress,
} from "./lessons";
import { initNav } from "./nav";
import { WasmRuntime } from "./wasm-runtime";

type LeftTab = "description" | "hints" | "approach" | "submissions";
type BottomTab = "testcase" | "result";

type MonacoEditorInstance = {
  getValue(): string;
  setValue(value: string): void;
  updateOptions(options: Record<string, unknown>): void;
  layout(): void;
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

type BannerState = {
  tone: "accepted" | "wa" | "error" | "assembly" | "tle";
  title: string;
  detail: string;
  detailMono?: string;
  xp?: number;
  confetti: Array<{ left: string; delay: string; duration: string; color: string }>;
};

type TimerState = {
  elapsedMs: number;
  runningSince: number | null;
};

declare global {
  interface Window {
    monaco?: MonacoApi;
    require?: MonacoRequire;
  }
}

const MONACO_CDN =
  "https://cdnjs.cloudflare.com/ajax/libs/" +
  "monaco-editor/0.44.0/min/vs";

const LEFT_TAB_BUTTONS = "[data-left-tab]";
const BOTTOM_TAB_BUTTONS = "[data-bottom-tab]";
const DIVIDER_V_STORAGE_KEY = "studyriscv_cp_vsplit";
const DIVIDER_H_STORAGE_KEY = "studyriscv_cp_hsplit";
const FULLSCREEN_STORAGE_KEY = "studyriscv_cp_fullscreen";
const BANNER_DISMISS_MS = 6000;
const CODE_SAVE_INTERVAL_MS = 30000;

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

function runShortcutLabel(): string {
  return isMacPlatform() ? "⌘Enter" : "Ctrl+Enter";
}

function submitShortcutLabel(): string {
  return isMacPlatform() ? "⌘⇧Enter" : "Ctrl+Shift+Enter";
}

function timerStorageKey(problemId: string): string {
  return `studyriscv_cp_timer_${problemId}`;
}

function loadNumberSetting(key: string, fallback: number): number {
  if (typeof localStorage === "undefined") {
    return fallback;
  }
  const stored = Number(localStorage.getItem(key));
  return Number.isFinite(stored) ? stored : fallback;
}

function loadBooleanSetting(key: string): boolean {
  return typeof localStorage !== "undefined" && localStorage.getItem(key) === "1";
}

function setNumberSetting(key: string, value: number): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(key, String(value));
}

function setBooleanSetting(key: string, value: boolean): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(key, value ? "1" : "0");
}

function loadTimer(problemId: string): TimerState {
  if (typeof sessionStorage === "undefined") {
    return { elapsedMs: 0, runningSince: Date.now() };
  }

  const raw = sessionStorage.getItem(timerStorageKey(problemId));
  if (!raw) {
    return { elapsedMs: 0, runningSince: Date.now() };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<TimerState>;
    return {
      elapsedMs: typeof parsed.elapsedMs === "number" && Number.isFinite(parsed.elapsedMs) ? Math.max(0, parsed.elapsedMs) : 0,
      runningSince:
        typeof parsed.runningSince === "number" && Number.isFinite(parsed.runningSince) ? parsed.runningSince : Date.now(),
    };
  } catch {
    return { elapsedMs: 0, runningSince: Date.now() };
  }
}

function saveTimer(problemId: string, timerState: TimerState): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  sessionStorage.setItem(timerStorageKey(problemId), JSON.stringify(timerState));
}

function timerElapsedMs(timerState: TimerState): number {
  return timerState.elapsedMs + (timerState.runningSince ? Date.now() - timerState.runningSince : 0);
}

function pauseTimer(problemId: string, timerState: TimerState): void {
  if (timerState.runningSince) {
    timerState.elapsedMs += Date.now() - timerState.runningSince;
    timerState.runningSince = null;
    saveTimer(problemId, timerState);
  }
}

function resumeTimer(problemId: string, timerState: TimerState): void {
  if (!timerState.runningSince) {
    timerState.runningSince = Date.now();
    saveTimer(problemId, timerState);
  }
}

function resetTimer(problemId: string): TimerState {
  const timerState = {
    elapsedMs: 0,
    runningSince: document.visibilityState === "hidden" ? null : Date.now(),
  };
  saveTimer(problemId, timerState);
  return timerState;
}

function formatElapsed(secondsTotal: number): string {
  const minutes = Math.floor(secondsTotal / 60);
  const seconds = secondsTotal % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function toUint32(value: number): number {
  return value >>> 0;
}

function signed32(value: number): number {
  return value >> 0;
}

function formatSizedValue(value: number, size: "byte" | "half" | "word" = "word"): string {
  const normalized = toUint32(value);
  const width = size === "byte" ? 2 : size === "half" ? 4 : 8;
  const masked =
    size === "byte" ? normalized & 0xff : size === "half" ? normalized & 0xffff : normalized;
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

function registerRole(registerName: string): string {
  const aliases: Record<string, string> = {
    x1: "role-ra",
    ra: "role-ra",
    x2: "role-sp",
    sp: "role-sp",
  };
  if (registerName in aliases) {
    return aliases[registerName];
  }

  const index = Number.parseInt(registerName.replace(/^\D+/u, ""), 10);
  if (index >= 10 && index <= 17) {
    return "role-arg";
  }
  if ((index >= 8 && index <= 9) || (index >= 18 && index <= 27)) {
    return "role-saved";
  }
  if ((index >= 5 && index <= 7) || (index >= 28 && index <= 31)) {
    return "role-temp";
  }
  return "";
}

function summaryTone(summary: RunSummary): BannerState["tone"] {
  switch (summary.verdict) {
    case "Accepted":
      return "accepted";
    case "Wrong Answer":
      return "wa";
    case "Assembly Error":
      return "assembly";
    case "Time Limit Exceeded":
      return "tle";
    case "Runtime Error":
      return "error";
  }
}

function buildConfetti(): BannerState["confetti"] {
  const colors = [
    "var(--accent)",
    "#22c55e",
    "var(--warning)",
    "color-mix(in srgb, var(--accent) 65%, var(--warning))",
  ];

  return Array.from({ length: 16 }, (_, index) => ({
    left: `${Math.round(Math.random() * 100)}%`,
    delay: `${(index % 4) * 100}ms`,
    duration: `${800 + (index % 5) * 40}ms`,
    color: colors[index % colors.length] ?? "var(--accent)",
  }));
}

function bannerForSummary(
  problem: CheckpointProblem,
  summary: RunSummary,
  session: UserSession | null
): BannerState {
  const tone = summaryTone(summary);
  const firstFailed = summary.firstFailedCase;
  if (summary.verdict === "Accepted") {
    return {
      tone,
      title: "Accepted",
      detail: `Passed ${summary.passedCount}/${summary.totalCount} test cases · ${summary.totalSteps} steps total`,
      xp: session?.isGtStudent ? checkpointXp(problem) : undefined,
      confetti: buildConfetti(),
    };
  }

  if (summary.verdict === "Wrong Answer") {
    const firstDiff = firstFailed?.diff[0];
    const location = firstDiff?.register ?? (firstDiff?.address !== undefined ? formatSizedValue(firstDiff.address) : "the expected state");
    return {
      tone,
      title: "Wrong Answer",
      detail: `Failed on ${firstFailed?.label ?? "the first failing case"}`,
      detailMono:
        firstDiff !== undefined
          ? `${location} expected ${formatCheckpointDiffValue(firstDiff.expected)} but got ${formatCheckpointDiffValue(firstDiff.actual)}`
          : "The observed register or memory state did not match the expected output.",
      confetti: [],
    };
  }

  if (summary.verdict === "Assembly Error") {
    return {
      tone,
      title: `Assembly Error${extractAssemblyLine(firstFailed?.errorMessage ?? "") ? ` · Line ${extractAssemblyLine(firstFailed?.errorMessage ?? "")}` : ""}`,
      detail: "Fix the error in your code and try again.",
      detailMono: firstFailed?.errorMessage ?? "The assembler could not parse the submission.",
      confetti: [],
    };
  }

  if (summary.verdict === "Time Limit Exceeded") {
    const limit = firstFailed?.errorMessage?.match(/\d+/u)?.[0] ?? `${problem.stepLimit ?? 1000}`;
    return {
      tone,
      title: "Time Limit Exceeded",
      detail: `Exceeded ${limit}-step limit · Try an iterative approach.`,
      confetti: [],
    };
  }

  return {
    tone,
    title: "Runtime Error",
    detail: "Execution trapped before the expected state was reached.",
    detailMono: firstFailed?.errorMessage ?? "The program trapped during execution.",
    confetti: [],
  };
}

function extractAssemblyLine(message: string): string | null {
  const match = message.match(/line\s+(\d+)/iu);
  return match?.[1] ?? null;
}

function relatedLessonLink(lessonNumber: number): string {
  const lessonId = getLessonIdForNumber(lessonNumber);
  return lessonId ? `/simulator/?lesson=${encodeURIComponent(lessonId)}` : "/learn/";
}

function maybePlural(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function mergeLessonProgress(localProgress: UserProgress, apiProgress: UserProgress): UserProgress {
  const mergedLessons = {
    ...localProgress.lessons,
    ...apiProgress.lessons,
  };

  return {
    lessons: mergedLessons,
    totalCompleted: Object.values(mergedLessons).filter((lesson) => lesson.completed).length,
    lastActiveLesson: apiProgress.lastActiveLesson ?? localProgress.lastActiveLesson,
  };
}

function byBestSubmission(left: CheckpointSubmission, right: CheckpointSubmission): number {
  const verdictRank = (submission: CheckpointSubmission): number => {
    switch (submission.verdict) {
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
  };
  if (verdictRank(left) !== verdictRank(right)) {
    return verdictRank(right) - verdictRank(left);
  }
  if (left.passedCases !== right.passedCases) {
    return right.passedCases - left.passedCases;
  }
  return Date.parse(right.submittedAt) - Date.parse(left.submittedAt);
}

function currentProblemFromUrl(): CheckpointProblem {
  const params = new URLSearchParams(window.location.search);
  const requestedId = params.get("id");
  if (!requestedId) {
    return CHECKPOINT_PROBLEMS[0]!;
  }
  return getCheckpointProblem(requestedId as CheckpointProblem["id"]) ?? CHECKPOINT_PROBLEMS[0]!;
}

function setProblemInUrl(problemId: string): void {
  const next = new URL(window.location.href);
  next.searchParams.set("id", problemId);
  window.location.href = next.toString();
}

function activeVisibleCases(problem: CheckpointProblem): TestCase[] {
  return problem.testCases.filter((testCase) => testCase.visible);
}

function renderRegisterTable(registers: Partial<Record<string, number>>, label: string): string {
  const entries = Object.entries(registers);
  if (entries.length === 0) {
    return "";
  }

  return `
    <div class="cp-state-section">
      <div class="cp-state-label">${escapeHtml(label)}</div>
      <table class="cp-register-table">
        <thead>
          <tr><th>Register</th><th>Value</th></tr>
        </thead>
        <tbody>
          ${entries
            .map(
              ([register, value]) => `
                <tr>
                  <td><span class="cp-reg-name ${registerRole(register)}">${escapeHtml(register)}</span></td>
                  <td>${escapeHtml(formatSizedValue(value ?? 0))}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderMemoryTable(memory: Array<{ address: number; value: number; size?: "byte" | "half" | "word" }>, label: string): string {
  if (memory.length === 0) {
    return "";
  }

  return `
    <div class="cp-state-section">
      <div class="cp-state-label">${escapeHtml(label)}</div>
      <table class="cp-memory-table">
        <thead>
          <tr><th>Address</th><th>Value</th></tr>
        </thead>
        <tbody>
          ${memory
            .map(
              (entry) => `
                <tr>
                  <td>${escapeHtml(formatSizedValue(entry.address))}</td>
                  <td>${escapeHtml(formatSizedValue(entry.value, entry.size ?? "word"))}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function cssColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function rgba(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    const normalized = color.length === 4
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

let monacoPromise: Promise<MonacoApi> | null = null;

function loadMonaco(): Promise<MonacoApi> {
  if (window.monaco) {
    return Promise.resolve(window.monaco);
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
      if (!window.monaco) {
        reject(new Error("Monaco loaded without exposing the editor API."));
        return;
      }
      resolve(window.monaco);
    };

    const bootstrap = (): void => {
      const requireJs = window.require;
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
      if (window.require) {
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
    },
  });
  monaco.editor.setTheme(dark ? "studyriscv-dark" : "vs");
}

function initEditor(container: HTMLElement, monaco: MonacoApi, starterCode: string): MonacoEditorInstance {
  applyMonacoTheme(monaco);
  return monaco.editor.create(container, {
    value: starterCode,
    language: "plaintext",
    theme: document.documentElement.dataset.theme === "dark" ? "studyriscv-dark" : "vs",
    fontFamily: "'Geist Mono', monospace",
    fontSize: 14,
    lineHeight: 22,
    tabSize: 2,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: "all",
    cursorBlinking: "smooth",
    smoothScrolling: true,
    contextmenu: true,
    wordWrap: "off",
    automaticLayout: true,
    padding: { top: 16, bottom: 16 },
  });
}

class CheckpointApp {
  private readonly layout = document.getElementById("cp-layout") as HTMLElement;
  private readonly panels = document.getElementById("cp-panels") as HTMLElement;
  private readonly leftPanel = document.getElementById("cp-left") as HTMLElement;
  private readonly rightPanel = document.getElementById("cp-right") as HTMLElement;
  private readonly dividerV = document.getElementById("cp-divider-v") as HTMLElement;
  private readonly dividerH = document.getElementById("cp-divider-h") as HTMLElement;
  private readonly problemButton = document.getElementById("cp-problem-btn") as HTMLButtonElement;
  private readonly problemTitle = document.getElementById("cp-problem-title") as HTMLElement;
  private readonly problemDropdown = document.getElementById("cp-problem-dropdown") as HTMLElement;
  private readonly difficultyBadge = document.getElementById("cp-difficulty-badge") as HTMLElement;
  private readonly status = document.getElementById("cp-status") as HTMLElement;
  private readonly timerButton = document.getElementById("cp-timer-btn") as HTMLButtonElement;
  private readonly leftContent = document.getElementById("cp-left-content") as HTMLElement;
  private readonly editorRoot = document.getElementById("cp-editor") as HTMLElement;
  private readonly editorStage = document.getElementById("cp-editor-stage") as HTMLElement;
  private readonly editorLoading = document.getElementById("cp-editor-loading") as HTMLElement;
  private readonly lockShell = document.getElementById("cp-lock-shell") as HTMLElement;
  private readonly bottomContent = document.getElementById("cp-bottom-content") as HTMLElement;
  private readonly verdictLayer = document.getElementById("cp-verdict-layer") as HTMLElement;
  private readonly runButton = document.getElementById("cp-run-btn") as HTMLButtonElement;
  private readonly submitButton = document.getElementById("cp-submit-btn") as HTMLButtonElement;
  private readonly resetButton = document.getElementById("cp-reset-btn") as HTMLButtonElement;
  private readonly fullscreenButton = document.getElementById("cp-fullscreen-btn") as HTMLButtonElement;
  private readonly saveIndicator = document.getElementById("cp-save-indicator") as HTMLElement;

  private session: UserSession | null = null;
  private lessonProgress: UserProgress = loadProgress();
  private checkpointProgress = loadCheckpointProgressForUser(null);
  private currentProblem: CheckpointProblem = currentProblemFromUrl();
  private leftTab: LeftTab = "description";
  private bottomTab: BottomTab = "testcase";
  private activeVisibleCaseIndex = 0;
  private latestSummary: RunSummary | null = null;
  private latestRunMode: "run" | "submit" | null = null;
  private banner: BannerState | null = null;
  private bannerTimer: number | null = null;
  private saveIndicatorTimer: number | null = null;
  private timerTicker: number | null = null;
  private timerState: TimerState = loadTimer(this.currentProblem.id);
  private editor: MonacoEditorInstance | null = null;
  private editorChangeListener: { dispose(): void } | null = null;
  private monaco: MonacoApi | null = null;
  private viewerEditors = new Map<string, MonacoEditorInstance>();
  private expandedSubmissionKey: string | null = null;
  private running = false;
  private verticalSplit = Math.min(65, Math.max(28, loadNumberSetting(DIVIDER_V_STORAGE_KEY, 40)));
  private horizontalSplit = Math.max(80, loadNumberSetting(DIVIDER_H_STORAGE_KEY, 200));
  private fullscreen = loadBooleanSetting(FULLSCREEN_STORAGE_KEY);
  private runtimePromise: Promise<WasmRuntime> | null = null;

  async init(): Promise<void> {
    initNav({ activePage: "challenges" });
    this.bindStaticListeners();
    await this.refreshSessionState();
    this.problemButton.setAttribute("aria-expanded", "false");
    this.problemButton.querySelector("span")?.removeAttribute("hidden");
    this.render();
    this.startTimerTicker();
    if (this.isProblemUnlocked()) {
      await this.ensureEditor();
    }
  }

  private bindStaticListeners(): void {
    document.querySelectorAll<HTMLButtonElement>(LEFT_TAB_BUTTONS).forEach((button) => {
      button.addEventListener("click", () => {
        this.leftTab = button.dataset.leftTab as LeftTab;
        this.renderLeftContent();
      });
    });

    document.querySelectorAll<HTMLButtonElement>(BOTTOM_TAB_BUTTONS).forEach((button) => {
      button.addEventListener("click", () => {
        this.bottomTab = button.dataset.bottomTab as BottomTab;
        this.renderBottomContent();
      });
    });

    this.problemButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleProblemDropdown();
    });

    this.runButton.addEventListener("click", () => {
      void this.execute("run");
    });

    this.submitButton.addEventListener("click", () => {
      void this.execute("submit");
    });

    this.resetButton.addEventListener("click", () => {
      if (this.editor) {
        this.editor.setValue(this.currentProblem.starterCode);
        this.showSaveIndicator("Starter restored");
        this.layoutEditor();
      }
    });

    this.fullscreenButton.addEventListener("click", () => {
      this.fullscreen = !this.fullscreen;
      setBooleanSetting(FULLSCREEN_STORAGE_KEY, this.fullscreen);
      this.renderLayoutState();
      this.layoutEditor();
    });

    this.dividerV.addEventListener("mousedown", (event) => {
      if (window.innerWidth <= 768 || this.fullscreen) {
        return;
      }
      event.preventDefault();
      this.layout.classList.add("is-dragging");
      const move = (moveEvent: MouseEvent): void => {
        const bounds = this.panels.getBoundingClientRect();
        const next = ((moveEvent.clientX - bounds.left) / bounds.width) * 100;
        this.verticalSplit = Math.max(28, Math.min(65, next));
        setNumberSetting(DIVIDER_V_STORAGE_KEY, this.verticalSplit);
        this.renderLayoutState();
      };
      const stop = (): void => {
        this.layout.classList.remove("is-dragging");
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", stop);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", stop);
    });

    this.dividerH.addEventListener("mousedown", (event) => {
      event.preventDefault();
      this.layout.classList.add("is-dragging");
      const move = (moveEvent: MouseEvent): void => {
        const rightBounds = this.rightPanel.getBoundingClientRect();
        const toolbarHeight = this.rightPanel.querySelector<HTMLElement>(".cp-editor-toolbar")?.offsetHeight ?? 0;
        const actionHeight = this.rightPanel.querySelector<HTMLElement>(".cp-action-bar")?.offsetHeight ?? 0;
        const top = moveEvent.clientY - rightBounds.top - toolbarHeight;
        const currentEditorHeight = Math.max(0, top);
        const nextBottom = rightBounds.height - toolbarHeight - actionHeight - currentEditorHeight - this.dividerH.offsetHeight;
        this.horizontalSplit = Math.max(80, Math.min(rightBounds.height * 0.55, nextBottom));
        setNumberSetting(DIVIDER_H_STORAGE_KEY, this.horizontalSplit);
        this.renderLayoutState();
      };
      const stop = (): void => {
        this.layout.classList.remove("is-dragging");
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", stop);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", stop);
    });

    document.addEventListener("click", (event) => {
      if (!this.problemDropdown.hidden) {
        const target = event.target;
        if (!(target instanceof Node) || !this.problemDropdown.contains(target)) {
          this.closeProblemDropdown();
        }
      }
    });

    document.addEventListener("keydown", (event) => {
      const loweredKey = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && loweredKey === "enter") {
        event.preventDefault();
        void this.execute("run");
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && loweredKey === "enter") {
        event.preventDefault();
        void this.execute("submit");
        return;
      }
      if ((event.metaKey || event.ctrlKey) && loweredKey === "r") {
        event.preventDefault();
        return;
      }
      if (loweredKey === "escape") {
        this.closeProblemDropdown();
        this.clearBanner();
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        pauseTimer(this.currentProblem.id, this.timerState);
      } else {
        resumeTimer(this.currentProblem.id, this.timerState);
      }
      this.renderTimer();
    });

    window.addEventListener("resize", () => {
      this.renderLayoutState();
    });

    window.addEventListener("studyriscv-auth-changed", (event) => {
      this.session = (event as CustomEvent<UserSession | null>).detail ?? null;
      void this.refreshSessionState();
    });

    this.bottomContent.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const caseTab = target?.closest<HTMLButtonElement>("[data-case-index]");
      if (caseTab) {
        this.activeVisibleCaseIndex = Number(caseTab.dataset.caseIndex ?? "0");
        this.renderBottomContent();
        return;
      }

      const resultToggle = target?.closest<HTMLButtonElement>("[data-result-toggle]");
      if (resultToggle) {
        const resultIndex = resultToggle.dataset.resultToggle ?? "";
        resultToggle.setAttribute(
          "aria-expanded",
          String(resultToggle.getAttribute("aria-expanded") !== "true")
        );
        const detail = this.bottomContent.querySelector<HTMLElement>(`[data-result-detail="${resultIndex}"]`);
        if (detail) {
          detail.hidden = !detail.hidden;
        }
      }
    });

    this.leftContent.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const hintButton = target?.closest<HTMLButtonElement>("[data-hint-index]");
      if (hintButton) {
        this.revealHint(Number(hintButton.dataset.hintIndex ?? "0"));
        return;
      }

      const submissionButton = target?.closest<HTMLButtonElement>("[data-submission-key]");
      if (submissionButton) {
        const nextKey = submissionButton.dataset.submissionKey ?? null;
        this.expandedSubmissionKey = this.expandedSubmissionKey === nextKey ? null : nextKey;
        this.renderLeftContent();
        return;
      }

      const action = target?.closest<HTMLElement>("[data-cp-auth-action]");
      if (action) {
        showAuthModal({ allowClose: true });
      }
    });

    (document.getElementById("cp-run-shortcut") as HTMLElement).textContent = runShortcutLabel();
    (document.getElementById("cp-submit-shortcut") as HTMLElement).textContent = submitShortcutLabel();
  }

  private async refreshSessionState(): Promise<void> {
    this.session = await getSession();
    const localLessonProgress = loadProgress();
    this.lessonProgress = localLessonProgress;

    if (this.session?.idToken) {
      const [apiLessonProgress, apiCheckpointProgress] = await Promise.all([
        loadProgressFromApi(this.session.idToken),
        loadCheckpointProgressFromApi(this.session.idToken),
      ]);

      if (apiLessonProgress) {
        this.lessonProgress = mergeLessonProgress(localLessonProgress, apiLessonProgress);
        saveProgress(this.lessonProgress);
      }

      const guestCheckpointProgress = loadCheckpointProgressForUser(null);
      const scopedCheckpointProgress = loadCheckpointProgressForUser(this.session.userId);
      const mergedCheckpointProgress = mergeCheckpointProgress(
        mergeCheckpointProgress(guestCheckpointProgress, scopedCheckpointProgress),
        apiCheckpointProgress ?? {}
      );
      this.checkpointProgress = mergedCheckpointProgress;
      saveCheckpointProgressForUser(mergedCheckpointProgress, this.session.userId);
      void syncCheckpointProgressToApi(mergedCheckpointProgress, this.session.idToken);
    } else {
      this.checkpointProgress = loadCheckpointProgressForUser(null);
    }

    ensureCheckpointEntry(this.checkpointProgress, this.currentProblem);
    this.render();
    if (this.isProblemUnlocked()) {
      await this.ensureEditor();
    } else {
      this.disposeEditor();
    }
  }

  private isProblemUnlocked(): boolean {
    const state = getCheckpointCardState(
      this.currentProblem,
      this.lessonProgress,
      this.checkpointProgress,
      this.session
    );
    return state === "completed" || state === "unlocked";
  }

  private async ensureEditor(): Promise<void> {
    if (this.editor) {
      return;
    }

    this.monaco = await loadMonaco();
    applyMonacoTheme(this.monaco);
    const savedCode = loadCheckpointCode(this.currentProblem.id);
    this.editor = initEditor(this.editorRoot, this.monaco, savedCode ?? this.currentProblem.starterCode);
    this.editorChangeListener = this.editor.onDidChangeModelContent(() => {
      this.showSaveIndicator("Editing…");
    });
    this.layoutEditor();

    const observer = new MutationObserver(() => {
      if (this.monaco) {
        applyMonacoTheme(this.monaco);
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }

  private disposeEditor(): void {
    this.editorChangeListener?.dispose();
    this.editorChangeListener = null;
    this.editor?.dispose();
    this.editor = null;
    this.editorRoot.innerHTML = "";
  }

  private async getRuntime(): Promise<WasmRuntime> {
    this.runtimePromise ??= WasmRuntime.create();
    return this.runtimePromise;
  }

  private startTimerTicker(): void {
    this.timerTicker = window.setInterval(() => {
      this.renderTimer();
      if (this.editor) {
        this.maybeAutosaveCode();
      }
    }, 1000);

    window.addEventListener("beforeunload", () => {
      if (this.timerTicker) {
        window.clearInterval(this.timerTicker);
      }
    });
  }

  private render(): void {
    this.problemTitle.textContent = this.currentProblem.title;
    this.difficultyBadge.textContent = this.currentProblem.difficulty;
    this.difficultyBadge.className = `cp-difficulty-badge ${this.currentProblem.difficulty.toLowerCase()}`;
    this.status.textContent = this.session
      ? `Signed in as ${this.session.email}`
      : "Guest mode · Progress saved locally";
    this.runButton.disabled = !this.isProblemUnlocked() || this.running;
    this.submitButton.disabled = !this.isProblemUnlocked() || this.running;
    this.resetButton.disabled = !this.isProblemUnlocked() || this.running;
    this.fullscreenButton.disabled = this.running;
    this.renderDropdown();
    this.renderLayoutState();
    this.renderTabs();
    this.renderLeftContent();
    this.renderBottomContent();
    this.renderBanner();
    this.renderLockState();
    this.renderTimer();
  }

  private renderDropdown(): void {
    const dropdownHtml = getCheckpointProblems()
      .map((problem) => {
        const state = getCheckpointCardState(problem, this.lessonProgress, this.checkpointProgress, this.session);
        const iconStateClass =
          problem.id === this.currentProblem.id
            ? "is-current"
            : state === "completed"
              ? "is-completed"
              : state === "locked" || state === "locked-tier"
                ? "is-locked"
                : "";
        const icon = state === "completed" ? "✓" : state === "locked" || state === "locked-tier" ? "🔒" : problem.id.replace("cp", "");
        return `
          <button class="cp-problem-row${problem.id === this.currentProblem.id ? " is-current" : ""}" data-problem-id="${escapeHtml(problem.id)}" type="button">
            <span class="cp-problem-row__icon ${iconStateClass}">${escapeHtml(icon)}</span>
            <span class="cp-problem-row__body">
              <span class="cp-problem-row__title">${escapeHtml(problem.title)}</span>
              <span class="cp-problem-row__meta">${escapeHtml(problem.tags.join(" · "))}</span>
            </span>
            <span class="cp-difficulty-pill ${problem.difficulty.toLowerCase()}">${escapeHtml(problem.difficulty)}</span>
          </button>
        `;
      })
      .join("");

    this.problemDropdown.innerHTML = dropdownHtml;
    this.problemDropdown.querySelectorAll<HTMLButtonElement>("[data-problem-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const problemId = button.dataset.problemId;
        if (problemId) {
          setProblemInUrl(problemId);
        }
      });
    });
  }

  private toggleProblemDropdown(): void {
    const isOpen = !this.problemDropdown.hidden;
    if (isOpen) {
      this.closeProblemDropdown();
      return;
    }
    this.problemDropdown.hidden = false;
    this.problemButton.setAttribute("aria-expanded", "true");
  }

  private closeProblemDropdown(): void {
    this.problemDropdown.hidden = true;
    this.problemButton.setAttribute("aria-expanded", "false");
  }

  private renderLayoutState(): void {
    this.layout.classList.toggle("is-fullscreen", this.fullscreen);
    if (!this.fullscreen && window.innerWidth > 768) {
      this.leftPanel.style.flexBasis = `${this.verticalSplit}%`;
    } else {
      this.leftPanel.style.flexBasis = "";
    }
    const bottom = document.getElementById("cp-bottom") as HTMLElement;
    bottom.style.flexBasis = `${Math.max(80, this.horizontalSplit)}px`;
    this.layoutEditor();
  }

  private renderTabs(): void {
    document.querySelectorAll<HTMLButtonElement>(LEFT_TAB_BUTTONS).forEach((button) => {
      button.classList.toggle("active", button.dataset.leftTab === this.leftTab);
    });
    document.querySelectorAll<HTMLButtonElement>(BOTTOM_TAB_BUTTONS).forEach((button) => {
      button.classList.toggle("active", button.dataset.bottomTab === this.bottomTab);
    });
  }

  private renderLeftContent(): void {
    this.disposeViewers();
    if (this.leftTab === "description") {
      this.leftContent.innerHTML = this.renderDescriptionTab();
    } else if (this.leftTab === "hints") {
      this.leftContent.innerHTML = this.renderHintsTab();
    } else if (this.leftTab === "approach") {
      this.leftContent.innerHTML = this.renderApproachTab();
    } else {
      this.leftContent.innerHTML = this.renderSubmissionsTab();
      void this.renderSubmissionViewer();
    }
  }

  private renderDescriptionTab(): string {
    const acceptanceRate = getCheckpointAcceptanceRate(this.currentProblem.id, this.checkpointProgress);
    return `
      <div class="cp-rich">
        <div>${this.currentProblem.description}</div>
        <div class="cp-pill-row">
          ${this.currentProblem.tags.map((tag) => `<span class="cp-pill">${escapeHtml(tag)}</span>`).join("")}
        </div>
        ${
          this.currentProblem.companies?.length
            ? `<div class="cp-companies-row"><span class="cp-pill-label">Used in:</span>${this.currentProblem.companies
                .map((company) => `<span class="cp-pill">${escapeHtml(company)}</span>`)
                .join("")}</div>`
            : ""
        }
        <div class="cp-stats-row">
          <span class="cp-stat-card"><span>Acceptance</span><strong>${acceptanceRate === null ? "—" : `${acceptanceRate}%`}</strong></span>
          <span class="cp-stat-card"><span>Estimate</span><strong>${maybePlural(this.currentProblem.estimatedMinutes, "min")}</strong></span>
          <span class="cp-stat-card"><span>Tier</span><strong>${escapeHtml(this.currentProblem.requiredTier)}</strong></span>
        </div>
        <div class="cp-related-row">
          ${this.currentProblem.relatedLessons
            .map(
              (lessonNumber) => `
                <a class="cp-pill" href="${escapeHtml(relatedLessonLink(lessonNumber))}">
                  Lesson ${lessonNumber}
                </a>
              `
            )
            .join("")}
        </div>
        ${this.currentProblem.examples
          .map(
            (example, index) => `
              <section class="cp-example-card">
                <div class="cp-section-title">Example ${index + 1}</div>
                <div class="cp-io-block">
                  <div class="cp-io-label">Input</div>
                  <div class="cp-io-value">${escapeHtml(example.input)}</div>
                </div>
                <div class="cp-io-block">
                  <div class="cp-io-label">Output</div>
                  <div class="cp-io-value">${escapeHtml(example.output)}</div>
                </div>
                ${
                  example.registers?.length
                    ? `
                      <table class="cp-register-table">
                        <thead>
                          <tr><th>Register</th><th>Value</th></tr>
                        </thead>
                        <tbody>
                          ${example.registers
                            .map(
                              (register) => `
                                <tr>
                                  <td><span class="cp-reg-name ${registerRole(register.name)}">${escapeHtml(register.name)}</span></td>
                                  <td>${escapeHtml(register.value)}</td>
                                </tr>
                              `
                            )
                            .join("")}
                        </tbody>
                      </table>
                    `
                    : ""
                }
                <div class="cp-io-block">
                  <div class="cp-io-label">Explanation</div>
                  <div class="cp-submission-detail">${escapeHtml(example.explanation)}</div>
                </div>
              </section>
            `
          )
          .join("")}
        <section class="cp-constraints-card">
          <div class="cp-section-title">Constraints</div>
          <ul class="cp-constraints-list">
            ${this.currentProblem.constraints.map((constraint) => `<li>${escapeHtml(constraint)}</li>`).join("")}
          </ul>
        </section>
      </div>
    `;
  }

  private renderHintsTab(): string {
    const entry = ensureCheckpointEntry(this.checkpointProgress, this.currentProblem);
    return `
      <div class="cp-rich">
        <div class="cp-hint-intro">Hints help but cost you nothing — use them freely.</div>
        ${this.currentProblem.hints
          .map((hint, index) => {
            const hintNumber = index + 1;
            const isRevealed = entry.hintsRevealed >= hintNumber;
            const canReveal = isRevealed || entry.hintsRevealed + 1 >= hintNumber;
            return `
              <section class="cp-hint-card${isRevealed ? " is-open" : ""}">
                <div class="cp-hint-count">Hint ${hintNumber} of ${this.currentProblem.hints.length}</div>
                <button class="cp-hint-toggle" data-hint-index="${index}" type="button" ${canReveal ? "" : "disabled"}>
                  <span>${isRevealed ? `Hint ${hintNumber}` : `Show Hint ${hintNumber}`}</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                    <path d="m9 6 6 6-6 6"></path>
                  </svg>
                </button>
                <div class="cp-hint-body">
                  <p>${escapeHtml(hint)}</p>
                </div>
              </section>
            `;
          })
          .join("")}
      </div>
    `;
  }

  private renderApproachTab(): string {
    if (!isCheckpointCompleted(this.currentProblem.id, this.checkpointProgress)) {
      return `
        <div class="cp-approach-lock">
          <div class="cp-lock-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <rect x="4" y="10" width="16" height="10" rx="2"></rect>
              <path d="M8 10V7a4 4 0 1 1 8 0v3"></path>
            </svg>
          </div>
          <div>Complete this problem to reveal the approach.</div>
        </div>
      `;
    }

    return `<div class="cp-rich">${this.currentProblem.approach}</div>`;
  }

  private renderSubmissionsTab(): string {
    const submissions = getCheckpointAllSubmissions(this.currentProblem.id, this.checkpointProgress);
    const bestSubmission = getCheckpointBestSubmission(this.currentProblem.id, this.checkpointProgress);
    if (submissions.length === 0) {
      return `
        <div class="cp-empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M8 5h8M8 9h8M6 3h12a2 2 0 0 1 2 2v14l-4-3-4 3-4-3-4 3V5a2 2 0 0 1 2-2Z"></path>
          </svg>
          <div class="cp-empty-state__title">No submissions yet</div>
          <div class="cp-empty-state__body">Write your solution and click Submit.</div>
        </div>
      `;
    }

    return `
      <div class="cp-submissions-table">
        <div class="cp-submissions-header">
          <div>Status</div>
          <div>Details</div>
          <div>Time</div>
          <div>Date</div>
        </div>
        ${submissions
          .slice()
          .sort((left, right) => byBestSubmission(left, right))
          .map((submission, index) => {
            const key = `${submission.submittedAt}-${index}`;
            const statusClass = summaryTone({
              verdict: submission.verdict,
              passedCount: submission.passedCases,
              totalCount: submission.totalCases,
              results: [],
              totalSteps: submission.executionSteps,
              totalTimeMs: 0,
            } as RunSummary);
            const isBest = bestSubmission === submission;
            const details =
              submission.verdict === "Accepted"
                ? `Passed ${submission.passedCases}/${submission.totalCases} cases · ${submission.executionSteps} steps`
                : submission.verdict === "Wrong Answer"
                  ? `Failed ${escapeHtml(submission.failedCaseId ?? "a test case")}`
                  : escapeHtml((submission.errorMessage ?? submission.verdict).slice(0, 120));

            return `
              <div class="cp-submission-row${isBest ? " is-best" : ""}">
                <button class="cp-submission-row__button" data-submission-key="${escapeHtml(key)}" type="button">
                  <span class="cp-status-chip ${statusClass}">${escapeHtml(this.statusLabel(submission))}</span>
                  <span class="cp-submission-detail">${details}</span>
                  <span class="cp-submission-detail">${escapeHtml(`${submission.executionSteps} steps`)}</span>
                  <span class="cp-submission-detail">${escapeHtml(formatRelativeDate(submission.submittedAt))}</span>
                </button>
              </div>
              ${
                this.expandedSubmissionKey === key
                  ? `<div class="cp-submission-code" id="cp-submission-viewer-${escapeHtml(key)}" data-submission-viewer="${escapeHtml(key)}"></div>`
                  : ""
              }
            `;
          })
          .join("")}
      </div>
    `;
  }

  private statusLabel(submission: CheckpointSubmission): string {
    if (submission.verdict === "Accepted") {
      return "✓ Accepted";
    }
    if (submission.verdict === "Wrong Answer") {
      return `✗ Wrong Answer (${submission.passedCases}/${submission.totalCases})`;
    }
    if (submission.verdict === "Runtime Error") {
      return "⚠ Runtime Error";
    }
    if (submission.verdict === "Time Limit Exceeded") {
      return "⏱ Time Limit Exceeded";
    }
    return "✗ Assembly Error";
  }

  private async renderSubmissionViewer(): Promise<void> {
    if (!this.expandedSubmissionKey) {
      return;
    }
    const container = this.leftContent.querySelector<HTMLElement>(`[data-submission-viewer="${CSS.escape(this.expandedSubmissionKey)}"]`);
    if (!container) {
      return;
    }
    const submissions = getCheckpointAllSubmissions(this.currentProblem.id, this.checkpointProgress)
      .slice()
      .sort(byBestSubmission);
    const submission = submissions.find((entry, index) => `${entry.submittedAt}-${index}` === this.expandedSubmissionKey);
    if (!submission) {
      return;
    }

    this.monaco = this.monaco ?? (await loadMonaco());
    applyMonacoTheme(this.monaco);
    const viewer = initEditor(container, this.monaco, submission.code);
    viewer.updateOptions({ readOnly: true });
    this.viewerEditors.set(this.expandedSubmissionKey, viewer);
    viewer.layout();
  }

  private disposeViewers(): void {
    this.viewerEditors.forEach((viewer) => viewer.dispose());
    this.viewerEditors.clear();
  }

  private renderBottomContent(): void {
    if (this.bottomTab === "testcase") {
      this.bottomContent.innerHTML = this.renderTestcaseTab();
    } else {
      this.bottomContent.innerHTML = this.renderResultTab();
    }
  }

  private renderTestcaseTab(): string {
    const visibleCases = activeVisibleCases(this.currentProblem);
    const activeCase = visibleCases[this.activeVisibleCaseIndex] ?? visibleCases[0];
    if (!activeCase) {
      return "";
    }
    const expectedRegisters = this.latestSummary ? activeCase.expectedRegisters : {};
    const expectedMemory = this.latestSummary ? activeCase.expectedMemory ?? [] : [];

    return `
      <div class="cp-test-shell">
        <div class="cp-case-tabs">
          ${visibleCases
            .map(
              (testCase, index) => `
                <button class="cp-case-tab${index === this.activeVisibleCaseIndex ? " active" : ""}" data-case-index="${index}" type="button">
                  ${escapeHtml(testCase.label)}
                </button>
              `
            )
            .join("")}
        </div>
        ${renderRegisterTable(activeCase.initialRegisters, "Initial State")}
        ${renderMemoryTable(activeCase.initialMemory ?? [], "Initial Memory")}
        ${renderRegisterTable(expectedRegisters, "Expected after execution")}
        ${renderMemoryTable(
          expectedMemory.map((entry) => ({ address: entry.address, value: entry.value, size: entry.size })),
          "Expected Memory"
        )}
      </div>
    `;
  }

  private renderResultTab(): string {
    if (!this.latestSummary) {
      return `
        <div class="cp-empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="m8 6 10 6-10 6z"></path>
          </svg>
          <div class="cp-empty-state__title">Run your code to see test results.</div>
          <div class="cp-empty-state__body">Visible cases appear on Run. Hidden cases appear on Submit.</div>
        </div>
      `;
    }

    const pass = this.latestSummary.verdict === "Accepted";
    return `
      <div class="cp-result-shell">
        <div class="cp-result-summary">
          <div class="cp-result-summary__title ${pass ? "pass" : "fail"}">
            ${
              pass
                ? `${this.latestSummary.passedCount}/${this.latestSummary.totalCount} test cases passed`
                : `${this.latestSummary.passedCount}/${this.latestSummary.totalCount} test cases passed · ${escapeHtml(this.latestSummary.verdict)}`
            }
          </div>
          <div class="cp-submission-detail">${escapeHtml(`${this.latestSummary.totalSteps} steps · ${Math.round(this.latestSummary.totalTimeMs)} ms`)}</div>
        </div>
        <div class="cp-result-list">
          ${this.latestSummary.results
            .map((result, index) => {
              const status = result.passed ? "pass" : "fail";
              const hidden = result.label.startsWith("Hidden Case");
              const canExpand = !result.passed && (!hidden || this.latestRunMode !== "submit");
              const detail = this.resultDetail(result, hidden);
              return `
                <div class="cp-result-row">
                  <button class="cp-result-row__button" data-result-toggle="${index}" type="button" aria-expanded="false">
                    <span class="cp-result-row__status ${status}">${result.passed ? "✓" : "✗"} ${escapeHtml(result.label)}</span>
                    <span class="cp-submission-detail">${escapeHtml(result.passed ? "Pass" : result.verdict)}</span>
                  </button>
                  ${
                    canExpand || detail
                      ? `<div class="cp-result-row__detail" data-result-detail="${index}" hidden>${detail}</div>`
                      : ""
                  }
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `;
  }

  private resultDetail(result: RunResult, hidden: boolean): string {
    if (hidden && this.latestRunMode === "submit") {
      return "";
    }

    if (result.verdict === "Assembly Error" || result.verdict === "Runtime Error") {
      return `<div class="cp-error-box">${escapeHtml(result.errorMessage ?? "Execution failed.")}</div>`;
    }
    if (result.verdict === "Time Limit Exceeded") {
      return `<div class="cp-error-box">${escapeHtml(result.errorMessage ?? "The submission exceeded the step limit.")}</div>`;
    }
    if (result.diff.length === 0) {
      return "";
    }

    return `
      <div class="cp-diff-grid">
        <div class="cp-diff-card">
          <div class="cp-diff-card__title">Expected</div>
          <table class="cp-result-diff">
            <tbody>
              ${result.diff
                .map(
                  (entry) => `
                    <tr>
                      <td>${escapeHtml(entry.register ?? formatSizedValue(entry.address ?? 0))}</td>
                      <td>${escapeHtml(formatCheckpointDiffValue(entry.expected))}</td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        </div>
        <div class="cp-diff-card">
          <div class="cp-diff-card__title">Actual</div>
          <table class="cp-result-diff">
            <tbody>
              ${result.diff
                .map(
                  (entry) => `
                    <tr>
                      <td>${escapeHtml(entry.register ?? formatSizedValue(entry.address ?? 0))}</td>
                      <td class="cp-diff-value is-different">${escapeHtml(formatCheckpointDiffValue(entry.actual))}</td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  private renderBanner(): void {
    if (!this.banner) {
      this.verdictLayer.innerHTML = "";
      return;
    }

    this.verdictLayer.innerHTML = `
      <div class="cp-verdict-banner is-visible">
        <div class="cp-verdict-banner__inner ${this.banner.tone}">
          <div class="cp-verdict-banner__main ${this.banner.tone}">
            <div class="cp-verdict-banner__icon">${this.banner.tone === "accepted" ? "✓" : this.banner.tone === "wa" ? "✗" : this.banner.tone === "tle" ? "⏱" : "⚠"}</div>
            <div>
              <div class="cp-verdict-banner__title">${escapeHtml(this.banner.title)}</div>
              <div class="cp-verdict-banner__detail">${escapeHtml(this.banner.detail)}</div>
              ${this.banner.detailMono ? `<div class="cp-verdict-banner__detail mono">${escapeHtml(this.banner.detailMono)}</div>` : ""}
            </div>
          </div>
          <div class="cp-verdict-banner__actions">
            ${this.banner.xp ? `<span class="cp-verdict-banner__xp">+${this.banner.xp} XP</span>` : ""}
            <button class="cp-verdict-banner__close" id="cp-banner-close" type="button" aria-label="Close">×</button>
          </div>
          ${
            this.banner.confetti.length
              ? `<div class="cp-confetti">
                  ${this.banner.confetti
                    .map(
                      (piece) => `
                        <span
                          class="cp-confetti__piece"
                          style="--cp-left:${piece.left};--cp-delay:${piece.delay};--cp-duration:${piece.duration};--cp-color:${piece.color};"
                        ></span>
                      `
                    )
                    .join("")}
                </div>`
              : ""
          }
        </div>
      </div>
    `;

    this.verdictLayer.querySelector<HTMLButtonElement>("#cp-banner-close")?.addEventListener("click", () => {
      this.clearBanner();
    });
  }

  private clearBanner(): void {
    if (this.bannerTimer) {
      window.clearTimeout(this.bannerTimer);
      this.bannerTimer = null;
    }
    this.banner = null;
    this.renderBanner();
  }

  private renderLockState(): void {
    const state = getCheckpointCardState(
      this.currentProblem,
      this.lessonProgress,
      this.checkpointProgress,
      this.session
    );

    if (state === "unlocked" || state === "completed") {
      this.lockShell.hidden = true;
      return;
    }

    const completedLessons = countCompletedRequiredLessons(this.currentProblem, this.lessonProgress);
    const totalLessons = this.currentProblem.unlocksAfterLessons.length;
    const progressPct = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;
    const currentTier = getCurrentCheckpointTier(this.session);
    const tierMessage =
      this.currentProblem.requiredTier === "Free"
        ? "Sign in to unlock this checkpoint."
        : "Georgia Tech Pro access required.";

    this.lockShell.hidden = false;
    this.lockShell.innerHTML = `
      <div class="cp-lock-card">
        <div class="cp-lock-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <rect x="4" y="10" width="16" height="10" rx="2"></rect>
            <path d="M8 10V7a4 4 0 1 1 8 0v3"></path>
          </svg>
        </div>
        <div class="cp-lock-title">Checkpoint Locked</div>
        <div class="cp-lock-body">
          ${
            state === "locked"
              ? `Complete Lessons ${escapeHtml(formatLessonRange(this.currentProblem))} to unlock this checkpoint.`
              : `${escapeHtml(tierMessage)} Current tier: ${escapeHtml(currentTier)}.`
          }
        </div>
        ${
          state === "locked"
            ? `
              <div class="cp-progress-bar" aria-hidden="true">
                <div class="cp-progress-bar__fill" style="width:${progressPct}%"></div>
              </div>
              <div class="cp-submission-detail">${completedLessons}/${totalLessons} required lessons completed</div>
            `
            : ""
        }
        <div class="cp-lock-actions">
          ${
            state === "locked"
              ? `<a class="cp-lock-btn primary" href="/learn/">Continue learning →</a>`
              : `<button class="cp-lock-btn primary" data-cp-auth-action="signin" type="button">${this.currentProblem.requiredTier === "Free" ? "Sign in →" : "Sign in with GT email →"}</button>`
          }
        </div>
      </div>
    `;
  }

  private revealHint(index: number): void {
    const entry = ensureCheckpointEntry(this.checkpointProgress, this.currentProblem);
    const nextCount = Math.max(entry.hintsRevealed, index + 1);
    if (nextCount === entry.hintsRevealed) {
      return;
    }

    entry.hintsRevealed = nextCount;
    this.persistCheckpointProgress(false);
    this.renderLeftContent();
  }

  private renderTimer(): void {
    const seconds = Math.floor(timerElapsedMs(this.timerState) / 1000);
    this.timerButton.textContent = `⏱ ${formatElapsed(seconds)}`;
    this.timerButton.classList.toggle(
      "is-warning",
      seconds >= 30 * 60 && !isCheckpointCompleted(this.currentProblem.id, this.checkpointProgress)
    );
  }

  private maybeAutosaveCode(): void {
    if (!this.editor || !this.isProblemUnlocked()) {
      return;
    }

    const elapsed = timerElapsedMs(this.timerState);
    if (elapsed === 0 || elapsed % CODE_SAVE_INTERVAL_MS > 1000) {
      return;
    }

    saveCheckpointCode(this.currentProblem.id, this.editor.getValue());
    this.showSaveIndicator(`Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  }

  private showSaveIndicator(message: string): void {
    this.saveIndicator.textContent = message;
    this.saveIndicator.classList.add("is-visible");
    if (this.saveIndicatorTimer) {
      window.clearTimeout(this.saveIndicatorTimer);
    }
    this.saveIndicatorTimer = window.setTimeout(() => {
      this.saveIndicator.classList.remove("is-visible");
    }, 2000);
  }

  private persistCheckpointProgress(syncToApi: boolean): void {
    const normalized = normalizeCheckpointProgress(this.checkpointProgress);
    this.checkpointProgress = normalized;
    saveCheckpointProgressForUser(normalized, this.session?.userId ?? null);
    if (syncToApi && this.session?.idToken) {
      void syncCheckpointProgressToApi(normalized, this.session.idToken);
    }
  }

  private async execute(mode: "run" | "submit"): Promise<void> {
    if (!this.editor || !this.isProblemUnlocked() || this.running) {
      return;
    }

    this.running = true;
    this.render();
    this.editor.updateOptions({ readOnly: true });
    this.editorLoading.hidden = false;

    try {
      const source = this.editor.getValue();
      const runtime = await this.getRuntime();
      const summary =
        mode === "run"
          ? await runVisible(source, this.currentProblem.testCases, runtime)
          : await runAll(source, this.currentProblem.testCases, runtime);

      this.latestSummary = summary;
      this.latestRunMode = mode;
      this.bottomTab = "result";
      if (mode === "submit") {
        saveCheckpointCode(this.currentProblem.id, source);
        const entry = ensureCheckpointEntry(this.checkpointProgress, this.currentProblem);
        const submission: CheckpointSubmission = {
          problemId: this.currentProblem.id,
          code: source,
          verdict: summary.verdict,
          passedCases: summary.passedCount,
          totalCases: summary.totalCount,
          executionSteps: summary.totalSteps,
          submittedAt: new Date().toISOString(),
          failedCaseId: summary.firstFailedCase?.caseId,
          errorMessage: summary.firstFailedCase?.errorMessage,
          elapsedSeconds: Math.floor(timerElapsedMs(this.timerState) / 1000),
        };
        entry.allSubmissions = [submission, ...entry.allSubmissions].sort(
          (left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt)
        );
        entry.bestSubmission = entry.allSubmissions.slice().sort(byBestSubmission)[0];
        if (summary.verdict === "Accepted") {
          entry.completed = true;
          entry.completedAt ??= submission.submittedAt;
        }
        this.persistCheckpointProgress(true);
        this.timerState = resetTimer(this.currentProblem.id);
      }
      this.banner = bannerForSummary(this.currentProblem, summary, this.session);
      if (this.bannerTimer) {
        window.clearTimeout(this.bannerTimer);
      }
      this.bannerTimer = window.setTimeout(() => this.clearBanner(), BANNER_DISMISS_MS);
      this.render();
    } catch (error) {
      this.banner = {
        tone: "error",
        title: "Runtime Error",
        detail: "The checkpoint runner could not start.",
        detailMono: error instanceof Error ? error.message : String(error),
        confetti: [],
      };
      this.render();
    } finally {
      this.running = false;
      this.editorLoading.hidden = true;
      this.editor?.updateOptions({ readOnly: false });
      this.render();
      this.layoutEditor();
    }
  }

  private layoutEditor(): void {
    window.requestAnimationFrame(() => {
      if (!this.editor) {
        return;
      }
      const toolbarHeight = this.rightPanel.querySelector<HTMLElement>(".cp-editor-toolbar")?.offsetHeight ?? 0;
      const bottomHeight = (document.getElementById("cp-bottom") as HTMLElement).offsetHeight;
      const actionHeight = this.rightPanel.querySelector<HTMLElement>(".cp-action-bar")?.offsetHeight ?? 0;
      const dividerHeight = this.dividerH.offsetHeight;
      const editorHeight = Math.max(160, this.rightPanel.clientHeight - toolbarHeight - bottomHeight - actionHeight - dividerHeight);
      this.editorStage.style.height = `${editorHeight}px`;
      this.editorRoot.style.height = `${editorHeight}px`;
      this.editor.layout();
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const app = new CheckpointApp();
  void app.init();
});

import type { UserSession } from "./auth";
import { loadChallengeSubmissions } from "./challenges";
import { escapeHtml, hex32 } from "./format";
import {
  checkGoals,
  getLesson,
  getLessons,
  getLessonState,
  loadProgress,
  loadProgressFromApi,
  saveProgress,
  syncProgressToApi,
  type Lesson,
  type LessonProgress,
  type LessonStep,
  type LessonGoal,
  type UserProgress,
} from "./lessons";
import { showNotification } from "./notifications";
import { buildReferralLink } from "./referrals";
import { addPoints, checkAndAwardBadges, loadScore, recordRecentActivity, syncScoreToApi } from "./scoring";
import { createShareSection } from "./share-card-ui";
import type { WasmStateDelta } from "./types";
import { activateWatchMode, deactivateWatchMode, generateNarration, isWatchModeActive } from "./watch-mode";

type LoadSourceOptions = {
  statusMessage?: string;
  focus?: boolean;
};

type LessonModeDependencies = {
  loadSource: (source: string, options?: LoadSourceOptions) => void;
  assembleSource: (showSpinner: boolean, successMessage: string) => Promise<boolean>;
  getExecutionDeltas: () => WasmStateDelta[];
  getInstructionCount: () => number;
  getInstructionText: (pc: number) => string;
  getCurrentSession: () => UserSession | null;
  stepForward: () => void;
  setEditorReadOnly: (readOnly: boolean) => void;
  showToast: (message: string) => void;
  setStatusMessage: (message: string) => void;
};

export interface LessonModeController {
  isActive(): boolean;
  prefillSource(): void;
  initialize(): Promise<void>;
  handleAssembled(): void;
  handleStep(recordAttempt?: boolean): void;
  handleStepBack(): void;
  handleRunEnd(): void;
  handleReset(): void;
  handleSessionChange(session: UserSession | null): Promise<void>;
}

type GoalEvaluation = {
  passed: boolean;
  results: Record<string, boolean>;
};

type StepPhase = "reading" | "watching" | "trying";

export const LESSON_READING_CURRENT_DOT_WIDTH = 20;
export const LESSON_READING_DEFAULT_DOT_WIDTH = 7;
export const LESSON_READING_CHECKPOINT_DOT_RADIUS = 2;
export const LESSON_COMPLETION_XP = 50;

const REGISTER_ABI_NAMES = [
  "zero",
  "ra",
  "sp",
  "gp",
  "tp",
  "t0",
  "t1",
  "t2",
  "s0/fp",
  "s1",
  "a0",
  "a1",
  "a2",
  "a3",
  "a4",
  "a5",
  "a6",
  "a7",
  "s2",
  "s3",
  "s4",
  "s5",
  "s6",
  "s7",
  "s8",
  "s9",
  "s10",
  "s11",
  "t3",
  "t4",
  "t5",
  "t6",
] as const;

const LESSON_INSTRUCTION_PATTERN =
  /^(?<mnemonic>[a-z.][a-z0-9.]*)\s+(?<operands>.+)$/i;
const REGISTER_TOKEN_PATTERN =
  /\b(?:x(?:[0-9]|[12][0-9]|3[01])|zero|ra|sp|gp|tp|a[0-7]|s(?:0(?:\/fp)?|1[0-1]?|[2-9]|fp)|t[0-6])\b/gi;
const REGISTER_TOKEN_EXACT_PATTERN =
  /^(?:x(?:[0-9]|[12][0-9]|3[01])|zero|ra|sp|gp|tp|a[0-7]|s(?:0(?:\/fp)?|1[0-1]?|[2-9]|fp)|t[0-6])$/i;
const ADDRESS_TOKEN_PATTERN = /\b0x[0-9a-fA-F]+\b/g;
const STRONG_PATTERN = /\*\*([^*]+)\*\*/g;
const INLINE_CODE_PATTERN = /`([^`]+)`/g;
const PROTECTED_TOKEN_PREFIX = "__LRO_TOKEN__";

const KNOWN_MNEMONICS = new Set([
  "add",
  "addi",
  "sub",
  "mul",
  "div",
  "rem",
  "lw",
  "lh",
  "lb",
  "lbu",
  "lhu",
  "sw",
  "sh",
  "sb",
  "beq",
  "bne",
  "blt",
  "bge",
  "bltu",
  "bgeu",
  "jal",
  "jalr",
  "li",
  "mv",
  "la",
  "nop",
  "j",
  "ret",
  "call",
  "ecall",
  "ebreak",
]);

const REGISTER_DESCRIPTIONS: Record<string, string> = {
  zero: "constant zero",
  ra: "return address",
  sp: "stack pointer",
  gp: "global pointer",
  tp: "thread pointer",
  a0: "arg / return value",
  a1: "arg",
  a2: "arg",
  a3: "arg",
  a4: "arg",
  a5: "arg",
  a6: "arg",
  a7: "arg / syscall",
  s0: "saved / frame pointer",
  fp: "frame pointer",
  s1: "saved register",
  t0: "temporary",
  t1: "temporary",
  t2: "temporary",
  t3: "temporary",
  t4: "temporary",
  t5: "temporary",
  t6: "temporary",
};

type ProtectedChunkStore = {
  chunks: Map<string, string>;
  nextId: number;
};

function getRegisterAbiName(index: number): string {
  return REGISTER_ABI_NAMES[index] ?? `x${index}`;
}

function createLessonProgress(lesson: Lesson, existing?: LessonProgress): LessonProgress {
  return {
    lessonId: lesson.id,
    completed: existing?.completed === true,
    currentStepIndex: Math.min(existing?.currentStepIndex ?? 0, lesson.steps.length - 1),
    stepsCompleted: existing?.stepsCompleted ? Array.from(new Set(existing.stepsCompleted)) : [],
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    completedAt: existing?.completedAt,
    attempts: existing?.attempts ?? 0,
  };
}

function mergeProgress(localProgress: UserProgress, apiProgress: UserProgress): UserProgress {
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

function uniqueStepIds(stepIds: string[]): string[] {
  return Array.from(new Set(stepIds));
}

function createProtectedStore(): ProtectedChunkStore {
  return {
    chunks: new Map<string, string>(),
    nextId: 0,
  };
}

function lessonPrefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function stashProtectedHtml(store: ProtectedChunkStore, html: string): string {
  const token = `${PROTECTED_TOKEN_PREFIX}${store.nextId++}__`;
  store.chunks.set(token, html);
  return token;
}

function restoreProtectedHtml(value: string, store: ProtectedChunkStore): string {
  let restored = value;
  for (const [token, html] of store.chunks.entries()) {
    restored = restored.split(token).join(html);
  }
  return restored;
}

function normalizeRegisterToken(token: string): string {
  const lower = token.toLowerCase();
  if (lower === "s0/fp") {
    return "fp";
  }
  return lower;
}

function renderRegisterReference(token: string): string {
  const normalized = normalizeRegisterToken(token);
  const label = normalized.startsWith("x") ? normalized : token;
  const description = REGISTER_DESCRIPTIONS[normalized];
  return `<span class="lro-reg-ref">${escapeHtml(label)}${
    description ? `<span class="lro-reg-ref__meta">${escapeHtml(description)}</span>` : ""
  }</span>`;
}

function renderInlineRich(text: string): string {
  if (!text.trim()) {
    return "";
  }

  const inlineStore = createProtectedStore();
  let processed = text.replace(INLINE_CODE_PATTERN, (_, inner: string) =>
    stashProtectedHtml(inlineStore, `<code>${escapeHtml(inner)}</code>`)
  );

  processed = escapeHtml(processed).replace(STRONG_PATTERN, "<strong>$1</strong>");
  processed = processed.replace(ADDRESS_TOKEN_PATTERN, (match) => `<span class="lro-addr-ref">${match}</span>`);
  processed = processed.replace(REGISTER_TOKEN_PATTERN, (match) => renderRegisterReference(match));

  return restoreProtectedHtml(processed, inlineStore);
}

function renderInstructionSyntax(syntax: string, description?: string, label?: string): string {
  const trimmed = syntax.trim();
  const [mnemonic = "", ...rawOperands] = trimmed.replace(/,/g, " , ").split(/\s+/).filter(Boolean);
  const operands = rawOperands.map((part, index) => {
    if (part === ",") {
      return ", ";
    }
    if (REGISTER_TOKEN_EXACT_PATTERN.test(part)) {
      const cls = index === 0 ? "lro-instruction-block__rd" : "lro-instruction-block__rs";
      return `<span class="${cls}">${escapeHtml(part)}</span>`;
    }
    if (/^-?(?:0x[0-9a-f]+|\d+)$/i.test(part)) {
      return `<span class="lro-instruction-block__imm">${escapeHtml(part)}</span>`;
    }
    return `<span class="lro-instruction-block__label">${escapeHtml(part)}</span>`;
  });

  return `<div class="lro-instruction-block">
    <div class="lro-instruction-block__header">${escapeHtml(label ?? "Instruction")}</div>
    <div class="lro-instruction-block__syntax">
      <span class="lro-instruction-block__mnemonic">${escapeHtml(mnemonic)}</span>
      ${operands.join(" ")}
    </div>
    ${
      description
        ? `<div class="lro-instruction-block__description">${renderInlineRich(description)}</div>`
        : ""
    }
  </div>`;
}

function renderInstructionLine(line: string): string | null {
  const match = LESSON_INSTRUCTION_PATTERN.exec(line.trim());
  if (!match?.groups) {
    return null;
  }

  const { mnemonic, operands } = match.groups;
  if (!KNOWN_MNEMONICS.has(mnemonic.toLowerCase())) {
    return null;
  }

  return renderInstructionSyntax(`${mnemonic} ${operands}`, undefined, `${mnemonic.toUpperCase()} syntax`);
}

export function renderStepContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  const store = createProtectedStore();
  let safeContent = trimmed;

  safeContent = safeContent.replace(/```([\s\S]*?)```/g, (_, inner: string) =>
    stashProtectedHtml(
      store,
      `<pre><div class="code-header">Assembly</div><code>${escapeHtml(inner.trim())}</code></pre>`
    )
  );

  safeContent = safeContent.replace(/\[instruction(?:\s+([^\]]+))?\]([\s\S]*?)\[\/instruction\]/gi, (_, rawName: string | undefined, inner: string) => {
    const lines = inner
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const syntax = lines.shift() ?? rawName ?? "";
    const description = lines.join(" ");
    const label = rawName ? `${rawName.toUpperCase()} instruction` : "Instruction";
    return stashProtectedHtml(store, renderInstructionSyntax(syntax, description, label));
  });

  safeContent = safeContent.replace(/\[tip\]([\s\S]*?)\[\/tip\]/gi, (_, inner: string) =>
    stashProtectedHtml(
      store,
      `<div class="lro-tip">
        <span class="lro-tip__icon">💡</span>
        <div class="lro-tip__body">
          <span class="lro-tip__label">Tip</span>
          ${renderInlineRich(inner.trim()).replace(/\n/g, "<br />")}
        </div>
      </div>`
    )
  );

  safeContent = safeContent.replace(/\[warning\]([\s\S]*?)\[\/warning\]/gi, (_, inner: string) =>
    stashProtectedHtml(
      store,
      `<div class="lro-tip lro-warning">
        <span class="lro-tip__icon">⚠️</span>
        <div class="lro-tip__body">
          <span class="lro-tip__label">Warning</span>
          ${renderInlineRich(inner.trim()).replace(/\n/g, "<br />")}
        </div>
      </div>`
    )
  );

  safeContent = safeContent.replace(/\[concept\]([\s\S]*?)\[\/concept\]/gi, (_, inner: string) =>
    stashProtectedHtml(store, `<div class="lro-concept"><div class="lro-concept__body">${renderInlineRich(inner.trim())}</div></div>`)
  );

  const blocks = safeContent
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const rendered = blocks
    .map((block) => {
      if (store.chunks.has(block)) {
        return block;
      }
      if (block === "---") {
        return "<hr />";
      }

      const lines = block.split("\n").map((line) => line.trimEnd());
      if (lines.every((line) => line.startsWith("#"))) {
        return lines
          .map((line) => `<div class="lro-section-label">${renderInlineRich(line.replace(/^#+\s*/, ""))}</div>`)
          .join("");
      }

      if (lines.every((line) => line.startsWith("- "))) {
        return `<ul class="lesson-list">${lines.map((line) => `<li>${renderInlineRich(line.slice(2))}</li>`).join("")}</ul>`;
      }

      if (lines.every((line) => /^\d+\.\s/.test(line))) {
        return `<ol class="lesson-list lesson-list--ordered">${lines
          .map((line) => `<li>${renderInlineRich(line.replace(/^\d+\.\s/, ""))}</li>`)
          .join("")}</ol>`;
      }

      const renderedInstructions = lines
        .map((line) => renderInstructionLine(line))
        .filter((line): line is string => Boolean(line));
      if (renderedInstructions.length === lines.length && renderedInstructions.length > 0) {
        return renderedInstructions.join("");
      }

      return `<p>${lines.map((line) => renderInlineRich(line)).join("<br />")}</p>`;
    })
    .join("");

  return restoreProtectedHtml(rendered, store);
}

export function createLessonMode(deps: LessonModeDependencies): LessonModeController {
  const searchParams = new URLSearchParams(window.location.search);
  const lessonId = searchParams.get("lesson");
  const requestedStepId = searchParams.get("step");
  const resolvedLesson = lessonId ? getLesson(lessonId) : null;

  if (!resolvedLesson) {
    return {
      isActive: () => false,
      prefillSource: () => {},
      initialize: async () => {},
      handleAssembled: () => {},
      handleStep: () => {},
      handleStepBack: () => {},
      handleRunEnd: () => {},
      handleReset: () => {},
      handleSessionChange: async () => {},
    };
  }

  const lesson = resolvedLesson;

  const allLessons = getLessons();
  let progress = loadProgress();
  let lessonProgress = createLessonProgress(lesson, progress.lessons[lesson.id]);
  if (requestedStepId) {
    const requestedStepIndex = lesson.steps.findIndex((step) => step.id === requestedStepId);
    if (requestedStepIndex >= 0) {
      lessonProgress.currentStepIndex = requestedStepIndex;
    }
  }
  let goalEvaluation: GoalEvaluation = { passed: false, results: {} };
  let currentState = getLessonState([]);
  let goalFeedback: Record<string, string> = {};
  let hintVisibility = new Set<string>();
  let stepAttemptCounts = new Map<string, number>();
  let runtimeReady = false;
  let completionVisible = lessonProgress.completed;
  let watchPlaying = false;
  let watchCompleted = false;
  let watchSpeed: 0.5 | 1 | 2 = 1;
  let watchNarration = "";
  let watchStarterCode = "";
  let watchLastState = currentState;
  let watchInstructionCount = 0;
  let watchTimer: number | null = null;
  let stepPhase: StepPhase = "reading";
  let pendingEnterDirection: "left" | "right" | null = null;
  let shortcutsOpen = false;
  let compactCollapsed = false;

  const simulatorLayout = document.querySelector(".simulator-layout");
  const leftColumn = document.querySelector(".sim-column--left");
  const centerColumn = document.querySelector(".sim-column--center");
  const rightColumn = document.querySelector(".sim-column--right");
  const editorPanel = document.querySelector(".sim-panel--editor") as HTMLElement | null;
  const brandRow = document.querySelector(".sim-nav__brand-row");
  const simulatorApp = document.querySelector(".simulator-app");
  const sampleSelect = document.querySelector<HTMLSelectElement>("#sampleSelect");
  const assembleButton = document.querySelector<HTMLButtonElement>("#assemble");
  const stepButton = document.querySelector<HTMLButtonElement>("#step");
  const stepBackButton = document.querySelector<HTMLButtonElement>("#stepBack");
  const runButton = document.querySelector<HTMLButtonElement>("#run");
  const resetButton = document.querySelector<HTMLButtonElement>("#reset");
  const sourceTextarea = document.querySelector<HTMLTextAreaElement>("#source-input");

  if (
    !(simulatorLayout instanceof HTMLElement) ||
    !(leftColumn instanceof HTMLElement) ||
    !(centerColumn instanceof HTMLElement) ||
    !(rightColumn instanceof HTMLElement) ||
    !(editorPanel instanceof HTMLElement) ||
    !(simulatorApp instanceof HTMLElement)
  ) {
    return {
      isActive: () => false,
      prefillSource: () => {},
      initialize: async () => {},
      handleAssembled: () => {},
      handleStep: () => {},
      handleStepBack: () => {},
      handleRunEnd: () => {},
      handleReset: () => {},
      handleSessionChange: async () => {},
    };
  }

  const simulatorLayoutEl = simulatorLayout;
  const simulatorAppEl = simulatorApp;
  const editorPanelEl = editorPanel;

  const panel = document.createElement("div");
  panel.className = "lro";
  panel.id = "lesson-reading-overlay";
  panel.setAttribute("role", "main");
  panel.setAttribute("aria-label", "Lesson content");
  panel.hidden = true;

  const lessonOverlayRoot =
    document.getElementById("lesson-reading-overlay-root") ??
    (() => {
      const root = document.createElement("div");
      root.id = "lesson-reading-overlay-root";
      document.body.appendChild(root);
      return root;
    })();
  lessonOverlayRoot.appendChild(panel);

  const compactShell = document.createElement("div");
  compactShell.className = "lesson-inline-shell";
  compactShell.id = "lessonCompactShell";
  compactShell.hidden = true;
  simulatorAppEl.insertBefore(compactShell, simulatorLayoutEl);

  const navIndicator = document.createElement("a");
  navIndicator.className = "lesson-nav-indicator";
  navIndicator.href = "/learn/";
  navIndicator.hidden = true;
  brandRow?.appendChild(navIndicator);

  function clearWatchTimer(): void {
    if (watchTimer !== null) {
      window.clearTimeout(watchTimer);
      watchTimer = null;
    }
  }

  function currentWatchStepActive(): boolean {
    return isWatchModeActive();
  }

  function canWatch(step: LessonStep): boolean {
    return Boolean((step.solution ?? step.code)?.trim());
  }

  function isCheckpointStep(step: LessonStep): boolean {
    return step.isCheckpoint === true && Array.isArray(step.goals) && step.goals.length > 0;
  }

  function showFullRegisters(step: LessonStep): boolean {
    const lessonNumber = allLessons.findIndex((entry) => entry.id === lesson.id) + 1;
    return (
      lessonNumber >= 6 ||
      step.goals?.some((goal) => goal.description.toLowerCase().includes("register")) === true && lessonNumber >= 3
    );
  }

  function resolvePhaseForStep(step: LessonStep, phase: string | null): StepPhase {
    if (!isCheckpointStep(step)) {
      return "reading";
    }
    if (phase === "watching" && canWatch(step)) {
      return "watching";
    }
    if (phase === "trying") {
      return "trying";
    }
    return "reading";
  }

  function updateUrl(push = false): void {
    const url = new URL(window.location.href);
    url.searchParams.set("lesson", lesson.id);
    url.searchParams.set("step", currentStep().id);
    url.searchParams.set("phase", stepPhase);
    const method = push ? "pushState" : "replaceState";
    window.history[method]({}, "", url);
  }

  function isWideLessonSplit(): boolean {
    return stepPhase !== "reading" && window.innerWidth >= 1200;
  }

  function isLessonSimulatorMode(): boolean {
    return stepPhase !== "reading" && !isWideLessonSplit();
  }

  function applyPhaseClasses(): void {
    const wantsRegisters = stepPhase !== "reading" && showFullRegisters(currentStep());
    const reading = stepPhase === "reading";
    const split = isWideLessonSplit();
    const simulatorOnly = isLessonSimulatorMode();

    document.body.classList.add("lesson-mode", "lesson-mode-active");
    document.body.classList.toggle("lesson-reading-active", reading);
    document.body.classList.toggle("lesson-split-mode", split);
    document.body.classList.toggle("lesson-simulator-active", simulatorOnly);
    document.body.classList.toggle("lesson-phase-reading", reading);
    document.body.classList.toggle("lesson-phase-watching", stepPhase === "watching");
    document.body.classList.toggle("lesson-phase-trying", stepPhase === "trying");
    document.body.classList.toggle("lesson-show-registers", wantsRegisters);

    simulatorAppEl.classList.add("lesson-mode");
    simulatorAppEl.classList.toggle("lesson-split-mode", split);
    simulatorAppEl.classList.toggle("lesson-simulator-active", simulatorOnly);
    simulatorAppEl.classList.toggle("lesson-phase-reading", reading);
    simulatorAppEl.classList.toggle("lesson-phase-watching", stepPhase === "watching");
    simulatorAppEl.classList.toggle("lesson-phase-trying", stepPhase === "trying");
    simulatorAppEl.classList.toggle("lesson-show-registers", wantsRegisters);

    simulatorLayoutEl.classList.add("lesson-mode");
    simulatorLayoutEl.classList.toggle("lesson-split-mode", split);
    simulatorLayoutEl.classList.toggle("lesson-simulator-active", simulatorOnly);
    simulatorLayoutEl.classList.toggle("lesson-phase-reading", reading);
    simulatorLayoutEl.classList.toggle("lesson-phase-watching", stepPhase === "watching");
    simulatorLayoutEl.classList.toggle("lesson-phase-trying", stepPhase === "trying");
    simulatorLayoutEl.classList.toggle("lesson-show-registers", wantsRegisters);

    panel.hidden = reading ? false : !split && !completionVisible;
    compactShell.hidden = !(simulatorOnly && !completionVisible);
  }

  function syncPhaseControls(): void {
    const interactive = stepPhase === "trying";
    const watching = stepPhase === "watching";
    sampleSelect?.toggleAttribute("disabled", !interactive);
    assembleButton?.toggleAttribute("disabled", !interactive);
    stepButton?.toggleAttribute("disabled", !interactive && !watching);
    stepBackButton?.toggleAttribute("disabled", !interactive);
    runButton?.toggleAttribute("disabled", true);
    resetButton?.toggleAttribute("disabled", !interactive && !watching);
    if (sourceTextarea) {
      sourceTextarea.readOnly = watching || !interactive;
    }
  }

  function syncEditorReadOnly(): void {
    deps.setEditorReadOnly(currentWatchStepActive() || stepPhase !== "trying");
    syncPhaseControls();
  }

  function stopWatchPlayback(): void {
    watchPlaying = false;
    clearWatchTimer();
  }

  function resetWatchState(): void {
    stopWatchPlayback();
    watchCompleted = false;
    watchNarration = "";
    watchStarterCode = "";
    watchInstructionCount = 0;
    watchLastState = getLessonState([]);
    deactivateWatchMode();
    syncEditorReadOnly();
  }

  function queueWatchStep(): void {
    clearWatchTimer();
    if (!watchPlaying || watchCompleted) {
      return;
    }
    const delay = Math.round(1500 / watchSpeed);
    watchTimer = window.setTimeout(() => {
      deps.stepForward();
    }, delay);
  }

  async function enterWatchMode(): Promise<void> {
    const step = currentStep();
    const solution = (step.solution ?? step.code ?? "").trim();
    if (!solution) {
      return;
    }

    watchStarterCode = step.code ?? "";
    watchCompleted = false;
    watchPlaying = false;
    watchNarration = "Watch the full solution execute, then switch back to the starter and solve it yourself.";
    activateWatchMode(lesson.id, step.id);
    syncEditorReadOnly();

    deps.loadSource(solution, {
      statusMessage: "",
      focus: false,
    });

    if (!runtimeReady) {
      render();
      return;
    }

    const assembled = await deps.assembleSource(false, "Watch mode assembled.");
    if (assembled) {
      watchInstructionCount = Math.max(1, deps.getInstructionCount());
      watchLastState = getLessonState([]);
      currentState = watchLastState;
      render();
      deps.showToast("Watch mode loaded the worked solution");
    }
  }

  async function exitWatchMode(loadStarter = true): Promise<void> {
    const starter = watchStarterCode;
    resetWatchState();
    if (!loadStarter) {
      render();
      return;
    }
    deps.loadSource(starter, {
      statusMessage: "",
      focus: false,
    });
    if (runtimeReady) {
      await deps.assembleSource(false, "Starter code restored.");
    }
    deps.showToast("Watch mode off · your starter code is ready");
    render();
  }

  function currentStep(): LessonStep {
    return lesson.steps[Math.min(lessonProgress.currentStepIndex, lesson.steps.length - 1)];
  }

  stepPhase = resolvePhaseForStep(currentStep(), searchParams.get("phase"));

  function persistProgress(): void {
    progress = {
      ...progress,
      lessons: {
        ...progress.lessons,
        [lesson.id]: lessonProgress,
      },
      totalCompleted: Object.values({
        ...progress.lessons,
        [lesson.id]: lessonProgress,
      }).filter((entry) => entry.completed).length,
      lastActiveLesson: lesson.id,
    };
    saveProgress(progress);
  }

  function updateNavIndicator(): void {
    const stepNumber = Math.min(lessonProgress.currentStepIndex + 1, lesson.steps.length);
    navIndicator.textContent = `← ${lesson.title} · Step ${stepNumber} of ${lesson.steps.length}`;
  }

  function markStepCompleted(stepId: string): void {
    const alreadyCompleted = lessonProgress.stepsCompleted.includes(stepId);
    lessonProgress = {
      ...lessonProgress,
      stepsCompleted: uniqueStepIds([...lessonProgress.stepsCompleted, stepId]),
    };
    persistProgress();

    if (!alreadyCompleted) {
      const completedStep = lesson.steps.find((step) => step.id === stepId);
      if (completedStep && !completedStep.isCheckpoint) {
        awardLessonStepPoints(completedStep);
      }
    }
  }

  function buildGoalFeedback(goal: LessonGoal, state: ReturnType<typeof getLessonState>): string {
    if (goal.targetRegister !== undefined && goal.expectedValue !== undefined) {
      return `x${goal.targetRegister} is currently ${hex32(state.registers[goal.targetRegister] ?? 0)} · expected ${hex32(
        goal.expectedValue
      )}`;
    }

    if (goal.targetMemoryAddress !== undefined && goal.expectedValue !== undefined) {
      const actual = state.memory.get(goal.targetMemoryAddress) ?? 0;
      return `mem[${hex32(goal.targetMemoryAddress)}] is ${hex32(actual)} · expected ${hex32(goal.expectedValue)}`;
    }

    return "Goal not yet met · keep stepping";
  }

  function awardLessonStepPoints(step: LessonStep): void {
    const basePoints = step.isCheckpoint ? 15 : 5;
    addPoints(basePoints, `lesson:${lesson.id}:${step.id}`);
    checkAndAwardBadges(loadProgress(), loadChallengeSubmissions());
    const session = deps.getCurrentSession();
    if (session?.idToken) {
      void syncScoreToApi(loadScore(), session.idToken);
    }
  }

  function applyCompactLayout(): void {
    simulatorLayoutEl.classList.add("has-lesson-column");
    editorPanelEl.hidden = false;
    compactShell.hidden = !(isLessonSimulatorMode() && !completionVisible);
  }

  function extractMentionedRegisters(text: string): string[] {
    const matches = text.match(REGISTER_TOKEN_PATTERN) ?? [];
    const seen = new Set<string>();
    return matches
      .map((entry) => normalizeRegisterToken(entry))
      .filter((entry) => {
        if (seen.has(entry)) {
          return false;
        }
        seen.add(entry);
        return true;
      })
      .slice(0, 8);
  }

  function extractMentionedInstructions(text: string): string[] {
    const lower = text.toLowerCase();
    const hits: string[] = [];
    for (const mnemonic of KNOWN_MNEMONICS) {
      if (new RegExp(`\\b${mnemonic}\\b`, "i").test(lower)) {
        hits.push(mnemonic);
      }
    }
    return hits.slice(0, 4);
  }

  function registerLabel(token: string): string {
    if (token.startsWith("x")) {
      const index = Number(token.slice(1));
      return `${token} · ${getRegisterAbiName(index)}`;
    }
    return token === "fp" ? "s0/fp" : token;
  }

  function instructionQuickRef(mnemonic: string): { syntax: string; rows: Array<{ label: string; value: string }> } {
    const refs: Record<string, { syntax: string; rows: Array<{ label: string; value: string }> }> = {
      addi: {
        syntax: "addi rd, rs1, imm",
        rows: [
          { label: "rd", value: "destination register" },
          { label: "rs1", value: "source register" },
          { label: "imm", value: "12-bit signed immediate" },
        ],
      },
      add: {
        syntax: "add rd, rs1, rs2",
        rows: [
          { label: "rd", value: "destination register" },
          { label: "rs1", value: "left operand" },
          { label: "rs2", value: "right operand" },
        ],
      },
      lw: {
        syntax: "lw rd, imm(rs1)",
        rows: [
          { label: "rd", value: "loaded word" },
          { label: "rs1", value: "base address" },
          { label: "imm", value: "byte offset" },
        ],
      },
      sw: {
        syntax: "sw rs2, imm(rs1)",
        rows: [
          { label: "rs2", value: "value to store" },
          { label: "rs1", value: "base address" },
          { label: "imm", value: "byte offset" },
        ],
      },
      beq: {
        syntax: "beq rs1, rs2, label",
        rows: [
          { label: "rs1", value: "left side" },
          { label: "rs2", value: "right side" },
          { label: "label", value: "branch target" },
        ],
      },
      jal: {
        syntax: "jal rd, label",
        rows: [
          { label: "rd", value: "return address register" },
          { label: "label", value: "jump target" },
        ],
      },
    };
    return refs[mnemonic] ?? {
      syntax: `${mnemonic} ...`,
      rows: [{ label: "note", value: "See the disassembly for exact operands" }],
    };
  }

  function renderQuickReference(step: LessonStep, lessonNumber: number): string {
    const stepText = `${step.title}\n${step.content}\n${step.code ?? ""}`;
    if (isCheckpointStep(step)) {
      return `
        <div class="lro__context-inner">
          <div class="lro__context-section">
            <div class="lro__context-label">Goal Status</div>
            ${renderGoalsMarkup(step, lessonNumber, { compact: true, includeActions: false })}
          </div>
        </div>
      `;
    }

    if (/calling convention|callee saved|caller saved|stack frame|return address/i.test(stepText)) {
      return `
        <div class="lro__context-inner">
          <div class="lro__context-section">
            <div class="lro__context-label">Calling Convention</div>
            <div class="lro-quick-ref">
              <div class="lro-quick-ref__row"><span class="lro-quick-ref__label">ra</span><span class="lro-quick-ref__value">return address</span></div>
              <div class="lro-quick-ref__row"><span class="lro-quick-ref__label">a0-a7</span><span class="lro-quick-ref__value">arguments / return</span></div>
              <div class="lro-quick-ref__row"><span class="lro-quick-ref__label">s0-s11</span><span class="lro-quick-ref__value">callee-saved</span></div>
              <div class="lro-quick-ref__row"><span class="lro-quick-ref__label">t0-t6</span><span class="lro-quick-ref__value">caller-saved temps</span></div>
            </div>
          </div>
        </div>
      `;
    }

    const instructions = extractMentionedInstructions(stepText);
    if (instructions.length > 0) {
      return `
        <div class="lro__context-inner">
          ${instructions
            .map((mnemonic) => {
              const ref = instructionQuickRef(mnemonic);
              return `<div class="lro__context-section">
                <div class="lro__context-label">${escapeHtml(mnemonic.toUpperCase())}</div>
                <div class="lro-quick-ref">
                  <div class="lro-quick-ref__row"><span class="lro-quick-ref__label">syntax</span><span class="lro-quick-ref__value">${escapeHtml(ref.syntax)}</span></div>
                  ${ref.rows
                    .map(
                      (row) =>
                        `<div class="lro-quick-ref__row"><span class="lro-quick-ref__label">${escapeHtml(row.label)}</span><span class="lro-quick-ref__value">${escapeHtml(row.value)}</span></div>`
                    )
                    .join("")}
                </div>
              </div>`;
            })
            .join("")}
        </div>
      `;
    }

    const registers = extractMentionedRegisters(stepText);
    if (registers.length > 0) {
      return `
        <div class="lro__context-inner">
          <div class="lro__context-section">
            <div class="lro__context-label">Registers Mentioned</div>
            <div class="lro-quick-ref">
              ${registers
                .map((token) => {
                  const description = REGISTER_DESCRIPTIONS[token] ?? "register";
                  return `<div class="lro-quick-ref__row"><span class="lro-quick-ref__label">${escapeHtml(
                    registerLabel(token)
                  )}</span><span class="lro-quick-ref__value">${escapeHtml(description)}</span></div>`;
                })
                .join("")}
            </div>
          </div>
        </div>
      `;
    }

    return `
      <div class="lro__context-inner">
        <div class="lro__context-section">
          <div class="lro__context-label">Curriculum Progress</div>
          <div class="lro-quick-ref">
            ${allLessons
              .slice(0, 6)
              .map(
                (entry, index) =>
                  `<div class="lro-quick-ref__row"><span class="lro-quick-ref__label">Lesson ${index + 1}</span><span class="lro-quick-ref__value">${
                    progress.lessons[entry.id]?.completed ? "complete" : entry.id === lesson.id ? "current" : "locked"
                  }</span></div>`
              )
              .join("")}
          </div>
        </div>
      </div>
    `;
  }

  function loadGoalEvaluation(options: { recordAttempt?: boolean; allowRewards?: boolean } = {}): void {
    const step = currentStep();
    currentState = getLessonState(deps.getExecutionDeltas());
    const recordAttempt = options.recordAttempt === true;
    const allowRewards = options.allowRewards !== false;
    if (!step.goals || step.goals.length === 0) {
      goalEvaluation = { passed: false, results: {} };
      goalFeedback = {};
      render();
      return;
    }

    const previousResults = { ...goalEvaluation.results };
    const result = checkGoals(step.goals, currentState);
    const nextResults = Object.fromEntries(result.results.map((entry) => [entry.goalId, entry.passed]));
    const newlyPassed = result.results
      .filter((entry) => entry.passed && !previousResults[entry.goalId])
      .map((entry) => entry.goalId);

    if (recordAttempt && !result.passed) {
      stepAttemptCounts.set(step.id, (stepAttemptCounts.get(step.id) ?? 0) + 1);
      lessonProgress = {
        ...lessonProgress,
        attempts: lessonProgress.attempts + 1,
      };
      persistProgress();
    }

    goalEvaluation = {
      passed: result.passed,
      results: nextResults,
    };
    goalFeedback = Object.fromEntries(
      step.goals.map((goal) => [goal.id, nextResults[goal.id] ? "" : buildGoalFeedback(goal, currentState)])
    );

    if (newlyPassed.length > 0) {
      window.setTimeout(() => {
        render();
      }, 320);
    }

    if (allowRewards && result.passed && !lessonProgress.stepsCompleted.includes(step.id)) {
      awardLessonStepPoints(step);
    }

    render();
  }

  async function loadStepCode(step: LessonStep, options: { toast?: boolean } = {}): Promise<void> {
    if (step.code === undefined) {
      return;
    }

    deps.loadSource(step.code, {
      statusMessage: "",
      focus: false,
    });

    if (!runtimeReady) {
      render();
      return;
    }

    const assembled = await deps.assembleSource(false, "Lesson step assembled.");
    if (assembled) {
      if (options.toast !== false) {
        deps.showToast("Code loaded for this step");
      }
      loadGoalEvaluation({ recordAttempt: false, allowRewards: !currentWatchStepActive() });
    }
  }

  async function navigateToStep(nextIndex: number, options: { markCurrentComplete?: boolean } = {}): Promise<void> {
    const clampedIndex = Math.max(0, Math.min(nextIndex, lesson.steps.length - 1));
    const previousStep = currentStep();
    const movingForward = clampedIndex >= lessonProgress.currentStepIndex;

    if (!lessonPrefersReducedMotion() && !panel.hidden && panel.querySelector(".lro__step-content")) {
      const content = panel.querySelector<HTMLElement>(".lro__step-content");
      content?.classList.add(movingForward ? "is-leaving-left" : "is-leaving-right");
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 180);
      });
    }

    if (options.markCurrentComplete) {
      markStepCompleted(previousStep.id);
    }

    lessonProgress = {
      ...lessonProgress,
      currentStepIndex: clampedIndex,
    };
    progress.lastActiveLesson = lesson.id;
    persistProgress();
    hintVisibility = new Set<string>();
    goalEvaluation = { passed: false, results: {} };
    completionVisible = false;
    stepPhase = resolvePhaseForStep(currentStep(), "reading");
    pendingEnterDirection = movingForward ? "right" : "left";
    resetWatchState();
    applyCompactLayout();
    updateUrl(true);
    updateNavIndicator();
    render();
    if (stepPhase !== "reading") {
      await loadStepCode(currentStep());
    }
  }

  async function enterPhase(nextPhase: StepPhase, pushHistory = true): Promise<void> {
    const step = currentStep();
    const resolvedPhase = resolvePhaseForStep(step, nextPhase);
    if (resolvedPhase === stepPhase && resolvedPhase !== "trying") {
      return;
    }

    stopWatchPlayback();
    if (resolvedPhase !== "watching" && currentWatchStepActive()) {
      await exitWatchMode(true);
    }

    stepPhase = resolvedPhase;
    applyPhaseClasses();
    syncEditorReadOnly();
    updateUrl(pushHistory);
    render();

    if (resolvedPhase === "reading") {
      return;
    }

    if (resolvedPhase === "watching") {
      await enterWatchMode();
      render();
      return;
    }

    if (currentWatchStepActive()) {
      await exitWatchMode(true);
    }
    await loadStepCode(step, { toast: false });
    render();
  }

  async function finishLesson(): Promise<void> {
    const wasCompleted = lessonProgress.completed;
    markStepCompleted(currentStep().id);
    lessonProgress = {
      ...lessonProgress,
      completed: true,
      completedAt: new Date().toISOString(),
      currentStepIndex: lesson.steps.length - 1,
    };
    persistProgress();
    completionVisible = true;
    if (!wasCompleted) {
      addPoints(LESSON_COMPLETION_XP, `lesson-complete:${lesson.id}`);
      recordRecentActivity({
        type: "lesson",
        title: lesson.title,
        completedAt: lessonProgress.completedAt ?? new Date().toISOString(),
      });
      checkAndAwardBadges(loadProgress(), loadChallengeSubmissions());
      const session = deps.getCurrentSession();
      if (session?.idToken) {
        void syncScoreToApi(loadScore(), session.idToken);
      }
    }
    render();
    showNotification({
      id: `lesson-${lesson.id}-${lessonProgress.completedAt ?? Date.now()}`,
      type: "lesson",
      title: "Lesson Complete!",
      message: `${lesson.title} · +${LESSON_COMPLETION_XP} XP`,
      icon: "🎓",
      duration: 4000,
      accentColor: "var(--success)",
    });

    const session = deps.getCurrentSession();
    if (session?.idToken) {
      void syncProgressToApi(progress, session.idToken);
    }
  }

  function renderMiniRegister(goal: LessonGoal): string {
    if (goal.targetRegister === undefined) {
      return "";
    }
    const value = currentState.registers[goal.targetRegister] ?? 0;
    const isTargetMet = goal.expectedValue !== undefined && value === goal.expectedValue;
    return `<div class="lesson-mini-reg">
      <span class="lesson-mini-reg__name">x${goal.targetRegister}</span>
      <span class="lesson-mini-reg__abi">${escapeHtml(getRegisterAbiName(goal.targetRegister))}</span>
      <span class="lesson-mini-reg__value${isTargetMet ? " is-target-met" : ""}">${hex32(value)}</span>
    </div>`;
  }

  function renderGoalsMarkup(
    step: LessonStep,
    lessonNumber: number,
    options: { compact?: boolean; includeActions?: boolean } = {}
  ): string {
    if (!step.goals || step.goals.length === 0) {
      return "";
    }

    const attempts = stepAttemptCounts.get(step.id) ?? 0;
    const showHints = attempts >= 3;
    const showSolution = attempts >= 5;
    const showMiniRegisters = lessonNumber <= 5;
    const primaryHint = step.goals.find((goal) => goal.hint)?.hint;
    const compact = options.compact === true;
    const includeActions = options.includeActions !== false;

    return `
        <div class="${compact ? "lro__goals-list" : "lesson-goals-list"}">
          ${step.goals
            .map((goal) => {
              const passed = goalEvaluation.results[goal.id] === true;
              const failing = !passed && (stepAttemptCounts.get(step.id) ?? 0) > 0;
              const hintVisible = hintVisibility.has(goal.id);
              return `
                <div class="${compact ? "lro__goal-item" : "lesson-goal-item"}${passed ? " is-passing" : ""}${failing ? " is-failing" : ""}">
                  <div class="${compact ? "lro__goal-circle" : "lesson-goal-item__circle"}">${passed ? "✓" : ""}</div>
                  <div class="${compact ? "lro__goal-body" : "lesson-goal-item__body"}">
                    <div class="${compact ? "lro__goal-desc" : "lesson-goal-item__desc"}">${escapeHtml(goal.description)}</div>
                    ${showMiniRegisters ? renderMiniRegister(goal) : ""}
                    ${
                      !passed && goalFeedback[goal.id]
                        ? `<div class="${compact ? "lro__goal-feedback" : "lesson-goal-item__feedback"}">${escapeHtml(goalFeedback[goal.id])}</div>`
                        : ""
                    }
                    ${
                      includeActions && showHints && goal.hint && !hintVisible
                        ? `<button class="lesson-goal__hint-toggle" type="button" data-lesson-hint="${escapeHtml(goal.id)}">Show hint</button>`
                        : ""
                    }
                    ${hintVisible && goal.hint ? `<div class="lesson-goal__hint">${escapeHtml(goal.hint)}</div>` : ""}
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
        ${
          includeActions && showHints && primaryHint
            ? `<div class="lesson-hint">
                <div class="lesson-hint__label">Hint</div>
                <div class="lesson-hint__text">${escapeHtml(primaryHint)}</div>
              </div>`
            : ""
        }
        ${includeActions && showSolution ? '<button class="lesson-show-solution" type="button" data-lesson-action="show-solution">Show solution</button>' : ""}
        ${
          goalEvaluation.passed
            ? `<div class="lro-success-banner">
                <div class="lro-success-banner__title">All goals passing</div>
                <div class="lro-success-banner__subtitle">The simulator state matches the goal checklist.</div>
                ${
                  includeActions
                    ? '<button class="lesson-success-banner__button" type="button" data-lesson-action="continue">Continue →</button>'
                    : ""
                }
              </div>`
            : ""
        }
    `;
  }

  function renderStepList(): string {
    return lesson.steps
      .map((entry, index) => {
        const isCompleted = lessonProgress.stepsCompleted.includes(entry.id);
        const isCurrent = index === lessonProgress.currentStepIndex;
        const isClickable = isCompleted || isCurrent;
        return `<button
          class="lro__step-item${isCompleted ? " is-completed" : ""}${isCurrent ? " is-current" : ""}${
            entry.isCheckpoint ? " is-checkpoint" : ""
          }"
          type="button"
          data-lesson-step-index="${index}"
          ${isClickable ? "" : "disabled"}
          aria-label="Step ${index + 1}: ${escapeHtml(entry.title)}"
        >
          <div class="lro__step-item-dot"></div>
          <div class="lro__step-item-info">
            <span class="lro__step-item-title">${escapeHtml(entry.title)}</span>
            <span class="lro__step-item-type">${entry.isCheckpoint ? "Checkpoint" : "Reading"}</span>
          </div>
        </button>`;
      })
      .join("");
  }

  function renderFooterDots(): string {
    return lesson.steps
      .map((entry, index) => {
        const isCompleted = lessonProgress.stepsCompleted.includes(entry.id);
        const isCurrent = index === lessonProgress.currentStepIndex;
        const isClickable = isCompleted || isCurrent;
        return `<button
          class="lro__dot${isCompleted ? " is-completed" : ""}${isCurrent ? " is-current" : ""}${entry.isCheckpoint ? " is-checkpoint" : ""}"
          type="button"
          data-lesson-step-dot="${index}"
          ${isClickable ? "" : "disabled"}
          aria-label="Jump to step ${index + 1}"
        ></button>`;
      })
      .join("");
  }

  function renderShortcutsPopover(): string {
    return `
      <div class="lro-shortcuts${shortcutsOpen ? " is-open" : ""}">
        <button class="lro-shortcuts__trigger" type="button" data-lesson-action="toggle-shortcuts">?</button>
        <div class="lro-shortcuts__popover" ${shortcutsOpen ? "" : "hidden"}>
          <span>→ / Space · next</span>
          <span>← · previous</span>
          <span>T · try it</span>
          <span>B · back to lesson</span>
          <span>Esc · curriculum</span>
          <span>1-9 · jump step</span>
        </div>
      </div>
    `;
  }

  function renderWatchSummary(): string {
    if (stepPhase !== "watching") {
      return "";
    }
    const progress =
      watchInstructionCount > 0 ? Math.min(100, (currentState.stepCount / watchInstructionCount) * 100) : 0;
    const currentInstruction = escapeHtml(deps.getInstructionText(watchLastState.pc) || "Waiting for the first instruction…");
    return `
      <div class="lro-watch-banner">
        <div class="lro-watch-banner__header">
          <span class="lro-watch-banner__label">Watch mode</span>
          <div class="lesson-watch__controls">
            <button class="lesson-watch__button" type="button" data-lesson-action="watch-play" ${watchPlaying || watchCompleted ? "disabled" : ""}>▶ Play</button>
            <button class="lesson-watch__button" type="button" data-lesson-action="watch-pause" ${!watchPlaying ? "disabled" : ""}>⏸ Pause</button>
            <button class="lesson-watch__button" type="button" data-lesson-action="watch-reset">⏮ Reset</button>
            <button class="lesson-watch__button" type="button" data-lesson-action="watch-speed">⏩ ${watchSpeed}x</button>
          </div>
        </div>
        <div class="lesson-watch__progress"><span style="width:${progress}%;"></span></div>
        <div class="lesson-watch__instruction">${currentInstruction}</div>
        <div class="lesson-watch__narration">${escapeHtml(
          watchNarration || "Watch the worked solution execute, then switch back to the starter."
        )}</div>
      </div>
    `;
  }

  function renderOverlay(step: LessonStep, lessonNumber: number): string {
    const progressPercent = lesson.steps.length === 0 ? 0 : (lessonProgress.stepsCompleted.length / lesson.steps.length) * 100;
    const canGoPrevious = lessonProgress.currentStepIndex > 0;
    const isCheckpoint = isCheckpointStep(step);
    const hasWatch = canWatch(step);
    const isLastStep = lessonProgress.currentStepIndex >= lesson.steps.length - 1;
    const split = isWideLessonSplit();
    const primaryAction =
      stepPhase === "watching"
        ? `<button class="lro__btn-try" id="lro-btn-try" type="button" data-lesson-action="watch-try">Now you try</button>`
        : isCheckpoint
          ? stepPhase === "reading"
            ? `<button class="lro__btn-try" id="lro-btn-try" type="button" data-lesson-action="start-trying">Try it</button>`
            : `<button class="lro__btn-continue${goalEvaluation.passed ? "" : " is-disabled"}" id="lro-btn-continue" type="button" data-lesson-action="continue" ${
                goalEvaluation.passed ? "" : "disabled"
              }>Continue</button>`
          : isLastStep
            ? `<button class="lro__btn-continue" id="lro-btn-continue" type="button" data-lesson-action="finish">Finish</button>`
            : `<button class="lro__btn-continue" id="lro-btn-continue" type="button" data-lesson-action="next-reading">Continue</button>`;

    return `
      <aside class="lro__sidebar">
        <div class="lro__sidebar-inner">
          <a href="/learn/" class="lro__back">← Curriculum</a>
          <div class="lro__lesson-meta">
            <span class="lro__lesson-num">Lesson ${lessonNumber} of ${allLessons.length}</span>
            <span class="lro__lesson-title-small">${escapeHtml(lesson.title)}</span>
          </div>
          <nav class="lro__step-list" aria-label="Lesson steps">${renderStepList()}</nav>
          <div class="lro__lesson-progress">
            <div class="lro__lesson-progress-bar"><div class="lro__lesson-progress-fill" style="width:${progressPercent}%;"></div></div>
            <span class="lro__lesson-progress-label">${lessonProgress.stepsCompleted.length} of ${lesson.steps.length} steps complete</span>
          </div>
        </div>
      </aside>
      <main class="lro__main">
        <div class="lro__content-wrapper${split ? " is-split" : ""}">
          <header class="lro__step-header">
            <div class="lro__step-indicator">
              <span class="lro__step-num">Step ${lessonProgress.currentStepIndex + 1}</span>
              <span class="lro__step-type-badge ${isCheckpoint ? "checkpoint" : "reading"}">${isCheckpoint ? "Checkpoint" : "Reading"}</span>
            </div>
            <h1 class="lro__step-title">${escapeHtml(step.title)}</h1>
          </header>
          ${renderWatchSummary()}
          <div class="lro__step-content" id="lro-step-content">${renderStepContent(step.content)}</div>
          ${
            isCheckpoint
              ? `<div class="lro__goals" id="lro-goals">
                  <div class="lro__goals-header">Checkpoint</div>
                  ${renderGoalsMarkup(step, lessonNumber, { compact: true, includeActions: true })}
                </div>`
              : ""
          }
        </div>
      </main>
      <aside class="lro__context" id="lro-context">${renderQuickReference(step, lessonNumber)}</aside>
      <footer class="lro__footer">
        <div class="lro__footer-inner">
          <div class="lro__footer-left">
            <button class="lro__btn-prev" id="lro-btn-prev" type="button" data-lesson-action="prev"${canGoPrevious ? "" : " disabled"}>← Previous</button>
          </div>
          <div class="lro__footer-center">
            <div class="lro__dots" role="tablist">${renderFooterDots()}</div>
            ${renderShortcutsPopover()}
          </div>
          <div class="lro__footer-right">
            ${isCheckpoint && hasWatch && stepPhase === "reading" ? '<button class="lesson-btn-watch-link" type="button" data-lesson-action="start-watch">Watch solution first</button>' : ""}
            ${primaryAction}
          </div>
        </div>
      </footer>
    `;
  }

  function renderInlineShell(step: LessonStep, lessonNumber: number): string {
    const totalGoals = step.goals?.length ?? 0;
    const passingGoals = step.goals?.filter((goal) => goalEvaluation.results[goal.id]).length ?? 0;
    return `
      <div class="lesson-inline-shell__card${compactCollapsed ? " is-collapsed" : ""}">
        <div class="lesson-inline-shell__header">
          <button class="lesson-inline-shell__back" type="button" data-lesson-action="back-to-reading">← ${escapeHtml(step.title)}</button>
          <button class="lesson-inline-shell__toggle" type="button" data-lesson-action="toggle-inline">${compactCollapsed ? "▾" : "▴"}</button>
        </div>
        <div class="lesson-inline-shell__summary">${passingGoals}/${totalGoals} goals passing · Lesson ${lessonNumber}</div>
        <div class="lesson-inline-shell__body"${compactCollapsed ? ' hidden' : ""}>
          ${renderWatchSummary()}
          ${isCheckpointStep(step) ? renderGoalsMarkup(step, lessonNumber, { compact: true, includeActions: true }) : ""}
        </div>
      </div>
    `;
  }

  function renderCompletion(): string {
    const lessonIndex = allLessons.findIndex((entry) => entry.id === lesson.id);
    const nextLesson = allLessons[lessonIndex + 1];
    const confetti = Array.from({ length: 16 }, (_, index) => {
      const delay = `${(index % 8) * 90}ms`;
      const left = `${10 + ((index * 11) % 80)}%`;
      const duration = `${1.5 + (index % 4) * 0.25}s`;
      const variant = ["is-accent", "is-success", "is-warning", "is-violet"][index % 4];
      return `<span class="lro-confetti-piece ${variant}" style="left:${left}; --delay:${delay}; --duration:${duration};"></span>`;
    }).join("");

    return `
      <div class="lro-completion" id="lro-completion">
        <div class="lro-completion__confetti" aria-hidden="true">${confetti}</div>
        <div class="lro-completion__card">
          <div class="lro-completion__icon">🎓</div>
          <h2 class="lro-completion__title">Lesson ${lessonIndex + 1} Complete</h2>
          <p class="lro-completion__subtitle">${escapeHtml(lesson.title)}</p>
          <div class="lro-completion__stats">
            <div class="lro-completion__stat">
              <span class="lro-completion__stat-value">${lesson.steps.length}</span>
              <span class="lro-completion__stat-label">Steps</span>
            </div>
            <div class="lro-completion__stat">
              <span class="lro-completion__stat-value">+${LESSON_COMPLETION_XP}</span>
              <span class="lro-completion__stat-label">XP earned</span>
            </div>
            <div class="lro-completion__stat">
              <span class="lro-completion__stat-value">${progress.totalCompleted}/20</span>
              <span class="lro-completion__stat-label">Lessons done</span>
            </div>
          </div>
          ${
            nextLesson
              ? `<div class="lro-completion__next" id="lro-completion-next">
                  <span class="lro-completion__next-label">Up next</span>
                  <span class="lro-completion__next-title">${escapeHtml(nextLesson.title)}</span>
                </div>`
              : ""
          }
          <div id="lessonShareMount"></div>
          <div class="lro-completion__actions">
            <a href="/learn/" class="lro-completion__btn-secondary">Back to curriculum</a>
            ${
              nextLesson
                ? `<button class="lro-completion__btn-primary" id="lro-btn-next-lesson" type="button" data-lesson-action="next-lesson">Start Lesson ${
                    lessonIndex + 2
                  } →</button>`
                : `<button class="lro-completion__btn-primary" id="lro-btn-next-lesson" type="button" data-lesson-action="back-curriculum">Back to curriculum</button>`
            }
          </div>
        </div>
      </div>
    `;
  }

  function bindLessonActions(container: ParentNode): void {
    container.querySelectorAll<HTMLElement>("[data-lesson-hint]").forEach((button) => {
      button.addEventListener("click", () => {
        const goalId = button.dataset.lessonHint;
        if (!goalId) {
          return;
        }
        hintVisibility.add(goalId);
        render();
      });
    });

    container.querySelectorAll<HTMLElement>("[data-lesson-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.lessonAction;
        if (action === "prev" && lessonProgress.currentStepIndex > 0) {
          void navigateToStep(lessonProgress.currentStepIndex - 1);
        }
        if (action === "next-reading" && lessonProgress.currentStepIndex < lesson.steps.length - 1) {
          void navigateToStep(lessonProgress.currentStepIndex + 1, { markCurrentComplete: true });
        }
        if (action === "start-trying") {
          void enterPhase("trying");
        }
        if (action === "start-watch") {
          void enterPhase("watching");
        }
        if (action === "back-to-reading") {
          void enterPhase("reading");
        }
        if (action === "skip-watch" || action === "watch-try") {
          void enterPhase("trying");
        }
        if (action === "continue" && goalEvaluation.passed) {
          if (lessonProgress.currentStepIndex >= lesson.steps.length - 1) {
            void finishLesson();
          } else {
            void navigateToStep(lessonProgress.currentStepIndex + 1, { markCurrentComplete: true });
          }
        }
        if (action === "finish") {
          void finishLesson();
        }
        if (action === "show-solution") {
          const step = currentStep();
          const replacement = step.solution ?? step.code;
          if (replacement) {
            deps.loadSource(replacement, {
              statusMessage: "Solution loaded for this step.",
              focus: false,
            });
            void deps.assembleSource(false, "Solution assembled.");
          }
        }
        if (action === "watch-play" && currentWatchStepActive() && !watchCompleted) {
          watchPlaying = true;
          queueWatchStep();
          render();
        }
        if (action === "watch-pause" && currentWatchStepActive()) {
          stopWatchPlayback();
          render();
        }
        if (action === "watch-reset" && currentWatchStepActive()) {
          stopWatchPlayback();
          void enterWatchMode();
        }
        if (action === "watch-speed" && currentWatchStepActive()) {
          watchSpeed = watchSpeed === 1 ? 2 : watchSpeed === 2 ? 0.5 : 1;
          if (watchPlaying) {
            queueWatchStep();
          }
          render();
        }
        if (action === "toggle-shortcuts") {
          shortcutsOpen = !shortcutsOpen;
          render();
        }
        if (action === "toggle-inline") {
          compactCollapsed = !compactCollapsed;
          render();
        }
        if (action === "next-lesson") {
          const lessonIndex = allLessons.findIndex((entry) => entry.id === lesson.id);
          const nextLesson = allLessons[lessonIndex + 1];
          if (nextLesson) {
            window.location.href = `/simulator/?lesson=${encodeURIComponent(nextLesson.id)}`;
          }
        }
        if (action === "back-curriculum") {
          window.location.href = "/learn/";
        }
      });
    });

    container.querySelectorAll<HTMLButtonElement>("[data-lesson-step-dot], [data-lesson-step-index]").forEach((button) => {
      button.addEventListener("click", () => {
        const rawIndex = Number(button.dataset.lessonStepDot ?? button.dataset.lessonStepIndex);
        if (!Number.isInteger(rawIndex)) {
          return;
        }
        const targetStep = lesson.steps[rawIndex];
        if (!targetStep) {
          return;
        }
        const isCompleted = lessonProgress.stepsCompleted.includes(targetStep.id);
        if (!isCompleted && rawIndex !== lessonProgress.currentStepIndex) {
          return;
        }
        void navigateToStep(rawIndex);
      });
    });
  }

  function animateEntryIfNeeded(): void {
    if (!pendingEnterDirection || lessonPrefersReducedMotion() || panel.hidden) {
      pendingEnterDirection = null;
      return;
    }
    const content = panel.querySelector<HTMLElement>(".lro__step-content");
    if (!content) {
      pendingEnterDirection = null;
      return;
    }
    const className = pendingEnterDirection === "right" ? "is-entering-right" : "is-entering-left";
    content.classList.add(className);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        content.classList.remove(className);
        pendingEnterDirection = null;
      });
    });
  }

  function render(): void {
    updateNavIndicator();
    applyCompactLayout();
    applyPhaseClasses();
    syncEditorReadOnly();

    const step = currentStep();
    const lessonNumber = allLessons.findIndex((entry) => entry.id === lesson.id) + 1;
    const showOverlay = completionVisible || stepPhase === "reading" || isWideLessonSplit();

    panel.hidden = !showOverlay;
    compactShell.hidden = !(isLessonSimulatorMode() && !completionVisible);

    if (showOverlay) {
      panel.innerHTML = `${renderOverlay(step, lessonNumber)}${completionVisible ? renderCompletion() : ""}`;
      bindLessonActions(panel);
      animateEntryIfNeeded();
    } else {
      panel.innerHTML = "";
    }

    if (!compactShell.hidden) {
      compactShell.innerHTML = renderInlineShell(step, lessonNumber);
      bindLessonActions(compactShell);
    } else {
      compactShell.innerHTML = "";
    }

    if (completionVisible) {
      const shareMount = panel.querySelector<HTMLElement>("#lessonShareMount");
      const session = deps.getCurrentSession();
      if (shareMount) {
        shareMount.appendChild(
          createShareSection({
            card: {
              variant: "lesson",
              title: `Lesson ${allLessons.findIndex((entry) => entry.id === lesson.id) + 1} Complete`,
              subtitle: lesson.title,
              stats: [
                { label: "Steps", value: `${lesson.steps.length}` },
                { label: "Instructions", value: `${currentState.stepCount}` },
              ],
              badge: "🎓",
              streakDays: loadScore().streak,
              accentColor: "var(--success)",
            },
            filename: `${lesson.id}.png`,
            link: session ? buildReferralLink(session.userId, "/learn/") : "https://studyriscv.com/learn/",
          })
        );
      }
    }
  }

  lessonProgress = createLessonProgress(lesson, progress.lessons[lesson.id]);
  if (requestedStepId) {
    const requestedStepIndex = lesson.steps.findIndex((step) => step.id === requestedStepId);
    if (requestedStepIndex >= 0) {
      lessonProgress.currentStepIndex = requestedStepIndex;
    }
  }
  progress = {
    ...progress,
    lessons: {
      ...progress.lessons,
      [lesson.id]: lessonProgress,
    },
    totalCompleted: Object.values({
      ...progress.lessons,
      [lesson.id]: lessonProgress,
    }).filter((entry) => entry.completed).length,
    lastActiveLesson: lesson.id,
  };
  saveProgress(progress);
  applyPhaseClasses();
  updateUrl(false);
  render();

  const handleResize = (): void => {
    applyPhaseClasses();
    render();
  };
  window.addEventListener("resize", handleResize);

  const handleReadingKeydown = (event: KeyboardEvent): void => {
    const active = document.activeElement;
    const isTyping =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable);
    const modalOpen =
      !panel.hidden && panel.querySelector(".lro-completion") !== null;

    if (isTyping || modalOpen) {
      return;
    }

    if (event.key === "Escape") {
      window.location.href = "/learn/";
      return;
    }

    if (event.key === "?") {
      event.preventDefault();
      shortcutsOpen = !shortcutsOpen;
      render();
      return;
    }

    if (event.key.toLowerCase() === "b" && stepPhase !== "reading") {
      event.preventDefault();
      void enterPhase("reading");
      return;
    }

    if (event.key.toLowerCase() === "t" && isCheckpointStep(currentStep()) && stepPhase === "reading") {
      event.preventDefault();
      void enterPhase("trying");
      return;
    }

    if (/^[1-9]$/.test(event.key)) {
      const targetIndex = Number(event.key) - 1;
      const target = lesson.steps[targetIndex];
      if (target) {
        const isCompleted = lessonProgress.stepsCompleted.includes(target.id);
        if (isCompleted || targetIndex === lessonProgress.currentStepIndex) {
          event.preventDefault();
          void navigateToStep(targetIndex);
        }
      }
      return;
    }

    if (event.key === "ArrowLeft" && lessonProgress.currentStepIndex > 0) {
      event.preventDefault();
      void navigateToStep(lessonProgress.currentStepIndex - 1);
      return;
    }

    if ((event.key === "ArrowRight" || event.key === " ") && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      const step = currentStep();
      if (stepPhase === "reading") {
        if (isCheckpointStep(step)) {
          void enterPhase("trying");
        } else if (lessonProgress.currentStepIndex >= lesson.steps.length - 1) {
          void finishLesson();
        } else {
          void navigateToStep(lessonProgress.currentStepIndex + 1, { markCurrentComplete: true });
        }
        return;
      }

      if (goalEvaluation.passed) {
        if (lessonProgress.currentStepIndex >= lesson.steps.length - 1) {
          void finishLesson();
        } else {
          void navigateToStep(lessonProgress.currentStepIndex + 1, { markCurrentComplete: true });
        }
      }
    }
  };
  window.addEventListener("keydown", handleReadingKeydown);

  window.addEventListener("popstate", () => {
    const params = new URLSearchParams(window.location.search);
    const nextStepId = params.get("step");
    const nextStepIndex = nextStepId ? lesson.steps.findIndex((entry) => entry.id === nextStepId) : -1;
    if (nextStepIndex >= 0) {
      lessonProgress = {
        ...lessonProgress,
        currentStepIndex: nextStepIndex,
      };
    }
    hintVisibility = new Set<string>();
    completionVisible = lessonProgress.completed;
    stepPhase = resolvePhaseForStep(currentStep(), params.get("phase"));
    if (stepPhase === "reading") {
      resetWatchState();
    }
    render();
    if (runtimeReady && stepPhase !== "reading") {
      void loadStepCode(currentStep(), { toast: false });
    }
  });

  return {
    isActive() {
      return true;
    },
    prefillSource() {
      deps.loadSource(currentStep().code ?? "", {
        statusMessage: "",
        focus: false,
      });
    },
    async initialize() {
      runtimeReady = true;
      syncEditorReadOnly();
      render();
      if (stepPhase === "watching") {
        await enterPhase("watching", false);
      } else if (stepPhase === "trying") {
        await enterPhase("trying", false);
      }
    },
    handleAssembled() {
      completionVisible = lessonProgress.completed;
      watchInstructionCount = Math.max(1, deps.getInstructionCount());
      watchLastState = getLessonState(deps.getExecutionDeltas());
      loadGoalEvaluation({ recordAttempt: false, allowRewards: !currentWatchStepActive() });
    },
    handleStep(recordAttempt = true) {
      const before = watchLastState;
      loadGoalEvaluation({
        recordAttempt: currentWatchStepActive() ? false : recordAttempt,
        allowRewards: !currentWatchStepActive(),
      });
      if (currentWatchStepActive()) {
        const instruction = deps.getInstructionText(before.pc);
        watchNarration = `Step ${currentState.stepCount}: ${instruction.trim() || "instruction"}\n\n${generateNarration(
          instruction,
          before,
          currentState
        )}`;
        watchLastState = currentState;
        if (currentState.halted || currentState.trapFired || currentState.stepCount >= watchInstructionCount) {
          stopWatchPlayback();
          watchCompleted = true;
        } else if (watchPlaying) {
          queueWatchStep();
        }
        render();
      }
    },
    handleStepBack() {
      watchLastState = getLessonState(deps.getExecutionDeltas());
      loadGoalEvaluation({ recordAttempt: false, allowRewards: !currentWatchStepActive() });
    },
    handleRunEnd() {
      stopWatchPlayback();
      loadGoalEvaluation({ recordAttempt: false, allowRewards: !currentWatchStepActive() });
    },
    handleReset() {
      watchLastState = getLessonState([]);
      if (currentWatchStepActive()) {
        watchCompleted = false;
        watchNarration = "Reset the watched program. Press Play to start again.";
      }
      loadGoalEvaluation({ recordAttempt: false, allowRewards: !currentWatchStepActive() });
    },
    async handleSessionChange(session: UserSession | null) {
      if (!session?.idToken) {
        return;
      }

      const apiProgress = await loadProgressFromApi(session.idToken);
      if (!apiProgress) {
        return;
      }

      const merged = mergeProgress(loadProgress(), apiProgress);
      saveProgress(merged);
      progress = merged;
      lessonProgress = createLessonProgress(lesson, merged.lessons[lesson.id]);
      if (requestedStepId) {
        const requestedStepIndex = lesson.steps.findIndex((step) => step.id === requestedStepId);
        if (requestedStepIndex >= 0) {
          lessonProgress.currentStepIndex = requestedStepIndex;
        }
      }
      completionVisible = lessonProgress.completed;
      stepPhase = resolvePhaseForStep(currentStep(), new URLSearchParams(window.location.search).get("phase"));
      syncEditorReadOnly();
      render();

      if (runtimeReady) {
        if (stepPhase !== "reading") {
          await loadStepCode(currentStep(), { toast: false });
          loadGoalEvaluation({ recordAttempt: false, allowRewards: !currentWatchStepActive() });
        }
      }
    },
  };
}

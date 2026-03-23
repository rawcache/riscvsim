import type { UserSession } from "./auth";
import { getBestSubmission, getChallengesForLesson, loadChallengeSubmissions } from "./challenges";
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
import { addPoints, checkAndAwardBadges, loadScore, syncScoreToApi } from "./scoring";
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

function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code class="lesson-rich-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function renderInstructionLine(line: string): string | null {
  const match = LESSON_INSTRUCTION_PATTERN.exec(line.trim());
  if (!match?.groups) {
    return null;
  }

  const { mnemonic, operands } = match.groups;
  if (!/[,(]|x\d+|\b(?:ra|sp|gp|tp|a[0-7]|s(?:[0-9]|1[01]|0\/fp)|t[0-6])\b/i.test(operands)) {
    return null;
  }

  const operandHtml = escapeHtml(operands)
    .replace(/\b(x(?:[12]?\d|3[01])|zero|ra|sp|gp|tp|a[0-7]|s(?:0\/fp|[0-9]|1[01])|t[0-6])\b/g, '<span class="lesson-instruction__rs">$1</span>')
    .replace(/\b(-?(?:0x[0-9a-f]+|\d+))\b/gi, '<span class="lesson-instruction__imm">$1</span>');

  return `<div class="lesson-instruction"><span class="lesson-instruction__mnemonic">${escapeHtml(
    mnemonic
  )}</span><span class="lesson-instruction__rs">${operandHtml}</span></div>`;
}

function renderStepContent(content: string): string {
  const blocks = content
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks
    .map((block) => {
      if (block === "---") {
        return '<hr class="lesson-divider" />';
      }

      if (block.startsWith("[tip]") && block.endsWith("[/tip]")) {
        const inner = block.slice(5, -6).trim();
        return `<div class="lesson-tip"><span class="lesson-tip__icon">💡</span><div class="lesson-tip__text">${renderInline(inner).replace(
          /\n/g,
          "<br />"
        )}</div></div>`;
      }

      if (block.startsWith("[warning]") && block.endsWith("[/warning]")) {
        const inner = block.slice(9, -10).trim();
        return `<div class="lesson-tip lesson-warning"><span class="lesson-tip__icon">⚠️</span><div class="lesson-tip__text">${renderInline(
          inner
        ).replace(/\n/g, "<br />")}</div></div>`;
      }

      const lines = block.split("\n").map((line) => line.trimEnd());
      if (lines.every((line) => line.startsWith("- "))) {
        return `<ul class="lesson-list">${lines
          .map((line) => `<li>${renderInline(line.slice(2))}</li>`)
          .join("")}</ul>`;
      }

      if (lines.every((line) => /^\d+\.\s/.test(line))) {
        return `<ol class="lesson-list lesson-list--ordered">${lines
          .map((line) => `<li>${renderInline(line.replace(/^\d+\.\s/, ""))}</li>`)
          .join("")}</ol>`;
      }

      const renderedInstructions = lines
        .map((line) => renderInstructionLine(line))
        .filter((line): line is string => Boolean(line));
      if (renderedInstructions.length === lines.length && renderedInstructions.length > 0) {
        return renderedInstructions.join("");
      }

      return `<p>${lines.map((line) => renderInline(line)).join("<br />")}</p>`;
    })
    .join("");
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

  const desktopColumn = document.createElement("div");
  desktopColumn.className = "sim-column sim-column--lesson";
  desktopColumn.id = "lessonModeDesktopColumn";

  const panel = document.createElement("section");
  panel.className = "sim-panel lesson-panel";
  panel.id = "lessonModePanel";

  const compactShell = document.createElement("div");
  compactShell.className = "lesson-compact-shell";
  compactShell.id = "lessonCompactShell";
  compactShell.hidden = true;
  compactShell.innerHTML = `
    <div class="lesson-compact-tabs" role="tablist" aria-label="Lesson and editor">
      <button class="lesson-compact-tab is-active" type="button" data-lesson-compact-tab="lesson" aria-selected="true">Lesson</button>
      <button class="lesson-compact-tab" type="button" data-lesson-compact-tab="editor" aria-selected="false">Editor</button>
    </div>
    <div class="lesson-compact-host" id="lessonCompactHost"></div>
  `;

  desktopColumn.appendChild(panel);
  simulatorLayout.insertBefore(desktopColumn, leftColumn);
  leftColumn.insertBefore(compactShell, leftColumn.firstChild);

  const navIndicator = document.createElement("a");
  navIndicator.className = "lesson-nav-indicator";
  navIndicator.href = "/learn/";
  navIndicator.hidden = false;
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

  function applyPhaseClasses(): void {
    const wantsRegisters = stepPhase !== "reading" && showFullRegisters(currentStep());
    document.body.classList.add("lesson-mode");
    document.body.classList.toggle("lesson-phase-reading", stepPhase === "reading");
    document.body.classList.toggle("lesson-phase-watching", stepPhase === "watching");
    document.body.classList.toggle("lesson-phase-trying", stepPhase === "trying");
    document.body.classList.toggle("lesson-show-registers", wantsRegisters);
    simulatorAppEl.classList.add("lesson-mode");
    simulatorAppEl.classList.toggle("lesson-phase-reading", stepPhase === "reading");
    simulatorAppEl.classList.toggle("lesson-phase-watching", stepPhase === "watching");
    simulatorAppEl.classList.toggle("lesson-phase-trying", stepPhase === "trying");
    simulatorAppEl.classList.toggle("lesson-show-registers", wantsRegisters);
    simulatorLayoutEl.classList.add("has-lesson-column", "lesson-mode");
    simulatorLayoutEl.classList.toggle("lesson-phase-reading", stepPhase === "reading");
    simulatorLayoutEl.classList.toggle("lesson-phase-watching", stepPhase === "watching");
    simulatorLayoutEl.classList.toggle("lesson-phase-trying", stepPhase === "trying");
    simulatorLayoutEl.classList.toggle("lesson-show-registers", wantsRegisters);
  }

  function syncPhaseControls(): void {
    const interactive = stepPhase === "trying";
    const watching = stepPhase === "watching";
    sampleSelect?.toggleAttribute("disabled", !interactive);
    assembleButton?.toggleAttribute("disabled", !interactive);
    stepButton?.toggleAttribute("disabled", !interactive && !watching);
    stepBackButton?.toggleAttribute("disabled", !interactive);
    runButton?.toggleAttribute("disabled", !interactive);
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

  function buildAnnotatedCode(step: LessonStep): string {
    const lines = (step.code ?? "").split("\n");
    const annotations = step.annotations ?? [];
    if (lines.length === 0) {
      return step.solution ?? step.code ?? "";
    }

    return lines
      .map((line, index) => {
        const note = annotations[index];
        return note ? `# ${note}\n${line}` : line;
      })
      .join("\n");
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
    compactShell.hidden = true;
    desktopColumn.hidden = false;
    desktopColumn.appendChild(panel);
    editorPanelEl.hidden = false;
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
      addPoints(50, `lesson-complete:${lesson.id}`);
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
      message: `${lesson.title} · +50 XP`,
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

  function renderGoalPanel(step: LessonStep, lessonNumber: number): string {
    if (!step.goals || step.goals.length === 0) {
      return "";
    }

    const attempts = stepAttemptCounts.get(step.id) ?? 0;
    const showHints = attempts >= 3;
    const showSolution = attempts >= 5;
    const showMiniRegisters = lessonNumber <= 5;
    const primaryHint = step.goals.find((goal) => goal.hint)?.hint;

    return `
      <div class="lesson-goal-panel">
        <button class="lesson-goal-panel__back" type="button" data-lesson-action="back-to-reading">← Back to explanation</button>
        <div class="lesson-goal-panel__title">Your goal</div>
        <div class="lesson-goals-list">
          ${step.goals
            .map((goal) => {
              const passed = goalEvaluation.results[goal.id] === true;
              const failing = !passed && (stepAttemptCounts.get(step.id) ?? 0) > 0;
              const hintVisible = hintVisibility.has(goal.id);
              return `
                <div class="lesson-goal-item${passed ? " is-passing" : ""}${failing ? " is-failing" : ""}">
                  <div class="lesson-goal-item__circle">${passed ? "✓" : ""}</div>
                  <div class="lesson-goal-item__body">
                    <div class="lesson-goal-item__desc">${escapeHtml(goal.description)}</div>
                    ${showMiniRegisters ? renderMiniRegister(goal) : ""}
                    ${
                      !passed && goalFeedback[goal.id]
                        ? `<div class="lesson-goal-item__feedback">${escapeHtml(goalFeedback[goal.id])}</div>`
                        : ""
                    }
                    ${
                      showHints && goal.hint && !hintVisible
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
          showHints && primaryHint
            ? `<div class="lesson-hint${hintVisibility.size > 0 ? "" : " is-visible"}">
                <div class="lesson-hint__label">Hint</div>
                <div class="lesson-hint__text">${escapeHtml(primaryHint)}</div>
              </div>`
            : ""
        }
        ${showSolution ? '<button class="lesson-show-solution" type="button" data-lesson-action="show-solution">Show solution</button>' : ""}
        ${
          goalEvaluation.passed
            ? `<div class="lesson-success-banner">
                <div class="lesson-success-banner__title">All goals complete.</div>
                <button class="lesson-success-banner__button" type="button" data-lesson-action="continue">Continue →</button>
              </div>`
            : ""
        }
      </div>
    `;
  }

  function renderStepDots(): string {
    return lesson.steps
      .map((entry, index) => {
        const isCompleted = lessonProgress.stepsCompleted.includes(entry.id);
        const isCurrent = index === lessonProgress.currentStepIndex;
        const isClickable = isCompleted || isCurrent;
        return `<button
          class="lesson-step-dot${isCompleted ? " is-completed" : ""}${isCurrent ? " is-current" : ""}${
            entry.isCheckpoint ? " is-checkpoint" : ""
          }"
          type="button"
          data-lesson-step-dot="${index}"
          ${isClickable ? "" : "disabled"}
          aria-label="Step ${index + 1}: ${escapeHtml(entry.title)}"
        ></button>`;
      })
      .join("");
  }

  function renderReadingView(step: LessonStep, lessonNumber: number): string {
    const progressPercent = lesson.steps.length === 0 ? 0 : ((lessonProgress.currentStepIndex + 1) / lesson.steps.length) * 100;
    const canGoPrevious = lessonProgress.currentStepIndex > 0;
    const isCheckpoint = isCheckpointStep(step);
    const hasWatch = canWatch(step);
    const isLastStep = lessonProgress.currentStepIndex >= lesson.steps.length - 1;

    return `
      <div class="lesson-reading-view">
        <div class="lesson-breadcrumb">
          <a href="/learn/" class="lesson-breadcrumb__back">← Curriculum</a>
          <span class="lesson-breadcrumb__sep">·</span>
          <span class="lesson-breadcrumb__lesson">Lesson ${lessonNumber} of ${allLessons.length}</span>
          <span class="lesson-breadcrumb__sep">·</span>
          <span class="lesson-breadcrumb__step">Step ${lessonProgress.currentStepIndex + 1} of ${lesson.steps.length}</span>
        </div>
        <div class="lesson-progress-bar">
          <div class="lesson-progress-bar__fill" style="width:${progressPercent}%;"></div>
        </div>
        <div class="lesson-step-dots">${renderStepDots()}</div>
        <div class="lesson-content-card">
          <h2 class="lesson-step-title">${escapeHtml(step.title)}</h2>
          <div class="lesson-step-body">${renderStepContent(step.content)}</div>
        </div>
        <div class="lesson-action-bar">
          <button class="lesson-btn-prev" type="button" data-lesson-action="prev"${canGoPrevious ? "" : " disabled"}>← Previous</button>
          <div class="lesson-action-bar__right">
            ${
              isCheckpoint && hasWatch
                ? '<button class="lesson-btn-watch-link" type="button" data-lesson-action="start-watch">Watch solution first</button>'
                : ""
            }
            ${
              isCheckpoint
                ? '<button class="lesson-btn-try" type="button" data-lesson-action="start-trying">Try it in the simulator →</button>'
                : isLastStep
                  ? '<button class="lesson-btn-continue" type="button" data-lesson-action="finish">Finish lesson →</button>'
                  : '<button class="lesson-btn-continue" type="button" data-lesson-action="next-reading">Continue →</button>'
            }
          </div>
        </div>
      </div>
    `;
  }

  function renderWatchingView(lessonNumber: number): string {
    const progress =
      watchInstructionCount > 0 ? Math.min(100, (currentState.stepCount / watchInstructionCount) * 100) : 0;
    const currentInstruction = escapeHtml(deps.getInstructionText(watchLastState.pc) || "Waiting for the first instruction…");

    return `
      <div class="lesson-goal-panel lesson-watch-panel">
        <button class="lesson-goal-panel__back" type="button" data-lesson-action="back-to-reading">← Back to explanation</button>
        <div class="lesson-panel__eyebrow">Lesson ${lessonNumber} · Watch</div>
        <div class="lesson-goal-panel__title">Watch the solution</div>
        <div class="lesson-watch">
          <div class="lesson-watch__controls">
            <button class="lesson-watch__button" type="button" data-lesson-action="watch-play" ${watchPlaying || watchCompleted ? "disabled" : ""}>▶ Play</button>
            <button class="lesson-watch__button" type="button" data-lesson-action="watch-pause" ${!watchPlaying ? "disabled" : ""}>⏸ Pause</button>
            <button class="lesson-watch__button" type="button" data-lesson-action="watch-reset">⏮ Reset</button>
            <button class="lesson-watch__button" type="button" data-lesson-action="watch-speed">⏩ ${watchSpeed}x</button>
          </div>
          <div class="lesson-watch__progress"><span style="width:${progress}%;"></span></div>
          <div class="lesson-watch__instruction">${currentInstruction}</div>
          <div class="lesson-watch__narration">${escapeHtml(
            watchNarration || "Watch the worked solution execute. The editor is locked while this phase is active."
          )}</div>
        </div>
        <div class="lesson-action-stack">
          <button class="lesson-btn-try" type="button" data-lesson-action="watch-try">Now you try →</button>
          <button class="lesson-btn-watch-link" type="button" data-lesson-action="skip-watch">Skip to try it</button>
        </div>
      </div>
    `;
  }

  function renderCompletion(): string {
    const lessonIndex = allLessons.findIndex((entry) => entry.id === lesson.id);
    const nextLesson = allLessons[lessonIndex + 1];
    const relatedChallenges = getChallengesForLesson(lesson.id);
    const confetti = Array.from({ length: 12 }, (_, index) => {
      const delay = `${(index % 6) * 90}ms`;
      const left = `${8 + index * 7}%`;
      return `<span class="lesson-complete__confetti" style="--confetti-delay:${delay}; left:${left};"></span>`;
    }).join("");

    return `
      <div class="lesson-complete">
        <div class="lesson-complete__confetti-layer" aria-hidden="true">${confetti}</div>
        <div class="lesson-complete__title">Lesson Complete!</div>
        ${
          nextLesson
            ? `<a class="lesson-complete__next" href="/simulator/?lesson=${encodeURIComponent(nextLesson.id)}">${escapeHtml(
                nextLesson.title
              )} unlocked</a>`
            : '<div class="lesson-complete__next">You finished the full learning path.</div>'
        }
        ${
          relatedChallenges.length > 0
            ? `<div class="lesson-complete__challenges">
                <div class="lesson-complete__challenges-title">Practice Challenges</div>
                ${relatedChallenges
                  .map((entry) => {
                    const best = getBestSubmission(entry.id);
                    return `<div class="lesson-complete__challenge">
                      <div>
                        <div class="lesson-complete__challenge-title">${escapeHtml(entry.title)}</div>
                        <div class="lesson-complete__challenge-meta">${escapeHtml(entry.difficulty)} · ${entry.points} pts · best ${
                          best ? `${best.score}/${best.maxScore}` : "none"
                        }</div>
                      </div>
                      <a class="lesson-complete__challenge-link" href="/simulator/?challenge=${encodeURIComponent(entry.id)}">Start Challenge →</a>
                    </div>`;
                  })
                  .join("")}
              </div>`
            : ""
        }
        <a class="lesson-complete__back" href="/learn/">Back to Learn</a>
      </div>
    `;
  }

  function render(): void {
    updateNavIndicator();
    applyCompactLayout();
    applyPhaseClasses();
    syncEditorReadOnly();

    if (completionVisible) {
      panel.innerHTML = renderCompletion();
      return;
    }

    const step = currentStep();
    const lessonNumber = allLessons.findIndex((entry) => entry.id === lesson.id) + 1;
    panel.innerHTML =
      stepPhase === "reading"
        ? renderReadingView(step, lessonNumber)
        : stepPhase === "watching"
          ? renderWatchingView(lessonNumber)
          : renderGoalPanel(step, lessonNumber);

    panel.querySelectorAll<HTMLElement>("[data-lesson-hint]").forEach((button) => {
      button.addEventListener("click", () => {
        const goalId = button.dataset.lessonHint;
        if (!goalId) {
          return;
        }
        hintVisibility.add(goalId);
        render();
      });
    });

    panel.querySelectorAll<HTMLElement>("[data-lesson-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.lessonAction;
        if (action === "prev" && lessonProgress.currentStepIndex > 0) {
          void navigateToStep(lessonProgress.currentStepIndex - 1);
        }
        if (action === "next" && !isCheckpointStep(currentStep()) && lessonProgress.currentStepIndex < lesson.steps.length - 1) {
          void navigateToStep(lessonProgress.currentStepIndex + 1, { markCurrentComplete: true });
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
        if (action === "skip-watch") {
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
        if (action === "breakdown") {
          const step = currentStep();
          const annotated = buildAnnotatedCode(step);
          if (annotated) {
            deps.loadSource(annotated, {
              statusMessage: "Annotated starter code loaded.",
              focus: false,
            });
            void deps.assembleSource(false, "Annotated starter assembled.");
          }
        }
        if (action === "watch-toggle") {
          if (currentWatchStepActive()) {
            void exitWatchMode(true);
          } else {
            void enterWatchMode();
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
        if (action === "watch-try" && currentWatchStepActive()) {
          void enterPhase("trying");
        }
      });
    });

    panel.querySelectorAll<HTMLButtonElement>("[data-lesson-step-dot]").forEach((button) => {
      button.addEventListener("click", () => {
        const rawIndex = Number(button.dataset.lessonStepDot);
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

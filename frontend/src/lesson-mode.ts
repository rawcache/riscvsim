import type { UserSession } from "./auth";
import { escapeHtml } from "./format";
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
  type UserProgress,
} from "./lessons";
import type { WasmStateDelta } from "./types";

type LoadSourceOptions = {
  statusMessage?: string;
  focus?: boolean;
};

type LessonModeDependencies = {
  loadSource: (source: string, options?: LoadSourceOptions) => void;
  assembleSource: (showSpinner: boolean, successMessage: string) => Promise<boolean>;
  getExecutionDeltas: () => WasmStateDelta[];
  getCurrentSession: () => UserSession | null;
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

function renderContent(content: string): string {
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
        return `<div class="lesson-callout lesson-callout--tip"><div class="lesson-callout__label">Tip</div><div class="lesson-callout__body">${renderInline(inner).replace(/\n/g, "<br />")}</div></div>`;
      }

      if (block.startsWith("[warning]") && block.endsWith("[/warning]")) {
        const inner = block.slice(9, -10).trim();
        return `<div class="lesson-callout lesson-callout--warning"><div class="lesson-callout__label">Warning</div><div class="lesson-callout__body">${renderInline(inner).replace(/\n/g, "<br />")}</div></div>`;
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

      return `<p>${lines.map((line) => renderInline(line)).join("<br />")}</p>`;
    })
    .join("");
}

function buttonArrow(direction: "left" | "right"): string {
  return direction === "left" ? "←" : "→";
}

export function createLessonMode(deps: LessonModeDependencies): LessonModeController {
  const lessonId = new URLSearchParams(window.location.search).get("lesson");
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
  let goalEvaluation: GoalEvaluation = { passed: false, results: {} };
  let justPassedGoalIds = new Set<string>();
  let hintVisibility = new Set<string>();
  let stepAttemptCounts = new Map<string, number>();
  let runtimeReady = false;
  let completionVisible = lessonProgress.completed;
  let compactTab: "lesson" | "editor" = "lesson";

  const simulatorLayout = document.querySelector(".simulator-layout");
  const leftColumn = document.querySelector(".sim-column--left");
  const editorPanel = document.querySelector(".sim-panel--editor") as HTMLElement | null;
  const brandRow = document.querySelector(".sim-nav__brand-row");

  if (!(simulatorLayout instanceof HTMLElement) || !(leftColumn instanceof HTMLElement) || !(editorPanel instanceof HTMLElement)) {
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

  const compactHost = compactShell.querySelector("#lessonCompactHost") as HTMLElement;

  desktopColumn.appendChild(panel);
  simulatorLayout.insertBefore(desktopColumn, leftColumn);
  leftColumn.insertBefore(compactShell, leftColumn.firstChild);

  const navIndicator = document.createElement("a");
  navIndicator.className = "lesson-nav-indicator";
  navIndicator.href = "/learn/";
  navIndicator.hidden = false;
  brandRow?.appendChild(navIndicator);

  const compactMedia = window.matchMedia("(max-width: 1399px)");

  function currentStep(): LessonStep {
    return lesson.steps[Math.min(lessonProgress.currentStepIndex, lesson.steps.length - 1)];
  }

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
    lessonProgress = {
      ...lessonProgress,
      stepsCompleted: uniqueStepIds([...lessonProgress.stepsCompleted, stepId]),
    };
    persistProgress();
  }

  function completedStepCount(): number {
    return lessonProgress.stepsCompleted.length;
  }

  function applyCompactLayout(): void {
    const compact = compactMedia.matches;
    compactShell.hidden = !compact;
    desktopColumn.hidden = compact;

    if (!compact) {
      desktopColumn.appendChild(panel);
      editorPanelEl.hidden = false;
      compactShell.classList.remove("is-editor-active");
      return;
    }

    compactHost.appendChild(panel);
    const showLesson = compactTab === "lesson";
    editorPanelEl.hidden = showLesson;
    compactShell.classList.toggle("is-editor-active", !showLesson);
    compactShell.querySelectorAll<HTMLButtonElement>("[data-lesson-compact-tab]").forEach((button) => {
      const active = button.dataset.lessonCompactTab === compactTab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
  }

  function loadGoalEvaluation(recordAttempt = false): void {
    const step = currentStep();
    if (!step.goals || step.goals.length === 0) {
      goalEvaluation = { passed: false, results: {} };
      render();
      return;
    }

    const previousResults = { ...goalEvaluation.results };
    const result = checkGoals(step.goals, getLessonState(deps.getExecutionDeltas()));
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

    if (newlyPassed.length > 0) {
      justPassedGoalIds = new Set(newlyPassed);
      window.setTimeout(() => {
        justPassedGoalIds = new Set<string>();
        render();
      }, 320);
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
      loadGoalEvaluation(false);
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
    compactTab = "lesson";
    applyCompactLayout();
    updateNavIndicator();
    render();
    await loadStepCode(currentStep());
  }

  async function finishLesson(): Promise<void> {
    markStepCompleted(currentStep().id);
    lessonProgress = {
      ...lessonProgress,
      completed: true,
      completedAt: new Date().toISOString(),
      currentStepIndex: lesson.steps.length - 1,
    };
    persistProgress();
    completionVisible = true;
    render();

    const session = deps.getCurrentSession();
    if (session?.idToken) {
      void syncProgressToApi(progress, session.idToken);
    }
  }

  function renderGoals(step: LessonStep): string {
    if (!step.goals || step.goals.length === 0) {
      return "";
    }

    const attempts = stepAttemptCounts.get(step.id) ?? 0;
    const showHints = attempts >= 3;

    return `
      <div class="lesson-goals">
        <div class="lesson-goals__heading">Goals</div>
        <div class="lesson-goals__list">
          ${step.goals
            .map((goal) => {
              const passed = goalEvaluation.results[goal.id] === true;
              const hintVisible = hintVisibility.has(goal.id);
              const canShowHint = !passed && showHints && Boolean(goal.hint);
              return `
                <div class="lesson-goal${passed ? " is-passed" : ""}${justPassedGoalIds.has(goal.id) ? " lesson-goal--just-passed" : ""}">
                  <div class="lesson-goal__status" aria-hidden="true">${passed ? "✓" : "○"}</div>
                  <div class="lesson-goal__content">
                    <div class="lesson-goal__text">${escapeHtml(goal.description)}</div>
                    ${
                      canShowHint
                        ? `<button class="lesson-goal__hint-toggle" type="button" data-lesson-hint="${escapeHtml(goal.id)}">Show hint</button>`
                        : ""
                    }
                    ${
                      hintVisible && goal.hint
                        ? `<div class="lesson-goal__hint">${escapeHtml(goal.hint)}</div>`
                        : ""
                    }
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `;
  }

  function renderCompletion(): string {
    const lessonIndex = allLessons.findIndex((entry) => entry.id === lesson.id);
    const nextLesson = allLessons[lessonIndex + 1];
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
        <a class="lesson-complete__back" href="/learn/">Back to Learn</a>
      </div>
    `;
  }

  function render(): void {
    updateNavIndicator();
    applyCompactLayout();

    if (completionVisible) {
      panel.innerHTML = renderCompletion();
      return;
    }

    const step = currentStep();
    const previousDisabled = lessonProgress.currentStepIndex === 0;
    const nextDisabled = step.isCheckpoint || lessonProgress.currentStepIndex >= lesson.steps.length - 1;
    const lessonNumber = allLessons.findIndex((entry) => entry.id === lesson.id) + 1;
    const progressPercent = lesson.steps.length === 0 ? 0 : (completedStepCount() / lesson.steps.length) * 100;

    panel.innerHTML = `
      <div class="panel-header lesson-panel__header">
        <div>
          <div class="lesson-panel__eyebrow">Lesson ${lessonNumber} of ${allLessons.length}</div>
          <div class="lesson-panel__title">${escapeHtml(lesson.title)}</div>
        </div>
      </div>
      <div class="lesson-panel__progress">
        <div class="lesson-panel__progress-track"><div class="lesson-panel__progress-fill" style="width: ${progressPercent}%;"></div></div>
      </div>
      <div class="lesson-panel__nav">
        <button class="lesson-panel__nav-button" type="button" data-lesson-action="prev" ${previousDisabled ? "disabled" : ""}>${buttonArrow(
          "left"
        )}</button>
        <div class="lesson-panel__nav-title">${escapeHtml(step.title)}</div>
        <button class="lesson-panel__nav-button" type="button" data-lesson-action="next" ${nextDisabled ? "disabled" : ""}>${buttonArrow(
          "right"
        )}</button>
      </div>
      <div class="lesson-panel__body">
        <div class="lesson-panel__content">${renderContent(step.content)}</div>
        ${renderGoals(step)}
      </div>
      <div class="lesson-panel__footer">
        ${
          step.isCheckpoint && step.goals && step.goals.length > 0 && goalEvaluation.passed
            ? `<div class="lesson-success-banner">
                <div>
                  <div class="lesson-success-banner__title">All goals complete!</div>
                </div>
                <button class="lesson-success-banner__button" type="button" data-lesson-action="continue">Continue →</button>
              </div>`
            : lessonProgress.currentStepIndex === lesson.steps.length - 1
              ? `<button class="lesson-finish-button" type="button" data-lesson-action="finish">Finish lesson →</button>`
              : ""
        }
      </div>
    `;

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
        if (action === "next" && !currentStep().isCheckpoint && lessonProgress.currentStepIndex < lesson.steps.length - 1) {
          void navigateToStep(lessonProgress.currentStepIndex + 1, { markCurrentComplete: true });
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
      });
    });
  }

  compactShell.querySelectorAll<HTMLButtonElement>("[data-lesson-compact-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextTab = button.dataset.lessonCompactTab;
      if (nextTab === "lesson" || nextTab === "editor") {
        compactTab = nextTab;
        applyCompactLayout();
      }
    });
  });

  compactMedia.addEventListener("change", () => {
    applyCompactLayout();
  });

  lessonProgress = createLessonProgress(lesson, progress.lessons[lesson.id]);
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
  render();

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
      render();
      await loadStepCode(currentStep(), { toast: false });
      loadGoalEvaluation(false);
    },
    handleAssembled() {
      completionVisible = lessonProgress.completed;
      loadGoalEvaluation(false);
    },
    handleStep(recordAttempt = true) {
      loadGoalEvaluation(recordAttempt);
    },
    handleStepBack() {
      loadGoalEvaluation(false);
    },
    handleRunEnd() {
      loadGoalEvaluation(false);
    },
    handleReset() {
      loadGoalEvaluation(false);
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
      completionVisible = lessonProgress.completed;
      render();

      if (runtimeReady) {
        await loadStepCode(currentStep(), { toast: false });
        loadGoalEvaluation(false);
      }
    },
  };
}

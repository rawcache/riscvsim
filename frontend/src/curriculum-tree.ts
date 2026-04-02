import type { UserSession } from "./auth";
import { show as showAuthModal } from "./auth-page";
import { CHECKPOINT_PROBLEMS } from "./checkpoint-data";
import { checkpointMilestone, formatLessonRange, getCheckpointCardState } from "./checkpoint-logic";
import type { CheckpointProgress } from "./checkpoint-data";
import { getChallengesForLesson, getChallengeStatus } from "./challenges";
import type { Lesson, UserProgress } from "./lessons";

const PHASE_LABELS: Record<string, string> = {
  "lesson-1-registers": "Foundation",
  "lesson-6-bitwise": "Core Concepts",
  "lesson-11-strings": "Intermediate",
  "lesson-16-pipeline": "Advanced",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function lessonState(lesson: Lesson, progress: UserProgress): "locked" | "available" | "in-progress" | "completed" {
  const lessonProgress = progress.lessons[lesson.id];
  if (lessonProgress?.completed) {
    return "completed";
  }
  if (lesson.prerequisites.some((prerequisiteId) => progress.lessons[prerequisiteId]?.completed !== true)) {
    return "locked";
  }
  if (lessonProgress && lessonProgress.stepsCompleted.length > 0) {
    return "in-progress";
  }
  return "available";
}

function progressPercent(lesson: Lesson, progress: UserProgress): number {
  const lessonProgress = progress.lessons[lesson.id];
  if (!lessonProgress || lesson.steps.length === 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (lessonProgress.stepsCompleted.length / lesson.steps.length) * 100));
}

function difficultyLabel(difficulty: Lesson["difficulty"]): string {
  return difficulty.charAt(0).toUpperCase() + difficulty.slice(1);
}

function phaseDivider(label: string): string {
  return `
    <div class="lesson-phase-divider">
      <div class="lesson-phase-divider__line"></div>
      <span class="lesson-phase-divider__label">${escapeHtml(label)}</span>
      <div class="lesson-phase-divider__line"></div>
    </div>
  `;
}

function actionLabel(state: ReturnType<typeof lessonState>): string {
  if (state === "completed") {
    return "Review →";
  }
  if (state === "in-progress") {
    return "Continue →";
  }
  if (state === "available") {
    return "Start →";
  }
  return "Locked";
}

function actionClass(state: ReturnType<typeof lessonState>): string {
  if (state === "completed") {
    return "lesson-row-btn lesson-row-btn--review";
  }
  if (state === "in-progress") {
    return "lesson-row-btn lesson-row-btn--continue";
  }
  if (state === "available") {
    return "lesson-row-btn lesson-row-btn--start";
  }
  return "lesson-row-btn lesson-row-btn--locked";
}

function circleInner(index: number, state: ReturnType<typeof lessonState>): string {
  if (state === "completed") {
    return "✓";
  }
  if (state === "locked") {
    return "🔒";
  }
  return String(index + 1);
}

function challengeDotsMarkup(lesson: Lesson): string {
  const dots = getChallengesForLesson(lesson.id)
    .map((challenge) => {
      const status = getChallengeStatus(challenge.id);
      if (status === "locked") {
        return "";
      }
      return `<span class="challenge-dot challenge-dot--${status}" aria-hidden="true"></span>`;
    })
    .join("");

  return dots ? `<div class="lesson-row__challenge-dots">${dots}</div>` : "";
}

function prerequisiteMessage(lesson: Lesson, lessonsById: Map<string, Lesson>): string {
  const prerequisiteId = lesson.prerequisites.find(Boolean);
  if (!prerequisiteId) {
    return "Complete the prerequisite lesson to unlock this lesson.";
  }
  const prerequisite = lessonsById.get(prerequisiteId);
  return `Complete ${prerequisite?.title ?? "the prerequisite lesson"} to unlock this lesson`;
}

function rowMarkup(
  lesson: Lesson,
  index: number,
  state: ReturnType<typeof lessonState>,
  progress: UserProgress,
  lessonsById: Map<string, Lesson>,
  isTerminal: boolean
): string {
  const difficulty = lesson.difficulty;
  const progressPct = progressPercent(lesson, progress);
  const metaProgress =
    state === "in-progress"
      ? `<div class="lesson-row__progress-bar"><div class="lesson-row__progress-fill" style="width:${progressPct}%;"></div></div>`
      : "";
  const href = state === "locked" ? "#" : `/simulator/?lesson=${encodeURIComponent(lesson.id)}`;
  const lockedMessage = state === "locked" ? prerequisiteMessage(lesson, lessonsById) : "";

  return `
    <a
      class="lesson-row lesson-row--${state}${isTerminal ? " lesson-row--terminal" : ""}"
      href="${href}"
      data-lesson-id="${escapeHtml(lesson.id)}"
      ${lockedMessage ? `data-locked-message="${escapeHtml(lockedMessage)}" aria-disabled="true"` : ""}
    >
      <div class="lesson-row__left">
        <div class="lesson-row__circle lr-circle--${difficulty}">
          ${escapeHtml(circleInner(index, state))}
        </div>
        <div class="lesson-row__connector"></div>
      </div>
      <div class="lesson-row__content">
        <div class="lesson-row__header">
          <span class="lesson-row__title">${escapeHtml(lesson.title)}</span>
          <div class="lesson-row__badges">
            ${lesson.eceCourse ? '<span class="lesson-badge lesson-badge--ece">ECE</span>' : ""}
            <span class="lesson-badge lesson-badge--${difficulty}">${escapeHtml(difficulty)}</span>
          </div>
        </div>
        <div class="lesson-row__meta">
          ${lesson.estimatedMinutes} min · ${escapeHtml(difficultyLabel(difficulty))}
          ${metaProgress}
        </div>
        ${challengeDotsMarkup(lesson)}
      </div>
      <div class="lesson-row__right">
        <span class="${actionClass(state)}">${escapeHtml(actionLabel(state))}</span>
      </div>
    </a>
  `;
}

function checkpointIcon(state: ReturnType<typeof getCheckpointCardState>, requiredTier: string): string {
  if (state === "completed") {
    return "✓";
  }
  if (state === "unlocked") {
    return "🏁";
  }
  if (state === "locked-tier") {
    return requiredTier === "Pro" ? "🐝" : "👤";
  }
  return "🔒";
}

function checkpointActionMarkup(
  state: ReturnType<typeof getCheckpointCardState>,
  problemId: string,
  requiredTier: string,
  completedAt?: string
): string {
  if (state === "completed") {
    return `
      <div class="cp-gate-card__action-stack">
        <span class="cp-gate-card__done">Completed ✓</span>
        ${completedAt ? `<span class="cp-gate-card__done-date">${escapeHtml(new Date(completedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</span>` : ""}
        <a class="cp-gate-card__link" href="/checkpoints/?id=${encodeURIComponent(problemId)}">View →</a>
      </div>
    `;
  }
  if (state === "unlocked") {
    return `<a class="cp-gate-card__button" href="/checkpoints/?id=${encodeURIComponent(problemId)}">Start Checkpoint →</a>`;
  }
  if (state === "locked-tier") {
    return `
      <div class="cp-gate-card__action-stack">
        <span class="cp-gate-card__lock-copy">${escapeHtml(requiredTier === "Pro" ? "Georgia Tech Pro required" : "Sign in required")}</span>
        <button class="cp-gate-card__button" data-cp-auth-action="signin" type="button">${escapeHtml(requiredTier === "Pro" ? "Use GT email →" : "Sign in →")}</button>
      </div>
    `;
  }
  return `<span class="cp-gate-card__lock-copy">Complete Lessons ${escapeHtml(formatLessonRange(CHECKPOINT_PROBLEMS.find((problem) => problem.id === problemId)!))} first</span>`;
}

function checkpointCardsMarkup(
  lessonNumber: number,
  progress: UserProgress,
  checkpointProgress: CheckpointProgress,
  session: UserSession | null
): string {
  const cards = CHECKPOINT_PROBLEMS.filter((problem) => checkpointMilestone(problem) === lessonNumber);
  if (cards.length === 0) {
    return "";
  }

  return `
    <div class="cp-gate-group">
      ${cards
        .map((problem) => {
          const state = getCheckpointCardState(problem, progress, checkpointProgress, session);
          const entry = checkpointProgress[problem.id];
          return `
            <div class="cp-gate-card" data-state="${escapeHtml(state)}" data-cp-id="${escapeHtml(problem.id)}">
              <div class="cp-gate-card__left">
                <div class="cp-gate-card__icon-wrap">${escapeHtml(checkpointIcon(state, problem.requiredTier))}</div>
              </div>
              <div class="cp-gate-card__body">
                <div class="cp-gate-card__label">Checkpoint ${problem.id.replace("cp", "")}</div>
                <div class="cp-gate-card__title">${escapeHtml(problem.title)}</div>
                <div class="cp-gate-card__meta">${escapeHtml(`${problem.difficulty} · ${problem.estimatedMinutes} min · ${problem.tags[0] ?? "Practice"}`)}</div>
                ${state === "unlocked" || state === "completed" ? '<div class="cp-gate-card__desc">Complete this checkpoint to continue.</div>' : ""}
              </div>
              <div class="cp-gate-card__action">
                ${checkpointActionMarkup(state, problem.id, problem.requiredTier, entry?.completedAt)}
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function removeExistingTooltip(container: HTMLElement): void {
  container.querySelector(".lesson-tree__tooltip")?.remove();
}

function showLockedTooltip(row: HTMLElement, message: string): void {
  const tree = row.closest(".lesson-tree");
  if (!(tree instanceof HTMLElement)) {
    return;
  }

  removeExistingTooltip(tree);

  const tooltip = document.createElement("div");
  tooltip.className = "lesson-tree__tooltip";
  tooltip.textContent = message;
  row.appendChild(tooltip);

  window.requestAnimationFrame(() => {
    tooltip.classList.add("is-visible");
  });

  window.setTimeout(() => {
    tooltip.classList.remove("is-visible");
    window.setTimeout(() => {
      tooltip.remove();
    }, 220);
  }, 2000);
}

export function renderCurriculumTree(
  container: HTMLElement,
  lessons: Lesson[],
  progress: UserProgress,
  checkpointProgress: CheckpointProgress,
  session: UserSession | null
): void {
  const lessonsById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const completedCount = lessons.filter((lesson) => progress.lessons[lesson.id]?.completed === true).length;
  const totalCount = lessons.length || 1;
  const progressPct = `${(completedCount / totalCount) * 100}%`;
  const terminalIds = new Set(["lesson-5-sorting", "lesson-10-mext", "lesson-15-capstone", "lesson-20-minikernel"]);

  const rows = lessons
    .map((lesson, index) => {
      const divider = PHASE_LABELS[lesson.id] ? phaseDivider(PHASE_LABELS[lesson.id]) : "";
      const state = lessonState(lesson, progress);
      return `${divider}${rowMarkup(lesson, index, state, progress, lessonsById, terminalIds.has(lesson.id))}${checkpointCardsMarkup(index + 1, progress, checkpointProgress, session)}`;
    })
    .join("");

  container.innerHTML = `
    <div class="lesson-tree">
      <div class="lesson-path-line" style="--progress-pct:${progressPct};"></div>
      ${rows}
    </div>
  `;

  container.querySelectorAll<HTMLElement>(".lesson-row--locked").forEach((row) => {
    row.addEventListener("click", (event) => {
      event.preventDefault();
      showLockedTooltip(row, row.dataset.lockedMessage ?? "Complete the prerequisite lesson to unlock this lesson.");
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-cp-auth-action='signin']").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      showAuthModal({ allowClose: true });
    });
  });
}

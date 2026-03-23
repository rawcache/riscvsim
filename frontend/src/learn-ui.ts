import { getSession } from "./auth";
import {
  getLessons,
  isUnlocked,
  loadProgress,
  loadProgressFromApi,
  saveProgress,
  type Lesson,
  type UserProgress,
} from "./lessons";
import { initSiteShell } from "./site-shell";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function difficultyLabel(lesson: Lesson): string {
  return lesson.difficulty.charAt(0).toUpperCase() + lesson.difficulty.slice(1);
}

function findLessonNumber(lessonId: string): number {
  return getLessons().findIndex((lesson) => lesson.id === lessonId) + 1;
}

function completedCount(progress: UserProgress): number {
  return Object.values(progress.lessons).filter((lesson) => lesson.completed).length;
}

function iconCheck(): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.1" aria-hidden="true"><path d="m5 12 4.2 4.2L19 6.5"></path></svg>`;
}

function iconLock(): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"></rect><path d="M8 10V7a4 4 0 1 1 8 0v3"></path></svg>`;
}

function renderLessonStateBadge(index: number, completed: boolean, unlocked: boolean): string {
  if (completed) {
    return `<span class="learn-lesson__badge learn-lesson__badge--completed">${iconCheck()}</span>`;
  }

  if (!unlocked) {
    return `<span class="learn-lesson__badge learn-lesson__badge--locked">${iconLock()}</span>`;
  }

  return `<span class="learn-lesson__badge learn-lesson__badge--active">${index}</span>`;
}

function renderLessonAction(lesson: Lesson, progress: UserProgress, unlocked: boolean): string {
  const lessonProgress = progress.lessons[lesson.id];
  const href = `/simulator/?lesson=${encodeURIComponent(lesson.id)}`;

  if (lessonProgress?.completed) {
    return `<a class="learn-lesson__action learn-lesson__action--outline" href="${href}">Review →</a>`;
  }

  if (unlocked) {
    return `<a class="learn-lesson__action learn-lesson__action--primary" href="${href}">Start →</a>`;
  }

  return `<button class="learn-lesson__action learn-lesson__action--disabled" type="button" disabled>Locked</button>`;
}

function renderLockedMessage(lesson: Lesson): string {
  const prerequisite = lesson.prerequisites[0];
  if (!prerequisite) {
    return "";
  }
  const prerequisiteNumber = findLessonNumber(prerequisite);
  return `<div class="learn-lesson__locked-note">Complete Lesson ${prerequisiteNumber} to unlock</div>`;
}

function renderLessons(progress: UserProgress): string {
  return getLessons()
    .map((lesson, index) => {
      const unlocked = isUnlocked(lesson.id, progress);
      const completed = progress.lessons[lesson.id]?.completed === true;

      return `
        <article class="learn-lesson${completed ? " is-complete" : unlocked ? " is-unlocked" : " is-locked"}">
          <div class="learn-lesson__marker">
            ${renderLessonStateBadge(index + 1, completed, unlocked)}
          </div>
          <div class="learn-lesson__body">
            <h2 class="learn-lesson__title">Lesson ${index + 1}. ${escapeHtml(lesson.title)}</h2>
            <p class="learn-lesson__description">${escapeHtml(lesson.description)}</p>
            <div class="learn-lesson__tags">
              ${lesson.tags.map((tag) => `<span class="learn-lesson__tag">${escapeHtml(tag)}</span>`).join("")}
            </div>
            <div class="learn-lesson__meta">~${lesson.estimatedMinutes} min · ${escapeHtml(difficultyLabel(lesson))}</div>
          </div>
          <div class="learn-lesson__actions">
            ${renderLessonAction(lesson, progress, unlocked)}
            ${!unlocked && !completed ? renderLockedMessage(lesson) : ""}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderProgress(progress: UserProgress, isLoggedIn: boolean): void {
  const progressShell = document.getElementById("learnProgressShell");
  const progressFill = document.getElementById("learnProgressFill");
  const progressLabel = document.getElementById("learnProgressLabel");

  if (!progressShell || !progressFill || !progressLabel) {
    return;
  }

  if (!isLoggedIn) {
    progressShell.hidden = true;
    return;
  }

  const count = completedCount(progress);
  progressShell.hidden = false;
  progressFill.style.width = `${(count / 5) * 100}%`;
  progressLabel.textContent = `${count} of 5 lessons complete`;
}

function renderPage(progress: UserProgress, isLoggedIn: boolean): void {
  const lessonsList = document.getElementById("learnLessonsList");
  if (!lessonsList) {
    return;
  }

  lessonsList.innerHTML = renderLessons(progress);
  renderProgress(progress, isLoggedIn);
}

document.addEventListener("DOMContentLoaded", () => {
  void initSiteShell().then(async () => {
    let progress = loadProgress();
    let session = await getSession();

    renderPage(progress, Boolean(session));

    if (!session) {
      return;
    }

    const apiProgress = await loadProgressFromApi(session.idToken);
    if (!apiProgress) {
      return;
    }

    progress = mergeProgress(progress, apiProgress);
    saveProgress(progress);
    session = await getSession();
    renderPage(progress, Boolean(session));
  });
});

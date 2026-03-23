import { getChallengesForLesson, getChallengeStatus } from "./challenges";
import type { Lesson, UserProgress } from "./lessons";

type Point = { x: number; y: number };

const TREE_LAYOUT: Record<string, Point> = {
  "lesson-1-registers": { x: 280, y: 20 },
  "lesson-2-memory": { x: 280, y: 150 },
  "lesson-3-branches": { x: 280, y: 280 },
  "lesson-4-functions": { x: 280, y: 410 },
  "lesson-6-bitwise": { x: 110, y: 540 },
  "lesson-7-shifts": { x: 110, y: 670 },
  "lesson-8-comparison": { x: 110, y: 800 },
  "lesson-5-sorting": { x: 450, y: 540 },
  "lesson-9-stack": { x: 450, y: 670 },
  "lesson-10-mext": { x: 450, y: 800 },
  "lesson-11-strings": { x: 110, y: 930 },
  "lesson-12-linkedlist": { x: 110, y: 1060 },
  "lesson-13-recursion": { x: 280, y: 1190 },
  "lesson-14-syscall": { x: 280, y: 1320 },
  "lesson-15-capstone": { x: 280, y: 1450 },
};

const TREE_EDGES: Array<[string, string]> = [
  ["lesson-1-registers", "lesson-2-memory"],
  ["lesson-2-memory", "lesson-3-branches"],
  ["lesson-3-branches", "lesson-4-functions"],
  ["lesson-4-functions", "lesson-5-sorting"],
  ["lesson-4-functions", "lesson-9-stack"],
  ["lesson-1-registers", "lesson-6-bitwise"],
  ["lesson-6-bitwise", "lesson-7-shifts"],
  ["lesson-7-shifts", "lesson-8-comparison"],
  ["lesson-6-bitwise", "lesson-11-strings"],
  ["lesson-11-strings", "lesson-12-linkedlist"],
  ["lesson-5-sorting", "lesson-15-capstone"],
  ["lesson-9-stack", "lesson-13-recursion"],
  ["lesson-10-mext", "lesson-13-recursion"],
  ["lesson-1-registers", "lesson-10-mext"],
  ["lesson-13-recursion", "lesson-14-syscall"],
  ["lesson-14-syscall", "lesson-15-capstone"],
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function difficultyLabel(difficulty: Lesson["difficulty"]): string {
  return difficulty.charAt(0).toUpperCase() + difficulty.slice(1);
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
  if (!lessonProgress) {
    return 0;
  }
  return Math.max(0, Math.min(100, (lessonProgress.stepsCompleted.length / lesson.steps.length) * 100));
}

function edgePath(from: Point, to: Point, compact: boolean): string {
  const nodeRadius = compact ? 12 : 36;
  const startX = from.x;
  const startY = from.y + nodeRadius;
  const endX = to.x;
  const endY = to.y - nodeRadius;
  const deltaY = (endY - startY) * 0.55;
  return `M ${startX} ${startY} C ${startX} ${startY + deltaY}, ${endX} ${endY - deltaY}, ${endX} ${endY}`;
}

function nodeArc(progress: number): string {
  const circumference = 2 * Math.PI * 30;
  const dash = (Math.max(0, Math.min(100, progress)) / 100) * circumference;
  return `${dash} ${circumference - dash}`;
}

export function renderCurriculumTree(container: HTMLElement, lessons: Lesson[], progress: UserProgress): void {
  const compact = container.dataset.compact === "true";
  const readOnly = compact || container.dataset.readonly === "true";
  const scale = compact ? 0.52 : 1;
  const width = compact ? 360 : 640;
  const height = compact ? 820 : 1560;
  const nodeSize = compact ? 24 : 72;
  const ringRadius = compact ? 11 : 30;

  const positionedLessons = lessons.filter((lesson) => lesson.id in TREE_LAYOUT);
  const lessonsById = new Map(positionedLessons.map((lesson) => [lesson.id, lesson]));

  const svgPaths = TREE_EDGES.map(([fromId, toId]) => {
    const fromLesson = lessonsById.get(fromId);
    const toLesson = lessonsById.get(toId);
    if (!fromLesson || !toLesson) {
      return "";
    }

    const fromState = lessonState(fromLesson, progress);
    const toState = lessonState(toLesson, progress);
    const completed = fromState === "completed" && (toState === "completed" || toState === "in-progress");
    const from = TREE_LAYOUT[fromId];
    const to = TREE_LAYOUT[toId];
    const scaledFrom = { x: from.x * scale, y: from.y * scale };
    const scaledTo = { x: to.x * scale, y: to.y * scale };
    return `<path d="${edgePath(scaledFrom, scaledTo, compact)}" class="tree-edge${completed ? " tree-edge--completed" : " tree-edge--locked"}" />`;
  }).join("");

  const nodesHtml = positionedLessons
    .map((lesson, index) => {
      const point = TREE_LAYOUT[lesson.id];
      const state = lessonState(lesson, progress);
      const completion = progressPercent(lesson, progress);
      const challengeDots = compact
        ? ""
        : getChallengesForLesson(lesson.id)
            .map((challenge) => {
              const status = getChallengeStatus(challenge.id);
              if (status === "locked") {
                return "";
              }
              return `<span class="challenge-dot challenge-dot--${status}" aria-hidden="true"></span>`;
            })
            .join("");
      const x = point.x * scale;
      const y = point.y * scale;
      const label = compact
        ? ""
        : `<div class="tree-node__label">${escapeHtml(lesson.title)}<div class="tree-node__sublabel">~${lesson.estimatedMinutes} min · ${escapeHtml(
            difficultyLabel(lesson.difficulty)
          )}</div></div>`;
      const progressBar =
        state === "in-progress" && !compact
          ? `<div class="tree-node__progress"><span style="width:${completion}%;"></span></div>`
          : "";
      const statusIcon = compact ? "" : state === "completed" ? "✓" : state === "locked" ? "🔒" : String(index + 1);
      const title = state === "locked" && lesson.prerequisites[0]
        ? `Complete ${lessonsById.get(lesson.prerequisites[0])?.title ?? "the prerequisite lesson"} to unlock.`
        : lesson.description;

      return `
        <div
          class="tree-node-shell${compact ? " tree-node-shell--compact" : ""}"
          style="left:${x - nodeSize / 2}px; top:${y}px;"
        >
          <button
            type="button"
            class="tree-node tree-node--${state}"
            data-lesson-id="${escapeHtml(lesson.id)}"
            ${readOnly || state === "locked" ? "disabled" : ""}
            title="${escapeHtml(title)}"
            aria-label="${escapeHtml(lesson.title)}"
          >
            ${
              state === "in-progress"
                ? `<svg class="tree-node__ring" viewBox="0 0 72 72" aria-hidden="true">
                    <circle cx="36" cy="36" r="${ringRadius}" class="tree-node__ring-track"></circle>
                    <circle cx="36" cy="36" r="${ringRadius}" class="tree-node__ring-progress" style="stroke-dasharray:${nodeArc(completion)};"></circle>
                  </svg>`
                : ""
            }
            <span class="tree-node__inner">${escapeHtml(statusIcon)}</span>
          </button>
          ${label}
          ${challengeDots ? `<div class="tree-node__dots">${challengeDots}</div>` : ""}
          ${progressBar}
        </div>
      `;
    })
    .join("");

  container.classList.toggle("curriculum-tree--compact", compact);
  container.innerHTML = `
    <svg class="curriculum-tree__edges" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMin meet" aria-hidden="true">
      ${svgPaths}
    </svg>
    <div class="curriculum-tree__nodes">
      ${nodesHtml}
    </div>
  `;

  if (readOnly) {
    return;
  }

  container.querySelectorAll<HTMLButtonElement>(".tree-node[data-lesson-id]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) {
        return;
      }
      const lessonId = button.dataset.lessonId;
      if (!lessonId) {
        return;
      }
      window.location.href = `/simulator/?lesson=${encodeURIComponent(lessonId)}`;
    });
  });
}

import { getChallenges, getChallengeStatus, getBestSubmission, type Challenge } from "./challenges";
import { initFooter } from "./footer";
import { getLesson } from "./lessons";
import { initNav } from "./nav";
import { loadScore } from "./scoring";

type DifficultyFilter = "all" | "easy" | "medium" | "hard";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function currentStatusIcon(status: ReturnType<typeof getChallengeStatus>): string {
  if (status === "passed") return "✓";
  if (status === "attempted") return "◔";
  if (status === "locked") return "🔒";
  return "○";
}

function renderChallengeCard(challenge: Challenge): string {
  const status = getChallengeStatus(challenge.id);
  const best = getBestSubmission(challenge.id);
  const lesson = getLesson(challenge.lessonId);
  return `
    <a class="challenge-card challenge-card--${status}" href="${status === "locked" ? "#" : `/simulator/?challenge=${encodeURIComponent(challenge.id)}`}">
      <div class="challenge-card__header">
        <span class="challenge-card__status">${escapeHtml(currentStatusIcon(status))}</span>
        <span class="challenge-card__difficulty challenge-card__difficulty--${challenge.difficulty}">${escapeHtml(challenge.difficulty)}</span>
      </div>
      <h2 class="challenge-card__title">${escapeHtml(challenge.title)}</h2>
      <div class="challenge-card__lesson">${escapeHtml(lesson?.title ?? challenge.lessonId)}</div>
      <p class="challenge-card__body">${escapeHtml(challenge.description)}</p>
      <div class="challenge-card__footer">
        <span class="challenge-card__points">${challenge.points} pts</span>
        <span class="challenge-card__best">${best ? `${best.score}/${best.maxScore}` : "Not attempted"}</span>
      </div>
    </a>
  `;
}

function applyFilters(challenges: Challenge[], difficulty: DifficultyFilter, lessonFilter: string): Challenge[] {
  return challenges.filter((challenge) => {
    if (difficulty !== "all" && challenge.difficulty !== difficulty) {
      return false;
    }
    if (lessonFilter !== "all" && challenge.lessonId !== lessonFilter) {
      return false;
    }
    return true;
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initNav({ activePage: "challenges" });
  initFooter();

  const list = document.getElementById("challengesGrid");
  const filterButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-challenge-difficulty]"));
  const lessonFilter = document.getElementById("challengeLessonFilter") as HTMLSelectElement | null;
  const solvedLabel = document.getElementById("challengesSolved");
  const xpLabel = document.getElementById("challengesXp");

  if (!list || !lessonFilter || !solvedLabel || !xpLabel) {
    return;
  }

  const challengesGrid = list;
  const lessonFilterEl = lessonFilter;
  const solvedLabelEl = solvedLabel;
  const xpLabelEl = xpLabel;

  const challenges = getChallenges();
  const lessons = Array.from(new Set(challenges.map((challenge) => challenge.lessonId)));
  let activeDifficulty: DifficultyFilter = "all";

  lessonFilterEl.innerHTML =
    `<option value="all">All lessons</option>` +
    lessons.map((lessonId) => `<option value="${escapeHtml(lessonId)}">${escapeHtml(lessonId.replace("lesson-", "Lesson ").replace(/-/g, " "))}</option>`).join("");

  function render() {
    const filtered = applyFilters(challenges, activeDifficulty, lessonFilterEl.value);
    challengesGrid.innerHTML = filtered.map((challenge) => renderChallengeCard(challenge)).join("");
    solvedLabelEl.textContent = `${challenges.filter((challenge) => getChallengeStatus(challenge.id) === "passed").length}/15 solved`;
    xpLabelEl.textContent = `${loadScore().totalPoints.toLocaleString("en-US")} XP`;

    filterButtons.forEach((button) => {
      const active = button.dataset.challengeDifficulty === activeDifficulty;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      activeDifficulty = (button.dataset.challengeDifficulty as DifficultyFilter) || "all";
      render();
    });
  });

  lessonFilterEl.addEventListener("change", render);
  render();
});

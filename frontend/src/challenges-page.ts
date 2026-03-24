import { getChallenges, getChallengeStatus, getBestSubmission, type Challenge } from "./challenges";
import { initFooter } from "./footer";
import { getLesson } from "./lessons";
import { initNav } from "./nav";
import { loadScore } from "./scoring";
import { formatWeeklyCountdown, getCurrentWeekNumber, getMsUntilWeeklyReset, getWeeklyChallengeId } from "./weekly-challenge";

type DifficultyFilter = "all" | "easy" | "medium" | "hard";
type WeeklyChallengePayload = {
  challengeId: string;
  weekNumber: number;
  startDate: string;
  endDate: string;
  totalAttempts: number;
  totalPassed: number;
  topScorers: Array<{
    displayName: string;
    score: number;
    timeSeconds: number;
  }>;
};

const DEFAULT_API_ENDPOINT = "https://api.studyriscv.com";
const API_ENDPOINT = (import.meta.env.VITE_API_ENDPOINT as string | undefined)?.trim() || DEFAULT_API_ENDPOINT;

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

async function fetchWeeklyChallenge(challengeId: string): Promise<WeeklyChallengePayload | null> {
  try {
    const response = await fetch(
      `${API_ENDPOINT}/leaderboard/weekly-challenge?challengeId=${encodeURIComponent(challengeId)}&weekNumber=${getCurrentWeekNumber()}`
    );
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as WeeklyChallengePayload;
  } catch {
    return null;
  }
}

function renderWeeklyChallengeCard(challenge: Challenge, payload: WeeklyChallengePayload | null): string {
  const attempts = payload?.totalAttempts ?? 0;
  const passed = payload?.totalPassed ?? 0;
  const passRate = attempts > 0 ? Math.round((passed / attempts) * 100) : 0;
  const topScorers = payload?.topScorers?.slice(0, 5) ?? [];

  return `
    <section class="weekly-challenge-card">
      <div class="weekly-challenge-card__header">
        <div>
          <div class="weekly-challenge-card__eyebrow">🏆 Challenge of the Week</div>
          <div class="weekly-challenge-card__reset">Resets Monday · <span id="weeklyChallengeCountdown">${escapeHtml(
            formatWeeklyCountdown(getMsUntilWeeklyReset())
          )}</span></div>
        </div>
      </div>
      <div class="weekly-challenge-card__title">${escapeHtml(challenge.title)}</div>
      <div class="weekly-challenge-card__meta">${escapeHtml(challenge.difficulty)} · ${challenge.points} pts · ${challenge.estimatedMinutes} min</div>
      <div class="weekly-challenge-card__stats">
        <div class="weekly-challenge-card__stat"><span>Attempted</span><strong>${attempts}</strong></div>
        <div class="weekly-challenge-card__stat"><span>Passed</span><strong>${passed} (${passRate}%)</strong></div>
      </div>
      <a class="learn-panel__link weekly-challenge-card__cta" href="/simulator/?challenge=${encodeURIComponent(challenge.id)}">Start Challenge →</a>
      <div class="weekly-challenge-card__leaderboard">
        <div class="weekly-challenge-card__leaderboard-title">This week's top scores</div>
        ${
          topScorers.length
            ? topScorers
                .map(
                  (entry, index) => `
                    <div class="weekly-challenge-card__row${index < 3 ? ` weekly-challenge-card__row--top-${index + 1}` : ""}">
                      <span>#${index + 1}</span>
                      <span>${escapeHtml(entry.displayName)}</span>
                      <span>${entry.score}</span>
                      <span>${entry.timeSeconds}s</span>
                    </div>
                  `
                )
                .join("")
            : '<div class="learn-badges__empty">No weekly completions yet.</div>'
        }
      </div>
    </section>
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
  const weeklyMount = document.getElementById("weeklyChallengeMount");

  if (!list || !lessonFilter || !solvedLabel || !xpLabel) {
    return;
  }

  const challengesGrid = list;
  const lessonFilterEl = lessonFilter;
  const solvedLabelEl = solvedLabel;
  const xpLabelEl = xpLabel;

  const challenges = getChallenges();
  const weeklyChallenge = challenges.find((challenge) => challenge.id === getWeeklyChallengeId());
  const lessons = Array.from(new Set(challenges.map((challenge) => challenge.lessonId)));
  let activeDifficulty: DifficultyFilter = "all";

  lessonFilterEl.innerHTML =
    `<option value="all">All lessons</option>` +
    lessons.map((lessonId) => `<option value="${escapeHtml(lessonId)}">${escapeHtml(lessonId.replace("lesson-", "Lesson ").replace(/-/g, " "))}</option>`).join("");

  function render() {
    const filtered = applyFilters(challenges, activeDifficulty, lessonFilterEl.value);
    challengesGrid.innerHTML = filtered.map((challenge) => renderChallengeCard(challenge)).join("");
    solvedLabelEl.textContent = `${challenges.filter((challenge) => getChallengeStatus(challenge.id) === "passed").length}/${challenges.length} solved`;
    xpLabelEl.textContent = `${loadScore().totalPoints.toLocaleString("en-US")} chips`;

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

  if (weeklyMount && weeklyChallenge) {
    void fetchWeeklyChallenge(weeklyChallenge.id).then((payload) => {
      weeklyMount.innerHTML = renderWeeklyChallengeCard(weeklyChallenge, payload);
      window.setInterval(() => {
        const countdown = document.getElementById("weeklyChallengeCountdown");
        if (countdown) {
          countdown.textContent = formatWeeklyCountdown(getMsUntilWeeklyReset());
        }
      }, 60_000);
    });
  }
});

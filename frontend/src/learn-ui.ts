import { getSession } from "./auth";
import { getBestSubmission, getChallengeStatus, getChallenges, loadChallengeSubmissions } from "./challenges";
import { renderCurriculumTree } from "./curriculum-tree";
import { initFooter } from "./footer";
import { getLessons, loadProgress, loadProgressFromApi, saveProgress, type UserProgress } from "./lessons";
import { initNav } from "./nav";
import { loadScore } from "./scoring";

const DEFAULT_API_ENDPOINT = "https://api.studyriscv.com";
const API_ENDPOINT = (import.meta.env.VITE_API_ENDPOINT as string | undefined)?.trim() || DEFAULT_API_ENDPOINT;

type LeaderboardEntry = {
  rank: number;
  displayName: string;
  totalPoints: number;
  weeklyPoints?: number;
  lessonsCompleted: number;
  challengesPassed: number;
  badges?: Array<{ id: string; name?: string }>;
  streak?: number;
};

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

function formatPoints(points: number): string {
  return points.toLocaleString("en-US");
}

function progressPercent(progress: UserProgress): number {
  const lessonCount = Math.max(1, getLessons().length);
  return Math.round((Object.values(progress.lessons).filter((lesson) => lesson.completed).length / lessonCount) * 100);
}

function lessonsCompleted(progress: UserProgress): number {
  return Object.values(progress.lessons).filter((lesson) => lesson.completed).length;
}

function challengesPassed(): number {
  return getChallenges().filter((challenge) => getChallengeStatus(challenge.id) === "passed").length;
}

function challengeSolvedText(): string {
  return `${challengesPassed()}/${getChallenges().length}`;
}

function resumeMarkup(progress: UserProgress): string {
  const lessons = getLessons();
  const activeId = progress.lastActiveLesson ?? lessons.find((lesson) => progress.lessons[lesson.id] && !progress.lessons[lesson.id]?.completed)?.id;
  if (!activeId) {
    return "";
  }
  const lesson = lessons.find((entry) => entry.id === activeId);
  const lessonProgress = lesson ? progress.lessons[lesson.id] : null;
  if (!lesson || !lessonProgress || lessonProgress.completed) {
    return "";
  }
  const stepIndex = Math.min(lessonProgress.currentStepIndex + 1, lesson.steps.length);
  return `
    <a class="learn-resume" href="/simulator/?lesson=${encodeURIComponent(lesson.id)}&step=${encodeURIComponent(lesson.steps[Math.min(lessonProgress.currentStepIndex, lesson.steps.length - 1)].id)}">
      <span class="learn-resume__label">Continue</span>
      <span class="learn-resume__text">${escapeHtml(lesson.title)} · Step ${stepIndex} of ${lesson.steps.length}</span>
      <span class="learn-resume__cta">Resume →</span>
    </a>
  `;
}

function renderBadges(): string {
  const recent = loadScore().badges.slice(-5).reverse();
  if (recent.length === 0) {
    return '<div class="learn-badges__empty">No badges yet</div>';
  }
  return recent
    .map(
      (badge) =>
        `<span class="badge-icon learn-badge" title="${escapeHtml(`${badge.name} · ${badge.description}`)}" aria-label="${escapeHtml(
          badge.name
        )}">${badge.icon}</span>`
    )
    .join("");
}

function renderHero(progress: UserProgress, loggedIn: boolean): void {
  const heroShell = document.getElementById("learnHeroShell");
  if (!heroShell) {
    return;
  }

  const score = loadScore();
  const completed = lessonsCompleted(progress);
  const percent = progressPercent(progress);
  const totalLessons = getLessons().length;

  heroShell.innerHTML = `
    <div class="learn-hero__copy">
      <div>
        <h1 class="learn-hero__title">Learn RISC-V Assembly</h1>
        <p class="learn-hero__subhead">${totalLessons} lessons · 15 challenges · ECE 2035 aligned</p>
      </div>
      <div class="learn-xp-pill">${formatPoints(score.totalPoints)} XP</div>
      ${resumeMarkup(progress)}
    </div>
    <div class="learn-hero__status">
      ${
        loggedIn
          ? `<div class="progress-ring" aria-label="${completed} of ${totalLessons} lessons complete">
              <svg viewBox="0 0 120 120" width="120" height="120">
                <circle cx="60" cy="60" r="48" class="progress-ring__track"></circle>
                <circle cx="60" cy="60" r="48" class="progress-ring__value" style="stroke-dasharray:${(percent / 100) * 301.59289474462014} 301.59289474462014;"></circle>
              </svg>
              <div class="progress-ring__content"><strong>${completed}/${totalLessons}</strong><span>${percent}%</span></div>
            </div>
            <div class="learn-badges">
              <div class="learn-badges__label">Recent badges</div>
              <div class="learn-badges__row">${renderBadges()}</div>
            </div>`
          : `<div class="learn-hero__signin">
              <div class="learn-hero__signin-copy">Sign in to save progress</div>
              <button id="learnHeroSignin" class="learn-hero__signin-button" type="button">Sign in</button>
            </div>`
      }
    </div>
  `;

  heroShell.querySelector<HTMLButtonElement>("#learnHeroSignin")?.addEventListener("click", () => {
    document.getElementById("auth-signin-btn")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function renderStats(progress: UserProgress): void {
  const statsStrip = document.getElementById("learnStatsStrip");
  if (!statsStrip) {
    return;
  }
  const score = loadScore();
  const totalLessons = getLessons().length;
  statsStrip.innerHTML = `
    <div class="stat-card"><span class="stat-card__label">Lessons</span><strong class="stat-card__value">${lessonsCompleted(progress)}/${totalLessons}</strong></div>
    <div class="stat-card"><span class="stat-card__label">Challenges</span><strong class="stat-card__value">${challengeSolvedText()}</strong></div>
    <div class="stat-card"><span class="stat-card__label">XP</span><strong class="stat-card__value">${formatPoints(score.totalPoints)}</strong></div>
    <div class="stat-card"><span class="stat-card__label">Streak</span><strong class="stat-card__value">${score.streak} day${score.streak === 1 ? "" : "s"}</strong></div>
  `;
}

function renderTree(progress: UserProgress): void {
  const treeRoot = document.getElementById("learnCurriculumTree");
  if (!treeRoot) {
    return;
  }
  renderCurriculumTree(treeRoot, getLessons(), progress);
}

function renderLeaderboard(
  entriesByPeriod: Record<"alltime" | "weekly", LeaderboardEntry[]>,
  activePeriod: "alltime" | "weekly",
  currentDisplayName?: string
): void {
  const root = document.getElementById("leaderboardSidebar");
  if (!root) {
    return;
  }

  const expanded = root.dataset.expanded === "true";
  const entries = entriesByPeriod[activePeriod];
  const visibleEntries = expanded ? entries.slice(0, 50) : entries.slice(0, 10);
  const currentUserEntry =
    currentDisplayName && !visibleEntries.some((entry) => entry.displayName === currentDisplayName)
      ? entries.find((entry) => entry.displayName === currentDisplayName)
      : null;

  const displayPoints = (entry: LeaderboardEntry) =>
    formatPoints(activePeriod === "weekly" ? entry.weeklyPoints ?? 0 : entry.totalPoints);
  const medalClass = (rank: number) =>
    rank === 1 ? " leaderboard-row__rank--gold" : rank === 2 ? " leaderboard-row__rank--silver" : rank === 3 ? " leaderboard-row__rank--bronze" : "";

  root.innerHTML = `
    <div class="leaderboard-sidebar__header">
      <div>
        <div class="leaderboard-sidebar__title">Leaderboard</div>
        <div class="leaderboard-sidebar__meta">Updated live</div>
      </div>
      <button id="leaderboardExpand" class="leaderboard-sidebar__toggle" type="button">${expanded ? "Collapse" : "View all"}</button>
    </div>
    <div class="leaderboard-sidebar__tabs">
      <button class="leaderboard-sidebar__tab${activePeriod === "alltime" ? " is-active" : ""}" type="button" data-leaderboard-period="alltime">All Time</button>
      <button class="leaderboard-sidebar__tab${activePeriod === "weekly" ? " is-active" : ""}" type="button" data-leaderboard-period="weekly">This Week</button>
    </div>
    <div class="leaderboard-sidebar__list">
      ${visibleEntries
        .map(
          (entry) => `
            <div class="leaderboard-row${currentDisplayName === entry.displayName ? " is-current" : ""}">
              <span class="leaderboard-row__rank${medalClass(entry.rank)}">#${entry.rank}</span>
              <span class="leaderboard-row__name">${escapeHtml(entry.displayName)}</span>
              <span class="leaderboard-row__xp">${displayPoints(entry)} XP</span>
            </div>
          `
        )
        .join("")}
      ${
        currentUserEntry
          ? `<div class="leaderboard-sidebar__current-label">You</div>
             <div class="leaderboard-row is-current">
               <span class="leaderboard-row__rank">#${currentUserEntry.rank}</span>
               <span class="leaderboard-row__name">${escapeHtml(currentUserEntry.displayName)}</span>
               <span class="leaderboard-row__xp">${displayPoints(currentUserEntry)} XP</span>
             </div>`
          : ""
      }
    </div>
  `;

  root.querySelector<HTMLButtonElement>("#leaderboardExpand")?.addEventListener("click", () => {
    root.dataset.expanded = String(!expanded);
    renderLeaderboard(entriesByPeriod, activePeriod, currentDisplayName);
  });

  root.querySelectorAll<HTMLButtonElement>("[data-leaderboard-period]").forEach((button) => {
    button.addEventListener("click", () => {
      const period = (button.dataset.leaderboardPeriod as "alltime" | "weekly") ?? "alltime";
      renderLeaderboard(entriesByPeriod, period, currentDisplayName);
    });
  });
}

async function fetchLeaderboard(period: "alltime" | "weekly"): Promise<LeaderboardEntry[]> {
  try {
    const response = await fetch(`${API_ENDPOINT}/leaderboard?period=${period}`, { method: "GET" });
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as unknown;
    return Array.isArray(payload) ? (payload as LeaderboardEntry[]) : [];
  } catch {
    return [];
  }
}

function renderChallengeSnapshot(): void {
  const summary = document.getElementById("learnChallengeSummary");
  if (!summary) {
    return;
  }

  const attempted = loadChallengeSubmissions().length;
  const passed = challengesPassed();
  const latest = getChallenges()
    .map((challenge) => ({ challenge, best: getBestSubmission(challenge.id) }))
    .filter((entry) => entry.best)
    .sort((left, right) => (right.best?.submittedAt ?? "").localeCompare(left.best?.submittedAt ?? ""))
    .slice(0, 4);

  summary.innerHTML = `
    <div class="learn-panel__header-row">
      <h2 class="learn-panel__title">Challenge snapshot</h2>
      <a class="learn-panel__link" href="/challenges/">Open challenges →</a>
    </div>
    <div class="learn-panel__meta">${passed} solved · ${attempted} submissions</div>
    <div class="learn-challenge-summary__list">
      ${
        latest.length === 0
          ? '<div class="learn-challenge-summary__empty">No challenge attempts yet.</div>'
          : latest
              .map(
                ({ challenge, best }) => `
                  <a class="learn-challenge-summary__item" href="/simulator/?challenge=${encodeURIComponent(challenge.id)}">
                    <span class="learn-challenge-summary__name">${escapeHtml(challenge.title)}</span>
                    <span class="learn-challenge-summary__score">${best?.score ?? 0}/${best?.maxScore ?? challenge.points}</span>
                  </a>
                `
              )
              .join("")
      }
    </div>
  `;
}

function renderPage(progress: UserProgress, loggedIn: boolean): void {
  renderHero(progress, loggedIn);
  renderStats(progress);
  renderTree(progress);
  renderChallengeSnapshot();
}

document.addEventListener("DOMContentLoaded", () => {
  initNav({ activePage: "learn" });
  initFooter();

  void (async () => {
    let progress = loadProgress();
    let session = await getSession();
    renderPage(progress, Boolean(session));

    if (session) {
      const apiProgress = await loadProgressFromApi(session.idToken);
      if (apiProgress) {
        progress = mergeProgress(progress, apiProgress);
        saveProgress(progress);
        renderPage(progress, true);
      }
    }

    const renderLeaderboardNow = async () => {
      const latestSession = await getSession();
      const [alltime, weekly] = await Promise.all([fetchLeaderboard("alltime"), fetchLeaderboard("weekly")]);
      renderLeaderboard({ alltime, weekly }, "alltime", latestSession?.displayName);
    };

    await renderLeaderboardNow();
    window.setInterval(() => {
      void renderLeaderboardNow();
    }, 60_000);
  })();
});

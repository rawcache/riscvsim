import { getSession, type UserSession } from "./auth";
import {
  loadCheckpointProgressForUser,
  loadCheckpointProgressFromApi,
  mergeCheckpointProgress,
  saveCheckpointProgressForUser,
} from "./checkpoint-progress";
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

function chipLabel(points: number): string {
  return `${formatPoints(points)} chips`;
}

function emptyProgress(): UserProgress {
  return {
    lessons: {},
    totalCompleted: 0,
    lastActiveLesson: undefined,
  };
}

function resumeDismissKey(lessonId: string, stepId: string): string {
  return `studyriscv_resume_dismissed:${lessonId}:${stepId}`;
}

function isResumeDismissed(lessonId: string, stepId: string): boolean {
  if (typeof localStorage === "undefined") {
    return false;
  }
  return localStorage.getItem(resumeDismissKey(lessonId, stepId)) === "1";
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

function resumeMarkup(progress: UserProgress, loggedIn: boolean): string {
  if (!loggedIn) {
    return "";
  }
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
  const safeStepIndex = Math.min(lessonProgress.currentStepIndex, lesson.steps.length - 1);
  const stepIndex = safeStepIndex + 1;
  const stepId = lesson.steps[safeStepIndex]?.id ?? "";
  if (!stepId || isResumeDismissed(lesson.id, stepId)) {
    return "";
  }
  return `
    <div class="learn-resume" data-resume-lesson-id="${escapeHtml(lesson.id)}" data-resume-step-id="${escapeHtml(stepId)}">
      <a class="learn-resume__main" href="/simulator/?lesson=${encodeURIComponent(lesson.id)}&step=${encodeURIComponent(stepId)}">
        <span class="learn-resume__label">Continue</span>
        <span class="learn-resume__text">${escapeHtml(lesson.title)} · Step ${stepIndex} of ${lesson.steps.length}</span>
        <span class="learn-resume__cta">Resume →</span>
      </a>
      <button class="learn-resume__dismiss" type="button" aria-label="Dismiss continue card">×</button>
    </div>
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
  const lessons = getLessons();
  const totalLessons = lessons.length;
  const firstLesson = lessons[0];
  const firstStepId = firstLesson?.steps[0]?.id ?? "";
  const startHref =
    firstLesson && firstStepId
      ? `/simulator/?lesson=${encodeURIComponent(firstLesson.id)}&step=${encodeURIComponent(firstStepId)}`
      : "/simulator/";

  heroShell.innerHTML = `
    <div class="learn-hero__copy">
      <div>
        <h1 class="learn-hero__title">Learn RISC-V Assembly</h1>
        <p class="learn-hero__subhead">${totalLessons} lessons · 15 challenges · ECE 2035 aligned</p>
      </div>
      <div class="learn-hero__ctas">
        <a class="learn-hero__cta-primary" href="${startHref}">Start learning</a>
        <a class="learn-hero__cta-secondary" href="/quiz/?take=diagnostic">Find your level →</a>
      </div>
      <div class="learn-xp-pill">${chipLabel(score.totalPoints)}</div>
      ${resumeMarkup(progress, loggedIn)}
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

  heroShell.querySelector<HTMLButtonElement>(".learn-resume__dismiss")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const card = (event.currentTarget as HTMLElement | null)?.closest<HTMLElement>(".learn-resume");
    const lessonId = card?.dataset.resumeLessonId ?? "";
    const stepId = card?.dataset.resumeStepId ?? "";
    if (typeof localStorage !== "undefined" && lessonId && stepId) {
      localStorage.setItem(resumeDismissKey(lessonId, stepId), "1");
    }
    card?.remove();
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
    <div class="stat-card"><span class="stat-card__label">Chips</span><strong class="stat-card__value">${formatPoints(score.totalPoints)}</strong></div>
    <div class="stat-card"><span class="stat-card__label">Streak</span><strong class="stat-card__value">${score.streak} day${score.streak === 1 ? "" : "s"}</strong></div>
  `;
}

function renderTree(progress: UserProgress, checkpointProgress: ReturnType<typeof loadCheckpointProgressForUser>, session: UserSession | null): void {
  const treeRoot = document.getElementById("learnCurriculumTree");
  if (!treeRoot) {
    return;
  }
  renderCurriculumTree(treeRoot, getLessons(), progress, checkpointProgress, session);
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
              <span class="leaderboard-row__xp">${displayPoints(entry)} chips</span>
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
               <span class="leaderboard-row__xp">${displayPoints(currentUserEntry)} chips</span>
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

async function fetchStudyGroups(idToken: string): Promise<Array<{ id: string; name: string; members: Array<{ displayName: string }>; maxMembers: number }>> {
  try {
    const response = await fetch(`${API_ENDPOINT}/groups/mine`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as unknown;
    return Array.isArray(payload) ? (payload as Array<{ id: string; name: string; members: Array<{ displayName: string }>; maxMembers: number }>) : [];
  } catch {
    return [];
  }
}

function renderStudyGroups(session: Awaited<ReturnType<typeof getSession>> | null, groups: Array<{ id: string; name: string; members: Array<{ displayName: string }>; maxMembers: number }>): void {
  const root = document.getElementById("learnStudyGroups");
  if (!root) {
    return;
  }

  if (!session) {
    root.innerHTML = `
      <div class="learn-panel__header-row">
        <h2 class="learn-panel__title">Study groups</h2>
        <div class="learn-panel__meta">Sign in required</div>
      </div>
      <div class="learn-challenge-summary__empty">Create or join a group to compare progress with classmates.</div>
      <a class="learn-panel__link" href="/groups/">Open groups →</a>
    `;
    return;
  }

  root.innerHTML = `
    <div class="learn-panel__header-row">
      <h2 class="learn-panel__title">Study groups</h2>
      <a class="learn-panel__link" href="/groups/">Open groups →</a>
    </div>
    <div class="learn-panel__meta">${groups.length} group${groups.length === 1 ? "" : "s"} joined</div>
    ${
      groups.length
        ? `
          <div class="learn-study-groups__list">
            ${groups
              .slice(0, 3)
              .map(
                (group) => `
                  <a class="learn-study-groups__item" href="/groups/?code=${encodeURIComponent(group.id)}">
                    <span class="learn-study-groups__name">${escapeHtml(group.name)}</span>
                    <span class="learn-study-groups__meta">${group.members.length}/${group.maxMembers} members</span>
                  </a>
                `
              )
              .join("")}
          </div>
        `
        : '<div class="learn-challenge-summary__empty">No study groups yet. Create one for your section or project team.</div>'
    }
  `;
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

function renderPage(
  progress: UserProgress,
  checkpointProgress: ReturnType<typeof loadCheckpointProgressForUser>,
  session: UserSession | null
): void {
  const loggedIn = Boolean(session);
  renderHero(progress, loggedIn);
  renderStats(progress);
  renderTree(progress, checkpointProgress, session);
  renderChallengeSnapshot();
}

document.addEventListener("DOMContentLoaded", () => {
  initNav({ activePage: "learn" });
  initFooter();

  void (async () => {
    let session = await getSession();
    let progress = session ? emptyProgress() : loadProgress();
    let checkpointProgress = session ? loadCheckpointProgressForUser(session.userId) : loadCheckpointProgressForUser(null);
    renderPage(progress, checkpointProgress, session);

    if (session) {
      const localProgress = loadProgress();
      const apiProgress = await loadProgressFromApi(session.idToken);
      progress = apiProgress ? mergeProgress(localProgress, apiProgress) : localProgress;
      saveProgress(progress);
      const localCheckpointProgress = loadCheckpointProgressForUser(session.userId);
      const guestCheckpointProgress = loadCheckpointProgressForUser(null);
      const apiCheckpointProgress = await loadCheckpointProgressFromApi(session.idToken);
      checkpointProgress = mergeCheckpointProgress(
        mergeCheckpointProgress(guestCheckpointProgress, localCheckpointProgress),
        apiCheckpointProgress ?? {}
      );
      saveCheckpointProgressForUser(checkpointProgress, session.userId);
      renderPage(progress, checkpointProgress, session);
    }

    const renderLeaderboardNow = async () => {
      const latestSession = await getSession();
      const [alltime, weekly] = await Promise.all([fetchLeaderboard("alltime"), fetchLeaderboard("weekly")]);
      renderLeaderboard({ alltime, weekly }, "alltime", latestSession?.displayName);
    };

    await renderLeaderboardNow();
    renderStudyGroups(session, session?.idToken ? await fetchStudyGroups(session.idToken) : []);
    window.setInterval(() => {
      void renderLeaderboardNow();
    }, 60_000);

    window.addEventListener("studyriscv-auth-changed", async (event) => {
      const nextSession = (event as CustomEvent<Awaited<ReturnType<typeof getSession>> | null>).detail ?? null;
      let nextProgress = nextSession ? emptyProgress() : loadProgress();
      let nextCheckpointProgress = nextSession
        ? loadCheckpointProgressForUser(nextSession.userId)
        : loadCheckpointProgressForUser(null);
      if (nextSession?.idToken) {
        const localProgress = loadProgress();
        const apiProgress = await loadProgressFromApi(nextSession.idToken);
        nextProgress = apiProgress ? mergeProgress(localProgress, apiProgress) : localProgress;
        saveProgress(nextProgress);
        const localCheckpointProgress = loadCheckpointProgressForUser(nextSession.userId);
        const guestCheckpointProgress = loadCheckpointProgressForUser(null);
        const apiCheckpointProgress = await loadCheckpointProgressFromApi(nextSession.idToken);
        nextCheckpointProgress = mergeCheckpointProgress(
          mergeCheckpointProgress(guestCheckpointProgress, localCheckpointProgress),
          apiCheckpointProgress ?? {}
        );
        saveCheckpointProgressForUser(nextCheckpointProgress, nextSession.userId);
      }
      renderPage(nextProgress, nextCheckpointProgress, nextSession);
      renderStudyGroups(nextSession, nextSession?.idToken ? await fetchStudyGroups(nextSession.idToken) : []);
    });
  })();
});

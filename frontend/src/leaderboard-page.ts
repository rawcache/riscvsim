import { getSession } from "./auth";
import { getChallengeStatus, getChallenges } from "./challenges";
import { initFooter } from "./footer";
import { getLessons, loadProgress } from "./lessons";
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

type LeaderboardAnnouncement = {
  type: "graduate";
  displayName: string;
  createdAt: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fetchLeaderboard(period: "alltime" | "weekly"): Promise<LeaderboardEntry[]> {
  try {
    const response = await fetch(`${API_ENDPOINT}/leaderboard?period=${period}`);
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as unknown;
    return Array.isArray(payload) ? (payload as LeaderboardEntry[]) : [];
  } catch {
    return [];
  }
}

async function fetchAnnouncements(): Promise<LeaderboardAnnouncement[]> {
  try {
    const response = await fetch(`${API_ENDPOINT}/leaderboard/announcements`);
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as unknown;
    return Array.isArray(payload) ? (payload as LeaderboardAnnouncement[]) : [];
  } catch {
    return [];
  }
}

function medal(rank: number): string {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return `#${rank}`;
}

function pointsForPeriod(entry: LeaderboardEntry, period: "alltime" | "weekly"): number {
  return period === "weekly" ? entry.weeklyPoints ?? 0 : entry.totalPoints;
}

function nextUnlockText(): string {
  const progress = loadProgress();
  const nextLesson = getLessons().find((lesson) => !progress.lessons[lesson.id]?.completed);
  if (nextLesson) {
    return nextLesson.title;
  }

  const nextChallenge = getChallenges().find((challenge) => getChallengeStatus(challenge.id) !== "passed");
  return nextChallenge?.title ?? "Review the docs";
}

function weeklyDigestMarkup(currentUser: LeaderboardEntry | null, totalUsers: number): string {
  if (!currentUser) {
    return "";
  }

  const score = loadScore();
  const best = score.recentActivity?.[0]?.title ?? "No completions recorded this week yet";
  return `
    <section class="learn-panel leaderboard-digest">
      <div class="learn-panel__header-row">
        <h2 class="learn-panel__title">Your week in review</h2>
        <div class="learn-panel__meta">Weekly summary</div>
      </div>
      <div class="leaderboard-digest__grid">
        <div class="leaderboard-digest__metric"><span>Chips earned this week</span><strong>${(score.weeklyPoints ?? 0).toLocaleString("en-US")}</strong></div>
        <div class="leaderboard-digest__metric"><span>Lessons completed</span><strong>${score.lessonsCompleted}</strong></div>
        <div class="leaderboard-digest__metric"><span>Challenges passed</span><strong>${score.challengesPassed}</strong></div>
        <div class="leaderboard-digest__metric"><span>Current rank</span><strong>#${currentUser.rank} of ${totalUsers}</strong></div>
        <div class="leaderboard-digest__metric"><span>Streak</span><strong>${score.streak} days 🔥</strong></div>
      </div>
      <div class="leaderboard-digest__rows">
        <div><span class="leaderboard-digest__label">Your best this week</span><strong>${escapeHtml(best)}</strong></div>
        <div><span class="leaderboard-digest__label">Next up</span><strong>${escapeHtml(nextUnlockText())}</strong></div>
      </div>
      <a class="learn-panel__link leaderboard-digest__cta" href="/learn/">Continue learning →</a>
    </section>
  `;
}

function render(
  entriesByPeriod: Record<"alltime" | "weekly", LeaderboardEntry[]>,
  activePeriod: "alltime" | "weekly",
  announcements: LeaderboardAnnouncement[],
  currentDisplayName?: string
): void {
  const root = document.getElementById("leaderboardApp");
  if (!root) {
    return;
  }

  const searchInput = (document.getElementById("leaderboardSearch") as HTMLInputElement | null)?.value.trim().toLowerCase() ?? "";
  const currentEntries = entriesByPeriod[activePeriod];
  const filtered = searchInput
    ? currentEntries.filter((entry) => entry.displayName.toLowerCase().includes(searchInput))
    : currentEntries;
  const currentUser = currentDisplayName ? currentEntries.find((entry) => entry.displayName === currentDisplayName) : null;
  const weeklyUser = currentDisplayName ? entriesByPeriod.weekly.find((entry) => entry.displayName === currentDisplayName) ?? null : null;
  const graduateAnnouncement = announcements.find((announcement) => announcement.type === "graduate") ?? null;

  root.innerHTML = `
    <section class="learn-hero">
      <div class="learn-hero__copy">
        <div>
          <h1 class="learn-hero__title">Leaderboard</h1>
          <p class="learn-hero__subhead">Track all-time and weekly chips across the StudyRISC-V platform.</p>
        </div>
        <div class="learn-xp-pill">${loadScore().totalPoints.toLocaleString("en-US")} chips</div>
      </div>
      <div class="learn-hero__status">
        ${
          currentUser
            ? `<div class="learn-hero__signin">
                <div class="learn-hero__signin-copy">Your rank · #${currentUser.rank}</div>
                <div class="learn-hero__signin-copy">${pointsForPeriod(currentUser, activePeriod).toLocaleString("en-US")} chips in this view</div>
              </div>`
            : `<div class="learn-hero__signin"><div class="learn-hero__signin-copy">Public rankings update every minute.</div></div>`
        }
      </div>
    </section>
    ${
      graduateAnnouncement
        ? `<section class="learn-panel leaderboard-announcement">
            <div class="leaderboard-announcement__icon">🎓</div>
            <div class="leaderboard-announcement__copy">
              <strong>${escapeHtml(graduateAnnouncement.displayName)} just completed all 20 lessons.</strong>
              <span>Visible for 24 hours.</span>
            </div>
          </section>`
        : ""
    }
    ${weeklyDigestMarkup(weeklyUser, entriesByPeriod.weekly.length)}
    <section class="leaderboard-page__controls">
      <div class="leaderboard-tabs">
        <button type="button" class="leaderboard-tab${activePeriod === "alltime" ? " is-active" : ""}" data-leaderboard-period="alltime">All Time</button>
        <button type="button" class="leaderboard-tab${activePeriod === "weekly" ? " is-active" : ""}" data-leaderboard-period="weekly">This Week</button>
      </div>
      <input id="leaderboardSearch" class="leaderboard-search" type="search" value="${escapeHtml(searchInput)}" placeholder="Search player" />
    </section>
    <section class="learn-panel leaderboard-page__panel">
      <div class="learn-panel__header-row">
        <h2 class="learn-panel__title">${activePeriod === "alltime" ? "Top 100 · All Time" : "Top 100 · This Week"}</h2>
        <div class="learn-panel__meta">Chips, lessons, challenges, badges, and streaks</div>
      </div>
      <div class="leaderboard-page__list">
        ${filtered
          .slice(0, 100)
          .map((entry) => {
            const isCurrent = currentDisplayName === entry.displayName;
            return `
              <div class="leaderboard-page__row${isCurrent ? " is-current" : ""}">
                <span class="leaderboard-page__rank">${medal(entry.rank)}</span>
                <span class="leaderboard-page__name">${escapeHtml(entry.displayName)}</span>
                <span class="leaderboard-page__meta">${entry.streak && entry.streak >= 3 ? `🔥 ${entry.streak}` : ""}</span>
                <span class="leaderboard-page__meta">${entry.badges?.length ?? 0} badges</span>
                <span class="leaderboard-page__meta">${entry.lessonsCompleted} lessons</span>
                <span class="leaderboard-page__xp">${pointsForPeriod(entry, activePeriod).toLocaleString("en-US")} chips</span>
              </div>
            `;
          })
          .join("")}
      </div>
    </section>
  `;

  root.querySelectorAll<HTMLButtonElement>("[data-leaderboard-period]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = (button.dataset.leaderboardPeriod as "alltime" | "weekly") ?? "alltime";
      render(entriesByPeriod, next, announcements, currentDisplayName);
    });
  });

  root.querySelector<HTMLInputElement>("#leaderboardSearch")?.addEventListener("input", () => {
    render(entriesByPeriod, activePeriod, announcements, currentDisplayName);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initNav({ activePage: "leaderboard" });
  initFooter();

  void (async () => {
    const [alltime, weekly, announcements, session] = await Promise.all([
      fetchLeaderboard("alltime"),
      fetchLeaderboard("weekly"),
      fetchAnnouncements(),
      getSession(),
    ]);
    render({ alltime, weekly }, "alltime", announcements, session?.displayName);
  })();
});

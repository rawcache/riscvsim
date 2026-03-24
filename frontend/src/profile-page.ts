import { getSession } from "./auth";
import { initFooter } from "./footer";
import { loadChallengeSubmissions } from "./challenges";
import { loadProgress } from "./lessons";
import { initNav } from "./nav";
import { getCurrentAvatarChoice } from "./profile-avatar";
import { loadScore, type Badge, type ScoreActivity } from "./scoring";
import { showNotification } from "./notifications";

const DEFAULT_API_ENDPOINT = "https://api.studyriscv.com";
const API_ENDPOINT = (import.meta.env.VITE_API_ENDPOINT as string | undefined)?.trim() || DEFAULT_API_ENDPOINT;

type PublicProfile = {
  displayName: string;
  username: string;
  joinedAt: string;
  lessonsCompleted: number;
  challengesPassed: number;
  totalXP: number;
  currentStreak: number;
  longestStreak: number;
  badges: Badge[];
  pinnedBadges?: Badge[];
  recentActivity: ScoreActivity[];
  isTier: "guest" | "free" | "pro";
  avatarType?: "preset" | "upload";
  avatarValue?: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(dateString: string): string {
  const parsed = Date.parse(dateString);
  if (Number.isNaN(parsed)) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(parsed);
}

function avatarMarkup(profile: PublicProfile): string {
  if (profile.avatarType === "upload" && profile.avatarValue) {
    return `<img class="profile-hero__avatar-image" src="${profile.avatarValue}" alt="" />`;
  }
  if (profile.avatarType === "preset" && profile.avatarValue) {
    return `<span class="profile-hero__avatar-emoji" aria-hidden="true">${profile.avatarValue}</span>`;
  }
  return escapeHtml((profile.displayName || profile.username || "U").charAt(0).toUpperCase());
}

async function fetchProfile(username: string): Promise<PublicProfile | null> {
  try {
    const response = await fetch(`${API_ENDPOINT}/profile/${encodeURIComponent(username)}`);
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as PublicProfile;
  } catch {
    return null;
  }
}

function fallbackProfile(username: string): PublicProfile {
  const score = loadScore();
  const avatar = getCurrentAvatarChoice();
  return {
    displayName: username,
    username,
    joinedAt: new Date().toISOString(),
    lessonsCompleted: Object.values(loadProgress().lessons).filter((lesson) => lesson.completed).length,
    challengesPassed: loadChallengeSubmissions().filter((submission) => submission.passed).length,
    totalXP: score.totalPoints,
    currentStreak: score.streak,
    longestStreak: score.longestStreak ?? score.streak,
    badges: score.badges,
    pinnedBadges: score.badges.filter((badge) => (score.pinnedBadgeIds ?? []).includes(badge.id)),
    recentActivity: score.recentActivity ?? [],
    isTier: "free",
    avatarType: avatar?.type,
    avatarValue: avatar?.value,
  };
}

function renderProfile(root: HTMLElement, profile: PublicProfile): void {
  const pinnedBadges = profile.pinnedBadges?.length ? profile.pinnedBadges : profile.badges.slice(0, 3);
  root.innerHTML = `
    <section class="learn-hero profile-hero">
      <div class="learn-hero__copy">
        <div class="profile-hero__avatar">${avatarMarkup(profile)}</div>
        <div>
          <div class="profile-hero__eyebrow">Public profile</div>
          <h1 class="learn-hero__title">${escapeHtml(profile.displayName)}</h1>
          <p class="learn-hero__subhead">@${escapeHtml(profile.username)} · Joined ${escapeHtml(formatDate(profile.joinedAt))}</p>
        </div>
      </div>
      <div class="learn-hero__status">
        <div class="learn-hero__signin">
          <div class="learn-hero__signin-copy">${profile.isTier === "pro" ? "🐝 Pro" : "Free"} · ${profile.totalXP.toLocaleString("en-US")} XP</div>
          <button id="profileCopyLink" class="learn-hero__signin-button" type="button">Copy profile link</button>
        </div>
      </div>
    </section>
    <section class="stats-strip profile-stats-strip">
      <div class="stat-card"><span class="stat-card__label">XP</span><strong class="stat-card__value">${profile.totalXP.toLocaleString("en-US")}</strong></div>
      <div class="stat-card"><span class="stat-card__label">Lessons</span><strong class="stat-card__value">${profile.lessonsCompleted}</strong></div>
      <div class="stat-card"><span class="stat-card__label">Challenges</span><strong class="stat-card__value">${profile.challengesPassed}</strong></div>
      <div class="stat-card"><span class="stat-card__label">Streak</span><strong class="stat-card__value">${profile.currentStreak} 🔥</strong></div>
    </section>
    <section class="profile-grid">
      <section class="learn-panel">
        <div class="learn-panel__header-row">
          <h2 class="learn-panel__title">Pinned badges</h2>
          <div class="learn-panel__meta">Up to 3 featured achievements</div>
        </div>
        <div class="profile-badges profile-badges--featured">
          ${
            pinnedBadges.length
              ? pinnedBadges
                  .map(
                    (badge) => `
                      <div class="profile-badge-card profile-badge-card--featured">
                        <div class="profile-badge-card__icon">${badge.icon}</div>
                        <div class="profile-badge-card__name">${escapeHtml(badge.name)}</div>
                      </div>
                    `
                  )
                  .join("")
              : '<div class="learn-badges__empty">No pinned badges yet.</div>'
          }
        </div>
      </section>
      <section class="learn-panel">
        <div class="learn-panel__header-row">
          <h2 class="learn-panel__title">Recent activity</h2>
          <div class="learn-panel__meta">Latest completions</div>
        </div>
        <div class="profile-activity-list">
          ${
            profile.recentActivity.length
              ? profile.recentActivity
                  .slice(0, 10)
                  .map(
                    (activity) => `
                      <div class="profile-activity-item">
                        <div class="profile-activity-item__type">${escapeHtml(activity.type)}</div>
                        <div class="profile-activity-item__body">
                          <div class="profile-activity-item__title">${escapeHtml(activity.title)}</div>
                          <div class="profile-activity-item__meta">${escapeHtml(formatDate(activity.completedAt))}${
                            typeof activity.score === "number" ? ` · ${activity.score}` : ""
                          }</div>
                        </div>
                      </div>
                    `
                  )
                  .join("")
              : '<div class="learn-badges__empty">No public activity yet.</div>'
          }
        </div>
      </section>
      <section class="learn-panel profile-grid__wide">
        <div class="learn-panel__header-row">
          <h2 class="learn-panel__title">All badges</h2>
          <div class="learn-panel__meta">${profile.badges.length} earned</div>
        </div>
        <div class="profile-badges">
          ${
            profile.badges.length
              ? profile.badges
                  .map(
                    (badge) => `
                      <div class="profile-badge-card">
                        <div class="profile-badge-card__icon">${badge.icon}</div>
                        <div class="profile-badge-card__name">${escapeHtml(badge.name)}</div>
                        <div class="profile-badge-card__meta">${escapeHtml(badge.description)}</div>
                      </div>
                    `
                  )
                  .join("")
              : '<div class="learn-badges__empty">No badges earned yet.</div>'
          }
        </div>
      </section>
    </section>
  `;

  root.querySelector<HTMLButtonElement>("#profileCopyLink")?.addEventListener("click", async () => {
    const link = `https://studyriscv.com/profile/?u=${encodeURIComponent(profile.username)}`;
    try {
      await navigator.clipboard.writeText(link);
      showNotification({
        id: `profile-link-${Date.now()}`,
        type: "badge",
        title: "Profile link copied",
        message: link,
        icon: "🔗",
        duration: 3000,
        accentColor: "var(--accent)",
      });
    } catch {
      window.prompt("Copy profile link", link);
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initNav({ activePage: "profile" });
  initFooter();

  void (async () => {
    const root = document.getElementById("profileApp");
    if (!root) {
      return;
    }

    const session = await getSession();
    const params = new URLSearchParams(window.location.search);
    const username = (params.get("u") || session?.email.split("@")[0] || "").trim().toLowerCase();

    if (!username) {
      root.innerHTML = `
        <section class="learn-hero">
          <div class="learn-hero__copy">
            <div>
              <h1 class="learn-hero__title">Profile unavailable</h1>
              <p class="learn-hero__subhead">Sign in to view your public StudyRISC-V profile.</p>
            </div>
          </div>
        </section>
      `;
      return;
    }

    const profile = (await fetchProfile(username)) ?? fallbackProfile(username);
    renderProfile(root, profile);
  })();
});

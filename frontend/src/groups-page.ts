import { getSession } from "./auth";
import { initFooter } from "./footer";
import { initNav } from "./nav";
import { showNotification } from "./notifications";

const DEFAULT_API_ENDPOINT = "https://api.studyriscv.com";
const API_ENDPOINT = (import.meta.env.VITE_API_ENDPOINT as string | undefined)?.trim() || DEFAULT_API_ENDPOINT;

type GroupMember = {
  userId: string;
  displayName: string;
  lessonsCompleted: number;
  challengesPassed: number;
  totalXP: number;
  streak: number;
  lastActive: string;
};

type StudyGroup = {
  id: string;
  name: string;
  createdBy: string;
  members: GroupMember[];
  createdAt: string;
  maxMembers: number;
};

const GROUP_SNAPSHOT_KEY = "studyriscv_group_snapshots";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function relativeLastActive(dateString: string): string {
  const parsed = Date.parse(dateString);
  if (Number.isNaN(parsed)) {
    return "Active recently";
  }
  const diffHours = Math.max(0, Math.floor((Date.now() - parsed) / 3_600_000));
  if (diffHours < 24) {
    return diffHours === 0 ? "Active today" : `Last active ${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `Last active ${diffDays}d ago`;
}

async function authedFetch<T>(sessionToken: string, path: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(`${API_ENDPOINT}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function aheadText(group: StudyGroup, currentUserId: string): string {
  const self = group.members.find((member) => member.userId === currentUserId);
  const comparison = group.members
    .filter((member) => member.userId !== currentUserId)
    .sort((left, right) => left.lessonsCompleted - right.lessonsCompleted)[0];

  if (!self || !comparison) {
    return "Invite classmates to compare progress here.";
  }

  const delta = self.lessonsCompleted - comparison.lessonsCompleted;
  if (delta > 0) {
    return `You're ${delta} lesson${delta === 1 ? "" : "s"} ahead of ${comparison.displayName}.`;
  }
  if (delta < 0) {
    return `${comparison.displayName} is ${Math.abs(delta)} lesson${Math.abs(delta) === 1 ? "" : "s"} ahead of you.`;
  }
  return `You're tied with ${comparison.displayName}.`;
}

function groupCard(group: StudyGroup, active = false): string {
  const sortedMembers = [...group.members].sort((left, right) => right.totalXP - left.totalXP);
  return `
    <article class="group-card${active ? " is-active" : ""}">
      <div class="group-card__header">
        <div>
          <div class="group-card__title">${escapeHtml(group.name)}</div>
          <div class="group-card__meta">${group.members.length}/${group.maxMembers} members · code ${escapeHtml(group.id)}</div>
        </div>
        <a class="learn-panel__link" href="/groups/?code=${encodeURIComponent(group.id)}">Open →</a>
      </div>
      <div class="group-card__members">
        ${sortedMembers
          .slice(0, 4)
          .map(
            (member) => `
              <div class="group-member-card">
                <div class="group-member-card__avatar">${escapeHtml(member.displayName.charAt(0).toUpperCase())}</div>
                <div class="group-member-card__body">
                  <div class="group-member-card__name">${escapeHtml(member.displayName)}</div>
                  <div class="group-member-card__meta">${member.totalXP.toLocaleString("en-US")} chips · ${member.lessonsCompleted}/20 lessons · 🔥 ${member.streak}</div>
                </div>
              </div>
            `
          )
          .join("")}
      </div>
    </article>
  `;
}

function collectGroupNotifications(groups: StudyGroup[], currentUserId: string): string[] {
  if (typeof localStorage === "undefined") {
    return [];
  }

  const raw = localStorage.getItem(GROUP_SNAPSHOT_KEY);
  const previous = raw ? (JSON.parse(raw) as Record<string, Record<string, { lessonsCompleted: number; challengesPassed: number; totalXP: number }>>) : {};
  const notifications: string[] = [];
  const nextSnapshot: Record<string, Record<string, { lessonsCompleted: number; challengesPassed: number; totalXP: number }>> = {};

  for (const group of groups) {
    nextSnapshot[group.id] = {};
    for (const member of group.members) {
      nextSnapshot[group.id][member.userId] = {
        lessonsCompleted: member.lessonsCompleted,
        challengesPassed: member.challengesPassed,
        totalXP: member.totalXP,
      };
      if (member.userId === currentUserId) {
        continue;
      }
      const prev = previous[group.id]?.[member.userId];
      if (!prev) {
        continue;
      }
      if (member.lessonsCompleted > prev.lessonsCompleted) {
        notifications.push(`${member.displayName} completed Lesson ${member.lessonsCompleted} while you were away.`);
      } else if (member.challengesPassed > prev.challengesPassed) {
        notifications.push(`${member.displayName} cleared another challenge while you were away.`);
      }
    }
  }

  localStorage.setItem(GROUP_SNAPSHOT_KEY, JSON.stringify(nextSnapshot));
  return notifications.slice(0, 2);
}

function renderGroups(root: HTMLElement, groups: StudyGroup[], currentUserId: string): void {
  const params = new URLSearchParams(window.location.search);
  const activeCode = (params.get("code") || groups[0]?.id || "").toUpperCase();
  const activeGroup = groups.find((group) => group.id === activeCode) ?? groups[0] ?? null;
  const notifications = collectGroupNotifications(groups, currentUserId);

  root.innerHTML = `
    <section class="learn-hero">
      <div class="learn-hero__copy">
        <div>
          <h1 class="learn-hero__title">Study Groups</h1>
          <p class="learn-hero__subhead">Shared progress, lightweight accountability, and GT-friendly group codes.</p>
        </div>
      </div>
      <div class="learn-hero__status">
        <div class="learn-hero__signin">
          <div class="learn-hero__signin-copy">${groups.length} group${groups.length === 1 ? "" : "s"} joined</div>
          <div class="learn-hero__signin-copy">${activeGroup ? aheadText(activeGroup, currentUserId) : "Create a group to get started."}</div>
        </div>
      </div>
    </section>
    ${
      notifications.length
        ? `<section class="learn-panel">
            ${notifications.map((message) => `<div class="group-notification-banner">${escapeHtml(message)}</div>`).join("")}
          </section>`
        : ""
    }
    <section class="groups-actions">
      <form id="groupCreateForm" class="learn-panel groups-action-card">
        <div class="learn-panel__header-row">
          <h2 class="learn-panel__title">Create group</h2>
          <div class="learn-panel__meta">Up to 10 members</div>
        </div>
        <div class="groups-form-row">
          <input id="groupCreateName" class="leaderboard-search" type="text" maxlength="32" placeholder="CS 61C Study Group" />
          <button class="learn-hero__signin-button" type="submit">Create</button>
        </div>
      </form>
      <form id="groupJoinForm" class="learn-panel groups-action-card">
        <div class="learn-panel__header-row">
          <h2 class="learn-panel__title">Join group</h2>
          <div class="learn-panel__meta">Enter a 6-character code</div>
        </div>
        <div class="groups-form-row">
          <input id="groupJoinCode" class="leaderboard-search groups-code-input" type="text" maxlength="6" placeholder="ABC123" autocomplete="off" />
          <button class="learn-hero__signin-button" type="submit">Join</button>
        </div>
      </form>
    </section>
    <section class="profile-grid">
      <section class="learn-panel">
        <div class="learn-panel__header-row">
          <h2 class="learn-panel__title">Your groups</h2>
          <div class="learn-panel__meta">${groups.length} joined</div>
        </div>
        <div class="groups-list">
          ${groups.length ? groups.map((group) => groupCard(group, group.id === activeGroup?.id)).join("") : '<div class="learn-badges__empty">No study groups yet.</div>'}
        </div>
      </section>
      <section class="learn-panel">
        <div class="learn-panel__header-row">
          <h2 class="learn-panel__title">${activeGroup ? escapeHtml(activeGroup.name) : "Group detail"}</h2>
          <div class="learn-panel__meta">${activeGroup ? `Code ${escapeHtml(activeGroup.id)}` : "Select a group"}</div>
        </div>
        ${
          activeGroup
            ? `
              <div class="group-detail__toolbar">
                <button id="copyGroupCode" class="challenge-secondary-button" type="button">Copy code</button>
                <button id="leaveGroupBtn" class="challenge-secondary-button" type="button">Leave group</button>
              </div>
              <div class="group-detail__lead">${escapeHtml(aheadText(activeGroup, currentUserId))}</div>
              <div class="group-detail__table">
                ${[...activeGroup.members]
                  .sort((left, right) => right.totalXP - left.totalXP)
                  .map(
                    (member, index) => `
                      <div class="leaderboard-page__row">
                        <span class="leaderboard-page__rank">#${index + 1}</span>
                        <span class="leaderboard-page__name">${escapeHtml(member.displayName)}</span>
                        <span class="leaderboard-page__meta">${member.lessonsCompleted}/20 lessons</span>
                        <span class="leaderboard-page__meta">${relativeLastActive(member.lastActive)}</span>
                        <span class="leaderboard-page__xp">${member.totalXP.toLocaleString("en-US")} chips</span>
                      </div>
                    `
                  )
                  .join("")}
              </div>
            `
            : '<div class="learn-badges__empty">Create or join a group to see member progress.</div>'
        }
      </section>
    </section>
  `;
}

document.addEventListener("DOMContentLoaded", () => {
  initNav({ activePage: "groups" });
  initFooter();

  void (async () => {
    const root = document.getElementById("groupsApp");
    if (!root) {
      return;
    }

    const session = await getSession();
    if (!session) {
      root.innerHTML = `
        <section class="learn-hero">
          <div class="learn-hero__copy">
            <div>
              <h1 class="learn-hero__title">Study Groups</h1>
              <p class="learn-hero__subhead">Sign in to create or join a group.</p>
            </div>
          </div>
          <div class="learn-hero__status">
            <div class="learn-hero__signin">
              <div class="learn-hero__signin-copy">Groups require an account.</div>
              <button id="groupsSignin" class="learn-hero__signin-button" type="button">Sign in</button>
            </div>
          </div>
        </section>
      `;
      root.querySelector<HTMLButtonElement>("#groupsSignin")?.addEventListener("click", () => {
        document.getElementById("auth-signin-btn")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      return;
    }

    const queryCode = new URLSearchParams(window.location.search).get("code")?.toUpperCase() ?? "";
    if (queryCode) {
      await authedFetch<StudyGroup>(session.idToken, "/groups/join", {
        method: "POST",
        body: JSON.stringify({ code: queryCode }),
      });
    }

    const groups = (await authedFetch<StudyGroup[]>(session.idToken, "/groups/mine", { method: "GET" })) ?? [];
    renderGroups(root, groups, session.userId);

    root.querySelector<HTMLFormElement>("#groupCreateForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const nameInput = root.querySelector<HTMLInputElement>("#groupCreateName");
      const name = nameInput?.value.trim() ?? "";
      if (!name) {
        return;
      }
      const created = await authedFetch<{ groupId: string }>(session.idToken, "/groups/create", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      if (!created?.groupId) {
        return;
      }
      window.location.href = `/groups/?code=${encodeURIComponent(created.groupId)}`;
    });

    root.querySelector<HTMLInputElement>("#groupJoinCode")?.addEventListener("input", (event) => {
      const input = event.currentTarget as HTMLInputElement;
      input.value = input.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
      if (input.value.length === 6) {
        root.querySelector<HTMLFormElement>("#groupJoinForm")?.requestSubmit();
      }
    });

    root.querySelector<HTMLFormElement>("#groupJoinForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const code = root.querySelector<HTMLInputElement>("#groupJoinCode")?.value.trim().toUpperCase() ?? "";
      if (code.length !== 6) {
        return;
      }
      window.location.href = `/groups/?code=${encodeURIComponent(code)}`;
    });

    root.querySelector<HTMLButtonElement>("#copyGroupCode")?.addEventListener("click", async () => {
      const code = new URLSearchParams(window.location.search).get("code")?.toUpperCase();
      if (!code) {
        return;
      }
      await navigator.clipboard.writeText(code).catch(() => {});
      showNotification({
        id: `group-code-${Date.now()}`,
        type: "badge",
        title: "Group code copied",
        message: code,
        icon: "👥",
        duration: 2500,
        accentColor: "var(--accent)",
      });
    });

    root.querySelector<HTMLButtonElement>("#leaveGroupBtn")?.addEventListener("click", async () => {
      const code = new URLSearchParams(window.location.search).get("code")?.toUpperCase();
      if (!code) {
        return;
      }
      await authedFetch(session.idToken, "/groups/leave", {
        method: "DELETE",
        body: JSON.stringify({ groupId: code }),
      });
      window.location.href = "/groups/";
    });
  })();
});

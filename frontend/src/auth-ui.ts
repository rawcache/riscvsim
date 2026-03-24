import { AUTH_CONFIG } from "./auth-config";
import * as authPage from "./auth-page";
import { getSession, logout } from "./auth";
import type { UserSession } from "./auth";
import { showNotification } from "./notifications";
import { applyPendingAvatarChoice, avatarMarkup, getCurrentAvatarChoice } from "./profile-avatar";
import { loadScore, setPinnedBadges, syncScoreToApi } from "./scoring";

type InitAuthUiOptions = {
  onSession?: (session: UserSession | null) => void;
};

type AuthElements = {
  authSignInBtn: HTMLButtonElement | null;
  authUserBtn: HTMLButtonElement | null;
  authMenu: HTMLElement | null;
  authDropdown: HTMLElement | null;
  authEmailEl: HTMLElement | null;
  authTierEl: HTMLElement | null;
  authProfileLink: HTMLAnchorElement | null;
  authManageBadgesBtn: HTMLButtonElement | null;
  authSignOutBtn: HTMLButtonElement | null;
};

let elements: AuthElements | null = null;
let onSessionChange: ((session: UserSession | null) => void) | null = null;
let listenersBound = false;
let currentSession: UserSession | null = null;
let badgeModalEl: HTMLElement | null = null;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateLabel(label: string, maxLength = 20): string {
  if (label.length <= maxLength) {
    return label;
  }
  return `${label.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

function tierLabel(session: UserSession | null): string {
  if (!session) {
    return "";
  }
  return session.isGtStudent ? "Georgia Tech · Pro" : "Free plan";
}

function deriveDisplayName(session: UserSession): string {
  const emailName = session.email.split("@")[0]?.trim();
  return truncateLabel(emailName || session.displayName || session.firstName || "User");
}

function renderTierPill(session: UserSession): string {
  if (session.isGtStudent) {
    return '<span class="nav-tier-pill nav-tier-pill--pro">🐝 PRO</span>';
  }
  return '<span class="nav-tier-pill nav-tier-pill--free">FREE</span>';
}

function usernameFromSession(session: UserSession): string {
  return session.email.split("@")[0]?.trim().toLowerCase() || deriveDisplayName(session).toLowerCase();
}

function ensureBadgeModal(): HTMLElement {
  if (badgeModalEl) {
    return badgeModalEl;
  }

  badgeModalEl = document.createElement("div");
  badgeModalEl.className = "badge-manager-modal";
  badgeModalEl.hidden = true;
  document.body.appendChild(badgeModalEl);
  return badgeModalEl;
}

function closeBadgeModal(): void {
  badgeModalEl?.setAttribute("hidden", "true");
  badgeModalEl?.classList.remove("is-visible");
}

function openBadgeModal(session: UserSession): void {
  const modal = ensureBadgeModal();
  const score = loadScore();
  let selected = new Set((score.pinnedBadgeIds ?? []).slice(0, 3));

  const renderModal = () => {
    modal.innerHTML = `
      <div class="badge-manager-modal__backdrop"></div>
      <div class="badge-manager-modal__card" role="dialog" aria-modal="true" aria-labelledby="badgeManagerTitle">
        <div class="learn-panel__header-row">
          <h2 id="badgeManagerTitle" class="learn-panel__title">Manage badges</h2>
          <button type="button" class="badge-manager-modal__close" data-badge-modal-action="close" aria-label="Close">×</button>
        </div>
        <div class="learn-panel__meta">Pin up to 3 badges to your public profile.</div>
        <div class="badge-manager-modal__grid">
          ${
            score.badges.length
              ? score.badges
                  .map(
                    (badge) => `
                      <button
                        type="button"
                        class="badge-manager-modal__badge${selected.has(badge.id) ? " is-selected" : ""}"
                        data-badge-id="${escapeHtml(badge.id)}"
                      >
                        <span class="badge-manager-modal__badge-icon">${badge.icon}</span>
                        <span class="badge-manager-modal__badge-name">${escapeHtml(badge.name)}</span>
                      </button>
                    `
                  )
                  .join("")
              : '<div class="learn-badges__empty">Earn badges first, then pin up to three here.</div>'
          }
        </div>
        <div class="badge-manager-modal__actions">
          <button type="button" class="badge-manager-modal__action" data-badge-modal-action="close">Cancel</button>
          <button type="button" class="badge-manager-modal__action badge-manager-modal__action--primary" data-badge-modal-action="save">Save pinned badges</button>
        </div>
      </div>
    `;

    modal.removeAttribute("hidden");
    modal.classList.add("is-visible");

    modal.querySelectorAll<HTMLButtonElement>("[data-badge-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const badgeId = button.dataset.badgeId ?? "";
        if (selected.has(badgeId)) {
          selected.delete(badgeId);
        } else if (selected.size < 3) {
          selected.add(badgeId);
        }
        renderModal();
      });
    });

    modal.querySelectorAll<HTMLElement>("[data-badge-modal-action='close']").forEach((element) => {
      element.addEventListener("click", () => closeBadgeModal());
    });

    modal.querySelector("[data-badge-modal-action='save']")?.addEventListener("click", () => {
      setPinnedBadges(Array.from(selected));
      void syncScoreToApi(loadScore(), session.idToken);
      closeBadgeModal();
      showNotification({
        id: `badge-manager-${Date.now()}`,
        type: "badge",
        title: "Pinned badges updated",
        message: `${selected.size} badge${selected.size === 1 ? "" : "s"} featured on your profile`,
        icon: "🏅",
        duration: 3000,
        accentColor: "var(--accent)",
      });
    });

    modal.querySelector(".badge-manager-modal__backdrop")?.addEventListener("click", () => closeBadgeModal());
  };

  renderModal();
}

function closeDropdown(): void {
  elements?.authDropdown?.setAttribute("hidden", "true");
  elements?.authUserBtn?.setAttribute("aria-expanded", "false");
  elements?.authMenu?.classList.remove("is-open");
}

function openAuthModal(): void {
  authPage.show({
    config: AUTH_CONFIG,
    allowClose: true,
  });
}

function bindListeners(): void {
  if (!elements || listenersBound) {
    return;
  }

  listenersBound = true;

  elements.authSignInBtn?.addEventListener("click", () => {
    openAuthModal();
  });

  elements.authUserBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!elements?.authDropdown || !elements.authUserBtn || elements.authUserBtn.hidden) {
      return;
    }
    const nextHidden = !elements.authDropdown.hidden;
    if (nextHidden) {
      elements.authDropdown.setAttribute("hidden", "true");
      elements.authUserBtn.setAttribute("aria-expanded", "false");
      elements.authMenu?.classList.remove("is-open");
    } else {
      elements.authDropdown.removeAttribute("hidden");
      elements.authUserBtn.setAttribute("aria-expanded", "true");
      elements.authMenu?.classList.add("is-open");
    }
  });

  elements.authDropdown?.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  elements.authSignOutBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    updateAuthUI(null);
    logout(AUTH_CONFIG);
  });

  elements.authManageBadgesBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (currentSession) {
      openBadgeModal(currentSession);
      closeDropdown();
    }
  });

  document.addEventListener("click", () => {
    closeDropdown();
  });

  window.addEventListener("studyriscv-auth-changed", (event) => {
    const session = (event as CustomEvent<UserSession | null>).detail ?? null;
    updateAuthUI(session);
  });
}

export function updateAuthUI(session: UserSession | null): void {
  if (!elements) {
    onSessionChange?.(session);
    return;
  }
  currentSession = session;
  if (!session) {
    closeBadgeModal();
  }

  const hasSession = Boolean(session);
  if (elements.authSignInBtn) {
    elements.authSignInBtn.hidden = hasSession;
  }

  if (elements.authMenu) {
    elements.authMenu.classList.remove("is-open");
  }

  if (elements.authUserBtn) {
    elements.authUserBtn.hidden = !hasSession;
    elements.authUserBtn.setAttribute("aria-expanded", "false");
    if (hasSession && session) {
      applyPendingAvatarChoice(session.email);
      const displayName = deriveDisplayName(session);
      const avatarChoice = getCurrentAvatarChoice();
      elements.authUserBtn.innerHTML = `
        <div class="nav-user-avatar">${avatarMarkup(avatarChoice, escapeHtml(displayName.charAt(0).toUpperCase()))}</div>
        <span class="nav-user-name">${escapeHtml(displayName)}</span>
        ${renderTierPill(session)}
        <svg class="nav-user-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5"></path>
        </svg>
      `;
      elements.authUserBtn.setAttribute("data-initialized", "true");
    } else {
      elements.authUserBtn.innerHTML = "";
      elements.authUserBtn.removeAttribute("data-initialized");
    }
  }

  if (elements.authDropdown) {
    elements.authDropdown.setAttribute("hidden", "true");
  }

  if (elements.authEmailEl) {
    elements.authEmailEl.textContent = session?.email ?? "";
  }

  if (elements.authTierEl) {
    elements.authTierEl.textContent = tierLabel(session);
    elements.authTierEl.className = session?.isGtStudent
      ? "auth-dropdown__tier auth-dropdown__tier--pro"
      : "auth-dropdown__tier auth-dropdown__tier--free";
  }

  if (elements.authProfileLink) {
    elements.authProfileLink.href = session ? `/profile/?u=${encodeURIComponent(usernameFromSession(session))}` : "/profile/";
  }

  if (elements.authMenu) {
    if (hasSession) {
      elements.authMenu.style.display = "";
      elements.authMenu.setAttribute("data-ready", "true");
      elements.authMenu.setAttribute("data-init", "1");
    } else {
      elements.authMenu.style.display = "none";
      elements.authMenu.removeAttribute("data-ready");
      elements.authMenu.setAttribute("data-init", "1");
    }
  }

  onSessionChange?.(session);
}

export async function initAuthUi(options: InitAuthUiOptions = {}): Promise<UserSession | null> {
  if (typeof document === "undefined" || typeof window === "undefined") {
    options.onSession?.(null);
    return null;
  }

  onSessionChange = options.onSession ?? null;
  elements = {
    authSignInBtn: document.getElementById("auth-signin-btn") as HTMLButtonElement | null,
    authUserBtn: document.getElementById("auth-user-btn") as HTMLButtonElement | null,
    authMenu: document.querySelector(".auth-menu") as HTMLElement | null,
    authDropdown: document.getElementById("auth-dropdown") as HTMLElement | null,
    authEmailEl: document.getElementById("auth-email") as HTMLElement | null,
    authTierEl: document.getElementById("auth-tier") as HTMLElement | null,
    authProfileLink: document.getElementById("auth-profile-link") as HTMLAnchorElement | null,
    authManageBadgesBtn: document.getElementById("auth-manage-badges-btn") as HTMLButtonElement | null,
    authSignOutBtn: document.getElementById("auth-signout-btn") as HTMLButtonElement | null,
  };

  bindListeners();

  const session = await getSession();
  updateAuthUI(session);
  return session;
}

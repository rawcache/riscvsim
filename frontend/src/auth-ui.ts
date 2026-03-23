import { AUTH_CONFIG } from "./auth-config";
import * as authPage from "./auth-page";
import { getSession, logout } from "./auth";
import type { UserSession } from "./auth";

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
  authSignOutBtn: HTMLButtonElement | null;
};

let elements: AuthElements | null = null;
let onSessionChange: ((session: UserSession | null) => void) | null = null;
let listenersBound = false;

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
      const displayName = deriveDisplayName(session);
      elements.authUserBtn.innerHTML = `
        <div class="nav-user-avatar">${escapeHtml(displayName.charAt(0).toUpperCase())}</div>
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
    authSignOutBtn: document.getElementById("auth-signout-btn") as HTMLButtonElement | null,
  };

  bindListeners();

  const session = await getSession();
  updateAuthUI(session);
  return session;
}

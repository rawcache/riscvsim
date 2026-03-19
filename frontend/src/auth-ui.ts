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

function truncateEmail(email: string, maxLength = 20): string {
  if (email.length <= maxLength) {
    return email;
  }
  return `${email.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

function tierLabel(session: UserSession | null): string {
  if (!session) {
    return "";
  }
  return session.isGtStudent ? "Georgia Tech · Pro" : "Free plan";
}

function closeDropdown(): void {
  elements?.authDropdown?.setAttribute("hidden", "true");
  elements?.authUserBtn?.setAttribute("aria-expanded", "false");
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
    } else {
      elements.authDropdown.removeAttribute("hidden");
      elements.authUserBtn.setAttribute("aria-expanded", "true");
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

  if (elements.authUserBtn) {
    elements.authUserBtn.hidden = !hasSession;
    elements.authUserBtn.setAttribute("aria-expanded", "false");
    elements.authUserBtn.innerHTML =
      hasSession && session
        ? `${session.isGtStudent ? '<span class="auth-user-btn__badge">Pro</span>' : ""}<span class="auth-user-btn__label">${escapeHtml(
            truncateEmail(session.email)
          )}</span><span class="auth-user-btn__chevron" aria-hidden="true">▾</span>`
        : "";
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

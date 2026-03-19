import { AUTH_CONFIG } from "./auth-config";
import { getSession, handleCallback, isLoggedIn, login, logout } from "./auth";
import type { UserSession } from "./auth";

type InitAuthUiOptions = {
  gtPillEl?: HTMLElement | null;
  onSession?: (session: UserSession | null) => void;
};

function truncateEmail(email: string, maxLength = 20): string {
  if (email.length <= maxLength) {
    return email;
  }
  return `${email.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

export async function initAuthUi(options: InitAuthUiOptions = {}): Promise<UserSession | null> {
  if (typeof document === "undefined" || typeof window === "undefined") {
    options.onSession?.(null);
    return null;
  }

  const authSignInBtn = document.getElementById("auth-signin-btn") as HTMLButtonElement | null;
  const authUserBtn = document.getElementById("auth-user-btn") as HTMLButtonElement | null;
  const authDropdown = document.getElementById("auth-dropdown") as HTMLElement | null;
  const authEmailEl = document.getElementById("auth-email") as HTMLElement | null;
  const authTierEl = document.getElementById("auth-tier") as HTMLElement | null;
  const authSignOutBtn = document.getElementById("auth-signout-btn") as HTMLButtonElement | null;
  const gtPillEl = options.gtPillEl ?? null;

  const closeDropdown = () => {
    if (authDropdown) {
      authDropdown.hidden = true;
    }
  };

  const applySession = (session: UserSession | null) => {
    const hasSession = Boolean(session);
    if (authSignInBtn) {
      authSignInBtn.hidden = hasSession;
    }
    if (authUserBtn) {
      authUserBtn.hidden = !hasSession;
      authUserBtn.textContent = hasSession && session ? `${truncateEmail(session.email)} ▾` : "";
    }
    if (authDropdown) {
      authDropdown.hidden = true;
    }
    if (authEmailEl) {
      authEmailEl.textContent = session?.email ?? "";
    }
    if (authTierEl) {
      authTierEl.textContent = session
        ? session.isGtStudent
          ? "GT Student · Free"
          : "General · Simulator only"
        : "";
    }
    if (gtPillEl) {
      gtPillEl.hidden = !(session && session.isGtStudent && isLoggedIn());
    }
    options.onSession?.(session);
  };

  authSignInBtn?.addEventListener("click", () => {
    login(AUTH_CONFIG);
  });

  authUserBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!authDropdown || authUserBtn.hidden) {
      return;
    }
    authDropdown.hidden = !authDropdown.hidden;
  });

  authDropdown?.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  authSignOutBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    logout(AUTH_CONFIG);
  });

  document.addEventListener("click", () => {
    closeDropdown();
  });

  let session: UserSession | null = null;
  if (new URLSearchParams(window.location.search).get("code")) {
    session = await handleCallback(AUTH_CONFIG);
  }
  if (!session) {
    session = await getSession();
  }

  applySession(session);
  return session;
}

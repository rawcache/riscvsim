import "./auth-page";
import { initAuthUi } from "./auth-ui";
import { captureReferralParam } from "./referrals";

const faviconChipUrl = new URL("../favicon-chip.svg", import.meta.url).href;

export interface NavConfig {
  activePage:
    | "problems"
    | "landing"
    | "learn"
    | "quiz"
    | "labs"
    | "leaderboard"
    | "challenges"
    | "checkpoints"
    | "simulator"
    | "about"
    | "docs"
    | "profile"
    | "groups";
}

const THEME_KEY = "studyriscv-theme";
const CLOSE_DELAY_MS = 80;
const HOME_HREF = "/";
let searchShortcutBound = false;

function getSearchKbd(): string {
  if (typeof navigator === "undefined") {
    return "⌘K";
  }
  const isMac =
    navigator.platform.toLowerCase().includes("mac") ||
    navigator.userAgent.includes("Mac");
  return isMac ? "⌘K" : "Ctrl+K";
}

function chevronSvg(): string {
  return `<svg class="nav-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"></path></svg>`;
}

function iconPerson(): string {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="8" r="3.5"></circle><path d="M5 20c1.8-3.5 4.2-5 7-5s5.2 1.5 7 5"></path></svg>`;
}

function iconBook(): string {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 4.5A2.5 2.5 0 0 1 8.5 2H20v20H8.5A2.5 2.5 0 0 0 6 22"></path><path d="M6 4.5V22"></path><path d="M10 7h7M10 11h7M10 15h5"></path></svg>`;
}

function iconCpu(): string {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"></rect><path d="M4 10h3M4 14h3M17 10h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3"></path></svg>`;
}

function iconFlask(): string {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 3h6M8 3v7L4 18c-.7 1.3.2 3 1.8 3h12.4c1.6 0 2.5-1.7 1.8-3L16 10V3"></path><path d="M6 15h12"></path></svg>`;
}

function iconFlag(): string {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" x2="4" y1="22" y2="15"></line></svg>`;
}

function iconStar(): string {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m12 2 3.1 6.3 6.9 1-5 4.8 1.2 6.8L12 17.9 5.8 20.9 7 14.1 2 9.3l6.9-1L12 2Z"></path></svg>`;
}

function iconGithub(): string {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>`;
}

function sunMoonSvg(): string {
  return `<span class="theme-toggle__icon theme-toggle__icon--sun" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12"></path></svg></span><span class="theme-toggle__icon theme-toggle__icon--moon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path></svg></span>`;
}

function setThemeToggleState(themeToggle: HTMLButtonElement | null): void {
  if (!themeToggle) {
    return;
  }

  const isDark = document.documentElement.dataset.theme === "dark";
  themeToggle.setAttribute("aria-pressed", String(isDark));
  themeToggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
}

function toggleTheme(themeToggles: Array<HTMLButtonElement | null>): void {
  const isDark = document.documentElement.dataset.theme === "dark";
  if (isDark) {
    document.documentElement.dataset.theme = "light";
    window.localStorage.setItem(THEME_KEY, "light");
  } else {
    document.documentElement.dataset.theme = "dark";
    window.localStorage.setItem(THEME_KEY, "dark");
  }

  themeToggles.forEach((toggle) => setThemeToggleState(toggle));
}

function practiceActive(page: NavConfig["activePage"]): boolean {
  return page === "problems" || page === "quiz" || page === "labs" || page === "checkpoints";
}

function resourcesActive(config: NavConfig["activePage"]): boolean {
  return config === "about" || config === "docs";
}

function renderNav(config: NavConfig): string {
  const isLearn = config.activePage === "learn";
  const isPractice = practiceActive(config.activePage);
  const isSimulator = config.activePage === "simulator";
  const isResources = resourcesActive(config.activePage);

  return `
    <div class="nav-mobile-shell">
      <div class="nav-inner">
        <a href="${HOME_HREF}" class="nav-logo" aria-label="StudyRISC-V home">
          <span class="nav-logo__badge" aria-hidden="true">
            <img class="nav-logo__mark" src="${faviconChipUrl}" alt="" />
            <span class="nav-logo__fallback">SR</span>
          </span>
          <span class="nav-logo__text">StudyRISC-V</span>
        </a>
        <div class="nav-links">
          <a href="/learn/" class="nav-link${isLearn ? " nav-link-active" : ""}">Learn</a>
          <div class="nav-dropdown-wrapper" data-nav-dropdown="practice">
            <button class="nav-link nav-dropdown-trigger${isPractice ? " nav-link-active" : ""}" type="button" aria-expanded="false" aria-controls="nav-dropdown-practice">
              Practice
              ${chevronSvg()}
            </button>
            <div class="nav-dropdown nav-dropdown--mega" id="nav-dropdown-practice">
              <div class="nav-mega-grid">
                <a href="/problems/" class="nav-mega-item${config.activePage === "problems" ? " nav-mega-item--active" : ""}">
                  <span class="nav-mega-icon">${iconCpu()}</span>
                  <span class="nav-mega-body">
                    <span class="nav-mega-title">Problems</span>
                    <span class="nav-mega-desc">Practice assembly challenges by topic</span>
                  </span>
                </a>
                <a href="/quiz/" class="nav-mega-item${config.activePage === "quiz" ? " nav-mega-item--active" : ""}">
                  <span class="nav-mega-icon">${iconStar()}</span>
                  <span class="nav-mega-body">
                    <span class="nav-mega-title">Quizzes</span>
                    <span class="nav-mega-desc">Check understanding with short assessments</span>
                  </span>
                </a>
                <a href="/labs/" class="nav-mega-item${config.activePage === "labs" ? " nav-mega-item--active" : ""}">
                  <span class="nav-mega-icon">${iconFlask()}</span>
                  <span class="nav-mega-body">
                    <span class="nav-mega-title">Labs</span>
                    <span class="nav-mega-desc">Build larger assembly routines end-to-end</span>
                  </span>
                </a>
                <a href="/checkpoints/" class="nav-mega-item${config.activePage === "checkpoints" ? " nav-mega-item--active" : ""}">
                  <span class="nav-mega-icon">${iconFlag()}</span>
                  <span class="nav-mega-body">
                    <span class="nav-mega-title">Checkpoints</span>
                    <span class="nav-mega-desc">Milestone challenges that unlock as you learn</span>
                  </span>
                </a>
              </div>
            </div>
          </div>
          <a href="/simulator/" class="nav-link${isSimulator ? " nav-link-active" : ""}">Simulator</a>
          <div class="nav-dropdown-wrapper" data-nav-dropdown="resources">
            <button class="nav-link nav-dropdown-trigger${isResources ? " nav-link-active" : ""}" type="button" aria-expanded="false" aria-controls="nav-dropdown-resources">
              Resources
              ${chevronSvg()}
            </button>
            <div class="nav-dropdown nav-dropdown--mega nav-dropdown--right" id="nav-dropdown-resources">
              <div class="nav-mega-grid nav-mega-grid--3col">
                <a href="/docs/" class="nav-mega-item${config.activePage === "docs" ? " nav-mega-item--active" : ""}">
                  <span class="nav-mega-icon">${iconBook()}</span>
                  <span class="nav-mega-body">
                    <span class="nav-mega-title">Docs</span>
                    <span class="nav-mega-desc">Instruction reference and guides</span>
                  </span>
                </a>
                <a href="/about/" class="nav-mega-item${config.activePage === "about" ? " nav-mega-item--active" : ""}">
                  <span class="nav-mega-icon">${iconPerson()}</span>
                  <span class="nav-mega-body">
                    <span class="nav-mega-title">About</span>
                    <span class="nav-mega-desc">Who built this and why</span>
                  </span>
                </a>
                <a href="https://github.com/sseth30/studyriscv" class="nav-mega-item" target="_blank" rel="noopener">
                  <span class="nav-mega-icon">${iconGithub()}</span>
                  <span class="nav-mega-body">
                    <span class="nav-mega-title">GitHub</span>
                    <span class="nav-mega-desc">Source code and issues</span>
                  </span>
                </a>
              </div>
            </div>
          </div>
        </div>
        <div class="nav-actions">
          <div id="nav-status-badge" class="nav-status-badge${config.activePage === "simulator" ? " visible" : ""}"></div>
          <button id="nav-search-btn" class="nav-search-btn" type="button" aria-label="Search site">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="11" cy="11" r="8"></circle>
              <path d="m21 21-4.35-4.35"></path>
            </svg>
            <span class="nav-search-btn__text">Search</span>
            <kbd class="nav-search-btn__kbd">${getSearchKbd()}</kbd>
          </button>
          <button id="auth-signin-btn" class="nav-signin-btn" type="button">Sign in</button>
          <div class="auth-menu">
            <button id="auth-user-btn" class="auth-user-btn nav-user-menu" type="button" hidden aria-label="Open account menu"></button>
            <div id="auth-dropdown" class="auth-dropdown" hidden>
              <div id="auth-email" class="auth-dropdown__email"></div>
              <div id="auth-tier" class="auth-dropdown__tier"></div>
              <a id="auth-profile-link" class="auth-dropdown__link" href="/profile/">View profile →</a>
              <a class="auth-dropdown__link" href="/groups/">Study groups →</a>
              <button id="auth-manage-badges-btn" class="auth-dropdown__link auth-dropdown__link--button" type="button">Manage badges</button>
              <div class="auth-dropdown__divider"></div>
              <button id="auth-signout-btn" class="auth-dropdown__signout" type="button">Sign out</button>
            </div>
          </div>
          <button id="theme-toggle" class="nav-theme-toggle" type="button" aria-label="Toggle theme">${sunMoonSvg()}</button>
          <button class="nav-hamburger" id="nav-hamburger" type="button" aria-expanded="false" aria-controls="nav-mobile-menu" aria-label="Toggle navigation"><span></span><span></span><span></span></button>
        </div>
      </div>
      <div class="nav-mobile-menu" id="nav-mobile-menu">
        <a href="/learn/" class="nav-mobile-link${isLearn ? " nav-link-active" : ""}">Learn</a>
        <a href="/problems/" class="nav-mobile-link${config.activePage === "problems" ? " nav-link-active" : ""}">Problems</a>
        <a href="/quiz/" class="nav-mobile-link${config.activePage === "quiz" ? " nav-link-active" : ""}">Quizzes</a>
        <a href="/labs/" class="nav-mobile-link${config.activePage === "labs" ? " nav-link-active" : ""}">Labs</a>
        <a href="/checkpoints/" class="nav-mobile-link${config.activePage === "checkpoints" ? " nav-link-active" : ""}">Checkpoints</a>
        <a href="/simulator/" class="nav-mobile-link${isSimulator ? " nav-link-active" : ""}">Simulator</a>
        <a href="/docs/" class="nav-mobile-link${config.activePage === "docs" ? " nav-link-active" : ""}">Docs</a>
        <a href="/about/" class="nav-mobile-link${config.activePage === "about" ? " nav-link-active" : ""}">About</a>
        <a href="https://github.com/sseth30/studyriscv" class="nav-mobile-link" target="_blank" rel="noopener">GitHub</a>
        <div class="nav-mobile-actions">
          <button id="nav-mobile-signin-btn" class="nav-signin-btn" type="button">Sign in</button>
        </div>
      </div>
    </div>
  `;
}

function isEditableSearchTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return target.isContentEditable || Boolean(target.closest("[contenteditable='true']"));
}

async function openSearchOverlay(): Promise<void> {
  const windowWithSearch = window as Window & {
    __searchUI?: {
      openSearch?: () => void;
    };
  };

  if (windowWithSearch.__searchUI?.openSearch) {
    windowWithSearch.__searchUI.openSearch();
    return;
  }

  try {
    const module = await import("./search-ui");
    windowWithSearch.__searchUI = module;
    module.openSearch();
  } catch {
    const query = window.prompt("Search StudyRISC-V:");
    if (query) {
      window.location.href = `/docs/?q=${encodeURIComponent(query)}`;
    }
  }
}

export function initNav(config: NavConfig): void {
  const root = document.getElementById("site-nav");
  if (!root) {
    return;
  }

  captureReferralParam();

  root.className = "site-nav";
  root.innerHTML = renderNav(config);

  const wrappers = Array.from(root.querySelectorAll<HTMLElement>(".nav-dropdown-wrapper"));
  const mobileMenu = root.querySelector<HTMLElement>("#nav-mobile-menu");
  const hamburger = root.querySelector<HTMLButtonElement>("#nav-hamburger");
  const themeToggle = root.querySelector<HTMLButtonElement>("#theme-toggle");
  const mobileThemeToggle = root.querySelector<HTMLButtonElement>("#nav-mobile-theme-toggle");
  const searchBtn = root.querySelector<HTMLButtonElement>("#nav-search-btn");
  const logoLink = root.querySelector<HTMLAnchorElement>(".nav-logo");
  const logoMark = root.querySelector<HTMLImageElement>(".nav-logo__mark");
  const mobileSignin = root.querySelector<HTMLButtonElement>("#nav-mobile-signin-btn");
  const desktopSignin = root.querySelector<HTMLButtonElement>("#auth-signin-btn");
  const userButton = root.querySelector<HTMLElement>("#auth-user-btn");
  const authMenu = root.querySelector<HTMLElement>(".auth-menu");
  const statusBadge = root.querySelector<HTMLElement>("#nav-status-badge");
  const closeTimers = new WeakMap<HTMLElement, number>();

  if (desktopSignin) {
    desktopSignin.hidden = true;
  }
  if (userButton) {
    userButton.hidden = true;
  }
  if (authMenu) {
    authMenu.style.display = "none";
    authMenu.removeAttribute("data-ready");
    authMenu.removeAttribute("data-init");
  }
  logoLink?.setAttribute("href", HOME_HREF);
  if (logoLink && logoMark) {
    const enableLogoFallback = () => {
      logoLink.classList.add("nav-logo--fallback");
    };
    logoMark.addEventListener("error", enableLogoFallback, { once: true });
    if (logoMark.complete && logoMark.naturalWidth === 0) {
      enableLogoFallback();
    }
  }

  const closeAllDropdowns = () => {
    wrappers.forEach((wrapper) => {
      const trigger = wrapper.querySelector<HTMLButtonElement>(".nav-dropdown-trigger");
      const dropdown = wrapper.querySelector<HTMLElement>(".nav-dropdown");
      wrapper.classList.remove("is-open");
      trigger?.setAttribute("aria-expanded", "false");
      dropdown?.classList.remove("open");
    });
  };

  const openDropdown = (wrapper: HTMLElement) => {
    const timer = closeTimers.get(wrapper);
    if (timer) {
      window.clearTimeout(timer);
    }
    closeAllDropdowns();
    wrapper.classList.add("is-open");
    wrapper.querySelector<HTMLButtonElement>(".nav-dropdown-trigger")?.setAttribute("aria-expanded", "true");
    wrapper.querySelector<HTMLElement>(".nav-dropdown")?.classList.add("open");
  };

  const closeDropdownLater = (wrapper: HTMLElement) => {
    const timer = window.setTimeout(() => {
      wrapper.classList.remove("is-open");
      wrapper.querySelector<HTMLButtonElement>(".nav-dropdown-trigger")?.setAttribute("aria-expanded", "false");
      wrapper.querySelector<HTMLElement>(".nav-dropdown")?.classList.remove("open");
    }, CLOSE_DELAY_MS);
    closeTimers.set(wrapper, timer);
  };

  wrappers.forEach((wrapper) => {
    const trigger = wrapper.querySelector<HTMLButtonElement>(".nav-dropdown-trigger");
    wrapper.addEventListener("mouseenter", () => openDropdown(wrapper));
    wrapper.addEventListener("mouseleave", () => closeDropdownLater(wrapper));
    trigger?.addEventListener("click", (event) => {
      event.preventDefault();
      const isOpen = wrapper.classList.contains("is-open");
      if (isOpen) {
        closeAllDropdowns();
      } else {
        openDropdown(wrapper);
      }
    });
  });

  const closeMobileMenu = () => {
    hamburger?.setAttribute("aria-expanded", "false");
    mobileMenu?.classList.remove("is-open");
  };

  hamburger?.addEventListener("click", () => {
    const nextOpen = hamburger.getAttribute("aria-expanded") !== "true";
    hamburger.setAttribute("aria-expanded", String(nextOpen));
    mobileMenu?.classList.toggle("is-open", nextOpen);
  });

  mobileMenu?.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => closeMobileMenu());
  });

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Node) || !root.contains(event.target)) {
      closeAllDropdowns();
      closeMobileMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAllDropdowns();
      closeMobileMenu();
    }
  });

  setThemeToggleState(themeToggle ?? null);
  setThemeToggleState(mobileThemeToggle ?? null);
  themeToggle?.addEventListener("click", () => {
    toggleTheme([themeToggle, mobileThemeToggle]);
  });
  mobileThemeToggle?.addEventListener("click", () => {
    toggleTheme([themeToggle, mobileThemeToggle]);
  });

  searchBtn?.addEventListener("click", () => {
    void openSearchOverlay();
  });

  if (!searchShortcutBound) {
    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if (isEditableSearchTarget(event.target)) {
          return;
        }
        event.preventDefault();
        void openSearchOverlay();
      }
    });
    searchShortcutBound = true;
  }

  if (desktopSignin && mobileSignin) {
    mobileSignin.addEventListener("click", () => {
      desktopSignin.click();
      closeMobileMenu();
    });
  }

  const syncMobileSigninVisibility = () => {
    if (!desktopSignin || !mobileSignin) {
      return;
    }

    const desktopHidden =
      desktopSignin.hidden ||
      desktopSignin.hasAttribute("hidden") ||
      window.getComputedStyle(desktopSignin).display === "none";

    mobileSignin.hidden = desktopHidden;
    mobileSignin.style.display = desktopHidden ? "none" : "";
  };

  const syncAuthMenuVisibility = () => {
    if (!userButton || !authMenu) {
      return;
    }

    const userHidden =
      userButton.hidden ||
      userButton.hasAttribute("hidden") ||
      userButton.textContent?.trim() === "" ||
      window.getComputedStyle(userButton).display === "none";

    authMenu.style.display = userHidden ? "none" : "";
    if (userHidden) {
      authMenu.removeAttribute("data-ready");
    } else {
      authMenu.setAttribute("data-ready", "true");
    }
  };

  syncMobileSigninVisibility();
  syncAuthMenuVisibility();

  void initAuthUi({
    onSession(session) {
      if (!session && statusBadge) {
        statusBadge.textContent = "";
        statusBadge.classList.remove("visible");
      }
    },
  }).then(() => {
    syncMobileSigninVisibility();
    syncAuthMenuVisibility();

    if (userButton) {
      const observer = new MutationObserver(() => {
        syncMobileSigninVisibility();
        syncAuthMenuVisibility();
      });
      observer.observe(userButton, {
        attributes: true,
        attributeFilter: ["hidden", "style", "class"],
        childList: true,
        subtree: true,
      });
    }
  });
}

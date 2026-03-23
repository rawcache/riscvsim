import "./auth-page";
import { initAuthUi } from "./auth-ui";

export interface NavConfig {
  activePage:
    | "landing"
    | "learn"
    | "quiz"
    | "labs"
    | "leaderboard"
    | "challenges"
    | "simulator"
    | "about"
    | "docs"
    | "github";
}

const THEME_KEY = "studyriscv-theme";
const CLOSE_DELAY_MS = 80;

function chevronSvg(): string {
  return `<svg class="nav-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"></path></svg>`;
}

function iconStep(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M4 12h11"></path><path d="m11 5 7 7-7 7"></path><path d="M4 5v14"></path></svg>`;
}

function iconStack(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><rect x="5" y="6" width="14" height="4" rx="1.5"></rect><rect x="5" y="10" width="14" height="4" rx="1.5"></rect><rect x="5" y="14" width="14" height="4" rx="1.5"></rect></svg>`;
}

function iconCode(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M8 8 4 12l4 4"></path><path d="m16 8 4 4-4 4"></path><path d="M10 19h4"></path></svg>`;
}

function iconPerson(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><circle cx="12" cy="8" r="3.5"></circle><path d="M5 20c1.8-3.5 4.2-5 7-5s5.2 1.5 7 5"></path></svg>`;
}

function iconBook(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M6 4.5A2.5 2.5 0 0 1 8.5 2H20v20H8.5A2.5 2.5 0 0 0 6 24"></path><path d="M6 4.5v17"></path><path d="M10 7h7M10 11h7M10 15h5"></path></svg>`;
}

function iconSchool(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="m3 10 9-5 9 5-9 5-9-5Z"></path><path d="M7 12.5V16c0 1.6 2.2 3 5 3s5-1.4 5-3v-3.5"></path></svg>`;
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
    document.documentElement.removeAttribute("data-theme");
    window.localStorage.setItem(THEME_KEY, "light");
  } else {
    document.documentElement.dataset.theme = "dark";
    window.localStorage.setItem(THEME_KEY, "dark");
  }

  themeToggles.forEach((toggle) => setThemeToggleState(toggle));
}

function productActive(config: NavConfig["activePage"]): boolean {
  return config === "simulator";
}

function resourcesActive(config: NavConfig["activePage"]): boolean {
  return config === "about" || config === "docs";
}

function loadStreakCount(): number {
  if (typeof localStorage === "undefined") {
    return 0;
  }

  try {
    const stored = localStorage.getItem("studyriscv_score");
    if (!stored) {
      return 0;
    }
    const parsed = JSON.parse(stored) as { streak?: unknown };
    return Number.isFinite(parsed?.streak) ? Math.max(0, Number(parsed.streak)) : 0;
  } catch {
    return 0;
  }
}

function renderNav(config: NavConfig): string {
  const isLearn = config.activePage === "learn";
  const isQuiz = config.activePage === "quiz";
  const isLabs = config.activePage === "labs";
  const isLeaderboard = config.activePage === "leaderboard";
  const isChallenges = config.activePage === "challenges";
  const isGithub = config.activePage === "github";
  const isProduct = productActive(config.activePage);
  const isResources = resourcesActive(config.activePage);
  const docsGuideActive = config.activePage === "docs";

  return `
    <div class="nav-mobile-shell">
      <div class="nav-inner">
        <a href="/" class="nav-logo">StudyRISC-V</a>
        <div class="nav-links">
          <a href="/learn/" class="nav-link${isLearn ? " nav-link-active" : ""}">Learn</a>
          <a href="/quiz/" class="nav-link${isQuiz ? " nav-link-active" : ""}">Quizzes</a>
          <a href="/labs/" class="nav-link${isLabs ? " nav-link-active" : ""}">Labs</a>
          <a href="/challenges/" class="nav-link${isChallenges ? " nav-link-active" : ""}">Challenges</a>
          <div class="nav-dropdown-wrapper" data-nav-dropdown="product">
            <button class="nav-link nav-dropdown-trigger${isProduct ? " nav-link-active" : ""}" type="button" aria-expanded="false" aria-controls="nav-dropdown-product">
              Product
              ${chevronSvg()}
            </button>
            <div class="nav-dropdown" id="nav-dropdown-product">
              <a href="/simulator/" class="nav-dropdown-item${isProduct ? " nav-dropdown-item-active" : ""}">
                <div class="nav-dropdown-icon">${iconStep()}</div>
                <div><span class="nav-dropdown-title">Simulator</span><span class="nav-dropdown-desc">Step through RISC-V assembly</span></div>
              </a>
              <a href="/simulator/" class="nav-dropdown-item${isProduct ? " nav-dropdown-item-active" : ""}">
                <div class="nav-dropdown-icon">${iconStack()}</div>
                <div><span class="nav-dropdown-title">Call Stack Visualizer</span><span class="nav-dropdown-desc">Watch stack frames build live</span></div>
              </a>
              <a href="/simulator/" class="nav-dropdown-item${isProduct ? " nav-dropdown-item-active" : ""}">
                <div class="nav-dropdown-icon">${iconCode()}</div>
                <div><span class="nav-dropdown-title">Pseudo-C Explainer</span><span class="nav-dropdown-desc">Assembly translated to readable C</span></div>
              </a>
            </div>
          </div>
          <div class="nav-dropdown-wrapper" data-nav-dropdown="resources">
            <button class="nav-link nav-dropdown-trigger${isResources ? " nav-link-active" : ""}" type="button" aria-expanded="false" aria-controls="nav-dropdown-resources">
              Resources
              ${chevronSvg()}
            </button>
            <div class="nav-dropdown" id="nav-dropdown-resources">
              <a href="/about/" class="nav-dropdown-item${config.activePage === "about" ? " nav-dropdown-item-active" : ""}">
                <div class="nav-dropdown-icon">${iconPerson()}</div>
                <div><span class="nav-dropdown-title">About</span><span class="nav-dropdown-desc">Who built this and why</span></div>
              </a>
              <a href="/docs/" class="nav-dropdown-item${config.activePage === "docs" ? " nav-dropdown-item-active" : ""}">
                <div class="nav-dropdown-icon">${iconBook()}</div>
                <div><span class="nav-dropdown-title">Docs</span><span class="nav-dropdown-desc">Instruction reference and guides</span></div>
              </a>
              <a href="/docs/#ece-2035" class="nav-dropdown-item${docsGuideActive ? " nav-dropdown-item-active" : ""}">
                <div class="nav-dropdown-icon">${iconSchool()}</div>
                <div><span class="nav-dropdown-title">ECE 2035 Guide</span><span class="nav-dropdown-desc">Georgia Tech course reference</span></div>
              </a>
            </div>
          </div>
          <a href="https://github.com/rawcache/riscvsim" class="nav-link${isGithub ? " nav-link-active" : ""}" target="_blank" rel="noopener">GitHub</a>
        </div>
        <div class="nav-actions">
          <div id="nav-status-badge" class="nav-status-badge${config.activePage === "simulator" ? " visible" : ""}"></div>
          <div id="nav-streak-indicator" class="nav-streak-indicator" hidden></div>
          <button id="auth-signin-btn" class="nav-signin-btn" type="button">Sign in</button>
          <div class="auth-menu">
            <button id="auth-user-btn" class="auth-user-btn nav-user-btn" type="button" hidden></button>
            <div id="auth-dropdown" class="auth-dropdown" hidden>
              <div id="auth-email" class="auth-dropdown__email"></div>
              <div id="auth-tier" class="auth-dropdown__tier"></div>
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
        <a href="/quiz/" class="nav-mobile-link${isQuiz ? " nav-link-active" : ""}">Quizzes</a>
        <a href="/labs/" class="nav-mobile-link${isLabs ? " nav-link-active" : ""}">Labs</a>
        <a href="/challenges/" class="nav-mobile-link${isChallenges ? " nav-link-active" : ""}">Challenges</a>
        <a href="/simulator/" class="nav-mobile-link${isProduct ? " nav-link-active" : ""}">Simulator</a>
        <a href="/simulator/" class="nav-mobile-link${isProduct ? " nav-link-active" : ""}">Call Stack Visualizer</a>
        <a href="/simulator/" class="nav-mobile-link${isProduct ? " nav-link-active" : ""}">Pseudo-C Explainer</a>
        <a href="/about/" class="nav-mobile-link${config.activePage === "about" ? " nav-link-active" : ""}">About</a>
        <a href="/docs/" class="nav-mobile-link${config.activePage === "docs" ? " nav-link-active" : ""}">Docs</a>
        <a href="/leaderboard/" class="nav-mobile-link${isLeaderboard ? " nav-link-active" : ""}">Leaderboard</a>
        <a href="/docs/#ece-2035" class="nav-mobile-link${docsGuideActive ? " nav-link-active" : ""}">ECE 2035 Guide</a>
        <a href="https://github.com/rawcache/riscvsim" class="nav-mobile-link${isGithub ? " nav-link-active" : ""}" target="_blank" rel="noopener">GitHub</a>
        <div class="nav-mobile-theme-row">
          <span>Theme</span>
          <button id="nav-mobile-theme-toggle" class="nav-theme-toggle" type="button" aria-label="Toggle theme">${sunMoonSvg()}</button>
        </div>
        <div class="nav-mobile-actions">
          <button id="nav-mobile-signin-btn" class="nav-signin-btn" type="button">Sign in</button>
        </div>
      </div>
    </div>
  `;
}

export function initNav(config: NavConfig): void {
  const root = document.getElementById("site-nav");
  if (!root) {
    return;
  }

  root.className = "site-nav";
  root.innerHTML = renderNav(config);

  const wrappers = Array.from(root.querySelectorAll<HTMLElement>(".nav-dropdown-wrapper"));
  const mobileMenu = root.querySelector<HTMLElement>("#nav-mobile-menu");
  const hamburger = root.querySelector<HTMLButtonElement>("#nav-hamburger");
  const themeToggle = root.querySelector<HTMLButtonElement>("#theme-toggle");
  const mobileThemeToggle = root.querySelector<HTMLButtonElement>("#nav-mobile-theme-toggle");
  const mobileSignin = root.querySelector<HTMLButtonElement>("#nav-mobile-signin-btn");
  const desktopSignin = root.querySelector<HTMLButtonElement>("#auth-signin-btn");
  const userButton = root.querySelector<HTMLElement>("#auth-user-btn");
  const authMenu = root.querySelector<HTMLElement>(".auth-menu");
  const streakIndicator = root.querySelector<HTMLElement>("#nav-streak-indicator");
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

  if (desktopSignin && mobileSignin) {
    mobileSignin.addEventListener("click", () => {
      desktopSignin.click();
      closeMobileMenu();
    });
  }

  const streakCount = loadStreakCount();
  if (streakIndicator) {
    if (streakCount >= 2) {
      streakIndicator.hidden = false;
      streakIndicator.textContent = `🔥 ${streakCount}`;
      streakIndicator.title = `${streakCount}-day streak! Keep it up.`;
      streakIndicator.setAttribute("aria-label", `${streakCount}-day streak`);
    } else {
      streakIndicator.hidden = true;
      streakIndicator.textContent = "";
      streakIndicator.removeAttribute("title");
    }
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

  void initAuthUi().then(() => {
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

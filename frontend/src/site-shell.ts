import "./auth-page";
import { initAuthUi } from "./auth-ui";

const THEME_KEY = "studyriscv-theme";

type SiteShellOptions = {
  navId?: string;
  themeToggleId?: string;
  mobileToggleId?: string;
  mobileMenuId?: string;
  bindTheme?: boolean;
  bindScroll?: boolean;
};

function setThemeToggleState(themeToggle: HTMLButtonElement | null): void {
  if (!themeToggle) {
    return;
  }

  const isDark = document.documentElement.dataset.theme === "dark";
  themeToggle.setAttribute("aria-pressed", String(isDark));
  themeToggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
}

export async function initSiteShell(options: SiteShellOptions = {}): Promise<void> {
  const {
    navId = "landingNav",
    themeToggleId = "landingThemeToggle",
    mobileToggleId = "landingNavToggle",
    mobileMenuId = "landingNavMobileMenu",
    bindTheme = true,
    bindScroll = true,
  } = options;

  const nav = document.getElementById(navId) as HTMLElement | null;
  const themeToggle = document.getElementById(themeToggleId) as HTMLButtonElement | null;
  const mobileToggle = document.getElementById(mobileToggleId) as HTMLButtonElement | null;
  const mobileMenu = document.getElementById(mobileMenuId) as HTMLElement | null;

  const closeMobileMenu = () => {
    if (!mobileToggle || !mobileMenu) {
      return;
    }

    mobileToggle.setAttribute("aria-expanded", "false");
    mobileToggle.classList.remove("is-open");
    mobileMenu.hidden = true;
    mobileMenu.classList.remove("is-open");
  };

  if (bindScroll && nav) {
    const syncNavShadow = () => {
      nav.classList.toggle("is-scrolled", window.scrollY > 8);
    };
    syncNavShadow();
    window.addEventListener("scroll", syncNavShadow, { passive: true });
  }

  if (bindTheme && themeToggle) {
    setThemeToggleState(themeToggle);
    themeToggle.addEventListener("click", () => {
      const isDark = document.documentElement.dataset.theme === "dark";
      if (isDark) {
        document.documentElement.removeAttribute("data-theme");
        window.localStorage.setItem(THEME_KEY, "light");
      } else {
        document.documentElement.dataset.theme = "dark";
        window.localStorage.setItem(THEME_KEY, "dark");
      }
      setThemeToggleState(themeToggle);
    });
  }

  if (mobileToggle && mobileMenu) {
    mobileToggle.addEventListener("click", () => {
      const nextExpanded = mobileToggle.getAttribute("aria-expanded") !== "true";
      mobileToggle.setAttribute("aria-expanded", String(nextExpanded));
      mobileToggle.classList.toggle("is-open", nextExpanded);
      mobileMenu.hidden = !nextExpanded;
      mobileMenu.classList.toggle("is-open", nextExpanded);
    });

    mobileMenu.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        closeMobileMenu();
      });
    });

    document.addEventListener("click", (event) => {
      if (
        mobileToggle.getAttribute("aria-expanded") === "true" &&
        event.target instanceof Node &&
        !mobileToggle.contains(event.target) &&
        !mobileMenu.contains(event.target)
      ) {
        closeMobileMenu();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMobileMenu();
      }
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 640) {
        closeMobileMenu();
      }
    });
  }

  await initAuthUi();
}

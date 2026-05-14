import "./auth-page";
import { initFooter } from "./footer";

declare global {
  interface Window {
    __studyriscvProblemsChromeReady?: boolean;
  }
}

export async function ensureProblemsChrome(): Promise<void> {
  if (typeof document === "undefined") {
    return;
  }

  if (!window.__studyriscvProblemsChromeReady) {
    try {
      const { initNav } = await import("./nav");
      initNav({ activePage: "problems" });
      await new Promise<void>((resolve) => {
        if (typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(() => resolve());
        } else {
          window.setTimeout(() => resolve(), 0);
        }
      });
    } catch (error) {
      console.error("Problems nav failed to initialize.", error);
    }

    try {
      initFooter();
    } catch (error) {
      console.error("Problems footer failed to initialize.", error);
    }

    window.__studyriscvProblemsChromeReady = true;
  }

  const nav = document.getElementById("site-nav") as HTMLElement | null;
  if (nav) {
    nav.hidden = false;
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureProblemsChrome, { once: true });
  } else {
    ensureProblemsChrome();
  }
}

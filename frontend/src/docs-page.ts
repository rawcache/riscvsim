import { initSiteShell } from "./site-shell";

function updateActiveLink(id: string): void {
  document.querySelectorAll<HTMLElement>("[data-docs-link]").forEach((link) => {
    const isActive = link.getAttribute("href") === `#${id}`;
    link.classList.toggle("is-active", isActive);
    if (isActive) {
      link.setAttribute("aria-current", "true");
    } else {
      link.removeAttribute("aria-current");
    }
  });
}

function initScrollSpy(): void {
  const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-docs-target]"));
  if (targets.length === 0) {
    return;
  }

  let currentId = targets[0].id;
  updateActiveLink(currentId);

  const observer = new IntersectionObserver(
    (entries) => {
      const visibleEntries = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);

      if (visibleEntries.length === 0) {
        return;
      }

      const nextId = visibleEntries[0].target.id;
      if (!nextId || nextId === currentId) {
        return;
      }

      currentId = nextId;
      updateActiveLink(currentId);
    },
    {
      rootMargin: "-100px 0px -65% 0px",
      threshold: [0, 0.2, 1],
    }
  );

  targets.forEach((target) => observer.observe(target));
}

function initMobileToc(): void {
  const mobileToc = document.getElementById("docsMobileToc") as HTMLDetailsElement | null;
  if (!mobileToc) {
    return;
  }

  mobileToc.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      mobileToc.open = false;
    });
  });
}

function initSignupCta(): void {
  const signupCta = document.getElementById("docsSignupCta") as HTMLButtonElement | null;
  const signInButton = document.getElementById("auth-signin-btn") as HTMLButtonElement | null;
  if (!signupCta || !signInButton) {
    return;
  }

  signupCta.addEventListener("click", () => {
    signInButton.click();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  void initSiteShell().then(() => {
    initScrollSpy();
    initMobileToc();
    initSignupCta();
  });
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function initLandingExperience(): void {
  const body = document.body;
  if (!body.classList.contains("landing-home")) {
    return;
  }

  const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-landing-section]"));
  const hero = document.querySelector<HTMLElement>(".hero");
  const nav = document.getElementById("site-nav");
  const depthLayers = Array.from(document.querySelectorAll<HTMLElement>("[data-landing-depth]"));

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }
          if (entry.target instanceof HTMLElement) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        }
      },
      {
        threshold: 0.18,
        rootMargin: "0px 0px -8% 0px",
      }
    );

    for (const section of sections) {
      observer.observe(section);
    }
  } else {
    for (const section of sections) {
      section.classList.add("is-visible");
    }
  }

  if (!hero) {
    return;
  }

  let ticking = false;

  const updateScrollDepth = () => {
    ticking = false;
    const viewportHeight = window.innerHeight || 1;

    if (hero) {
      const rect = hero.getBoundingClientRect();
      const progress = clamp((0 - rect.top) / Math.max(viewportHeight, 1), 0, 1);
      body.style.setProperty("--landing-hero-parallax", `${(progress * 18).toFixed(2)}px`);
    }

    nav?.classList.toggle("is-scrolled", window.scrollY > 12);

    for (const layer of depthLayers) {
      const rect = layer.getBoundingClientRect();
      const centered = clamp((rect.top + rect.height * 0.5 - viewportHeight * 0.55) / viewportHeight, -1, 1);
      const shift = clamp(centered * -12, -12, 12);
      layer.style.setProperty("--landing-depth-shift", `${shift.toFixed(2)}px`);
    }
  };

  const requestUpdate = () => {
    if (ticking) {
      return;
    }
    ticking = true;
    window.requestAnimationFrame(updateScrollDepth);
  };

  updateScrollDepth();
  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", requestUpdate);
}

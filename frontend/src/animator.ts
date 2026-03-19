import type { Effect, WasmStateDelta } from "./types";

const prefersReducedMotion =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let animationsEnabled = !prefersReducedMotion;
let pendingSummaryOnly = false;
let clikeAnimating = false;
let clikeToken = 0;
let clikeExitTimer: number | null = null;
let clikeEnterTimer: number | null = null;
let lastClikeMarkup = "";

function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

function clearTransientNodes() {
  document.querySelectorAll(".reg-fly, .memory-ripple").forEach((node) => node.remove());
}

function clearClikeTimers() {
  if (clikeExitTimer !== null) {
    window.clearTimeout(clikeExitTimer);
    clikeExitTimer = null;
  }
  if (clikeEnterTimer !== null) {
    window.clearTimeout(clikeEnterTimer);
    clikeEnterTimer = null;
  }
}

function cancelClikeAnimation() {
  clearClikeTimers();
  clikeToken += 1;
  clikeAnimating = false;
  document.getElementById("clike")?.classList.remove("clike-view--leaving", "clike-view--entering");
  document.getElementById("clikeCard")?.classList.remove("explainer-updated");
}

function regCell(reg: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.reg-cell[data-reg-index="${reg}"]`);
}

function disasmRow(pc: number, className: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.disasm-line.${className}[data-pc="${pc >>> 0}"]`);
}

function memoryByteCell(addr: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.memory-byte[data-byte-addr="${addr >>> 0}"]`);
}

function animateRegister(effect: Extract<Effect, { kind: "reg" }>) {
  if (effect.reg === 0) {
    return;
  }
  const cell = regCell(effect.reg);
  if (!cell) {
    return;
  }

  const rect = cell.getBoundingClientRect();
  const chip = document.createElement("div");
  chip.className = "reg-fly";
  chip.textContent = hex32(effect.before);
  chip.style.left = `${rect.left + rect.width / 2}px`;
  chip.style.top = `${rect.top - 6}px`;
  document.body.appendChild(chip);
  chip.addEventListener("animationend", () => chip.remove(), { once: true });
}

function animatePc(effect: Extract<Effect, { kind: "pc" }>) {
  const previousRow = disasmRow(effect.before, "disasm-pc-prev");
  const currentRow = disasmRow(effect.after, "disasm-pc-current");
  const container = document.getElementById("disasm");

  if (previousRow) {
    previousRow.classList.remove("disasm-prev-pulse");
    void previousRow.offsetWidth;
    previousRow.classList.add("disasm-prev-pulse");
  }

  if (currentRow) {
    currentRow.classList.remove("disasm-entering");
    void currentRow.offsetWidth;
    currentRow.classList.add("disasm-entering");

    if (container) {
      const containerRect = container.getBoundingClientRect();
      const rowRect = currentRow.getBoundingClientRect();
      if (rowRect.top < containerRect.top || rowRect.bottom > containerRect.bottom) {
        currentRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }
}

function animateMemory(effect: Extract<Effect, { kind: "mem" }>) {
  const cell = memoryByteCell(effect.addr);
  if (!cell) {
    return;
  }

  const ripple = document.createElement("span");
  ripple.className = "memory-ripple";
  cell.appendChild(ripple);
  ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
}

function animateClike(currentMarkup: string) {
  const clikeEl = document.getElementById("clike") as HTMLElement | null;
  const clikeCard = document.getElementById("clikeCard") as HTMLElement | null;
  if (!clikeEl || !clikeCard) {
    lastClikeMarkup = currentMarkup;
    return;
  }

  if (!lastClikeMarkup) {
    lastClikeMarkup = currentMarkup;
    return;
  }

  if (currentMarkup === lastClikeMarkup) {
    return;
  }

  if (clikeAnimating) {
    cancelClikeAnimation();
    clikeEl.innerHTML = currentMarkup;
    lastClikeMarkup = currentMarkup;
    return;
  }

  const previousMarkup = lastClikeMarkup;
  const nextMarkup = currentMarkup;
  const token = ++clikeToken;
  clikeAnimating = true;
  clikeEl.innerHTML = previousMarkup;
  clikeCard.classList.remove("explainer-updated");
  void clikeCard.offsetWidth;
  clikeCard.classList.add("explainer-updated");
  clikeEl.classList.remove("clike-view--entering", "clike-view--leaving");
  void clikeEl.offsetWidth;
  clikeEl.classList.add("clike-view--leaving");

  clikeExitTimer = window.setTimeout(() => {
    if (token !== clikeToken) {
      return;
    }
    clikeEl.classList.remove("clike-view--leaving");
    clikeEl.innerHTML = nextMarkup;
    void clikeEl.offsetWidth;
    clikeEl.classList.add("clike-view--entering");

    clikeEnterTimer = window.setTimeout(() => {
      if (token !== clikeToken) {
        return;
      }
      clikeEl.classList.remove("clike-view--entering");
      clikeCard.classList.remove("explainer-updated");
      clikeAnimating = false;
      lastClikeMarkup = nextMarkup;
      clearClikeTimers();
    }, 200);
  }, 150);
}

function animateLatestEffect() {
  const latest = document.querySelector<HTMLElement>("#effects .effect-entry--latest");
  if (!latest) {
    return;
  }
  latest.classList.remove("effect-entry--entering");
  void latest.offsetWidth;
  latest.classList.add("effect-entry--entering");
}

export function resetAnimator(): void {
  if (typeof document === "undefined") {
    return;
  }
  clearTransientNodes();
  cancelClikeAnimation();
  pendingSummaryOnly = false;
  lastClikeMarkup = (document.getElementById("clike") as HTMLElement | null)?.innerHTML ?? "";
}

export function setAnimationsEnabled(enabled: boolean): void {
  if (prefersReducedMotion) {
    animationsEnabled = false;
    pendingSummaryOnly = false;
    return;
  }

  if (!enabled) {
    animationsEnabled = false;
    pendingSummaryOnly = true;
    clearTransientNodes();
    cancelClikeAnimation();
    return;
  }

  animationsEnabled = true;
}

export function animateStep(delta: WasmStateDelta): void {
  if (typeof document === "undefined") {
    return;
  }

  const currentClikeMarkup = (document.getElementById("clike") as HTMLElement | null)?.innerHTML ?? "";
  const summaryOnly = pendingSummaryOnly;
  pendingSummaryOnly = false;

  if (!animationsEnabled || prefersReducedMotion || summaryOnly) {
    lastClikeMarkup = currentClikeMarkup;
    return;
  }

  for (const effect of delta.effects) {
    if (effect.kind === "reg") {
      animateRegister(effect);
    } else if (effect.kind === "pc") {
      animatePc(effect);
    } else if (effect.kind === "mem") {
      animateMemory(effect);
    }
  }

  animateClike(currentClikeMarkup);
  animateLatestEffect();
}

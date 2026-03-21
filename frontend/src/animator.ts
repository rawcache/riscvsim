import type { Effect, WasmStateDelta } from "./types";
import { stackFrameKey, type StackFrame } from "./stack-tracker";

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
  document.querySelectorAll(".stack-frame-block--ghost").forEach((node) => node.remove());
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

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function canAnimateStack(): boolean {
  return typeof document !== "undefined" && animationsEnabled && !prefersReducedMotion;
}

function stackFrameElement(frame: StackFrame, ghost = false): HTMLElement | null {
  const selector = ghost
    ? `.stack-frame-block[data-frame-key="${stackFrameKey(frame)}"][data-popping="true"]`
    : `.stack-frame-block[data-frame-key="${stackFrameKey(frame)}"]:not([data-popping="true"])`;
  return document.querySelector<HTMLElement>(selector);
}

function pulseHeaderBorder(header: HTMLElement | null, colorVar: string, duration: number): void {
  if (!header) {
    return;
  }

  const accent = cssVar(colorVar, cssVar("--accent", "#2d6be4"));
  const border = cssVar("--border", "#e2ddd6");
  header.animate(
    [
      { boxShadow: `inset 0 0 0 1px ${border}` },
      { boxShadow: `inset 0 0 0 1px ${accent}` },
      { boxShadow: `inset 0 0 0 1px ${border}` },
    ],
    {
      duration,
      easing: "ease-out",
    }
  );
}

function flashRowBackground(row: HTMLElement | null, colorVar: string, duration: number): void {
  if (!row) {
    return;
  }

  const start = cssVar(colorVar, cssVar("--highlight-new", "#fef3c7"));
  const end = window.getComputedStyle(row).backgroundColor;
  row.animate(
    [
      { backgroundColor: start },
      { backgroundColor: end },
    ],
    {
      duration,
      easing: "ease-out",
    }
  );
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

export function animateFramePush(frame: StackFrame): void {
  if (!canAnimateStack()) {
    return;
  }

  const frameEl = stackFrameElement(frame);
  if (!frameEl) {
    return;
  }

  frameEl.animate(
    [
      { opacity: 0, transform: "translateY(-20px)" },
      { opacity: 1, transform: "translateY(0)" },
    ],
    {
      duration: 350,
      easing: "cubic-bezier(0.34, 1.56, 0.64, 1)",
      fill: "both",
    }
  );

  const header = frameEl.querySelector<HTMLElement>(".stack-frame-header");
  pulseHeaderBorder(header, "--accent", 400);

  const slots = Array.from(frameEl.querySelectorAll<HTMLElement>(".stack-slot-row")).reverse();
  slots.forEach((slot, index) => {
    slot.animate(
      [
        { opacity: 0 },
        { opacity: 1 },
      ],
      {
        duration: 180,
        delay: index * 60,
        easing: "ease-out",
        fill: "both",
      }
    );
  });

  const spRow = frameEl.querySelector<HTMLElement>(".stack-sp-row");
  if (spRow) {
    spRow.animate(
      [
        { transform: "translateY(-8px)" },
        { transform: "translateY(0)" },
      ],
      {
        duration: 250,
        easing: "ease-out",
      }
    );
    flashRowBackground(spRow, "--highlight-new", 600);
  }
}

export function animateFramePop(frame: StackFrame): void {
  if (!canAnimateStack()) {
    return;
  }

  const frameEl = stackFrameElement(frame, true) ?? stackFrameElement(frame);
  if (!frameEl) {
    return;
  }

  const slots = Array.from(frameEl.querySelectorAll<HTMLElement>(".stack-slot-row"));
  slots.forEach((slot, index) => {
    slot.animate(
      [
        { opacity: 1 },
        { opacity: 0 },
      ],
      {
        duration: 160,
        delay: index * 40,
        easing: "ease-in",
        fill: "forwards",
      }
    );
  });

  const popAnimation = frameEl.animate(
    [
      { transform: "translateY(0)", opacity: 1 },
      { transform: "translateY(-16px)", opacity: 0 },
    ],
    {
      duration: 300,
      easing: "ease-in",
      fill: "forwards",
    }
  );

  popAnimation.addEventListener("finish", () => frameEl.remove(), { once: true });

  const currentHeader = document.querySelector<HTMLElement>(".stack-frame-block--current .stack-frame-header");
  pulseHeaderBorder(currentHeader, "--success", 400);

  const spRow = document.querySelector<HTMLElement>(".stack-frame-block--current .stack-sp-row");
  if (spRow) {
    spRow.animate(
      [
        { transform: "translateY(8px)" },
        { transform: "translateY(0)" },
      ],
      {
        duration: 250,
        easing: "ease-out",
      }
    );
    flashRowBackground(spRow, "--highlight-prev", 600);
  }
}

export function animateSlotWrite(address: number, _value: number): void {
  if (!canAnimateStack()) {
    return;
  }

  const row = document.querySelector<HTMLElement>(
    `.stack-frame-block--current .stack-slot-row[data-slot-address="${address >>> 0}"]`
  );
  if (!row) {
    return;
  }

  flashRowBackground(row, "--highlight-new", 300);

  const content = row.querySelector<HTMLElement>(".stack-slot-content");
  content?.animate(
    [
      { transform: "scale(1)" },
      { transform: "scale(1.05)" },
      { transform: "scale(1)" },
    ],
    {
      duration: 200,
      easing: "ease-out",
    }
  );

  if (row.classList.contains("stack-slot-row--new")) {
    row.animate(
      [
        { transform: "translateX(12px)", opacity: 0 },
        { transform: "translateX(0)", opacity: 1 },
      ],
      {
        duration: 250,
        easing: "ease-out",
        fill: "both",
      }
    );
  }
}

import type { ClipLine } from "./clip-dialogue";
import { recordDismissal, recordSpoken } from "./clip-dialogue";

type BubbleElements = {
  bubble: HTMLDivElement;
  text: HTMLDivElement;
  dismiss: HTMLButtonElement;
};

let bubbleElements: BubbleElements | null = null;
let activeLine: ClipLine | null = null;
let queue: ClipLine[] = [];
let hideTimer: number | null = null;
let removeTimer: number | null = null;

function clearBubbleTimers(): void {
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (removeTimer !== null) {
    window.clearTimeout(removeTimer);
    removeTimer = null;
  }
}

function ensureChipAnchor(): HTMLElement {
  const existing = document.getElementById("chip-wrapper");
  if (existing) {
    return existing;
  }

  const chip = document.createElement("div");
  chip.id = "chip-wrapper";
  chip.className = "clip-chip-anchor clip-chip-anchor--calm is-visible";
  chip.setAttribute("aria-hidden", "true");
  chip.innerHTML = `
    <div id="chip-reactor">
      <div id="chip-stage">
        <svg class="cpu-pet__svg" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="clipChipBodyGradient" x1="16" y1="16" x2="48" y2="48" gradientUnits="userSpaceOnUse">
              <stop offset="0%" style="stop-color: var(--chip-body-top)" />
              <stop offset="100%" style="stop-color: var(--chip-body-bottom)" />
            </linearGradient>
          </defs>
          <g class="cpu-pet__pins">
            <line x1="16" y1="22" x2="10" y2="22" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
            <line x1="16" y1="26" x2="10" y2="26" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
            <line x1="16" y1="30" x2="10" y2="30" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
            <line x1="16" y1="34" x2="10" y2="34" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
            <line x1="48" y1="22" x2="54" y2="22" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
            <line x1="48" y1="26" x2="54" y2="26" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
            <line x1="48" y1="30" x2="54" y2="30" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
            <line x1="48" y1="34" x2="54" y2="34" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
            <line x1="22" y1="16" x2="22" y2="10" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
            <line x1="26" y1="16" x2="26" y2="10" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
            <line x1="30" y1="16" x2="30" y2="10" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
            <line x1="34" y1="16" x2="34" y2="10" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
            <line x1="22" y1="48" x2="22" y2="54" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
            <line x1="26" y1="48" x2="26" y2="54" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
            <line x1="30" y1="48" x2="30" y2="54" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
            <line x1="34" y1="48" x2="34" y2="54" stroke="var(--chip-stroke)" stroke-width="2" stroke-linecap="round" />
          </g>
          <g>
            <circle class="cpu-pet__pin-dot" cx="10" cy="22" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 0ms" />
            <circle class="cpu-pet__pin-dot" cx="10" cy="26" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 200ms" />
            <circle class="cpu-pet__pin-dot" cx="10" cy="30" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 400ms" />
            <circle class="cpu-pet__pin-dot" cx="10" cy="34" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 600ms" />
            <circle class="cpu-pet__pin-dot" cx="54" cy="22" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 0ms" />
            <circle class="cpu-pet__pin-dot" cx="54" cy="26" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 200ms" />
            <circle class="cpu-pet__pin-dot" cx="54" cy="30" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 400ms" />
            <circle class="cpu-pet__pin-dot" cx="54" cy="34" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 600ms" />
            <circle class="cpu-pet__pin-dot" cx="22" cy="10" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 0ms" />
            <circle class="cpu-pet__pin-dot" cx="26" cy="10" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 200ms" />
            <circle class="cpu-pet__pin-dot" cx="30" cy="10" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 400ms" />
            <circle class="cpu-pet__pin-dot" cx="34" cy="10" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 600ms" />
            <circle class="cpu-pet__pin-dot" cx="22" cy="54" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 0ms" />
            <circle class="cpu-pet__pin-dot" cx="26" cy="54" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 200ms" />
            <circle class="cpu-pet__pin-dot" cx="30" cy="54" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 400ms" />
            <circle class="cpu-pet__pin-dot" cx="34" cy="54" r="1.5" fill="var(--chip-stroke)" opacity="0.5" style="--pin-delay: 600ms" />
          </g>
          <rect x="16" y="16" width="32" height="32" rx="4" ry="4" fill="url(#clipChipBodyGradient)" stroke="var(--chip-stroke)" stroke-width="2.2" />
          <rect x="22" y="22" width="20" height="20" rx="2" fill="var(--chip-die-fill)" stroke="var(--chip-stroke)" stroke-width="1.6" />
          <rect x="24" y="24" width="6" height="2" fill="var(--chip-stroke)" opacity="0.6" />
          <rect x="24" y="28" width="10" height="2" fill="var(--chip-stroke)" opacity="0.6" />
          <rect x="24" y="32" width="8" height="2" fill="var(--chip-stroke)" opacity="0.6" />
          <rect x="24" y="36" width="5" height="2" fill="var(--chip-stroke)" opacity="0.6" />
          <g class="cpu-pet__eye cpu-pet__eye--left">
            <circle cx="27" cy="30" r="2.4" fill="var(--text-primary)" />
            <circle cx="27" cy="30" r="1" fill="var(--accent)" />
          </g>
          <g class="cpu-pet__eye cpu-pet__eye--right">
            <circle cx="37" cy="30" r="2.4" fill="var(--text-primary)" />
            <circle cx="37" cy="30" r="1" fill="var(--accent)" />
          </g>
          <path class="cpu-pet__mouth cpu-pet__mouth--neutral" d="M 27 35 Q 32 38.5 37 35" stroke="var(--text-primary)" stroke-width="1.8" fill="none" stroke-linecap="round" />
          <path class="cpu-pet__mouth cpu-pet__mouth--happy" d="M 26 34.5 Q 32 40 38 34.5" stroke="var(--text-primary)" stroke-width="1.9" fill="none" stroke-linecap="round" />
        </svg>
      </div>
    </div>
  `;
  document.body.appendChild(chip);
  return chip;
}

function ensureBubbleElements(): BubbleElements {
  if (bubbleElements) {
    return bubbleElements;
  }

  const anchor = ensureChipAnchor();
  const bubble = document.createElement("div");
  bubble.id = "clip-bubble";
  bubble.className = "clip-bubble";
  bubble.hidden = true;
  bubble.innerHTML = `
    <div class="clip-bubble__text"></div>
    <button class="clip-bubble__dismiss" aria-label="Dismiss">×</button>
    <div class="clip-bubble__tail"></div>
  `;
  anchor.insertAdjacentElement("afterend", bubble);

  const text = bubble.querySelector(".clip-bubble__text");
  const dismiss = bubble.querySelector(".clip-bubble__dismiss");
  if (!(text instanceof HTMLDivElement) || !(dismiss instanceof HTMLButtonElement)) {
    throw new Error("Clip bubble failed to initialize.");
  }

  dismiss.addEventListener("click", () => {
    recordDismissal();
    queue = [];
    hideBubble(true);
  });

  bubbleElements = { bubble, text, dismiss };
  return bubbleElements;
}

function flushNext(): void {
  activeLine = null;
  if (queue.length > 0) {
    const next = queue.shift();
    if (next) {
      showClipLine(next);
    }
  }
}

function hideBubble(immediate = false): void {
  const elements = bubbleElements;
  if (!elements) {
    return;
  }
  clearBubbleTimers();
  const { bubble } = elements;
  if (immediate) {
    bubble.hidden = true;
    bubble.classList.remove("is-entering", "is-leaving");
    flushNext();
    return;
  }
  bubble.classList.remove("is-entering");
  bubble.classList.add("is-leaving");
  removeTimer = window.setTimeout(() => {
    bubble.hidden = true;
    bubble.classList.remove("is-leaving");
    flushNext();
  }, 200);
}

function renderLine(line: ClipLine): void {
  const { bubble, text } = ensureBubbleElements();
  clearBubbleTimers();
  activeLine = line;
  text.textContent = line.text;
  bubble.hidden = false;
  bubble.classList.remove("is-leaving");
  bubble.classList.remove("is-entering");
  void bubble.offsetWidth;
  bubble.classList.add("is-entering");
  recordSpoken();
  hideTimer = window.setTimeout(() => {
    hideBubble();
  }, line.duration);
}

export function showClipLine(line: ClipLine): void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }
  if (window.location.pathname.startsWith("/quiz")) {
    return;
  }
  if (activeLine) {
    queue.push(line);
    return;
  }
  renderLine(line);
}

export function initClipBubble(): void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }
  ensureBubbleElements();
}

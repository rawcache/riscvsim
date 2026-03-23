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
  chip.className = "clip-chip-anchor";
  chip.setAttribute("aria-hidden", "true");
  const chipIconUrl = new URL("../favicon-chip.svg", import.meta.url).href;
  chip.innerHTML = `<img class="clip-chip-anchor__image" src="${chipIconUrl}" alt="" />`;
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

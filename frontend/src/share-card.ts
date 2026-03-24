import { showNotification } from "./notifications";
import "./styles/share-card.css";

export interface ShareCard {
  variant: "lesson" | "challenge" | "quiz" | "rank";
  title: string;
  subtitle: string;
  stats: Array<{ label: string; value: string }>;
  badge?: string;
  streakDays?: number;
  accentColor: string;
}

type Html2CanvasFn = (element: HTMLElement) => Promise<HTMLCanvasElement>;

declare global {
  interface Window {
    html2canvas?: Html2CanvasFn;
  }
}

const HTML2CANVAS_SRC = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";

function statItem(label: string, value: string): HTMLElement {
  const item = document.createElement("div");
  item.className = "share-card__stat";

  const labelEl = document.createElement("span");
  labelEl.className = "share-card__stat-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("span");
  valueEl.className = "share-card__stat-value";
  valueEl.textContent = value;

  item.append(labelEl, valueEl);
  return item;
}

async function loadHtml2Canvas(): Promise<Html2CanvasFn> {
  if (typeof window === "undefined") {
    throw new Error("html2canvas requires a browser environment");
  }

  if (window.html2canvas) {
    return window.html2canvas;
  }

  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-html2canvas="1"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load html2canvas")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = HTML2CANVAS_SRC;
    script.async = true;
    script.dataset.html2canvas = "1";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Failed to load html2canvas")), { once: true });
    document.head.appendChild(script);
  });

  if (!window.html2canvas) {
    throw new Error("html2canvas did not initialize");
  }

  return window.html2canvas;
}

export function generateShareCard(card: ShareCard): HTMLElement {
  const root = document.createElement("div");
  root.className = "share-card";
  root.dataset.variant = card.variant;
  root.dataset.theme = "dark";
  root.style.setProperty("--share-card-accent", card.accentColor);

  const header = document.createElement("div");
  header.className = "share-card__header";

  const brand = document.createElement("span");
  brand.className = "share-card__brand";
  brand.textContent = "StudyRISC-V";

  const badge = document.createElement("span");
  badge.className = "share-card__badge";
  badge.textContent = card.badge ?? "🐝";

  header.append(brand, badge);

  const body = document.createElement("div");
  body.className = "share-card__body";

  const check = document.createElement("div");
  check.className = "share-card__check";
  check.textContent = "✓";

  const title = document.createElement("div");
  title.className = "share-card__title";
  title.textContent = card.title;

  const subtitle = document.createElement("div");
  subtitle.className = "share-card__subtitle";
  subtitle.textContent = card.subtitle;

  body.append(check, title, subtitle);

  const stats = document.createElement("div");
  stats.className = "share-card__stats";
  card.stats.forEach((entry) => stats.appendChild(statItem(entry.label, entry.value)));

  const footer = document.createElement("div");
  footer.className = "share-card__footer";

  const streak = document.createElement("span");
  streak.className = "share-card__streak";
  streak.textContent = card.streakDays && card.streakDays > 0 ? `${card.streakDays} day streak 🔥` : "studyriscv.com";

  const url = document.createElement("span");
  url.className = "share-card__url";
  url.textContent = "studyriscv.com";

  footer.append(streak, url);
  root.append(header, body, stats, footer);
  return root;
}

export async function downloadCardAsPNG(card: ShareCard, filename: string): Promise<void> {
  const element = generateShareCard(card);
  element.classList.add("share-card--capture");
  document.body.appendChild(element);

  try {
    const html2canvas = await loadHtml2Canvas();
    const canvas = await html2canvas(element);
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = filename;
    link.click();
  } catch {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      // Ignore clipboard failures and still show the fallback toast.
    }
    showNotification({
      id: `share-card-fallback-${Date.now()}`,
      type: "lesson",
      title: "Share link copied",
      message: "PNG export failed, so the permalink was copied instead.",
      icon: "🔗",
      duration: 4000,
      accentColor: "var(--accent)",
    });
  } finally {
    element.remove();
  }
}

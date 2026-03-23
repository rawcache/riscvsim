export interface Notification {
  id: string;
  type: "xp" | "badge" | "streak" | "lesson" | "challenge" | "quiz" | "lab" | "level-up";
  title: string;
  message: string;
  icon: string;
  duration: number;
  accentColor: string;
}

const CONTAINER_ID = "notification-container";
const MAX_VISIBLE_TOASTS = 3;

type ToastRecord = {
  id: string;
  element: HTMLElement;
  timer: number | null;
};

const activeToasts: ToastRecord[] = [];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ensureContainer(): HTMLElement | null {
  if (typeof document === "undefined") {
    return null;
  }

  let container = document.getElementById(CONTAINER_ID);
  if (container) {
    return container;
  }

  container = document.createElement("div");
  container.id = CONTAINER_ID;
  container.setAttribute("aria-live", "polite");
  container.style.position = "fixed";
  container.style.top = "80px";
  container.style.right = "24px";
  container.style.zIndex = "1200";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.gap = "8px";
  container.style.pointerEvents = "none";
  document.body.appendChild(container);
  return container;
}

function levelUpConfettiMarkup(): string {
  return Array.from({ length: 10 }, (_, index) => {
    const left = 8 + index * 9;
    const delay = index * 0.08;
    const hue = 210 + index * 12;
    return `<span style="position:absolute;top:-6px;left:${left}%;width:6px;height:6px;border-radius:1px;background:hsl(${hue} 80% 62%);opacity:0;animation:notification-confetti 1.6s ease ${delay}s forwards;"></span>`;
  }).join("");
}

function createToast(notification: Notification): HTMLElement {
  const toast = document.createElement("div");
  toast.className = `notification-toast notification-toast--${notification.type}`;
  toast.dataset.notificationId = notification.id;
  toast.style.position = "relative";
  toast.style.width = notification.type === "level-up" ? "360px" : "320px";
  toast.style.maxWidth = "calc(100vw - 32px)";
  toast.style.background = "var(--bg-elevated)";
  toast.style.border = `1px solid color-mix(in srgb, ${notification.accentColor} 30%, transparent)`;
  toast.style.borderLeft = `3px solid ${notification.accentColor}`;
  toast.style.borderRadius = "10px";
  toast.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.3)";
  toast.style.padding = "12px 16px";
  toast.style.display = "flex";
  toast.style.gap = "12px";
  toast.style.alignItems = "flex-start";
  toast.style.pointerEvents = "auto";
  toast.style.opacity = "0";
  toast.style.transform = "translateX(24px)";
  toast.style.animation = "notification-slide-in 300ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards";
  toast.innerHTML = `
    ${notification.type === "level-up" ? `<div aria-hidden="true">${levelUpConfettiMarkup()}</div>` : ""}
    <div style="width:36px;height:36px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb, ${notification.accentColor} 12%, transparent);color:${notification.accentColor};flex-shrink:0;font-size:18px;">
      ${notification.icon}
    </div>
    <div style="min-width:0;display:flex;flex-direction:column;gap:4px;flex:1 1 auto;">
      <div style="color:var(--text-primary);font-family:var(--font-body);font-size:14px;font-weight:600;line-height:1.3;">${escapeHtml(notification.title)}</div>
      <div style="color:var(--text-secondary);font-family:var(--font-body);font-size:13px;line-height:1.45;">${escapeHtml(notification.message)}</div>
    </div>
    <button type="button" aria-label="Dismiss notification" style="border:none;background:none;color:var(--text-muted);cursor:pointer;font-size:12px;line-height:1;padding:0;">✕</button>
  `;

  const dismissButton = toast.querySelector("button");
  dismissButton?.addEventListener("click", () => dismissToast(notification.id));
  return toast;
}

function removeRecord(id: string): ToastRecord | null {
  const index = activeToasts.findIndex((record) => record.id === id);
  if (index < 0) {
    return null;
  }
  const [record] = activeToasts.splice(index, 1);
  if (record.timer !== null) {
    window.clearTimeout(record.timer);
  }
  return record;
}

function dismissToast(id: string, immediate = false): void {
  if (typeof document === "undefined") {
    return;
  }

  const record = removeRecord(id);
  if (!record) {
    return;
  }

  if (immediate) {
    record.element.remove();
    return;
  }

  record.element.style.animation = "notification-slide-out 200ms ease-in forwards";
  window.setTimeout(() => {
    record.element.remove();
  }, 210);
}

export function showNotification(input: Notification): void {
  if (typeof document === "undefined") {
    return;
  }

  const container = ensureContainer();
  if (!container) {
    return;
  }

  const existing = activeToasts.find((record) => record.id === input.id);
  if (existing) {
    dismissToast(existing.id);
  }

  while (activeToasts.length >= MAX_VISIBLE_TOASTS) {
    dismissToast(activeToasts[0]?.id ?? "", true);
  }

  const toast = createToast({
    ...input,
    duration: input.duration > 0 ? input.duration : 4000,
  });
  container.appendChild(toast);

  const record: ToastRecord = {
    id: input.id,
    element: toast,
    timer: window.setTimeout(() => dismissToast(input.id), input.duration > 0 ? input.duration : 4000),
  };

  activeToasts.push(record);

  if (!document.getElementById("notification-style-tag")) {
    const style = document.createElement("style");
    style.id = "notification-style-tag";
    style.textContent = `
      @keyframes notification-slide-in {
        from { opacity: 0; transform: translateX(24px); }
        to { opacity: 1; transform: translateX(0); }
      }
      @keyframes notification-slide-out {
        from { opacity: 1; transform: translateX(0); }
        to { opacity: 0; transform: translateX(24px); }
      }
      @keyframes notification-confetti {
        0% { opacity: 0; transform: translateY(0) rotate(0deg); }
        15% { opacity: 1; }
        100% { opacity: 0; transform: translateY(42px) rotate(220deg); }
      }
    `;
    document.head.appendChild(style);
  }
}

import { hex32 } from "./format";
import type { Effect } from "./types";

type RegisterFormat = "hex" | "dec" | "uint" | "asc" | "flt";

type RenderPayload = {
  regs?: number[];
  effects?: Effect[];
  previousEffects?: Effect[];
  running?: boolean;
};

const FORMAT_STORAGE_KEY = "studyriscv_reg_format";
const BEGINNER_STORAGE_KEY = "studyriscv_beginner_mode";
const BEGINNER_REGS = [0, 1, 2, 10, 11, 12, 5, 6, 7];
const ABI_NAMES = [
  "zero",
  "ra",
  "sp",
  "gp",
  "tp",
  "t0",
  "t1",
  "t2",
  "s0/fp",
  "s1",
  "a0",
  "a1",
  "a2",
  "a3",
  "a4",
  "a5",
  "a6",
  "a7",
  "s2",
  "s3",
  "s4",
  "s5",
  "s6",
  "s7",
  "s8",
  "s9",
  "s10",
  "s11",
  "t3",
  "t4",
  "t5",
  "t6",
] as const;

function loadFormat(): RegisterFormat {
  try {
    const stored = window.localStorage.getItem(FORMAT_STORAGE_KEY);
    if (stored === "dec" || stored === "uint" || stored === "asc" || stored === "flt" || stored === "hex") {
      return stored;
    }
  } catch {
    // Ignore storage failures and use the default.
  }
  return "hex";
}

function loadBeginnerMode(): boolean {
  try {
    const stored = window.localStorage.getItem(BEGINNER_STORAGE_KEY);
    return stored !== "false";
  } catch {
    return true;
  }
}

function saveFormat(format: RegisterFormat): void {
  try {
    window.localStorage.setItem(FORMAT_STORAGE_KEY, format);
  } catch {
    // Ignore storage failures.
  }
}

function saveBeginnerMode(enabled: boolean): void {
  try {
    window.localStorage.setItem(BEGINNER_STORAGE_KEY, String(enabled));
  } catch {
    // Ignore storage failures.
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function asSigned(value: number): number {
  return value | 0;
}

function formatAscii(value: number): string | null {
  const bytes = [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
  const printable = bytes.every((byte) => byte === 0 || (byte >= 32 && byte <= 126));
  if (!printable) {
    return null;
  }
  return `'${bytes
    .map((byte) => {
      if (byte === 0) return "\\0";
      return String.fromCharCode(byte);
    })
    .join("")}'`;
}

function formatFloat(value: number): string | null {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, value >>> 0, true);
  const float = view.getFloat32(0, true);
  if (!Number.isFinite(float)) {
    return value === 0x7f800000 ? "inf" : value === 0xff800000 ? "-inf" : null;
  }
  if (float === 0) {
    return "0.0";
  }
  return Math.abs(float) >= 1e-6 && Math.abs(float) < 1e8 ? `${Number(float.toPrecision(6))}` : null;
}

function formatPrimary(value: number, format: RegisterFormat): string {
  switch (format) {
    case "dec":
      return String(asSigned(value));
    case "uint":
      return String(value >>> 0);
    case "asc":
      return formatAscii(value) ?? hex32(value);
    case "flt":
      return formatFloat(value) ?? hex32(value);
    case "hex":
    default:
      return hex32(value);
  }
}

function tooltipLines(value: number): string[] {
  const ascii = formatAscii(value);
  const float = formatFloat(value);
  return [
    `hex:   ${hex32(value)}`,
    `dec:   ${asSigned(value)}`,
    `udec:  ${value >>> 0}`,
    `float: ${float ?? "—"}`,
    `ascii: ${ascii ?? "—"}`,
    `bin:   0b${(value & 0xff).toString(2).padStart(8, "0")}`,
  ];
}

function formatDiff(effect: Extract<Effect, { kind: "reg" }> | undefined): string {
  if (!effect) {
    return "";
  }
  return `<div class="reg-diff-old">${hex32(effect.before)}</div>`;
}

function directionBadge(index: number, effect: Extract<Effect, { kind: "reg" }> | undefined): string {
  if (!effect) {
    return "";
  }
  if (index === 2) {
    const direction = effect.after < effect.before ? "down" : effect.after > effect.before ? "up" : "";
    if (direction === "down") {
      return '<span class="reg-diff-arrow reg-diff-arrow--down">↓</span>';
    }
    if (direction === "up") {
      return '<span class="reg-diff-arrow reg-diff-arrow--up">↑</span>';
    }
  }
  if (index === 1) {
    return `<span class="reg-diff-ra">→ ${hex32(effect.after)}</span>`;
  }
  return "";
}

export function createRegistersUi(root: HTMLElement) {
  let format: RegisterFormat = loadFormat();
  let beginnerMode = loadBeginnerMode();
  let lastPayload: RenderPayload = { regs: Array.from({ length: 32 }, () => 0) };
  let hiddenChangeTimer: number | null = null;

  function render(payload: RenderPayload = lastPayload): void {
    lastPayload = payload;
    const regs = payload.regs && payload.regs.length === 32 ? payload.regs : Array.from({ length: 32 }, () => 0);
    const currentEffects = new Map<number, Extract<Effect, { kind: "reg" }>>();
    const previousRegs = new Set<number>();

    for (const effect of payload.effects ?? []) {
      if (effect.kind === "reg") {
        currentEffects.set(effect.reg, effect);
      }
    }
    for (const effect of payload.previousEffects ?? []) {
      if (effect.kind === "reg") {
        previousRegs.add(effect.reg);
      }
    }

    if (beginnerMode && Array.from(currentEffects.keys()).some((index) => !BEGINNER_REGS.includes(index))) {
      if (hiddenChangeTimer !== null) {
        window.clearTimeout(hiddenChangeTimer);
      }
      hiddenChangeTimer = window.setTimeout(() => {
        root.querySelector(".regs-show-all")?.classList.remove("is-flashing");
        hiddenChangeTimer = null;
      }, 1000);
    }

    const visible = beginnerMode ? BEGINNER_REGS : Array.from({ length: 32 }, (_, index) => index);
    const viewClass = beginnerMode ? "regs-grid regs-grid--beginner" : "regs-grid regs-grid--full";

    root.innerHTML = `
      <div class="regs-toolbar">
        <div class="regs-format-toggle" role="tablist" aria-label="Register display format">
          ${(["hex", "dec", "uint", "asc", "flt"] as RegisterFormat[])
            .map(
              (candidate) => `
                <button
                  type="button"
                  class="regs-format-button${candidate === format ? " is-active" : ""}"
                  data-format="${candidate}"
                >${candidate.toUpperCase()}</button>
              `
            )
            .join("")}
        </div>
        <button type="button" class="regs-beginner-toggle${beginnerMode ? " is-active" : ""}">
          👁 Beginner
        </button>
      </div>
      <div class="regs-running-overlay${payload.running ? " is-visible" : ""}">Running…</div>
      <div class="${viewClass}">
        ${visible
          .map((index) => {
            const value = regs[index] >>> 0;
            const effect = currentEffects.get(index);
            const classes = ["reg-card"];
            if (effect) {
              classes.push("is-changed");
            } else if (previousRegs.has(index)) {
              classes.push("was-changed");
            }
            if (index === 0) {
              classes.push("is-zero");
            }
            return `
              <div class="${classes.join(" ")}" data-reg="${index}">
                <div class="reg-card__meta">
                  <div class="reg-card__abi">${ABI_NAMES[index]}</div>
                  <div class="reg-card__x">x${index}</div>
                </div>
                <div class="reg-card__value-wrap">
                  ${formatDiff(effect)}
                  <div class="reg-card__value">${escapeHtml(formatPrimary(value, format))}</div>
                  ${directionBadge(index, effect)}
                </div>
                <div class="reg-card__tooltip">
                  ${tooltipLines(value)
                    .map((line) => `<div>${escapeHtml(line)}</div>`)
                    .join("")}
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
      ${
        beginnerMode
          ? `<button type="button" class="regs-show-all${Array.from(currentEffects.keys()).some((index) => !BEGINNER_REGS.includes(index)) ? " is-flashing" : ""}">Show all 32 registers ↓</button>`
          : ""
      }
    `;

    root.querySelectorAll<HTMLButtonElement>(".regs-format-button").forEach((button) => {
      button.addEventListener("click", () => {
        format = button.dataset.format as RegisterFormat;
        saveFormat(format);
        render(lastPayload);
      });
    });

    root.querySelector<HTMLButtonElement>(".regs-beginner-toggle")?.addEventListener("click", () => {
      beginnerMode = !beginnerMode;
      saveBeginnerMode(beginnerMode);
      render(lastPayload);
    });

    root.querySelector<HTMLButtonElement>(".regs-show-all")?.addEventListener("click", () => {
      beginnerMode = false;
      saveBeginnerMode(false);
      render(lastPayload);
    });
  }

  return {
    render,
    setRunningOverlay(active: boolean) {
      render({ ...lastPayload, running: active });
    },
  };
}

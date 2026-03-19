import type { Effect, Trap } from "./types";

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

const TRAP_CAUSE_CODES: Record<string, number> = {
  instruction_address_misaligned: 0,
  instruction_access_fault: 1,
  illegal_instruction: 2,
  breakpoint: 3,
  load_address_misaligned: 4,
  load_access_fault: 5,
  store_address_misaligned: 6,
  store_access_fault: 7,
  environment_call: 11,
};

const TRAP_LABELS: Record<string, string> = {
  environment_call: "ecall",
  breakpoint: "ebreak",
};

export type ClikeExpressionParts = {
  dest: string;
  op: string;
  src: string;
};

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function hex32(n: number): string {
  const u = n >>> 0;
  return "0x" + u.toString(16).padStart(8, "0");
}

export function hex8(n: number): string {
  return (n & 0xff).toString(16).padStart(2, "0");
}

export function fmtBytes(bytes?: number[]): string {
  if (!bytes || bytes.length === 0) return "[]";
  return (
    "[" +
    bytes.map((b) => "0x" + (b & 0xff).toString(16).padStart(2, "0")).join(" ") +
    "]"
  );
}

export function trapCauseCode(cause: string | undefined): number | undefined {
  if (!cause) return undefined;
  return TRAP_CAUSE_CODES[cause];
}

export function fmtEffect(effect: Effect): string {
  switch (effect.kind) {
    case "pc":
      return `PC ${hex32(effect.before)} → ${hex32(effect.after)}`;
    case "reg":
      return `x${effect.reg} ${hex32(effect.before)} → ${hex32(effect.after)}`;
    case "mem":
      return `mem[${hex32(effect.addr)}] 0x${hex8(effect.before)} → 0x${hex8(effect.after)}`;
  }
}

export function fmtTrap(trap: Trap): string {
  const causeLabel = TRAP_LABELS[trap.cause] ?? trap.cause;
  const causeCode = trapCauseCode(trap.cause);
  const causeText = causeCode !== undefined ? `cause=${causeCode}` : `cause=${trap.cause}`;
  return `TRAP ${causeLabel} (${causeText})`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function renderRegs(
  regs?: number[],
  changedNow: ReadonlySet<number> = new Set<number>(),
  changedPrev: ReadonlySet<number> = new Set<number>()
): string {
  const safeRegs = regs && regs.length === 32 ? regs : Array.from({ length: 32 }, () => 0);
  const renderColumn = (start: number) =>
    Array.from({ length: 16 }, (_, offset) => start + offset)
      .map((index) => {
        const value = safeRegs[index] >>> 0;
        const signedValue = value | 0;
        const classes = ["reg-cell"];
        if (index === 0) {
          classes.push("reg-cell--zero");
        } else if (changedNow.has(index)) {
          classes.push("reg-changed-now");
        } else if (changedPrev.has(index)) {
          classes.push("reg-changed-prev");
        }
        return `
          <div class="${classes.join(" ")}" data-reg-index="${index}" data-tooltip="dec: ${signedValue}  udec: ${value}">
            <span class="reg-meta">
              <span class="reg-abi">${ABI_NAMES[index]}</span>
              <span class="reg-name">x${index}</span>
            </span>
            <span class="reg-value">${hex32(value)}</span>
          </div>
        `;
      })
      .join("");

  return `
    <div class="regs-column regs-column--left">${renderColumn(0)}</div>
    <div class="regs-column regs-column--right">${renderColumn(16)}</div>
  `;
}

export function formatClikeExpression(expression?: string): ClikeExpressionParts | null {
  const normalized = expression?.trim() ?? "";
  if (!normalized) {
    return null;
  }

  const match = /^(.*?)=(.*?)(;?)$/.exec(normalized);
  if (!match) {
    return {
      dest: "",
      op: "",
      src: normalized,
    };
  }

  const lhs = match[1].trim();
  const rhs = match[2].trim();
  const suffix = match[3] || "";
  return {
    dest: lhs,
    op: lhs ? " = " : "",
    src: `${rhs}${suffix}`.trim(),
  };
}

export function renderClikeExpression(parts?: ClikeExpressionParts | null): string {
  if (!parts) {
    return '<span class="clike-empty">Step a program to inspect the current instruction.</span>';
  }

  if (!parts.dest && !parts.op) {
    return `<span class="pc-src">${escapeHtml(parts.src)}</span>`;
  }

  return `
    <span class="pc-dest">${escapeHtml(parts.dest)}</span>
    <span class="pc-op">${escapeHtml(parts.op)}</span>
    <span class="pc-src">${escapeHtml(parts.src)}</span>
  `;
}

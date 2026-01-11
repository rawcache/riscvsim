import type { Effect } from "./types";

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

export function fmtEffect(e: Effect): string {
  if (e.kind === "pc") {
    return `PC ${hex32(e.before ?? 0)} -> ${hex32(e.after ?? 0)}`;
  }
  if (e.kind === "reg") {
    return `REG x${e.reg ?? -1} ${hex32(e.before ?? 0)} -> ${hex32(e.after ?? 0)}`;
  }
  if (e.kind === "mem") {
    return `MEM [${hex32(e.addr ?? 0)}] ${fmtBytes(e.beforeBytes)} -> ${fmtBytes(
      e.afterBytes
    )}`;
  }
  return `Effect(${e.kind})`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function renderRegs(regs?: number[]): string {
  if (!regs || regs.length !== 32) return "";
  const lines: string[] = [];
  for (let i = 0; i < 32; i++) {
    lines.push(`x${i.toString().padStart(2, "0")}: ${hex32(regs[i])}`);
  }
  return lines.join("\n");
}

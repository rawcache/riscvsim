import type { Effect } from "./types";
import { clamp, fmtBytes, hex32, hex8 } from "./format";

const MEM_SIZE = 64 * 1024;
const WINDOW_BYTES = 128;
const BYTES_PER_ROW = 16;
const MAX_RECENT_WRITES = 8;

type MemoryView = {
  reset: () => void;
  applyEffects: (effects: Effect[]) => void;
  renderWindow: (anchor: number) => string;
  getRecentWrites: () => string[];
  getLastAddr: () => number | undefined;
};

export function createMemoryView(): MemoryView {
  const memBytes = new Map<number, number>();
  let recentWrites: string[] = [];
  let lastMemAddr: number | undefined;

  function formatWriteEffect(e: Effect): string {
    const addr = e.addr ?? 0;
    const size = e.size ?? e.afterBytes?.length ?? 0;
    return `${hex32(addr)} (${size}b) ${fmtBytes(e.beforeBytes)} -> ${fmtBytes(e.afterBytes)}`;
  }

  function applyEffects(effects: Effect[]) {
    for (const effect of effects) {
      if (effect.kind !== "mem" || effect.addr === undefined || !effect.afterBytes) continue;
      const base = effect.addr >>> 0;
      effect.afterBytes.forEach((value, idx) => {
        const addr = base + idx;
        if (addr >= 0 && addr < MEM_SIZE) {
          memBytes.set(addr, value & 0xff);
        }
      });
      recentWrites.unshift(formatWriteEffect(effect));
      if (recentWrites.length > MAX_RECENT_WRITES) {
        recentWrites = recentWrites.slice(0, MAX_RECENT_WRITES);
      }
      lastMemAddr = base;
    }
  }

  function renderWindow(anchor: number): string {
    const windowStart = clamp(anchor - Math.floor(WINDOW_BYTES / 4), 0, MEM_SIZE - WINDOW_BYTES);
    const lines: string[] = [];
    lines.push(`base ${hex32(windowStart)} (16 bytes/row)`);
    for (let offset = 0; offset < WINDOW_BYTES; offset += BYTES_PER_ROW) {
      const addr = windowStart + offset;
      const bytes: string[] = [];
      for (let i = 0; i < BYTES_PER_ROW; i++) {
        const value = memBytes.get(addr + i) ?? 0;
        bytes.push(hex8(value));
      }
      lines.push(`${hex32(addr)}: ${bytes.join(" ")}`);
    }
    return lines.join("\n");
  }

  function reset() {
    memBytes.clear();
    recentWrites = [];
    lastMemAddr = undefined;
  }

  return {
    reset,
    applyEffects,
    renderWindow,
    getRecentWrites: () => recentWrites,
    getLastAddr: () => lastMemAddr,
  };
}

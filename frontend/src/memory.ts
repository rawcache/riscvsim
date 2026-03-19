import type { Effect } from "./types";
import { fmtBytes, hex32, hex8 } from "./format";

const WINDOW_BYTES = 32;
const BYTES_PER_ROW = 8;
const MAX_RECENT_WRITES = 8;

type MemoryView = {
  reset: () => void;
  seedBytes: (start: number, bytes: Uint8Array) => void;
  applyEffects: (effects: Effect[]) => void;
  renderWindow: (base: number) => string;
  getRecentWrites: () => string[];
  getLastAddr: () => number | undefined;
};

export function createMemoryView(): MemoryView {
  const memBytes = new Map<number, number>();
  let recentWrites: string[] = [];
  let lastMemAddr: number | undefined;
  let currentWriteAddrs = new Set<number>();
  let previousWriteAddrs = new Set<number>();

  function isMemEffect(effect: Effect): effect is Extract<Effect, { kind: "mem" }> {
    return effect.kind === "mem";
  }

  function formatWriteEffects(effects: Extract<Effect, { kind: "mem" }>[]): string {
    if (effects.length === 0) return "";

    const sorted = [...effects].sort((a, b) => a.addr - b.addr);
    const segments: Extract<Effect, { kind: "mem" }>[][] = [];
    for (const effect of sorted) {
      const current = segments[segments.length - 1];
      if (!current || effect.addr !== current[current.length - 1].addr + 1) {
        segments.push([effect]);
      } else {
        current.push(effect);
      }
    }

    return segments
      .map((segment) => {
        const addr = segment[0].addr;
        const beforeBytes = segment.map((effect) => effect.before);
        const afterBytes = segment.map((effect) => effect.after);
        return `mem[${hex32(addr)}] ${fmtBytes(beforeBytes)} → ${fmtBytes(afterBytes)}`;
      })
      .join(" · ");
  }

  function applyEffects(effects: Effect[]) {
    const memEffects = effects.filter(isMemEffect);
    previousWriteAddrs = currentWriteAddrs;
    currentWriteAddrs = new Set<number>();

    for (const effect of memEffects) {
      const addr = effect.addr >>> 0;
      memBytes.set(addr, effect.after & 0xff);
      currentWriteAddrs.add(addr);
    }

    if (memEffects.length > 0) {
      const sorted = [...memEffects].sort((a, b) => a.addr - b.addr);
      recentWrites.unshift(formatWriteEffects(sorted));
      if (recentWrites.length > MAX_RECENT_WRITES) {
        recentWrites = recentWrites.slice(0, MAX_RECENT_WRITES);
      }
      lastMemAddr = sorted[0].addr >>> 0;
    }
  }

  function seedBytes(start: number, bytes: Uint8Array) {
    const base = start >>> 0;
    for (let index = 0; index < bytes.length; index++) {
      memBytes.set((base + index) >>> 0, bytes[index] & 0xff);
    }
  }

  function renderWindow(base: number): string {
    const windowStart = (base >>> 0) & ~0x7;
    const rows: string[] = [];

    for (let rowOffset = 0; rowOffset < WINDOW_BYTES; rowOffset += BYTES_PER_ROW) {
      const rowAddr = (windowStart + rowOffset) >>> 0;
      const cells: string[] = [];
      for (let column = 0; column < BYTES_PER_ROW; column++) {
        const addr = (rowAddr + column) >>> 0;
        const value = memBytes.get(addr);
        const classes = ["memory-byte"];
        const display = value === undefined ? "--" : hex8(value);
        if (value === undefined) {
          classes.push("memory-byte--empty");
        }
        if (currentWriteAddrs.has(addr)) {
          classes.push("memory-byte--current");
        } else if (previousWriteAddrs.has(addr)) {
          classes.push("memory-byte--prev");
        }
        cells.push(
          `<span class="${classes.join(" ")}" data-byte-addr="${addr}" title="${hex32(addr)} = ${value === undefined ? "uninitialized" : `0x${hex8(value)}`}">${display}</span>`
        );
      }

      rows.push(`
        <div class="memory-row">
          <span class="memory-row__addr">${hex32(rowAddr)}</span>
          <div class="memory-row__bytes">${cells.join("")}</div>
        </div>
      `);
    }

    return rows.join("");
  }

  function reset() {
    memBytes.clear();
    recentWrites = [];
    lastMemAddr = undefined;
    currentWriteAddrs = new Set<number>();
    previousWriteAddrs = new Set<number>();
  }

  return {
    reset,
    seedBytes,
    applyEffects,
    renderWindow,
    getRecentWrites: () => recentWrites,
    getLastAddr: () => lastMemAddr,
  };
}

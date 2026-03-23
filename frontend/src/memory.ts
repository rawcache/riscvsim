import type { Effect } from "./types";
import { hex32, hex8 } from "./format";

const WINDOW_BYTES = 32;
const BYTES_PER_ROW = 8;
const MAX_RECENT_WRITES = 10;
const MAX_WATCHES = 4;

export type MemoryViewMode = "bytes" | "words" | "ascii" | "stack";
export type MemoryWordFormat = "hex" | "dec" | "uint";

export type RecentWrite = {
  address: number;
  before: number;
  after: number;
  step: number;
};

type MemoryView = {
  reset: () => void;
  seedBytes: (start: number, bytes: Uint8Array) => void;
  applyEffects: (effects: Effect[], stepNumber?: number) => void;
  renderWindow: (
    base: number,
    options?: {
      mode?: MemoryViewMode;
      wordFormat?: MemoryWordFormat;
      sp?: number;
    }
  ) => string;
  renderWatches: (wordFormat?: MemoryWordFormat) => string;
  setWatchedAddresses: (addresses: number[]) => void;
  getWatchedAddresses: () => number[];
  getRecentWrites: () => RecentWrite[];
  getLastAddr: () => number | undefined;
  readByte: (addr: number) => number | undefined;
  readWord: (addr: number) => number;
};

function formatWord(value: number, format: MemoryWordFormat): string {
  switch (format) {
    case "dec":
      return String(value | 0);
    case "uint":
      return String(value >>> 0);
    case "hex":
    default:
      return hex32(value);
  }
}

function printable(byte: number | undefined): string {
  if (byte === undefined || byte < 32 || byte > 126) {
    return ".";
  }
  return String.fromCharCode(byte);
}

export function createMemoryView(): MemoryView {
  const memBytes = new Map<number, number>();
  const initialBytes = new Map<number, number>();
  let recentWrites: RecentWrite[] = [];
  let lastMemAddr: number | undefined;
  let currentWriteAddrs = new Set<number>();
  let previousWriteAddrs = new Set<number>();
  let watchedAddresses: number[] = [];

  function isMemEffect(effect: Effect): effect is Extract<Effect, { kind: "mem" }> {
    return effect.kind === "mem";
  }

  function readByte(addr: number): number | undefined {
    return memBytes.get(addr >>> 0);
  }

  function readWord(addr: number): number {
    const base = addr >>> 0;
    const b0 = memBytes.get(base) ?? 0;
    const b1 = memBytes.get((base + 1) >>> 0) ?? 0;
    const b2 = memBytes.get((base + 2) >>> 0) ?? 0;
    const b3 = memBytes.get((base + 3) >>> 0) ?? 0;
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }

  function applyEffects(effects: Effect[], stepNumber = 0): void {
    const memEffects = effects.filter(isMemEffect);
    previousWriteAddrs = currentWriteAddrs;
    currentWriteAddrs = new Set<number>();

    for (const effect of memEffects) {
      const addr = effect.addr >>> 0;
      memBytes.set(addr, effect.after & 0xff);
      currentWriteAddrs.add(addr);
      recentWrites.unshift({
        address: addr,
        before: effect.before & 0xff,
        after: effect.after & 0xff,
        step: stepNumber,
      });
    }

    if (recentWrites.length > MAX_RECENT_WRITES) {
      recentWrites = recentWrites.slice(0, MAX_RECENT_WRITES);
    }

    if (memEffects.length > 0) {
      const sorted = [...memEffects].sort((a, b) => a.addr - b.addr);
      lastMemAddr = sorted[0].addr >>> 0;
    }
  }

  function seedBytes(start: number, bytes: Uint8Array): void {
    const base = start >>> 0;
    for (let index = 0; index < bytes.length; index += 1) {
      const addr = (base + index) >>> 0;
      const value = bytes[index] & 0xff;
      memBytes.set(addr, value);
      initialBytes.set(addr, value);
    }
  }

  function renderBytesWindow(base: number): string {
    const windowStart = (base >>> 0) & ~0x7;
    const rows: string[] = [];

    for (let rowOffset = 0; rowOffset < WINDOW_BYTES; rowOffset += BYTES_PER_ROW) {
      const rowAddr = (windowStart + rowOffset) >>> 0;
      const cells: string[] = [];
      for (let column = 0; column < BYTES_PER_ROW; column += 1) {
        const addr = (rowAddr + column) >>> 0;
        const value = memBytes.get(addr);
        const classes = ["memory-byte"];
        if (value === undefined) {
          classes.push("memory-byte--empty");
        }
        if (currentWriteAddrs.has(addr)) {
          classes.push("memory-byte--current");
        } else if (previousWriteAddrs.has(addr)) {
          classes.push("memory-byte--prev");
        }
        cells.push(
          `<span class="${classes.join(" ")}" title="${hex32(addr)}">${value === undefined ? "--" : hex8(value)}</span>`
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

  function renderWordsWindow(base: number, format: MemoryWordFormat): string {
    const start = (base >>> 0) & ~0x3;
    return Array.from({ length: 8 }, (_, index) => {
      const addr = (start + index * 4) >>> 0;
      const classes = ["memory-word-row"];
      if ([0, 1, 2, 3].some((offset) => currentWriteAddrs.has((addr + offset) >>> 0))) {
        classes.push("is-current");
      }
      const value = readWord(addr);
      return `
        <div class="${classes.join(" ")}">
          <span class="memory-word-row__addr">${hex32(addr)}</span>
          <span class="memory-word-row__value">${formatWord(value, format)}</span>
        </div>
      `;
    }).join("");
  }

  function renderAsciiWindow(base: number): string {
    const start = (base >>> 0) & ~0x3;
    return Array.from({ length: 8 }, (_, index) => {
      const addr = (start + index * 4) >>> 0;
      const bytes = Array.from({ length: 4 }, (_, byteIndex) => memBytes.get((addr + byteIndex) >>> 0));
      return `
        <div class="memory-ascii-row">
          <span class="memory-ascii-row__addr">${hex32(addr)}</span>
          <span class="memory-ascii-row__hex">${bytes.map((byte) => (byte === undefined ? "--" : hex8(byte))).join(" ")}</span>
          <span class="memory-ascii-row__text">${bytes.map((byte) => printable(byte)).join("")}</span>
        </div>
      `;
    }).join("");
  }

  function renderStackWindow(sp: number, format: MemoryWordFormat): string {
    const base = sp >>> 0;
    const newestStep = recentWrites[0]?.step ?? 0;
    return Array.from({ length: 16 }, (_, index) => {
      const addr = (base + index * 4) >>> 0;
      const value = readWord(addr);
      const initialValue =
        ((initialBytes.get(addr) ?? 0) |
          ((initialBytes.get((addr + 1) >>> 0) ?? 0) << 8) |
          ((initialBytes.get((addr + 2) >>> 0) ?? 0) << 16) |
          ((initialBytes.get((addr + 3) >>> 0) ?? 0) << 24)) >>>
        0;
      const recentlyWritten = recentWrites.some(
        (write) => write.address >= addr && write.address < ((addr + 4) >>> 0) && newestStep - write.step <= 5
      );
      const classes = ["memory-word-row", "memory-word-row--stack"];
      if (index === 0) {
        classes.push("is-current-sp");
      }
      if (recentlyWritten) {
        classes.push("is-recent");
      }
      if (value === initialValue) {
        classes.push("is-unchanged");
      }
      return `
        <div class="${classes.join(" ")}">
          <span class="memory-word-row__addr">sp+${index * 4}</span>
          <span class="memory-word-row__value">${formatWord(value, format)}</span>
        </div>
      `;
    }).join("");
  }

  function renderWindow(
    base: number,
    options: {
      mode?: MemoryViewMode;
      wordFormat?: MemoryWordFormat;
      sp?: number;
    } = {}
  ): string {
    const mode = options.mode ?? "bytes";
    const wordFormat = options.wordFormat ?? "hex";
    if (mode === "words") {
      return renderWordsWindow(base, wordFormat);
    }
    if (mode === "ascii") {
      return renderAsciiWindow(base);
    }
    if (mode === "stack") {
      return renderStackWindow(options.sp ?? base, wordFormat);
    }
    return renderBytesWindow(base);
  }

  function renderWatches(wordFormat: MemoryWordFormat = "hex"): string {
    return watchedAddresses
      .map((address) => {
        const normalized = address >>> 0;
        return `
          <div class="memory-watch-row" data-watch-address="${normalized}">
            <span class="memory-watch-row__addr">${hex32(normalized)}</span>
            <span class="memory-watch-row__value">${formatWord(readWord(normalized), wordFormat)}</span>
            <button type="button" class="memory-watch-row__remove" data-remove-watch="${normalized}" aria-label="Remove watch">✕</button>
          </div>
        `;
      })
      .join("");
  }

  function setWatchedAddresses(addresses: number[]): void {
    watchedAddresses = addresses.slice(0, MAX_WATCHES).map((address) => address >>> 0);
  }

  function reset(): void {
    memBytes.clear();
    initialBytes.clear();
    recentWrites = [];
    lastMemAddr = undefined;
    currentWriteAddrs = new Set<number>();
    previousWriteAddrs = new Set<number>();
    watchedAddresses = [];
  }

  return {
    reset,
    seedBytes,
    applyEffects,
    renderWindow,
    renderWatches,
    setWatchedAddresses,
    getWatchedAddresses: () => [...watchedAddresses],
    getRecentWrites: () => [...recentWrites],
    getLastAddr: () => lastMemAddr,
    readByte,
    readWord,
  };
}

import { describe, expect, it } from "vitest";

import {
  MAX_HISTORY,
  MOBILE_KEYBOARD_KEYS,
  MOBILE_MNEMONIC_KEYS,
  MOBILE_REGISTER_KEYS,
  MOBILE_SYMBOL_KEYS,
  formatMobileRegisterValue,
  insertAtCursor,
  isMobileViewport,
  nextTabFromSwipe,
  pushPseudoHistory,
  resolveTabSwitch,
} from "../../src/mobile-sim";

function createTextareaMock(value: string, start: number, end = start): HTMLTextAreaElement {
  return {
    value,
    selectionStart: start,
    selectionEnd: end,
    focus() {
      // no-op
    },
    dispatchEvent() {
      return true;
    },
  } as HTMLTextAreaElement;
}

describe("mobile-sim.ts", () => {
  it("isMobile detection returns true for width < 768", () => {
    expect(isMobileViewport(767, false)).toBe(true);
    expect(isMobileViewport(800, false)).toBe(false);
  });

  it("insertAtCursor inserts text at correct position", () => {
    const textarea = createTextareaMock("addi x1 x2", 7);

    insertAtCursor(textarea, ", ");

    expect(textarea.value).toBe("addi x1,  x2");
  });

  it("insertAtCursor handles selection replacement", () => {
    const textarea = createTextareaMock("addi x1, x2, 0", 9, 11);

    insertAtCursor(textarea, "a0");

    expect(textarea.value).toBe("addi x1, a0, 0");
  });

  it("insertAtCursor moves cursor past inserted text", () => {
    const textarea = createTextareaMock("lw x1 0(x2)", 5);

    insertAtCursor(textarea, ", ");

    expect(textarea.selectionStart).toBe(7);
    expect(textarea.selectionEnd).toBe(7);
  });

  it("Keyboard row keys array is non-empty", () => {
    expect(MOBILE_KEYBOARD_KEYS.length).toBeGreaterThan(0);
  });

  it("Mnemonic keys include addi, lw, beq", () => {
    expect(MOBILE_MNEMONIC_KEYS).toEqual(expect.arrayContaining(["addi", "lw", "beq"]));
  });

  it("Register keys include x0, sp, ra", () => {
    expect(MOBILE_REGISTER_KEYS).toEqual(expect.arrayContaining(["x0", "sp", "ra"]));
  });

  it("Symbol keys include comma and parentheses", () => {
    expect(MOBILE_SYMBOL_KEYS).toEqual(expect.arrayContaining([",", "(", ")"]));
  });

  it("Tab switch updates activeTab correctly", () => {
    expect(resolveTabSwitch("editor", "registers")).toBe("registers");
    expect(resolveTabSwitch("pseudo", "unknown")).toBe("pseudo");
  });

  it("Swipe left on last tab does not wrap", () => {
    expect(nextTabFromSwipe("pseudo", -120, 5)).toBe("pseudo");
  });

  it("Swipe right on first tab does not wrap", () => {
    expect(nextTabFromSwipe("editor", 120, 5)).toBe("editor");
  });

  it("Format conversion hex: 30 -> 0x0000001E", () => {
    expect(formatMobileRegisterValue(30, "hex")).toBe("0x0000001E");
  });

  it("Format conversion dec: 0xFFFFFFFF -> -1", () => {
    expect(formatMobileRegisterValue(0xffffffff, "dec")).toBe("-1");
  });

  it("Format conversion uint: 0xFFFFFFFF -> 4294967295", () => {
    expect(formatMobileRegisterValue(0xffffffff, "uint")).toBe("4294967295");
  });

  it("pseudoHistory does not exceed MAX_HISTORY", () => {
    let history: string[] = [];
    for (let index = 0; index < MAX_HISTORY + 3; index += 1) {
      history = pushPseudoHistory(history, `entry-${index}`);
    }
    expect(history).toHaveLength(MAX_HISTORY);
    expect(history[0]).toBe(`entry-${MAX_HISTORY + 2}`);
  });
});

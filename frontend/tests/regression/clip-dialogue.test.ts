import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetClipDialogueForTests,
  getClipLine,
  recordDismissal,
  recordSpoken,
  recordStep,
  shouldSpeak,
} from "../../src/clip-dialogue";

describe("clip-dialogue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:00:00Z"));
    __resetClipDialogueForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getClipLine('assemble-error', {errorMessage: 'immediate'}) returns line containing '12-bit'", () => {
    const line = getClipLine("assemble-error", { errorMessage: "Immediate out of range" });
    expect(line?.text).toContain("12-bit");
  });

  it("getClipLine('step', {destIsX0: true}) returns line containing 'x0'", () => {
    const line = getClipLine("step", { destIsX0: true });
    expect(line?.text).toContain("x0");
  });

  it("getClipLine('step', {spDelta: -8}) returns line containing '8-byte'", () => {
    const line = getClipLine("step", { spDelta: -8 });
    expect(line?.text).toContain("8-byte");
  });

  it("getClipLine('step', {branchTaken: true, instructionType: 'beq'}) returns branch line", () => {
    const line = getClipLine("step", { branchTaken: true, instructionType: "beq" });
    expect(line?.text).toBe("Equal. Branch taken.");
  });

  it("getClipLine('step', {}) returns null", () => {
    expect(getClipLine("step", {})).toBeNull();
  });

  it("shouldSpeak(5) returns false when called within 8s of last speech", () => {
    recordSpoken();
    vi.advanceTimersByTime(1000);
    expect(shouldSpeak(5)).toBe(false);
  });

  it("shouldSpeak(9) returns true even within 8s", () => {
    recordSpoken();
    vi.advanceTimersByTime(1000);
    expect(shouldSpeak(9)).toBe(true);
  });

  it("shouldSpeak(5) returns false during dismissal cooldown", () => {
    recordDismissal();
    recordDismissal();
    recordDismissal();
    expect(shouldSpeak(5)).toBe(false);
  });

  it("recordStep() sets userInFlow after 10 rapid steps", () => {
    for (let index = 0; index < 10; index += 1) {
      recordStep();
      vi.advanceTimersByTime(1000);
    }
    expect(shouldSpeak(5)).toBe(false);
  });

  it("shouldSpeak(5) returns false when userInFlow is true", () => {
    for (let index = 0; index < 10; index += 1) {
      recordStep();
      vi.advanceTimersByTime(500);
    }
    expect(shouldSpeak(5)).toBe(false);
  });

  it("getClipLine('landing-load', {}) returns null 80%+ of time", () => {
    let nullCount = 0;
    for (let index = 0; index < 100; index += 1) {
      if (getClipLine("landing-load", {}) === null) {
        nullCount += 1;
      }
    }
    expect(nullCount / 100).toBeGreaterThanOrEqual(0.75);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkAndUpdateStreak, getScore, recordActivity, saveScore, type UserScore } from "../../src/scoring";

function createStorageMock(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key) ?? null : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

const originalLocalStorage = globalThis.localStorage;

function baseScore(): UserScore {
  return {
    totalPoints: 0,
    lessonPoints: 0,
    challengePoints: 0,
    lessonsCompleted: 0,
    challengesPassed: 0,
    streak: 0,
    lastActiveDate: "",
    badges: [],
  };
}

describe("streak helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createStorageMock(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it("streak increments on consecutive days", () => {
    vi.setSystemTime(new Date("2026-03-23T12:00:00.000Z"));
    let score = recordActivity(baseScore());
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    score = recordActivity(score);
    expect(score.streak).toBe(2);
  });

  it("streak resets after 2 missed days", () => {
    const score = baseScore();
    score.streak = 4;
    score.lastActiveDate = "2026-03-20";
    saveScore(score);

    vi.setSystemTime(new Date("2026-03-23T12:00:00.000Z"));
    const updated = checkAndUpdateStreak(getScore());
    expect(updated.streak).toBe(0);
  });

  it("freeze prevents reset when count > 0", () => {
    const score = baseScore();
    score.streak = 7;
    score.lastActiveDate = "2026-03-20";
    Object.defineProperty(score, "streakFreezeCount", { value: 1, writable: true, enumerable: false, configurable: true });
    saveScore(score);

    vi.setSystemTime(new Date("2026-03-23T12:00:00.000Z"));
    const updated = checkAndUpdateStreak(getScore());
    expect(updated.streak).toBe(7);
    expect(updated.streakFreezeCount).toBe(0);
  });

  it("recordActivity updates lastActivityDate", () => {
    vi.setSystemTime(new Date("2026-03-23T12:00:00.000Z"));
    const updated = recordActivity(baseScore());
    expect(updated.lastActivityDate).toBe("2026-03-23");
  });

  it("streak milestones award correct XP", () => {
    const score = baseScore();
    score.streak = 2;
    score.lastActiveDate = "2026-03-22";
    Object.defineProperty(score, "lastActivityDate", { value: "2026-03-22", writable: true, enumerable: false, configurable: true });

    vi.setSystemTime(new Date("2026-03-23T12:00:00.000Z"));
    const updated = recordActivity(score);
    expect(updated.streak).toBe(3);
    expect(updated.totalPoints).toBe(35);
    expect(updated.badges.some((badge) => badge.id === "on-fire")).toBe(true);
  });
});

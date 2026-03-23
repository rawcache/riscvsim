import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkAndAwardBadges, addPoints, getScore, loadScore, saveScore, type UserScore } from "../../src/scoring";
import type { UserProgress } from "../../src/lessons";

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

function progressWithFirstStep(): UserProgress {
  return {
    lessons: {
      "lesson-1-registers": {
        lessonId: "lesson-1-registers",
        completed: false,
        currentStepIndex: 1,
        stepsCompleted: ["lesson-1-step-1"],
        startedAt: "2026-03-23T00:00:00.000Z",
        attempts: 0,
      },
    },
    totalCompleted: 0,
    lastActiveLesson: "lesson-1-registers",
  };
}

describe("scoring.ts", () => {
  beforeEach(() => {
    vi.useRealTimers();
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

  it("getScore returns an empty score initially", () => {
    expect(getScore()).toEqual({
      totalPoints: 0,
      lessonPoints: 0,
      challengePoints: 0,
      lessonsCompleted: 0,
      challengesPassed: 0,
      streak: 0,
      lastActiveDate: "",
      badges: [],
    });
  });

  it("addPoints increases totalPoints correctly", () => {
    addPoints(15, "lesson:demo");
    expect(loadScore().totalPoints).toBe(15);
    expect(loadScore().lessonPoints).toBe(15);
  });

  it('checkAndAwardBadges awards "First Step" correctly', () => {
    const awarded = checkAndAwardBadges(progressWithFirstStep(), []);
    expect(awarded.map((badge) => badge.name)).toContain("First Step");
  });

  it("saveScore then loadScore round-trips", () => {
    const score: UserScore = {
      totalPoints: 120,
      lessonPoints: 70,
      challengePoints: 50,
      lessonsCompleted: 2,
      challengesPassed: 1,
      streak: 3,
      lastActiveDate: "2026-03-23",
      badges: [],
    };

    saveScore(score);
    expect(loadScore()).toEqual(score);
  });

  it("streak increments on consecutive days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:00:00.000Z"));
    addPoints(10, "lesson:first");
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    addPoints(10, "lesson:second");

    const score = loadScore();
    expect(score.streak).toBe(2);
    expect(score.totalPoints).toBe(30);
  });

  it("badge is not awarded twice for the same condition", () => {
    const progress = progressWithFirstStep();
    const firstAward = checkAndAwardBadges(progress, []);
    const secondAward = checkAndAwardBadges(progress, []);

    expect(firstAward).toHaveLength(1);
    expect(secondAward).toHaveLength(0);
    expect(loadScore().badges.filter((badge) => badge.id === "first-step")).toHaveLength(1);
  });
});

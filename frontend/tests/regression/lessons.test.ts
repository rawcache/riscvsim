import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkGoals,
  getLesson,
  getLessons,
  getLessonState,
  isUnlocked,
  loadProgress,
  saveProgress,
  type LessonGoal,
  type LessonState,
  type UserProgress,
} from "../../src/lessons";
import type { WasmStateDelta } from "../../src/types";

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

describe("lessons.ts", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createStorageMock(),
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it("getLessons returns exactly 5 lessons", () => {
    expect(getLessons()).toHaveLength(5);
  });

  it("each lesson has at least one step", () => {
    expect(getLessons().every((lesson) => lesson.steps.length > 0)).toBe(true);
  });

  it("each checkpoint step has goals", () => {
    const checkpointSteps = getLessons().flatMap((lesson) => lesson.steps).filter((step) => step.isCheckpoint);
    expect(checkpointSteps.every((step) => Array.isArray(step.goals) && step.goals.length > 0)).toBe(true);
  });

  it("isUnlocked returns true for lesson-1", () => {
    expect(isUnlocked("lesson-1-registers", { lessons: {}, totalCompleted: 0 })).toBe(true);
  });

  it("isUnlocked returns false for lesson-2 when lesson-1 is not complete", () => {
    expect(isUnlocked("lesson-2-memory", { lessons: {}, totalCompleted: 0 })).toBe(false);
  });

  it("isUnlocked returns true for lesson-2 when lesson-1 is complete", () => {
    const progress: UserProgress = {
      lessons: {
        "lesson-1-registers": {
          lessonId: "lesson-1-registers",
          completed: true,
          currentStepIndex: 4,
          stepsCompleted: ["lesson-1-step-1", "lesson-1-step-2", "lesson-1-step-3", "lesson-1-step-4", "lesson-1-step-5"],
          startedAt: "2026-03-22T00:00:00.000Z",
          completedAt: "2026-03-22T00:10:00.000Z",
          attempts: 2,
        },
      },
      totalCompleted: 1,
    };

    expect(isUnlocked("lesson-2-memory", progress)).toBe(true);
  });

  it("checkGoals returns passed true when checks pass", () => {
    const goal: LessonGoal = {
      id: "goal-pass",
      description: "pass",
      check: (state: LessonState) => state.registers[3] === 30,
    };

    const state: LessonState = {
      registers: Array.from({ length: 32 }, (_, index) => (index === 3 ? 30 : 0)),
      memory: new Map(),
      pc: 0,
      stepCount: 0,
      assembled: false,
      halted: false,
      trapFired: false,
    };

    const result = checkGoals([goal], state);
    expect(result.passed).toBe(true);
    expect(result.results).toEqual([{ goalId: "goal-pass", passed: true }]);
  });

  it("checkGoals returns passed false when checks fail", () => {
    const goal: LessonGoal = {
      id: "goal-fail",
      description: "fail",
      check: (state: LessonState) => state.registers[4] === 120,
    };

    const state: LessonState = {
      registers: Array.from({ length: 32 }, () => 0),
      memory: new Map(),
      pc: 0,
      stepCount: 0,
      assembled: false,
      halted: false,
      trapFired: false,
    };

    const result = checkGoals([goal], state);
    expect(result.passed).toBe(false);
    expect(result.results).toEqual([{ goalId: "goal-fail", passed: false }]);
  });

  it("getLessonState with empty deltas returns zeroed registers", () => {
    const state = getLessonState([]);
    expect(state.registers).toEqual(Array.from({ length: 32 }, () => 0));
    expect(state.memory.size).toBe(0);
    expect(state.pc).toBe(0);
    expect(state.stepCount).toBe(0);
    expect(state.assembled).toBe(false);
  });

  it("getLessonState with one reg delta returns the register value", () => {
    const deltas: WasmStateDelta[] = [
      {
        pc: 4,
        halted: false,
        trap: null,
        effects: [
          { kind: "reg", reg: 3, before: 0, after: 30 },
          { kind: "pc", before: 0, after: 4 },
        ],
      },
    ];

    const state = getLessonState(deltas);
    expect(state.registers[3]).toBe(30);
    expect(state.pc).toBe(4);
    expect(state.stepCount).toBe(1);
    expect(state.assembled).toBe(true);
  });

  it("loadProgress returns empty progress when localStorage is empty", () => {
    expect(loadProgress()).toEqual({ lessons: {}, totalCompleted: 0 });
  });

  it("saveProgress then loadProgress round-trips correctly", () => {
    const progress: UserProgress = {
      lessons: {
        "lesson-1-registers": {
          lessonId: "lesson-1-registers",
          completed: true,
          currentStepIndex: 4,
          stepsCompleted: ["lesson-1-step-1", "lesson-1-step-2"],
          startedAt: "2026-03-22T00:00:00.000Z",
          completedAt: "2026-03-22T00:15:00.000Z",
          attempts: 3,
        },
      },
      totalCompleted: 1,
      lastActiveLesson: "lesson-1-registers",
    };

    saveProgress(progress);
    expect(loadProgress()).toEqual(progress);
  });

  it("lookup by lesson id returns the requested lesson", () => {
    expect(getLesson("lesson-4-functions")?.title).toBe("Functions and Calling Convention");
  });
});

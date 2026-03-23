import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getBestLabSubmission,
  getLabs,
  loadLabSubmissions,
  saveLabSubmission,
  type LabSubmission,
} from "../../src/labs";

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

describe("labs.ts", () => {
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

  it("getLabs returns exactly 5 labs", () => {
    expect(getLabs()).toHaveLength(5);
  });

  it("each lab has at least 4 test cases", () => {
    expect(getLabs().every((lab) => lab.testCases.length >= 4)).toBe(true);
  });

  it("hidden test cases exist for each lab", () => {
    expect(getLabs().every((lab) => lab.testCases.some((testCase) => testCase.isHidden))).toBe(true);
  });

  it("saveLabSubmission / loadLabSubmissions round-trips", () => {
    const submission: LabSubmission = {
      labId: "lab-1-arrays",
      code: "ret",
      score: 20,
      maxScore: 100,
      passed: false,
      testResults: [{ testId: "visible-1", passed: true, hidden: false }],
      hintsUsed: [],
      submittedAt: "2026-03-23T00:00:00.000Z",
      timeSpentSeconds: 45,
      attempts: 1,
    };

    saveLabSubmission(submission);
    expect(loadLabSubmissions()).toEqual([submission]);
  });

  it("bestSubmission returns the highest score", () => {
    saveLabSubmission({
      labId: "lab-1-arrays",
      code: "first",
      score: 40,
      maxScore: 100,
      passed: false,
      testResults: [],
      hintsUsed: [],
      submittedAt: "2026-03-23T00:00:00.000Z",
      timeSpentSeconds: 30,
      attempts: 1,
    });
    saveLabSubmission({
      labId: "lab-1-arrays",
      code: "second",
      score: 80,
      maxScore: 100,
      passed: false,
      testResults: [],
      hintsUsed: [],
      submittedAt: "2026-03-23T00:10:00.000Z",
      timeSpentSeconds: 60,
      attempts: 2,
    });

    expect(getBestLabSubmission("lab-1-arrays")?.score).toBe(80);
  });
});

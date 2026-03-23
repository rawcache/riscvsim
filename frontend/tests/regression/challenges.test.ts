import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getBestSubmission,
  getChallengeStatus,
  getChallenges,
  getChallengesForLesson,
  loadChallengeSubmissions,
  saveChallengeSubmission,
  getTotalScore,
  type ChallengeSubmission,
} from "../../src/challenges";

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

describe("challenges.ts", () => {
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

  it("getChallenges returns exactly 15 challenges", () => {
    expect(getChallenges()).toHaveLength(15);
  });

  it("each challenge has at least 2 test cases", () => {
    expect(getChallenges().every((challenge) => challenge.testCases.length >= 2)).toBe(true);
  });

  it("getChallengesForLesson returns the correct challenge set", () => {
    const challenges = getChallengesForLesson("lesson-1-registers");
    expect(challenges).toHaveLength(1);
    expect(challenges[0]?.id).toBe("challenge-1-sum-of-three");
  });

  it("saveChallengeSubmission then loadChallengeSubmissions round-trips", () => {
    const submission: ChallengeSubmission = {
      challengeId: "challenge-1-sum-of-three",
      code: "add x3, x1, x2",
      passed: true,
      score: 30,
      maxScore: 30,
      testResults: [{ testCaseId: "sum-three-1", passed: true, description: "ok" }],
      submittedAt: "2026-03-23T00:00:00.000Z",
      timeSpentSeconds: 15,
    };

    saveChallengeSubmission(submission);
    expect(loadChallengeSubmissions()).toEqual([submission]);
  });

  it("getBestSubmission returns the highest score", () => {
    saveChallengeSubmission({
      challengeId: "challenge-1-sum-of-three",
      code: "first",
      passed: false,
      score: 10,
      maxScore: 30,
      testResults: [],
      submittedAt: "2026-03-23T00:00:00.000Z",
      timeSpentSeconds: 10,
    });
    saveChallengeSubmission({
      challengeId: "challenge-1-sum-of-three",
      code: "second",
      passed: true,
      score: 30,
      maxScore: 30,
      testResults: [],
      submittedAt: "2026-03-23T00:01:00.000Z",
      timeSpentSeconds: 20,
    });

    expect(getBestSubmission("challenge-1-sum-of-three")?.score).toBe(30);
  });

  it("getTotalScore sums all best submission scores", () => {
    saveChallengeSubmission({
      challengeId: "challenge-1-sum-of-three",
      code: "sum",
      passed: true,
      score: 30,
      maxScore: 30,
      testResults: [],
      submittedAt: "2026-03-23T00:00:00.000Z",
      timeSpentSeconds: 10,
    });
    saveChallengeSubmission({
      challengeId: "challenge-2-memory-roundtrip",
      code: "memory",
      passed: true,
      score: 20,
      maxScore: 30,
      testResults: [],
      submittedAt: "2026-03-23T00:02:00.000Z",
      timeSpentSeconds: 12,
    });

    expect(getTotalScore()).toBe(50);
  });

  it("getChallengeStatus returns available for challenge 1", () => {
    expect(getChallengeStatus("challenge-1-sum-of-three")).toBe("available");
  });

  it("getChallengeStatus returns locked for challenge 12", () => {
    expect(getChallengeStatus("challenge-12-list-length")).toBe("locked");
  });
});

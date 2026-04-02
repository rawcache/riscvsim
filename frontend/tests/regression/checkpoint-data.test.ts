import { describe, expect, it } from "vitest";

import { CHECKPOINT_PROBLEMS } from "../../src/checkpoint-data";

describe("checkpoint-data.ts", () => {
  it("defines exactly 8 problems", () => {
    expect(CHECKPOINT_PROBLEMS).toHaveLength(8);
  });

  it("gives every problem at least 3 visible test cases", () => {
    expect(
      CHECKPOINT_PROBLEMS.every((problem) => problem.testCases.filter((testCase) => testCase.visible).length >= 3)
    ).toBe(true);
  });

  it("gives every problem at least 2 hidden test cases", () => {
    expect(
      CHECKPOINT_PROBLEMS.every((problem) => problem.testCases.filter((testCase) => !testCase.visible).length >= 2)
    ).toBe(true);
  });

  it("marks CP1 as Guest tier", () => {
    expect(CHECKPOINT_PROBLEMS.find((problem) => problem.id === "cp1")?.requiredTier).toBe("Guest");
  });

  it("marks CP2 as Guest tier", () => {
    expect(CHECKPOINT_PROBLEMS.find((problem) => problem.id === "cp2")?.requiredTier).toBe("Guest");
  });

  it("marks CP3 as Free tier", () => {
    expect(CHECKPOINT_PROBLEMS.find((problem) => problem.id === "cp3")?.requiredTier).toBe("Free");
  });

  it("marks CP5 as Pro tier", () => {
    expect(CHECKPOINT_PROBLEMS.find((problem) => problem.id === "cp5")?.requiredTier).toBe("Pro");
  });

  it("sets CP5 step limit to 5000", () => {
    expect(CHECKPOINT_PROBLEMS.find((problem) => problem.id === "cp5")?.stepLimit).toBe(5000);
  });

  it("sets CP7 step limit to 10000", () => {
    expect(CHECKPOINT_PROBLEMS.find((problem) => problem.id === "cp7")?.stepLimit).toBe(10000);
  });

  it("sets CP8 step limit to 50000", () => {
    expect(CHECKPOINT_PROBLEMS.find((problem) => problem.id === "cp8")?.stepLimit).toBe(50000);
  });

  it("uses unique test-case ids across all problems", () => {
    const ids = CHECKPOINT_PROBLEMS.flatMap((problem) => problem.testCases.map((testCase) => testCase.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every problem at least one hint", () => {
    expect(CHECKPOINT_PROBLEMS.every((problem) => problem.hints.length > 0)).toBe(true);
  });
});

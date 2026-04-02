import { describe, expect, it } from "vitest";

import { PROBLEMS } from "../../src/problem-data";

describe("problem-data.ts", () => {
  it("defines exactly 15 problems", () => {
    expect(PROBLEMS).toHaveLength(15);
  });

  it("uses unique problem ids", () => {
    const ids = PROBLEMS.map((problem) => problem.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses ids that match p[0-9]{3}", () => {
    expect(PROBLEMS.every((problem) => /^p\d{3}$/u.test(problem.id))).toBe(true);
  });

  it("gives every problem at least 3 visible test cases", () => {
    expect(PROBLEMS.every((problem) => problem.testCases.filter((testCase) => testCase.visible).length >= 3)).toBe(true);
  });

  it("gives every problem at least 2 hidden test cases", () => {
    expect(PROBLEMS.every((problem) => problem.testCases.filter((testCase) => !testCase.visible).length >= 2)).toBe(true);
  });

  it("gives every problem at least 1 hint", () => {
    expect(PROBLEMS.every((problem) => problem.hints.length >= 1)).toBe(true);
  });

  it("gives every problem starter code", () => {
    expect(PROBLEMS.every((problem) => problem.starterCode.trim().length > 0)).toBe(true);
  });

  it("keeps acceptance rates between 20 and 80", () => {
    expect(PROBLEMS.every((problem) => problem.acceptanceRate >= 20 && problem.acceptanceRate <= 80)).toBe(true);
  });

  it("sets step limits for problems tagged with Loops", () => {
    expect(PROBLEMS.filter((problem) => problem.tags.includes("Loops")).every((problem) => typeof problem.stepLimit === "number")).toBe(true);
  });

  it("sets P006 step limit to 5000", () => {
    expect(PROBLEMS.find((problem) => problem.id === "p006")?.stepLimit).toBe(5000);
  });

  it("sets P007 step limit to 10000", () => {
    expect(PROBLEMS.find((problem) => problem.id === "p007")?.stepLimit).toBe(10000);
  });

  it("sets P013 step limit to 50000", () => {
    expect(PROBLEMS.find((problem) => problem.id === "p013")?.stepLimit).toBe(50000);
  });
});

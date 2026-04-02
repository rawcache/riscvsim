import { beforeAll, describe, expect, it } from "vitest";

import type { Problem, ProblemTestCase } from "../../src/problem-data";
import { runAll, runTestCase, runVisible } from "../../src/problem-runner";
import { WasmRuntime } from "../../src/wasm-runtime";

const DATA_BASE = 0x10000000;

function makeCase(overrides: Partial<ProblemTestCase> = {}): ProblemTestCase {
  return {
    id: overrides.id ?? "case-1",
    label: overrides.label ?? "Case 1",
    visible: overrides.visible ?? true,
    description: overrides.description ?? "default",
    initialRegisters: overrides.initialRegisters ?? {},
    initialMemory: overrides.initialMemory,
    expectedRegisters: overrides.expectedRegisters ?? {},
    expectedMemory: overrides.expectedMemory,
    stepLimit: overrides.stepLimit,
  };
}

function makeProblem(testCases: ProblemTestCase[]): Problem {
  return {
    id: "p999",
    number: 999,
    title: "Test Problem",
    difficulty: "Easy",
    tags: ["Arithmetic"],
    acceptanceRate: 99,
    description: "<p>Test problem</p>",
    constraints: ["none"],
    examples: [],
    hints: ["hint"],
    starterCode: "",
    testCases,
  };
}

describe("problem-runner.ts", () => {
  let runtime: WasmRuntime;

  beforeAll(async () => {
    runtime = await WasmRuntime.create();
  });

  it("passes for a correct add solution", async () => {
    const result = await runTestCase(
      "add x12, x10, x11",
      makeCase({
        initialRegisters: { x10: 3, x11: 5 },
        expectedRegisters: { x12: 8 },
      }),
      runtime
    );

    expect(result.passed).toBe(true);
    expect(result.verdict).toBe("Accepted");
    expect(result.actualRegisters.x12).toBe(8);
  });

  it("fails for the wrong register", async () => {
    const result = await runTestCase(
      "addi x13, x0, 8",
      makeCase({
        expectedRegisters: { x12: 8 },
      }),
      runtime
    );

    expect(result.passed).toBe(false);
    expect(result.verdict).toBe("Wrong Answer");
  });

  it("returns Assembly Error for invalid assembly", async () => {
    const result = await runTestCase(
      "add x12, x10",
      makeCase({
        expectedRegisters: { x12: 8 },
      }),
      runtime
    );

    expect(result.verdict).toBe("Assembly Error");
    expect(result.errorMessage).toMatch(/line/i);
  });

  it("returns TLE when stepLimit is exceeded", async () => {
    const result = await runTestCase(
      "loop:\nbeq x0, x0, loop",
      makeCase({
        expectedRegisters: { x12: 0 },
        stepLimit: 5,
      }),
      runtime
    );

    expect(result.verdict).toBe("Time Limit Exceeded");
    expect(result.timedOut).toBe(true);
    expect(result.stepsTaken).toBe(5);
  });

  it("handles initialMemory correctly", async () => {
    const result = await runTestCase(
      "lui t0, 65536\nlw x12, 0(t0)",
      makeCase({
        initialMemory: [{ address: DATA_BASE, value: 123, size: "word" }],
        expectedRegisters: { x12: 123 },
      }),
      runtime
    );

    expect(result.passed).toBe(true);
    expect(result.actualRegisters.x12).toBe(123);
  });

  it("reads expectedMemory correctly", async () => {
    const result = await runTestCase(
      "lui t0, 65536\naddi t1, x0, 9\nsw t1, 4(t0)",
      makeCase({
        expectedMemory: [{ address: DATA_BASE + 4, value: 9, size: "word" }],
      }),
      runtime
    );

    expect(result.passed).toBe(true);
    expect(result.actualMemory).toEqual([{ address: DATA_BASE + 4, value: 9 }]);
  });

  it("produces an empty diff for a passing case", async () => {
    const result = await runTestCase(
      "add x12, x10, x11",
      makeCase({
        initialRegisters: { x10: 3, x11: 5 },
        expectedRegisters: { x12: 8 },
      }),
      runtime
    );

    expect(result.diff).toEqual([]);
  });

  it("produces a diff entry for a failing register", async () => {
    const result = await runTestCase(
      "addi x12, x0, 7",
      makeCase({
        expectedRegisters: { x12: 8 },
      }),
      runtime
    );

    expect(result.diff).toHaveLength(1);
    expect(result.diff[0]).toEqual({
      key: "x12",
      expected: 8,
      actual: 7,
    });
  });

  it("runVisible runs only visible cases", async () => {
    const summary = await runVisible(
      "add x12, x10, x11",
      makeProblem([
        makeCase({ id: "visible-1", visible: true, initialRegisters: { x10: 1, x11: 2 }, expectedRegisters: { x12: 3 } }),
        makeCase({ id: "hidden-1", label: "Case 2", visible: false, initialRegisters: { x10: 1, x11: 2 }, expectedRegisters: { x12: 999 } }),
      ]),
      runtime
    );

    expect(summary.totalCount).toBe(1);
    expect(summary.passedCount).toBe(1);
  });

  it("runAll runs all cases including hidden", async () => {
    const summary = await runAll(
      "add x12, x10, x11",
      makeProblem([
        makeCase({ id: "visible-1", visible: true, initialRegisters: { x10: 1, x11: 2 }, expectedRegisters: { x12: 3 } }),
        makeCase({ id: "hidden-1", label: "Case 2", visible: false, initialRegisters: { x10: 1, x11: 2 }, expectedRegisters: { x12: 3 } }),
      ]),
      runtime
    );

    expect(summary.totalCount).toBe(2);
    expect(summary.results[1]?.label).toBe("Hidden Case 2");
  });

  it("sets RunSummary verdict to Accepted when all pass", async () => {
    const summary = await runAll(
      "add x12, x10, x11",
      makeProblem([
        makeCase({ id: "pass-1", initialRegisters: { x10: 1, x11: 2 }, expectedRegisters: { x12: 3 } }),
        makeCase({ id: "pass-2", initialRegisters: { x10: 3, x11: 4 }, expectedRegisters: { x12: 7 } }),
      ]),
      runtime
    );

    expect(summary.verdict).toBe("Accepted");
  });

  it("sets RunSummary verdict to Wrong Answer when any fail", async () => {
    const summary = await runAll(
      "add x12, x10, x11",
      makeProblem([
        makeCase({ id: "pass-1", initialRegisters: { x10: 1, x11: 2 }, expectedRegisters: { x12: 3 } }),
        makeCase({ id: "fail-1", initialRegisters: { x10: 3, x11: 4 }, expectedRegisters: { x12: 8 } }),
      ]),
      runtime
    );

    expect(summary.verdict).toBe("Wrong Answer");
  });

  it("sets firstFailedResult on failure", async () => {
    const summary = await runAll(
      "add x12, x10, x11",
      makeProblem([
        makeCase({ id: "pass-1", initialRegisters: { x10: 1, x11: 2 }, expectedRegisters: { x12: 3 } }),
        makeCase({ id: "fail-1", initialRegisters: { x10: 3, x11: 4 }, expectedRegisters: { x12: 8 } }),
      ]),
      runtime
    );

    expect(summary.firstFailedResult?.caseId).toBe("fail-1");
  });
});

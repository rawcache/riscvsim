import { describe, expect, it, test } from "vitest";
import { canLoadRuntime, finalRegs, run } from "./helpers";

const wasm = await canLoadRuntime();

if (!wasm.ok) {
  test.skip(`WASM runtime unavailable in Vitest/Node: ${wasm.error.message}`, () => {
    // Skip instead of mocking; M-extension regressions should hit the real WASM interpreter.
  });
}

const runtimeDescribe = wasm.ok ? describe : describe.skip;

runtimeDescribe("M extension", () => {
  it("mul handles positive * positive", async () => {
    const deltas = await run(["addi x1, x0, 6", "addi x2, x0, 7", "mul x3, x1, x2", "ecall"].join("\n"), 5);
    expect(finalRegs(deltas)[3]).toBe(42);
  });

  it("mul handles negative * positive", async () => {
    const deltas = await run(["addi x1, x0, -6", "addi x2, x0, 7", "mul x3, x1, x2", "ecall"].join("\n"), 5);
    expect(finalRegs(deltas)[3]).toBe(0xffffffd6);
  });

  it("mulh returns the upper 32 bits of the signed product", async () => {
    const deltas = await run(["li x1, 0x12345678", "addi x2, x0, 16", "mulh x3, x1, x2", "ecall"].join("\n"), 6);
    expect(finalRegs(deltas)[3]).toBe(1);
  });

  it("div handles positive / positive", async () => {
    const deltas = await run(["addi x1, x0, 20", "addi x2, x0, 3", "div x3, x1, x2", "ecall"].join("\n"), 5);
    expect(finalRegs(deltas)[3]).toBe(6);
  });

  it("div handles negative / positive", async () => {
    const deltas = await run(["addi x1, x0, -20", "addi x2, x0, 3", "div x3, x1, x2", "ecall"].join("\n"), 5);
    expect(finalRegs(deltas)[3]).toBe(0xfffffffa);
  });

  it("div by zero returns -1 without trapping", async () => {
    const deltas = await run(["addi x1, x0, 7", "addi x2, x0, 0", "div x3, x1, x2", "ecall"].join("\n"), 5);
    expect(finalRegs(deltas)[3]).toBe(0xffffffff);
  });

  it("rem by zero returns the dividend without trapping", async () => {
    const deltas = await run(["addi x1, x0, 7", "addi x2, x0, 0", "rem x3, x1, x2", "ecall"].join("\n"), 5);
    expect(finalRegs(deltas)[3]).toBe(7);
  });

  it("divu by zero returns 2^32 - 1", async () => {
    const deltas = await run(["addi x1, x0, 7", "addi x2, x0, 0", "divu x3, x1, x2", "ecall"].join("\n"), 5);
    expect(finalRegs(deltas)[3]).toBe(0xffffffff);
  });

  it("INT_MIN / -1 returns INT_MIN without trapping", async () => {
    const deltas = await run(["li x1, 0x80000000", "addi x2, x0, -1", "div x3, x1, x2", "ecall"].join("\n"), 6);
    expect(finalRegs(deltas)[3]).toBe(0x80000000);
  });
});

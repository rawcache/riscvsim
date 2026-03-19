import { describe, expect, it, test } from "vitest";
import { canLoadRuntime, finalRegs, run } from "./helpers";

const wasm = await canLoadRuntime();

if (!wasm.ok) {
  test.skip(`WASM runtime unavailable in Vitest/Node: ${wasm.error.message}`, () => {
    // Skip instead of mocking; ALU regressions should execute through the real WASM core.
  });
}

const runtimeDescribe = wasm.ok ? describe : describe.skip;

runtimeDescribe("ALU edge cases", () => {
  it("add overflow wraps without trapping", async () => {
    const deltas = await run(["li x1, 0x7fffffff", "addi x2, x0, 1", "add x3, x1, x2", "ecall"].join("\n"), 6);
    expect(finalRegs(deltas)[3]).toBe(0x80000000);
  });

  it("sub underflow wraps correctly", async () => {
    const deltas = await run(["addi x1, x0, 0", "addi x2, x0, 1", "sub x3, x1, x2", "ecall"].join("\n"), 5);
    expect(finalRegs(deltas)[3]).toBe(0xffffffff);
  });

  it("srai preserves the sign bit on negative values", async () => {
    const deltas = await run(["addi x1, x0, -8", "srai x2, x1, 2", "ecall"].join("\n"), 4);
    expect(finalRegs(deltas)[2]).toBe(0xfffffffe);
  });

  it("srli does not preserve the sign bit", async () => {
    const deltas = await run(["addi x1, x0, -8", "srli x2, x1, 2", "ecall"].join("\n"), 4);
    expect(finalRegs(deltas)[2]).toBe(0x3ffffffe);
  });

  it("sll and srl by 0 are identity operations", async () => {
    const deltas = await run(
      ["addi x1, x0, 7", "addi x2, x0, 0", "sll x3, x1, x2", "srl x4, x1, x2", "ecall"].join("\n"),
      6
    );
    const regs = finalRegs(deltas);
    expect(regs[3]).toBe(7);
    expect(regs[4]).toBe(7);
  });

  it("sll and srl by 31 behave correctly", async () => {
    const deltas = await run(
      ["addi x1, x0, 1", "addi x2, x0, 31", "li x4, 0x80000000", "sll x3, x1, x2", "srl x5, x4, x2", "ecall"].join("\n"),
      8
    );
    const regs = finalRegs(deltas);
    expect(regs[3]).toBe(0x80000000);
    expect(regs[5]).toBe(1);
  });
});

import { describe, expect, it, test } from "vitest";
import { assemble, canLoadRuntime, decodeIImmediate, finalRegs, run, wordAt } from "./helpers";

const wasm = await canLoadRuntime();

if (!wasm.ok) {
  test.skip(`WASM runtime unavailable in Vitest/Node: ${wasm.error.message}`, () => {
    // Skip instead of mocking; the binary checks here rely on the real encoder/WASM path.
  });
}

const runtimeDescribe = wasm.ok ? describe : describe.skip;

runtimeDescribe("signed immediate handling", () => {
  it("addi with -1 produces correct two's-complement machine code", async () => {
    const bytes = await assemble("addi x1, x0, -1");
    expect(wordAt(bytes, 0)).toBe(0xfff00093);
  });

  it("addi with -2048 assembles without error", async () => {
    const bytes = await assemble("addi x1, x0, -2048");
    expect(decodeIImmediate(wordAt(bytes, 0))).toBe(-2048);
  });

  it("addi with 2047 assembles without error", async () => {
    const bytes = await assemble("addi x1, x0, 2047");
    expect(decodeIImmediate(wordAt(bytes, 0))).toBe(2047);
  });

  it("addi with 2048 throws an assembler error", async () => {
    await expect(assemble("addi x1, x0, 2048")).rejects.toThrow(
      /addi immediate 2048 out of range \(valid range: -2048 to 2047\)/
    );
  });

  it.each([
    ["ori", "ori x1, x0, 4096"],
    ["slti", "slti x1, x0, 4096"],
    ["lw", "lw x1, 4096(x0)"],
    ["sw", "sw x1, 4096(x0)"],
  ])("%s with an out-of-range immediate throws an assembler error", async (_op, src) => {
    await expect(assemble(src)).rejects.toThrow(/out of range \(valid range: -2048 to 2047\)/);
  });

  it("slti with a negative immediate executes correctly", async () => {
    const deltas = await run(["addi x1, x0, -2", "slti x2, x1, -1", "ecall"].join("\n"), 4);
    const regs = finalRegs(deltas);
    expect(regs[2]).toBe(1);
  });
});

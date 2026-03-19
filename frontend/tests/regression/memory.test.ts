import { describe, expect, it, test } from "vitest";
import { canLoadRuntime, finalRegs, run, trapCauseCode } from "./helpers";

const wasm = await canLoadRuntime();

if (!wasm.ok) {
  test.skip(`WASM runtime unavailable in Vitest/Node: ${wasm.error.message}`, () => {
    // Skip instead of mocking; memory regressions must hit the real runtime.
  });
}

const runtimeDescribe = wasm.ok ? describe : describe.skip;

runtimeDescribe("load/store and sign extension", () => {
  it("sw then lw round-trips the same value", async () => {
    const deltas = await run(
      ["addi x1, x0, 64", "li x2, 0x12345678", "sw x2, 0(x1)", "lw x3, 0(x1)", "ecall"].join("\n"),
      8
    );
    expect(finalRegs(deltas)[3]).toBe(0x12345678);
  });

  it("sb then lb sign-extends a negative byte", async () => {
    const deltas = await run(
      ["addi x1, x0, 64", "addi x2, x0, 128", "sb x2, 0(x1)", "lb x3, 0(x1)", "ecall"].join("\n"),
      6
    );
    expect(finalRegs(deltas)[3]).toBe(0xffffff80);
  });

  it("sb then lbu zero-extends the same byte", async () => {
    const deltas = await run(
      ["addi x1, x0, 64", "addi x2, x0, 128", "sb x2, 0(x1)", "lbu x3, 0(x1)", "ecall"].join("\n"),
      6
    );
    expect(finalRegs(deltas)[3]).toBe(0x80);
  });

  it("sh then lh sign-extends a negative halfword", async () => {
    const deltas = await run(
      ["addi x1, x0, 64", "li x2, 0x8001", "sh x2, 0(x1)", "lh x3, 0(x1)", "ecall"].join("\n"),
      8
    );
    expect(finalRegs(deltas)[3]).toBe(0xffff8001);
  });

  it("sh then lhu zero-extends the same halfword", async () => {
    const deltas = await run(
      ["addi x1, x0, 64", "li x2, 0x8001", "sh x2, 0(x1)", "lhu x3, 0(x1)", "ecall"].join("\n"),
      8
    );
    expect(finalRegs(deltas)[3]).toBe(0x8001);
  });

  it("misaligned lw traps with cause 4", async () => {
    const deltas = await run(["addi x1, x0, 2", "lw x2, 0(x1)"].join("\n"), 3);
    expect(trapCauseCode(deltas.at(-1)!)).toBe(4);
  });

  it("misaligned sw traps with cause 6", async () => {
    const deltas = await run(["addi x1, x0, 2", "addi x2, x0, 1", "sw x2, 0(x1)"].join("\n"), 4);
    expect(trapCauseCode(deltas.at(-1)!)).toBe(6);
  });

  it("misaligned lh traps with cause 4", async () => {
    const deltas = await run(["addi x1, x0, 1", "lh x2, 0(x1)"].join("\n"), 3);
    expect(trapCauseCode(deltas.at(-1)!)).toBe(4);
  });

  it("out-of-bounds load produces a trap", async () => {
    const deltas = await run(["li x1, 65536", "lb x2, 0(x1)"].join("\n"), 4);
    expect(deltas.at(-1)?.trap).toBeTruthy();
  });
});

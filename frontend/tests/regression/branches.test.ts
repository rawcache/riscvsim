import { describe, expect, it, test } from "vitest";
import { canLoadRuntime, finalRegs, pcAfter, run } from "./helpers";

const wasm = await canLoadRuntime();

if (!wasm.ok) {
  test.skip(`WASM runtime unavailable in Vitest/Node: ${wasm.error.message}`, () => {
    // Skip instead of mocking; these regressions need the real WASM runtime.
  });
}

const runtimeDescribe = wasm.ok ? describe : describe.skip;

runtimeDescribe("branch and jump encoding/execution", () => {
  it("beq taken lands on the correct target", async () => {
    const deltas = await run(["beq x0, x0, target", "addi x1, x0, 1", "target:", "ecall"].join("\n"), 3);
    expect(pcAfter(deltas[0])).toBe(8);
  });

  it("beq not taken advances PC by 4", async () => {
    const deltas = await run(
      ["addi x1, x0, 1", "beq x1, x0, target", "addi x2, x0, 2", "target:", "ecall"].join("\n"),
      5
    );
    expect(pcAfter(deltas[1])).toBe(8);
    expect(finalRegs(deltas)[2]).toBe(2);
  });

  it.each([
    {
      name: "bne taken",
      op: "bne",
      lhs: 1,
      rhs: 0,
      expectedPc: 16,
      skippedRegWritten: false,
    },
    {
      name: "bne not taken",
      op: "bne",
      lhs: 1,
      rhs: 1,
      expectedPc: 12,
      skippedRegWritten: true,
    },
    {
      name: "blt taken",
      op: "blt",
      lhs: 1,
      rhs: 2,
      expectedPc: 16,
      skippedRegWritten: false,
    },
    {
      name: "blt not taken",
      op: "blt",
      lhs: 2,
      rhs: 1,
      expectedPc: 12,
      skippedRegWritten: true,
    },
    {
      name: "bge taken",
      op: "bge",
      lhs: 2,
      rhs: 1,
      expectedPc: 16,
      skippedRegWritten: false,
    },
    {
      name: "bge not taken",
      op: "bge",
      lhs: 1,
      rhs: 2,
      expectedPc: 12,
      skippedRegWritten: true,
    },
  ])("$name", async ({ op, lhs, rhs, expectedPc, skippedRegWritten }) => {
    const deltas = await run(
      [
        `addi x1, x0, ${lhs}`,
        `addi x2, x0, ${rhs}`,
        `${op} x1, x2, target`,
        "addi x3, x0, 7",
        "target:",
        "ecall",
      ].join("\n"),
      6
    );

    expect(pcAfter(deltas[2])).toBe(expectedPc);
    expect(finalRegs(deltas)[3]).toBe(skippedRegWritten ? 7 : 0);
  });

  it("jal writes PC+4 to rd and jumps to the target", async () => {
    const deltas = await run(["jal ra, target", "addi x2, x0, 99", "target:", "ecall"].join("\n"), 3);
    const regs = finalRegs(deltas);
    expect(pcAfter(deltas[0])).toBe(8);
    expect(regs[1]).toBe(4);
    expect(regs[2]).toBe(0);
  });

  it("jalr writes PC+4 to rd and sets PC = (rs1 + offset) & ~1", async () => {
    const deltas = await run(
      ["addi t0, x0, 12", "jalr ra, 0(t0)", "addi x2, x0, 99", "ecall"].join("\n"),
      4
    );
    const regs = finalRegs(deltas);
    expect(pcAfter(deltas[1])).toBe(12);
    expect(regs[1]).toBe(8);
    expect(regs[2]).toBe(0);
  });

  it("jalr honors a non-zero offset", async () => {
    const deltas = await run(
      ["addi t0, x0, 12", "jalr ra, 4(t0)", "addi x2, x0, 99", "addi x3, x0, 7", "ecall"].join("\n"),
      5
    );
    const regs = finalRegs(deltas);
    expect(pcAfter(deltas[1])).toBe(16);
    expect(regs[1]).toBe(8);
    expect(regs[2]).toBe(0);
    expect(regs[3]).toBe(0);
  });

  it("auipc computes rd = PC + (imm << 12)", async () => {
    const deltas = await run(["addi x0, x0, 0", "auipc x5, 1", "ecall"].join("\n"), 4);
    expect(finalRegs(deltas)[5]).toBe(0x1004);
  });
});

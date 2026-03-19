import { describe, expect, it, test } from "vitest";
import { parseAssembly } from "../../src/asm";
import { canLoadRuntime, finalRegs, pcAfter, run } from "./helpers";

const wasm = await canLoadRuntime();

if (!wasm.ok) {
  test.skip(`WASM runtime unavailable in Vitest/Node: ${wasm.error.message}`, () => {
    // Skip only the execution-backed call assertion if the real WASM runtime is unavailable.
  });
}

const runtimeDescribe = wasm.ok ? describe : describe.skip;

describe("pseudo-instruction expansion", () => {
  it("li with a small immediate emits a single addi", () => {
    const parsed = parseAssembly("li x5, 123");
    expect(parsed.instructions).toHaveLength(1);
    expect(parsed.instructions[0]).toMatchObject({
      op: "addi",
      rd: 5,
      rs1: 0,
      imm: 123,
    });
  });

  it("li with a large immediate emits lui + addi", () => {
    const parsed = parseAssembly("li x5, 0x12345");
    expect(parsed.instructions).toHaveLength(2);
    expect(parsed.instructions[0]).toMatchObject({
      op: "lui",
      rd: 5,
    });
    expect(parsed.instructions[1]).toMatchObject({
      op: "addi",
      rd: 5,
      rs1: 5,
    });
  });

  it("mv expands to addi rd, rs, 0", () => {
    const parsed = parseAssembly("mv x6, x7");
    expect(parsed.instructions).toEqual([
      {
        op: "addi",
        rd: 6,
        rs1: 7,
        imm: 0,
        src_line: 0,
      },
    ]);
  });

  it("nop expands to addi x0, x0, 0", () => {
    const parsed = parseAssembly("nop");
    expect(parsed.instructions).toEqual([
      {
        op: "addi",
        rd: 0,
        rs1: 0,
        imm: 0,
        src_line: 0,
      },
    ]);
  });

  it("j label expands to jal x0, label", () => {
    const parsed = parseAssembly(["j target", "target:", "nop"].join("\n"));
    expect(parsed.instructions[0]).toMatchObject({
      op: "jal",
      rd: 0,
      target_pc: 4,
    });
  });

  it("ret expands to jalr x0, ra, 0", () => {
    const parsed = parseAssembly("ret");
    expect(parsed.instructions).toEqual([
      {
        op: "jalr",
        rd: 0,
        rs1: 1,
        imm: 0,
        src_line: 0,
      },
    ]);
  });

  it("call label expands to auipc + jalr", () => {
    const parsed = parseAssembly(["call target", "addi x2, x0, 99", "target:", "addi x3, x0, 7", "ecall"].join("\n"));
    expect(parsed.instructions).toHaveLength(5);
    expect(parsed.instructions[0]).toMatchObject({ op: "auipc", rd: 1, imm: 0 });
    expect(parsed.instructions[1]).toMatchObject({ op: "jalr", rd: 1, rs1: 1, imm: 12 });
  });
});

runtimeDescribe("call execution", () => {
  it("call lands on the target and writes the return address to ra", async () => {
    const deltas = await run(
      ["call target", "addi x2, x0, 99", "target:", "addi x3, x0, 7", "ecall"].join("\n"),
      6
    );
    const regs = finalRegs(deltas);
    expect(pcAfter(deltas[1])).toBe(12);
    expect(regs[1]).toBe(8);
    expect(regs[2]).toBe(0);
    expect(regs[3]).toBe(7);
  });
});

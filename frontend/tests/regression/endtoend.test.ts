import { describe, expect, it, test } from "vitest";
import { parseAssembly } from "../../src/asm";
import { DATA_BASE } from "../../src/memory-map";
import { canLoadRuntime, finalRegs, run } from "./helpers";

const wasm = await canLoadRuntime();
const copiedString = "Hello, RISC-V!";
const bubbleSortProgram = [
  ".data",
  "arr:",
  "  .word 5, 2, 8, 1, 4",
  ".text",
  "la x1, arr",
  "addi x2, x0, 4",
  "outer:",
  "beq x2, x0, done",
  "addi x3, x0, 0",
  "inner:",
  "beq x3, x2, next_pass",
  "slli x4, x3, 2",
  "add x5, x1, x4",
  "lw x6, 0(x5)",
  "lw x7, 4(x5)",
  "bge x7, x6, no_swap",
  "sw x7, 0(x5)",
  "sw x6, 4(x5)",
  "no_swap:",
  "addi x3, x3, 1",
  "beq x0, x0, inner",
  "next_pass:",
  "addi x2, x2, -1",
  "beq x0, x0, outer",
  "done:",
  "ecall",
].join("\n");
const stringCopyProgram = [
  ".data",
  "src:",
  `  .asciz "${copiedString}"`,
  "dst:",
  "  .space 32",
  ".text",
  "la x1, src",
  "la x2, dst",
  "copy_loop:",
  "lb x3, 0(x1)",
  "sb x3, 0(x2)",
  "beq x3, x0, done",
  "addi x1, x1, 1",
  "addi x2, x2, 1",
  "beq x0, x0, copy_loop",
  "done:",
  "ecall",
].join("\n");

if (!wasm.ok) {
  test.skip(`WASM runtime unavailable in Vitest/Node: ${wasm.error.message}`, () => {
    // Skip instead of mocking; these are true end-to-end regressions.
  });
}

const runtimeDescribe = wasm.ok ? describe : describe.skip;

function finalMemory(src: string, deltas: Awaited<ReturnType<typeof run>>): Map<number, number> {
  const parsed = parseAssembly(src);
  const memory = new Map<number, number>();

  parsed.data.forEach((byte, index) => {
    memory.set((DATA_BASE + index) >>> 0, byte & 0xff);
  });

  for (const delta of deltas) {
    for (const effect of delta.effects) {
      if (effect.kind === "mem") {
        memory.set(effect.addr >>> 0, effect.after & 0xff);
      }
    }
  }

  return memory;
}

function readWord(memory: Map<number, number>, addr: number): number {
  let value = 0;
  for (let index = 0; index < 4; index++) {
    value |= (memory.get((addr + index) >>> 0) ?? 0) << (index * 8);
  }
  return value >>> 0;
}

function readBytes(memory: Map<number, number>, addr: number, length: number): number[] {
  return Array.from({ length }, (_, index) => memory.get((addr + index) >>> 0) ?? 0);
}

runtimeDescribe("end-to-end sample programs", () => {
  it("loop counting to 10 leaves the counter register at 10", async () => {
    const deltas = await run(
      ["addi x1, x0, 0", "addi x2, x0, 10", "loop:", "addi x1, x1, 1", "blt x1, x2, loop", "ecall"].join("\n"),
      32
    );
    expect(finalRegs(deltas)[1]).toBe(10);
  });

  it("array sum of [1,2,3,4,5] leaves the result register at 15", async () => {
    const deltas = await run(
      [
        "addi x1, x0, 256",
        "addi x2, x0, 1",
        "sw x2, 0(x1)",
        "addi x2, x0, 2",
        "sw x2, 4(x1)",
        "addi x2, x0, 3",
        "sw x2, 8(x1)",
        "addi x2, x0, 4",
        "sw x2, 12(x1)",
        "addi x2, x0, 5",
        "sw x2, 16(x1)",
        "addi x3, x0, 0",
        "addi x4, x0, 0",
        "loop:",
        "slti x5, x3, 5",
        "beq x5, x0, done",
        "slli x6, x3, 2",
        "add x7, x1, x6",
        "lw x8, 0(x7)",
        "add x4, x4, x8",
        "addi x3, x3, 1",
        "beq x0, x0, loop",
        "done:",
        "ecall",
      ].join("\n"),
      128
    );
    expect(finalRegs(deltas)[4]).toBe(15);
  });

  it("factorial of 5 leaves the result register at 120", async () => {
    const deltas = await run(
      ["addi x1, x0, 5", "addi x2, x0, 1", "loop:", "beq x1, x0, done", "mul x2, x2, x1", "addi x1, x1, -1", "beq x0, x0, loop", "done:", "ecall"].join(
        "\n"
      ),
      64
    );
    expect(finalRegs(deltas)[2]).toBe(120);
  });

  it("string length leaves the result register at the correct length", async () => {
    const deltas = await run(
      [
        "addi x1, x0, 128",
        "addi x2, x0, 0x48",
        "sb x2, 0(x1)",
        "addi x2, x0, 0x69",
        "sb x2, 1(x1)",
        "addi x2, x0, 0x21",
        "sb x2, 2(x1)",
        "sb x0, 3(x1)",
        "addi x3, x0, 0",
        "loop:",
        "lb x4, 0(x1)",
        "beq x4, x0, done",
        "addi x3, x3, 1",
        "addi x1, x1, 1",
        "beq x0, x0, loop",
        "done:",
        "ecall",
      ].join("\n"),
      64
    );
    expect(finalRegs(deltas)[3]).toBe(3);
  });

  it("xor checksum leaves the checksum register at the expected value", async () => {
    const deltas = await run(
      [
        "addi x1, x0, 400",
        "addi x2, x0, 0x12",
        "sb x2, 0(x1)",
        "addi x2, x0, 0x34",
        "sb x2, 1(x1)",
        "addi x2, x0, 0x56",
        "sb x2, 2(x1)",
        "addi x2, x0, 0x78",
        "sb x2, 3(x1)",
        "addi x3, x0, 0",
        "addi x4, x0, 0",
        "loop:",
        "slti x5, x3, 4",
        "beq x5, x0, done",
        "add x6, x1, x3",
        "lbu x7, 0(x6)",
        "xor x4, x4, x7",
        "addi x3, x3, 1",
        "beq x0, x0, loop",
        "done:",
        "ecall",
      ].join("\n"),
      96
    );
    expect(finalRegs(deltas)[4]).toBe(0x08);
  });

  it("bubble sort leaves the data segment array in ascending order", async () => {
    const deltas = await run(bubbleSortProgram, 256);
    const memory = finalMemory(bubbleSortProgram, deltas);
    const words = Array.from({ length: 5 }, (_, index) => readWord(memory, DATA_BASE + index * 4));
    expect(words).toEqual([1, 2, 4, 5, 8]);
  });

  it("string copy leaves the destination buffer with the copied bytes and terminator", async () => {
    const deltas = await run(stringCopyProgram, 256);
    const memory = finalMemory(stringCopyProgram, deltas);
    const dstAddr = DATA_BASE + copiedString.length + 1;
    const expected = [...new TextEncoder().encode(copiedString), 0];
    expect(readBytes(memory, dstAddr, expected.length)).toEqual(expected);
  });
});

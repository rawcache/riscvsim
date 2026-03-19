import { describe, expect, it, test } from "vitest";
import { parseAssembly } from "../../src/asm";
import { DATA_BASE } from "../../src/memory-map";
import { canLoadRuntime, finalRegs, run } from "./helpers";

const wasm = await canLoadRuntime();

if (!wasm.ok) {
  test.skip(`WASM runtime unavailable in Vitest/Node: ${wasm.error.message}`, () => {
    // Skip instead of mocking; these assertions depend on the real WASM runtime.
  });
}

const runtimeDescribe = wasm.ok ? describe : describe.skip;

function u16At(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function u32At(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

describe("data directive emission", () => {
  it(".byte emits the expected bytes", () => {
    const parsed = parseAssembly([".data", ".byte 1, 2, 3"].join("\n"));
    expect(Array.from(parsed.data)).toEqual([1, 2, 3]);
  });

  it(".half emits little-endian bytes", () => {
    const parsed = parseAssembly([".data", ".half 0x1234"].join("\n"));
    expect(parsed.data).toHaveLength(2);
    expect(Array.from(parsed.data)).toEqual([0x34, 0x12]);
    expect(u16At(parsed.data, 0)).toBe(0x1234);
  });

  it(".word emits little-endian bytes", () => {
    const parsed = parseAssembly([".data", ".word 0xDEADBEEF"].join("\n"));
    expect(parsed.data).toHaveLength(4);
    expect(Array.from(parsed.data)).toEqual([0xef, 0xbe, 0xad, 0xde]);
    expect(u32At(parsed.data, 0)).toBe(0xdeadbeef >>> 0);
  });

  it(".ascii emits bytes without a null terminator", () => {
    const parsed = parseAssembly([".data", '.ascii "hi"'].join("\n"));
    expect(Array.from(parsed.data)).toEqual([0x68, 0x69]);
  });

  it(".asciz emits bytes with a null terminator", () => {
    const parsed = parseAssembly([".data", '.asciz "hi"'].join("\n"));
    expect(Array.from(parsed.data)).toEqual([0x68, 0x69, 0x00]);
  });

  it(".space emits zero-filled bytes", () => {
    const parsed = parseAssembly([".data", ".space 8"].join("\n"));
    expect(parsed.data).toHaveLength(8);
    expect(Array.from(parsed.data)).toEqual(new Array(8).fill(0));
  });

  it(".align pads to the next 2^n byte boundary", () => {
    const parsed = parseAssembly([".data", ".byte 1", ".align 2", ".byte 2"].join("\n"));
    expect(Array.from(parsed.data)).toEqual([1, 0, 0, 0, 2]);
  });
});

runtimeDescribe("data label resolution", () => {
  it("a label defined in .data resolves to 0x10000000 + offset", async () => {
    const deltas = await run(
      [".text", "la x5, value", "ecall", ".data", ".byte 1, 2, 3, 4", "value:", ".word 99"].join("\n"),
      4
    );
    expect(finalRegs(deltas)[5]).toBe(DATA_BASE + 4);
  });
});

describe("data label references", () => {
  it(".word with a label reference encodes the target address", () => {
    const parsed = parseAssembly(
      [".data", "value:", ".word 0x12345678", "ptr:", ".word value"].join("\n")
    );
    expect(u32At(parsed.data, 4)).toBe(DATA_BASE);
  });
});

describe("la pseudo-instruction", () => {
  it("la occupies two instructions", () => {
    const parsed = parseAssembly([".text", "la x5, value", "ecall", ".data", "value:", ".word 7"].join("\n"));
    expect(parsed.instructions.slice(0, 2)).toMatchObject([
      { op: "auipc", rd: 5 },
      { op: "addi", rd: 5, rs1: 5 },
    ]);
  });

  it("la to an undefined label throws a descriptive error", () => {
    expect(() => parseAssembly("la x5, missing")).toThrow(/undefined label "missing"/i);
  });
});

runtimeDescribe("la execution", () => {
  it("la followed by lw loads the correct value from .data", async () => {
    const deltas = await run(
      [".text", "la x5, value", "lw x6, 0(x5)", "ecall", ".data", "value:", ".word 0x12345678"].join("\n"),
      6
    );
    expect(finalRegs(deltas)[6]).toBe(0x12345678);
  });
});

runtimeDescribe("data end-to-end programs", () => {
  it("array sum from .data leaves the sum register at 15", async () => {
    const deltas = await run(
      [
        ".data",
        "values:",
        ".word 1, 2, 3, 4, 5",
        ".text",
        "la x1, values",
        "addi x2, x0, 5",
        "addi x3, x0, 0",
        "addi x4, x0, 0",
        "loop:",
        "beq x3, x2, done",
        "slli x5, x3, 2",
        "add x6, x1, x5",
        "lw x7, 0(x6)",
        "add x4, x4, x7",
        "addi x3, x3, 1",
        "beq x0, x0, loop",
        "done:",
        "ecall",
      ].join("\n"),
      128
    );
    expect(finalRegs(deltas)[4]).toBe(15);
  });

  it("string length from .data leaves the length register at 5", async () => {
    const deltas = await run(
      [
        ".data",
        'msg: .asciz "hello"',
        ".text",
        "la x1, msg",
        "addi x2, x0, 0",
        "loop:",
        "lb x3, 0(x1)",
        "beq x3, x0, done",
        "addi x2, x2, 1",
        "addi x1, x1, 1",
        "beq x0, x0, loop",
        "done:",
        "ecall",
      ].join("\n"),
      96
    );
    expect(finalRegs(deltas)[2]).toBe(5);
  });

  it(".word label reference supports pointer-to-pointer round trips", async () => {
    const deltas = await run(
      [
        ".data",
        "value: .word 99",
        "ptr: .word value",
        ".text",
        "la x1, ptr",
        "lw x2, 0(x1)",
        "lw x3, 0(x2)",
        "ecall",
      ].join("\n"),
      12
    );
    expect(finalRegs(deltas)[3]).toBe(99);
  });

  it("stack round-trip near the initialized sp preserves the stored value", async () => {
    const deltas = await run(
      [".text", "li x5, 0x12345", "sw x5, -4(sp)", "lw x6, -4(sp)", "ecall"].join("\n"),
      8
    );
    expect(finalRegs(deltas)[6]).toBe(0x12345);
  });
});

import { describe, expect, it, test } from "vitest";
import { parseAssembly } from "../../src/asm";
import { assemble, canLoadRuntime, decodeBImmediate, decodeJImmediate, wordAt } from "./helpers";

const wasm = await canLoadRuntime();

if (!wasm.ok) {
  test.skip(`WASM runtime unavailable in Vitest/Node: ${wasm.error.message}`, () => {
    // Skip instead of mocking; these regressions are supposed to exercise the real encode path.
  });
}

const runtimeDescribe = wasm.ok ? describe : describe.skip;

runtimeDescribe("label resolution", () => {
  it("forward branch label reference resolves correctly", async () => {
    const src = ["beq x0, x0, target", "addi x1, x0, 1", "target:", "ecall"].join("\n");
    const parsed = parseAssembly(src);
    expect(parsed.instructions[0]).toMatchObject({ op: "beq", target_pc: 8 });

    const bytes = await assemble(src);
    expect(decodeBImmediate(wordAt(bytes, 0))).toBe(8);
  });

  it("backward branch label reference resolves correctly", async () => {
    const src = ["start:", "addi x1, x0, 1", "beq x0, x0, start"].join("\n");
    const parsed = parseAssembly(src);
    expect(parsed.instructions[1]).toMatchObject({ op: "beq", target_pc: 0 });

    const bytes = await assemble(src);
    expect(decodeBImmediate(wordAt(bytes, 1))).toBe(-4);
  });

  it("label at the start of the program resolves to PC 0", async () => {
    const src = ["start:", "j start"].join("\n");
    const parsed = parseAssembly(src);
    expect(parsed.instructions[0]).toMatchObject({ op: "jal", rd: 0, target_pc: 0 });

    const bytes = await assemble(src);
    expect(decodeJImmediate(wordAt(bytes, 0))).toBe(0);
  });

  it("two labels in the same program do not interfere", async () => {
    const src = [
      "first:",
      "beq x0, x0, second",
      "addi x1, x0, 1",
      "second:",
      "beq x0, x0, first",
    ].join("\n");

    const parsed = parseAssembly(src);
    expect(parsed.instructions[0]).toMatchObject({ op: "beq", target_pc: 8 });
    expect(parsed.instructions[2]).toMatchObject({ op: "beq", target_pc: 0 });

    const bytes = await assemble(src);
    expect(decodeBImmediate(wordAt(bytes, 0))).toBe(8);
    expect(decodeBImmediate(wordAt(bytes, 2))).toBe(-8);
  });

  it("encodes a negative signed branch offset for a label behind the current PC", async () => {
    const src = ["loop:", "addi x1, x0, 1", "beq x0, x0, loop"].join("\n");
    const bytes = await assemble(src);
    expect(decodeBImmediate(wordAt(bytes, 1))).toBeLessThan(0);
    expect(decodeBImmediate(wordAt(bytes, 1))).toBe(-4);
  });
});

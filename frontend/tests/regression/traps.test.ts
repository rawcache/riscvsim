import { describe, expect, it, test } from "vitest";
import { canLoadRuntime, finalRegs, run, runBytes, trapCauseCode, u32le } from "./helpers";

const wasm = await canLoadRuntime();

if (!wasm.ok) {
  test.skip(`WASM runtime unavailable in Vitest/Node: ${wasm.error.message}`, () => {
    // Skip instead of mocking; trap regressions need the real runtime behavior.
  });
}

const runtimeDescribe = wasm.ok ? describe : describe.skip;

runtimeDescribe("trap emission", () => {
  it("misaligned jal target traps and does not write ra before the trap", async () => {
    const deltas = await runBytes(u32le(0x002000ef), 1); // jal x1, +2
    expect(trapCauseCode(deltas[0])).toBe(0);
    expect(deltas[0].trap?.cause).toBeTruthy();
    expect(finalRegs(deltas)[1]).toBe(0);
  });

  it("misaligned jalr target traps and does not write rd before the trap", async () => {
    const deltas = await run(["addi x2, x0, 2", "jalr x1, 0(x2)"].join("\n"), 3);
    expect(trapCauseCode(deltas.at(-1)!)).toBe(0);
    expect(finalRegs(deltas)[1]).toBe(0);
  });

  it("ecall emits a trap with a cause field", async () => {
    const deltas = await run("ecall", 1);
    expect(deltas[0].trap?.cause).toBeTruthy();
    expect(trapCauseCode(deltas[0])).toBe(11);
  });

  it("ebreak emits a trap with a cause field", async () => {
    const deltas = await runBytes(u32le(0x00100073), 1);
    expect(deltas[0].trap?.cause).toBeTruthy();
    expect(trapCauseCode(deltas[0])).toBe(3);
  });
});

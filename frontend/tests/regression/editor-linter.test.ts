import { describe, expect, it } from "vitest";

import { parseAssembly } from "../../src/asm";
import { lintProgram } from "../../src/linter";

describe("editor linter integration", () => {
  it("lintProgram with clean program returns []", () => {
    const source = ["addi x1, x0, 5", "addi x2, x1, 3", "ecall"].join("\n");
    expect(lintProgram(source, parseAssembly(source))).toEqual([]);
  });

  it("WARN001 fired for addi x0, x1, 5", () => {
    const source = "addi x0, x1, 5";
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN001")).toBe(true);
  });

  it("WARN002 fired for lw x0, 0(x1)", () => {
    const source = "lw x0, 0(x1)";
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN002")).toBe(true);
  });

  it("WARN003 fired for instruction after j label", () => {
    const source = ["j done", "addi x1, x0, 5", "done:", "ecall"].join("\n");
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN003" && warning.line === 2)).toBe(true);
  });

  it("WARN003 NOT fired for label after j", () => {
    const source = ["j done", "done:", "addi x1, x0, 5", "ecall"].join("\n");
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN003")).toBe(false);
  });

  it("WARN004 fired for lw x1, 1(x2)", () => {
    const source = "lw x1, 1(x2)";
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN004")).toBe(true);
  });

  it("WARN004 NOT fired for lw x1, 4(x2)", () => {
    const source = "lw x1, 4(x2)";
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN004")).toBe(false);
  });

  it("WARN005 fired for addi x1, x0, 5000", () => {
    const source = "addi x1, x0, 5000";
    const warnings = lintProgram(source, { instructions: [], disasm: [], text: new Uint8Array(), data: new Uint8Array() });
    expect(warnings.some((warning) => warning.code === "WARN005")).toBe(true);
  });

  it("WARN007 fired for unrestored sp", () => {
    const source = ["addi sp, sp, -16", "ecall"].join("\n");
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN007")).toBe(true);
  });

  it("WARN007 NOT fired for properly restored sp", () => {
    const source = ["addi sp, sp, -16", "addi sp, sp, 16", "ecall"].join("\n");
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN007")).toBe(false);
  });
});

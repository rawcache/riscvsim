import { describe, expect, it } from "vitest";

import { parseAssembly } from "../../src/asm";
import { BreakpointManager } from "../../src/breakpoints";
import { lintProgram } from "../../src/linter";

describe("linter.ts", () => {
  it("WARN001: writing to x0 detected", () => {
    const source = "addi x0, x1, 5";
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN001")).toBe(true);
  });

  it("WARN001: NOT triggered for valid addi x1, x0, 5", () => {
    const source = "addi x1, x0, 5";
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN001")).toBe(false);
  });

  it("WARN002: load to x0 detected", () => {
    const source = "lw x0, 0(x1)";
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN002")).toBe(true);
  });

  it("WARN003: unreachable code after j detected", () => {
    const source = ["j done", "addi x1, x0, 5", "done:", "ecall"].join("\n");
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN003" && warning.line === 2)).toBe(true);
  });

  it("WARN003: NOT triggered for code after a label", () => {
    const source = ["j done", "done:", "addi x1, x0, 5", "ecall"].join("\n");
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN003")).toBe(false);
  });

  it("WARN004: misaligned lw offset 1 detected", () => {
    const source = "lw x1, 1(x2)";
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN004")).toBe(true);
  });

  it("WARN004: NOT triggered for lw offset 4", () => {
    const source = "lw x1, 4(x2)";
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN004")).toBe(false);
  });

  it("WARN005: large immediate > 4095 detected", () => {
    const source = "addi x1, x0, 5000";
    const warnings = lintProgram(source, { instructions: [], disasm: [], text: new Uint8Array(), data: new Uint8Array() });
    expect(warnings.some((warning) => warning.code === "WARN005")).toBe(true);
  });

  it("WARN005: NOT triggered for imm = 100", () => {
    const source = "addi x1, x0, 100";
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN005")).toBe(false);
  });

  it("WARN006: register read before write detected", () => {
    const source = "add x3, x4, x5";
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN006")).toBe(true);
  });

  it("WARN007: sp decremented not restored detected", () => {
    const source = ["addi sp, sp, -16", "ecall"].join("\n");
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN007")).toBe(true);
  });

  it("WARN007: NOT triggered when sp correctly restored", () => {
    const source = ["addi sp, sp, -16", "addi sp, sp, 16", "ecall"].join("\n");
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.some((warning) => warning.code === "WARN007")).toBe(false);
  });

  it("lintProgram returns empty array for clean program", () => {
    const source = ["addi x1, x0, 5", "addi x2, x1, 3", "ecall"].join("\n");
    expect(lintProgram(source, parseAssembly(source))).toEqual([]);
  });

  it("lintProgram returns multiple warnings for bad program", () => {
    const source = ["addi sp, sp, -8", "lw x0, 1(x3)", "j done", "addi x0, x1, 5", "done:", "ecall"].join("\n");
    const warnings = lintProgram(source, parseAssembly(source));
    expect(warnings.length).toBeGreaterThanOrEqual(4);
  });
});

describe("breakpoints.ts", () => {
  it("add() creates breakpoint with correct line", () => {
    const manager = new BreakpointManager();
    const breakpoint = manager.add(4);
    expect(breakpoint.line).toBe(4);
    expect(manager.getAll()).toHaveLength(1);
  });

  it("toggle() adds new breakpoint if not exists", () => {
    const manager = new BreakpointManager();
    manager.toggle(6);
    expect(manager.getAll()).toHaveLength(1);
    expect(manager.getAll()[0]?.line).toBe(6);
  });

  it("toggle() removes existing breakpoint", () => {
    const manager = new BreakpointManager();
    manager.toggle(6);
    manager.toggle(6);
    expect(manager.getAll()).toHaveLength(0);
  });

  it("isBreakpointAt() returns true after resolveAddresses", () => {
    const manager = new BreakpointManager();
    manager.add(2);
    manager.resolveAddresses(parseAssembly(["addi x1, x0, 1", "addi x2, x0, 2", "ecall"].join("\n")));
    expect(manager.isBreakpointAt(4)).toBe(true);
  });

  it("clear() removes all breakpoints", () => {
    const manager = new BreakpointManager();
    manager.add(1);
    manager.add(2);
    manager.clear();
    expect(manager.getAll()).toHaveLength(0);
  });

  it("maximum 10 breakpoints enforced", () => {
    const manager = new BreakpointManager();
    for (let line = 1; line <= 12; line += 1) {
      manager.add(line);
    }
    expect(manager.getAll()).toHaveLength(10);
  });

  it("recordHit() increments hitCount", () => {
    const manager = new BreakpointManager();
    const breakpoint = manager.add(1);
    manager.resolveAddresses(parseAssembly("addi x1, x0, 1"));
    manager.recordHit(0);
    expect(manager.getAll().find((entry) => entry.id === breakpoint.id)?.hitCount).toBe(1);
  });
});

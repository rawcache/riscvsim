import { describe, expect, it } from "vitest";

import { parseAssembly } from "../../src/asm";
import { BreakpointManager } from "../../src/breakpoints";

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

import { describe, expect, it } from "vitest";

import { StackTracker } from "../../src/stack-tracker";
import type { Effect, WasmStateDelta } from "../../src/types";

const SP_INIT = 0x7ffffffc;

function step(pcBefore: number, pcAfter: number, effects: Effect[] = []): WasmStateDelta {
  return {
    pc: pcAfter >>> 0,
    halted: false,
    trap: null,
    effects: [...effects, { kind: "pc", before: pcBefore >>> 0, after: pcAfter >>> 0 }],
  };
}

function wordStoreEffects(address: number, value: number, before = 0): Effect[] {
  const beforeBytes = [
    before & 0xff,
    (before >>> 8) & 0xff,
    (before >>> 16) & 0xff,
    (before >>> 24) & 0xff,
  ];
  const afterBytes = [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];

  return afterBytes.map((afterByte, index) => ({
    kind: "mem" as const,
    addr: (address + index) >>> 0,
    before: beforeBytes[index],
    after: afterByte,
  }));
}

describe("StackTracker", () => {
  it("reset() produces empty call stack with correct spInitial", () => {
    const tracker = new StackTracker();

    tracker.reset();

    expect(tracker.getCallStack()).toEqual({
      frames: [],
      spCurrent: SP_INIT,
      spInitial: SP_INIT,
      totalDepth: 0,
    });
  });

  it("applyDelta with ra write + non-sequential PC detects function call", () => {
    const tracker = new StackTracker();

    tracker.applyDelta(step(0x00000000, 0x00000020, [{ kind: "reg", reg: 1, before: 0, after: 0x00000004 }]));

    const callStack = tracker.getCallStack();
    expect(callStack.frames).toHaveLength(1);
    expect(callStack.totalDepth).toBe(1);
    expect(callStack.frames[0]).toMatchObject({
      entryPc: 0x00000020,
      returnAddress: 0x00000004,
      baseAddress: SP_INIT,
      isLeaf: true,
    });
  });

  it("applyDelta with PC matching returnAddress detects function return", () => {
    const tracker = new StackTracker();

    tracker.applyDelta(step(0x00000000, 0x00000020, [{ kind: "reg", reg: 1, before: 0, after: 0x00000004 }]));
    tracker.applyDelta(step(0x00000030, 0x00000004));

    expect(tracker.getCallStack().frames).toHaveLength(0);
  });

  it("sw to stack address adds slot to current frame", () => {
    const tracker = new StackTracker();

    tracker.applyDelta(step(0x00000000, 0x00000020, [{ kind: "reg", reg: 1, before: 0, after: 0x00000004 }]));
    tracker.applyDelta(
      step(0x00000020, 0x00000024, [{ kind: "reg", reg: 2, before: SP_INIT, after: 0x7ffffff4 }])
    );
    tracker.applyDelta(step(0x00000024, 0x00000028, wordStoreEffects(0x7ffffff4, 0xdeadbeef)));

    const currentFrame = tracker.getCallStack().frames[0];
    expect(currentFrame.localSlots).toEqual([
      {
        address: 0x7ffffff4,
        value: 0xdeadbeef,
        label: "local",
      },
    ]);
  });

  it("sw of callee-saved register is classified as savedRegister", () => {
    const tracker = new StackTracker();

    tracker.applyDelta(step(0x00000000, 0x00000040, [{ kind: "reg", reg: 1, before: 0, after: 0x00000004 }]));
    tracker.applyDelta(
      step(0x00000040, 0x00000044, [{ kind: "reg", reg: 8, before: 0, after: 0x12345678 }])
    );
    tracker.applyDelta(
      step(0x00000044, 0x00000048, [{ kind: "reg", reg: 2, before: SP_INIT, after: 0x7ffffff4 }])
    );
    tracker.applyDelta(step(0x00000048, 0x0000004c, wordStoreEffects(0x7ffffff8, 0x12345678)));

    const currentFrame = tracker.getCallStack().frames[0];
    expect(currentFrame.savedRegisters).toEqual([
      {
        reg: 8,
        name: "s0",
        value: 0x12345678,
        address: 0x7ffffff8,
      },
    ]);
    expect(currentFrame.localSlots).toEqual([]);
  });

  it("stepBack() restores previous frame count", () => {
    const tracker = new StackTracker();

    tracker.applyDelta(step(0x00000000, 0x00000020, [{ kind: "reg", reg: 1, before: 0, after: 0x00000004 }]));
    expect(tracker.getCallStack().frames).toHaveLength(1);

    tracker.stepBack();

    expect(tracker.getCallStack().frames).toHaveLength(0);
  });

  it("multiple nested calls produce correct frame depth", () => {
    const tracker = new StackTracker();

    tracker.applyDelta(step(0x00000000, 0x00000020, [{ kind: "reg", reg: 1, before: 0, after: 0x00000004 }]));
    tracker.applyDelta(
      step(0x00000020, 0x00000040, [{ kind: "reg", reg: 1, before: 0x00000004, after: 0x00000024 }])
    );

    const callStack = tracker.getCallStack();
    expect(callStack.frames).toHaveLength(2);
    expect(callStack.totalDepth).toBe(2);
    expect(callStack.frames[0].isLeaf).toBe(false);
    expect(callStack.frames[1].returnAddress).toBe(0x00000024);
  });

  it("frame pop after recursive return restores correct frame", () => {
    const tracker = new StackTracker();

    tracker.applyDelta(step(0x00000000, 0x00000020, [{ kind: "reg", reg: 1, before: 0, after: 0x00000004 }]));
    tracker.applyDelta(
      step(0x00000028, 0x00000020, [{ kind: "reg", reg: 1, before: 0x00000004, after: 0x0000002c }])
    );
    tracker.applyDelta(step(0x00000034, 0x0000002c));

    const callStack = tracker.getCallStack();
    expect(callStack.frames).toHaveLength(1);
    expect(callStack.frames[0]).toMatchObject({
      entryPc: 0x00000020,
      returnAddress: 0x00000004,
      isLeaf: false,
    });
  });
});

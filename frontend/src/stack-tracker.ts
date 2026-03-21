import type { Effect, WasmStateDelta } from "./types";

const STACK_POINTER_INIT = 0x7ffffffc;
const STACK_SCAN_BYTES = 128;
const MAX_HISTORY = 500;
const ROOT_RETURN_ADDRESS = -1;

const ABI_NAMES = [
  "zero",
  "ra",
  "sp",
  "gp",
  "tp",
  "t0",
  "t1",
  "t2",
  "s0",
  "s1",
  "a0",
  "a1",
  "a2",
  "a3",
  "a4",
  "a5",
  "a6",
  "a7",
  "s2",
  "s3",
  "s4",
  "s5",
  "s6",
  "s7",
  "s8",
  "s9",
  "s10",
  "s11",
  "t3",
  "t4",
  "t5",
  "t6",
] as const;

const CALLEE_SAVED_REGS = [1, 8, 9, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27] as const;
const CALLEE_SAVED_SET = new Set<number>(CALLEE_SAVED_REGS);

export interface StackFrame {
  functionLabel: string;
  baseAddress: number;
  returnAddress: number;
  savedRegisters: {
    reg: number;
    name: string;
    value: number;
    address: number;
  }[];
  localSlots: {
    address: number;
    value: number;
    label: string;
  }[];
  entryPc: number;
  isLeaf: boolean;
}

export interface CallStack {
  frames: StackFrame[];
  spCurrent: number;
  spInitial: number;
  totalDepth: number;
}

type TrackerSnapshot = {
  callStack: CallStack;
  regState: number[];
  memState: [number, number][];
};

type LabelResolver = (pc: number) => string | undefined;

let resolveFunctionLabel: LabelResolver | null = null;
let fallbackRootLabel = "main";

export function setStackLabelResolver(resolver: LabelResolver | null, rootLabel = "main"): void {
  resolveFunctionLabel = resolver;
  fallbackRootLabel = rootLabel || "main";
}

export function stackFrameKey(frame: Pick<StackFrame, "entryPc" | "baseAddress" | "returnAddress">): string {
  return `${frame.entryPc}:${frame.baseAddress}:${frame.returnAddress}`;
}

function cloneFrame(frame: StackFrame): StackFrame {
  return {
    functionLabel: frame.functionLabel,
    baseAddress: frame.baseAddress >>> 0,
    returnAddress: frame.returnAddress,
    savedRegisters: frame.savedRegisters.map((saved) => ({
      reg: saved.reg,
      name: saved.name,
      value: saved.value >>> 0,
      address: saved.address >>> 0,
    })),
    localSlots: frame.localSlots.map((slot) => ({
      address: slot.address >>> 0,
      value: slot.value >>> 0,
      label: slot.label,
    })),
    entryPc: frame.entryPc >>> 0,
    isLeaf: frame.isLeaf,
  };
}

function cloneCallStack(callStack: CallStack): CallStack {
  return {
    frames: callStack.frames.map(cloneFrame),
    spCurrent: callStack.spCurrent >>> 0,
    spInitial: callStack.spInitial >>> 0,
    totalDepth: callStack.frames.length,
  };
}

function makeEmptyCallStack(): CallStack {
  return {
    frames: [],
    spCurrent: STACK_POINTER_INIT,
    spInitial: STACK_POINTER_INIT,
    totalDepth: 0,
  };
}

function abiName(reg: number): string {
  return ABI_NAMES[reg] ?? `x${reg}`;
}

function resolveLabel(pc: number, fallback = `sub_${(pc >>> 0).toString(16).padStart(8, "0")}`): string {
  return resolveFunctionLabel?.(pc >>> 0) ?? (pc === 0 ? fallbackRootLabel : fallback);
}

function effectPc(delta: WasmStateDelta): Extract<Effect, { kind: "pc" }> | undefined {
  return delta.effects.find((effect): effect is Extract<Effect, { kind: "pc" }> => effect.kind === "pc");
}

function effectReg(delta: WasmStateDelta, reg: number): Extract<Effect, { kind: "reg" }> | undefined {
  return delta.effects.find(
    (effect): effect is Extract<Effect, { kind: "reg" }> => effect.kind === "reg" && effect.reg === reg
  );
}

export class StackTracker {
  private callStack: CallStack;
  private history: CallStack[];
  private regState: number[];
  private memState: Map<number, number>;
  private snapshots: TrackerSnapshot[];

  constructor() {
    this.callStack = makeEmptyCallStack();
    this.history = [];
    this.regState = Array.from({ length: 32 }, () => 0);
    this.regState[2] = STACK_POINTER_INIT;
    this.memState = new Map<number, number>();
    this.snapshots = [];
  }

  reset(): void {
    this.callStack = makeEmptyCallStack();
    this.history = [];
    this.regState = Array.from({ length: 32 }, () => 0);
    this.regState[2] = STACK_POINTER_INIT;
    this.memState = new Map<number, number>();
    this.snapshots = [];
  }

  applyDelta(delta: WasmStateDelta): void {
    this.pushHistorySnapshot();

    const pcEffect = effectPc(delta);
    const raEffect = effectReg(delta, 1);
    const previousRegs = [...this.regState];
    const previousSp = previousRegs[2] >>> 0;

    for (const effect of delta.effects) {
      if (effect.kind === "reg") {
        this.regState[effect.reg] = effect.after >>> 0;
      }
    }

    for (const effect of delta.effects) {
      if (effect.kind === "mem") {
        this.memState.set(effect.addr >>> 0, effect.after & 0xff);
      }
    }

    this.callStack.spCurrent = this.regState[2] >>> 0;

    const touchedStackWords = this.collectTouchedStackWords(delta.effects);
    if (this.callStack.frames.length === 0 && (this.callStack.spCurrent < this.callStack.spInitial || touchedStackWords.size > 0)) {
      this.ensureRootFrame(pcEffect?.before ?? delta.pc ?? 0, previousSp);
    }

    if (
      pcEffect &&
      raEffect &&
      (raEffect.after >>> 0) === ((pcEffect.before + 4) >>> 0) &&
      (pcEffect.after >>> 0) !== ((pcEffect.before + 4) >>> 0)
    ) {
      const currentFrame = this.currentFrame();
      if (currentFrame) {
        currentFrame.isLeaf = false;
      }
      this.callStack.frames.push({
        functionLabel: resolveLabel(pcEffect.after),
        baseAddress: this.callStack.spCurrent >>> 0,
        returnAddress: raEffect.after >>> 0,
        savedRegisters: [],
        localSlots: [],
        entryPc: pcEffect.after >>> 0,
        isLeaf: true,
      });
    }

    const frameBeforeReturn = this.currentFrame();
    if (
      pcEffect &&
      frameBeforeReturn &&
      frameBeforeReturn.returnAddress !== ROOT_RETURN_ADDRESS &&
      (pcEffect.after >>> 0) === (frameBeforeReturn.returnAddress >>> 0)
    ) {
      this.callStack.frames.pop();
    }

    const activeFrame = this.currentFrame();
    if (activeFrame) {
      for (const address of touchedStackWords) {
        const value = this.readWord(address);
        const savedRegister = this.classifySavedRegister(activeFrame, address, value);
        if (savedRegister) {
          this.upsertSavedRegister(activeFrame, {
            reg: savedRegister.reg,
            name: savedRegister.name,
            value,
            address,
          });
        } else {
          this.upsertLocalSlot(activeFrame, {
            address,
            value,
            label: "local",
          });
        }
      }
    }

    this.callStack.totalDepth = this.callStack.frames.length;
  }

  getCallStack(): CallStack {
    return cloneCallStack(this.callStack);
  }

  stepBack(): void {
    const snapshot = this.snapshots.pop();
    if (!snapshot) {
      return;
    }

    this.history.pop();
    this.callStack = cloneCallStack(snapshot.callStack);
    this.regState = [...snapshot.regState];
    this.memState = new Map(snapshot.memState);
  }

  private pushHistorySnapshot(): void {
    const snapshot: TrackerSnapshot = {
      callStack: cloneCallStack(this.callStack),
      regState: [...this.regState],
      memState: Array.from(this.memState.entries()),
    };

    this.history.push(cloneCallStack(this.callStack));
    this.snapshots.push(snapshot);

    while (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }
    while (this.snapshots.length > MAX_HISTORY) {
      this.snapshots.shift();
    }
  }

  private currentFrame(): StackFrame | undefined {
    return this.callStack.frames[this.callStack.frames.length - 1];
  }

  private ensureRootFrame(entryPc: number, baseAddress: number): void {
    if (this.callStack.frames.length > 0) {
      return;
    }

    this.callStack.frames.push({
      functionLabel: resolveLabel(entryPc >>> 0, fallbackRootLabel),
      baseAddress: baseAddress >>> 0,
      returnAddress: ROOT_RETURN_ADDRESS,
      savedRegisters: [],
      localSlots: [],
      entryPc: entryPc >>> 0,
      isLeaf: true,
    });
  }

  private collectTouchedStackWords(effects: readonly Effect[]): Set<number> {
    const addresses = new Set<number>();
    const lowerBound = Math.max(0, (this.callStack.spCurrent >>> 0) - STACK_SCAN_BYTES);

    for (const effect of effects) {
      if (effect.kind !== "mem") {
        continue;
      }
      const addr = effect.addr >>> 0;
      if (addr >= this.callStack.spInitial || addr < lowerBound) {
        continue;
      }
      addresses.add(addr & ~0x3);
    }

    return addresses;
  }

  private readWord(address: number): number {
    const b0 = this.memState.get(address) ?? 0;
    const b1 = this.memState.get(address + 1) ?? 0;
    const b2 = this.memState.get(address + 2) ?? 0;
    const b3 = this.memState.get(address + 3) ?? 0;
    return (((b3 & 0xff) << 24) | ((b2 & 0xff) << 16) | ((b1 & 0xff) << 8) | (b0 & 0xff)) >>> 0;
  }

  private classifySavedRegister(
    frame: StackFrame,
    address: number,
    value: number
  ): { reg: number; name: string } | null {
    const existing = frame.savedRegisters.find((saved) => saved.address === address);
    if (existing) {
      return { reg: existing.reg, name: existing.name };
    }

    if (address > this.callStack.spCurrent && value === (frame.returnAddress >>> 0)) {
      return { reg: 1, name: abiName(1) };
    }

    if (address <= this.callStack.spCurrent) {
      return null;
    }

    const alreadySaved = new Set(frame.savedRegisters.map((saved) => saved.reg));
    const match = CALLEE_SAVED_REGS.find((reg) => {
      if (reg === 1 || alreadySaved.has(reg) || !CALLEE_SAVED_SET.has(reg)) {
        return false;
      }
      return (this.regState[reg] >>> 0) === (value >>> 0);
    });

    return match !== undefined ? { reg: match, name: abiName(match) } : null;
  }

  private upsertSavedRegister(
    frame: StackFrame,
    savedRegister: { reg: number; name: string; value: number; address: number }
  ): void {
    frame.localSlots = frame.localSlots.filter((slot) => slot.address !== savedRegister.address);

    const index = frame.savedRegisters.findIndex(
      (saved) => saved.address === savedRegister.address || saved.reg === savedRegister.reg
    );
    if (index >= 0) {
      frame.savedRegisters[index] = {
        reg: savedRegister.reg,
        name: savedRegister.name,
        value: savedRegister.value >>> 0,
        address: savedRegister.address >>> 0,
      };
    } else {
      frame.savedRegisters.push({
        reg: savedRegister.reg,
        name: savedRegister.name,
        value: savedRegister.value >>> 0,
        address: savedRegister.address >>> 0,
      });
    }

    frame.savedRegisters.sort((left, right) => right.address - left.address);
  }

  private upsertLocalSlot(frame: StackFrame, slot: { address: number; value: number; label: string }): void {
    if (frame.savedRegisters.some((saved) => saved.address === slot.address)) {
      return;
    }

    const index = frame.localSlots.findIndex((existing) => existing.address === slot.address);
    if (index >= 0) {
      frame.localSlots[index] = {
        address: slot.address >>> 0,
        value: slot.value >>> 0,
        label: slot.label,
      };
    } else {
      frame.localSlots.push({
        address: slot.address >>> 0,
        value: slot.value >>> 0,
        label: slot.label,
      });
    }

    frame.localSlots.sort((left, right) => right.address - left.address);
  }
}

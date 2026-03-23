import type { LessonState } from "./lessons";

type WatchModeState = {
  lessonId: string;
  stepId: string;
} | null;

type NarrationSnapshot = {
  registers?: number[];
  pc?: number;
};

let activeWatchMode: WatchModeState = null;

function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function regName(index: number | undefined): string {
  return typeof index === "number" && index >= 0 ? `x${index}` : "register";
}

function parseRegisters(line: string): number[] {
  return Array.from(line.matchAll(/\b(?:x([0-9]|[12][0-9]|3[01])|(?:zero|ra|sp|gp|tp|t[0-6]|s(?:[0-9]|1[01])|a[0-7]|fp))\b/g))
    .map((match) => match[1])
    .filter((value): value is string => typeof value === "string")
    .map((value) => Number(value));
}

function registerValue(state: NarrationSnapshot | undefined, register: number | undefined): number {
  if (!state || register === undefined || !Array.isArray(state.registers)) {
    return 0;
  }
  return state.registers[register] ?? 0;
}

export function activateWatchMode(lessonId: string, stepId: string): void {
  activeWatchMode = { lessonId, stepId };
}

export function deactivateWatchMode(): void {
  activeWatchMode = null;
}

export function isWatchModeActive(): boolean {
  return activeWatchMode !== null;
}

export function currentWatchMode(): WatchModeState {
  return activeWatchMode;
}

export function generateNarration(
  instruction: string,
  stateBefore: NarrationSnapshot | LessonState,
  stateAfter: NarrationSnapshot | LessonState
): string {
  const trimmed = instruction.trim();
  if (!trimmed) {
    return "No instruction executed on this step.";
  }

  const [, mnemonicRaw = "", operandsRaw = ""] = trimmed.match(/^([.\w]+)\s*(.*)$/) ?? [];
  const mnemonic = mnemonicRaw.toLowerCase();
  const operands = operandsRaw.split(",").map((part) => part.trim()).filter(Boolean);
  const registers = parseRegisters(trimmed);
  const [rd, rs1, rs2] = registers;
  const beforeDest = registerValue(stateBefore, rd);
  const afterDest = registerValue(stateAfter, rd);
  const rs1Value = registerValue(stateBefore, rs1);
  const rs2Value = registerValue(stateBefore, rs2);

  if (mnemonic === "addi" || mnemonic === "add" || mnemonic === "sub") {
    const verb = mnemonic === "sub" ? "subtracts" : "adds";
    const relation = mnemonic === "sub" ? "from" : "to";
    const sourceText =
      mnemonic === "addi"
        ? operands[2] ?? "the immediate"
        : `${regName(rs2)} (${hex32(rs2Value)})`;
    return `This ${verb} ${sourceText} ${relation} ${regName(rs1)} (${hex32(rs1Value)}), storing ${hex32(afterDest)} in ${regName(rd)}.`;
  }

  if (mnemonic === "lw" || mnemonic === "sw") {
    const offsetMatch = operands[1]?.match(/^(-?(?:0x[0-9a-f]+|\d+))\(([^)]+)\)$/i);
    const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
    const baseValue = registerValue(stateBefore, rs1 ?? registers[1]);
    const address = (baseValue + offset) >>> 0;
    if (mnemonic === "lw") {
      return `This loads the 32-bit word at address ${hex32(address)} into ${regName(rd)}. After the load, ${regName(rd)} = ${hex32(afterDest)}.`;
    }
    return `This stores the 32-bit word from ${regName(rd)} (${hex32(beforeDest)}) to address ${hex32(address)}.`;
  }

  if (mnemonic === "beq" || mnemonic === "bne" || mnemonic === "blt" || mnemonic === "bge") {
    const relation =
      mnemonic === "beq"
        ? "is equal to"
        : mnemonic === "bne"
          ? "is not equal to"
          : mnemonic === "blt"
            ? "is less than"
            : "is greater than or equal to";
    const branched = (stateAfter.pc ?? 0) !== ((stateBefore.pc ?? 0) + 4);
    return `This ${branched ? "branches" : "does not branch"} because ${regName(rs1)} (${hex32(rs1Value)}) ${relation} ${regName(rs2)} (${hex32(rs2Value)}).`;
  }

  if (mnemonic === "jal") {
    return `This calls the target label, saving the return address ${hex32(((stateBefore.pc ?? 0) + 4) >>> 0)} in ${regName(rd ?? 1)} before control jumps.`;
  }

  if (mnemonic === "mul" || mnemonic === "div" || mnemonic === "rem") {
    const noun = mnemonic === "mul" ? "lower 32 bits of the product" : mnemonic === "div" ? "quotient" : "remainder";
    const verb = mnemonic === "mul" ? "multiplies" : mnemonic === "div" ? "divides" : "divides to compute the remainder of";
    return `This ${verb} ${regName(rs1)} (${hex32(rs1Value)}) and ${regName(rs2)} (${hex32(rs2Value)}), storing the ${noun} ${hex32(afterDest)} in ${regName(rd)}.`;
  }

  if (mnemonic === "ecall") {
    return "This raises an environment call trap. In StudyRISC-V that halts execution so you can inspect the register state at the system-call boundary.";
  }

  return `This executes \`${trimmed}\`, updating the machine state from ${hex32(stateBefore.pc ?? 0)} to ${hex32(stateAfter.pc ?? 0)}.`;
}

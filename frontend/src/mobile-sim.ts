import { parseAssembly } from "./asm";
import { getChallenge } from "./challenges";
import { escapeHtml, formatClikeExpression, hex32, renderClikeExpression } from "./format";
import { getLab } from "./labs";
import { getLesson, loadProgress } from "./lessons";
import { showNotification } from "./notifications";
import { pushToUrl, readFromUrl } from "./permalink";
import type { DisasmLine, WasmStateDelta } from "./types";
import { WasmRuntime } from "./wasm-runtime";

export type MobileTab = "editor" | "registers" | "disasm" | "pseudo";
export type MobileRegisterFormat = "hex" | "dec" | "uint";

type KeyboardKey = {
  label: string;
  kind: "mnemonic" | "register" | "symbol" | "utility";
  value?: string;
  action?: "tab" | "newline" | "backspace";
};

type SampleProgramOption = {
  value: string;
  label: string;
};

type MobileSnapshot = {
  pc: number;
  regs: number[];
  halted: boolean;
  trap: WasmStateDelta["trap"] | null;
  effects: WasmStateDelta["effects"];
};

const ABI_NAMES = [
  "zero",
  "ra",
  "sp",
  "gp",
  "tp",
  "t0",
  "t1",
  "t2",
  "s0/fp",
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

export const MOBILE_TABS: MobileTab[] = ["editor", "registers", "disasm", "pseudo"];
export const MAX_HISTORY = 5;

export const MOBILE_MNEMONIC_KEYS = ["addi", "add", "sub", "lw", "sw", "beq", "bne", "blt", "jal", "jalr", "mul", "li", "mv", "ret", "j"];
export const MOBILE_REGISTER_KEYS = ["x0", "x1", "x2", "a0", "a1", "sp", "ra", "t0", "t1"];
export const MOBILE_SYMBOL_KEYS = [",", "(", ")", "#", ":", "-", "0", "4", "8"];
export const MOBILE_UTILITY_KEYS = ["TAB", "NL", "⌫"];

export const MOBILE_KEYBOARD_KEYS: KeyboardKey[] = [
  ...MOBILE_MNEMONIC_KEYS.map((label) => ({ label, kind: "mnemonic" as const, value: `${label} ` })),
  ...MOBILE_REGISTER_KEYS.map((label) => ({ label, kind: "register" as const, value: label })),
  ...MOBILE_SYMBOL_KEYS.map((label) => ({ label, kind: "symbol" as const, value: label })),
  { label: "TAB", kind: "utility", action: "tab" },
  { label: "NL", kind: "utility", action: "newline" },
  { label: "⌫", kind: "utility", action: "backspace" },
];

const SAMPLE_OPTIONS: SampleProgramOption[] = [
  { value: "arraySum", label: "Array sum (sensor readings)" },
  { value: "stringLength", label: "String length" },
  { value: "memoryCopy", label: "Memory copy" },
  { value: "functionCall", label: "Function call (calling convention)" },
  { value: "recursiveFactorial", label: "Recursive factorial" },
  { value: "tempConvert", label: "Temp conversion (mul/div)" },
  { value: "checksum", label: "XOR checksum" },
  { value: "bubbleSortData", label: "Bubble sort (data segment)" },
  { value: "stringCopyData", label: "String copy (data + .asciz)" },
  { value: "syscall", label: "Syscall (ecall)" },
];

const SAMPLE_PROGRAMS: Record<string, string> = {
  arraySum: [
    "# Sample: sum 4 sensor readings",
    "addi x1, x0, 64       # base address",
    "addi x2, x0, 10",
    "addi x3, x0, 20",
    "addi x4, x0, 30",
    "addi x5, x0, 40",
    "sw   x2, 0(x1)",
    "sw   x3, 4(x1)",
    "sw   x4, 8(x1)",
    "sw   x5, 12(x1)",
    "addi x6, x0, 0        # i",
    "addi x7, x0, 0        # sum",
    "loop:",
    "slti x8, x6, 4        # i < 4 ?",
    "beq  x8, x0, done",
    "slli x9, x6, 2        # byte offset",
    "add  x10, x1, x9",
    "lw   x11, 0(x10)",
    "add  x7, x7, x11",
    "addi x6, x6, 1",
    "beq  x0, x0, loop",
    "done:",
    "beq x0, x0, done",
  ].join("\n"),
  stringLength: [
    "# Sample: string length (null-terminated)",
    "addi x1, x0, 128      # base address",
    "addi x2, x0, 0x48     # 'H'",
    "sb   x2, 0(x1)",
    "addi x2, x0, 0x69     # 'i'",
    "sb   x2, 1(x1)",
    "addi x2, x0, 0x21     # '!'",
    "sb   x2, 2(x1)",
    "sb   x0, 3(x1)        # null terminator",
    "addi x3, x0, 0        # len",
    "loop:",
    "lb   x4, 0(x1)",
    "beq  x4, x0, done",
    "addi x3, x3, 1",
    "addi x1, x1, 1",
    "beq  x0, x0, loop",
    "done:",
    "beq x0, x0, done",
  ].join("\n"),
  memoryCopy: [
    "# Sample: memcpy 3 words",
    "addi x1, x0, 200      # src",
    "addi x2, x0, 300      # dst",
    "addi x3, x0, 0x1111",
    "sw   x3, 0(x1)",
    "addi x3, x0, 0x2222",
    "sw   x3, 4(x1)",
    "addi x3, x0, 0x3333",
    "sw   x3, 8(x1)",
    "addi x4, x0, 0        # i",
    "loop:",
    "slti x5, x4, 3",
    "beq  x5, x0, done",
    "slli x6, x4, 2",
    "add  x7, x1, x6",
    "add  x8, x2, x6",
    "lw   x9, 0(x7)",
    "sw   x9, 0(x8)",
    "addi x4, x4, 1",
    "beq  x0, x0, loop",
    "done:",
    "beq x0, x0, done",
  ].join("\n"),
  functionCall: [
    "# Calling convention demo",
    "main:",
    "addi sp, sp, -16",
    "sw   ra, 12(sp)",
    "sw   s0, 8(sp)",
    "addi a0, x0, 21",
    "jal  ra, double",
    "mv   s0, a0",
    "lw   ra, 12(sp)",
    "lw   s0, 8(sp)",
    "addi sp, sp, 16",
    "beq  x0, x0, done",
    "double:",
    "addi sp, sp, -8",
    "sw   ra, 4(sp)",
    "add  a0, a0, a0",
    "lw   ra, 4(sp)",
    "addi sp, sp, 8",
    "jalr x0, ra, 0",
    "done:",
    "beq  x0, x0, done",
  ].join("\n"),
  recursiveFactorial: [
    "# Recursive factorial",
    "main:",
    "addi a0, x0, 5",
    "jal  ra, factorial",
    "beq  x0, x0, done",
    "factorial:",
    "addi sp, sp, -8",
    "sw   ra, 4(sp)",
    "sw   a0, 0(sp)",
    "slti t0, a0, 2",
    "bne  t0, x0, base",
    "addi a0, a0, -1",
    "jal  ra, factorial",
    "lw   t0, 0(sp)",
    "mul  a0, t0, a0",
    "lw   ra, 4(sp)",
    "addi sp, sp, 8",
    "jalr x0, ra, 0",
    "base:",
    "addi a0, x0, 1",
    "lw   ra, 4(sp)",
    "addi sp, sp, 8",
    "jalr x0, ra, 0",
    "done:",
    "beq  x0, x0, done",
  ].join("\n"),
  tempConvert: [
    "# Sample: temperature conversion C -> F",
    "addi a0, x0, 25",
    "addi t0, x0, 9",
    "mul  t1, a0, t0",
    "addi t2, x0, 5",
    "div  t3, t1, t2",
    "addi a0, t3, 32",
    "halt:",
    "beq  x0, x0, halt",
  ].join("\n"),
  checksum: [
    "# Sample: XOR checksum over 4 bytes",
    "addi x1, x0, 400",
    "addi x2, x0, 0x12",
    "sb   x2, 0(x1)",
    "addi x2, x0, 0x34",
    "sb   x2, 1(x1)",
    "addi x2, x0, 0x56",
    "sb   x2, 2(x1)",
    "addi x2, x0, 0x78",
    "sb   x2, 3(x1)",
    "addi x3, x0, 0",
    "addi x4, x0, 0",
    "loop:",
    "slti x5, x3, 4",
    "beq  x5, x0, done",
    "add  x6, x1, x3",
    "lbu  x7, 0(x6)",
    "xor  x4, x4, x7",
    "addi x3, x3, 1",
    "beq  x0, x0, loop",
    "done:",
    "beq x0, x0, done",
  ].join("\n"),
  bubbleSortData: [
    ".data",
    "arr:",
    "  .word 5, 2, 8, 1, 4",
    ".text",
    "la   x1, arr",
    "addi x2, x0, 4",
    "outer:",
    "beq  x2, x0, done",
    "addi x3, x0, 0",
    "inner:",
    "beq  x3, x2, next_pass",
    "slli x4, x3, 2",
    "add  x5, x1, x4",
    "lw   x6, 0(x5)",
    "lw   x7, 4(x5)",
    "bge  x7, x6, no_swap",
    "sw   x7, 0(x5)",
    "sw   x6, 4(x5)",
    "no_swap:",
    "addi x3, x3, 1",
    "beq  x0, x0, inner",
    "next_pass:",
    "addi x2, x2, -1",
    "beq  x0, x0, outer",
    "done:",
    "ecall",
  ].join("\n"),
  stringCopyData: [
    ".data",
    "src:",
    '  .asciz "Hello, RISC-V!"',
    "dst:",
    "  .space 32",
    ".text",
    "la   x1, src",
    "la   x2, dst",
    "copy_loop:",
    "lb   x3, 0(x1)",
    "sb   x3, 0(x2)",
    "beq  x3, x0, done",
    "addi x1, x1, 1",
    "addi x2, x2, 1",
    "beq  x0, x0, copy_loop",
    "done:",
    "ecall",
  ].join("\n"),
  syscall: [
    "# Sample: ecall with ID in a7",
    "addi a0, x0, 42",
    "addi a1, x0, 7",
    "addi a2, x0, 3",
    "addi a7, x0, 103",
    "ecall",
  ].join("\n"),
};

export function isMobileViewport(width: number, hasTouch: boolean): boolean {
  return width < 768 || (hasTouch && width < 1024);
}

export function insertAtCursor(textarea: HTMLTextAreaElement, text: string): void {
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? 0;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = before + text + after;
  textarea.selectionStart = start + text.length;
  textarea.selectionEnd = start + text.length;
  textarea.focus();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function deleteBackwardAtCursor(textarea: HTMLTextAreaElement): void {
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? 0;
  if (start !== end) {
    insertAtCursor(textarea, "");
    return;
  }
  if (start <= 0) {
    textarea.focus();
    return;
  }
  const before = textarea.value.slice(0, start - 1);
  const after = textarea.value.slice(end);
  textarea.value = before + after;
  textarea.selectionStart = start - 1;
  textarea.selectionEnd = start - 1;
  textarea.focus();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

export function resolveTabSwitch(current: MobileTab, next: string): MobileTab {
  return (MOBILE_TABS as string[]).includes(next) ? (next as MobileTab) : current;
}

export function nextTabFromSwipe(activeTab: MobileTab, dx: number, dy: number): MobileTab {
  if (Math.abs(dx) <= Math.abs(dy) || Math.abs(dx) <= 60) {
    return activeTab;
  }
  const index = MOBILE_TABS.indexOf(activeTab);
  if (dx < 0) {
    return MOBILE_TABS[Math.min(MOBILE_TABS.length - 1, index + 1)];
  }
  return MOBILE_TABS[Math.max(0, index - 1)];
}

export function formatMobileRegisterValue(value: number, format: MobileRegisterFormat): string {
  const unsigned = value >>> 0;
  if (format === "dec") {
    return String(unsigned | 0);
  }
  if (format === "uint") {
    return String(unsigned);
  }
  return `0x${unsigned.toString(16).padStart(8, "0").toUpperCase()}`;
}

export function pushPseudoHistory(history: string[], previousPseudo: string, maxHistory = MAX_HISTORY): string[] {
  const trimmed = previousPseudo.trim();
  if (!trimmed) {
    return history.slice(0, maxHistory);
  }
  return [trimmed, ...history].slice(0, maxHistory);
}

function sampleMarkup(): string {
  return SAMPLE_OPTIONS.map((option) => `<option value="${option.value}">${escapeHtml(option.label)}</option>`).join("");
}

function splitInstruction(text: string): { mnemonic: string; operands: string } {
  const [inst] = text.split("#", 1);
  const trimmed = inst.trim();
  const match = /^([^\s]+)\s*(.*)$/.exec(trimmed);
  return {
    mnemonic: match?.[1] ?? trimmed,
    operands: match?.[2]?.trim() ?? "",
  };
}

function instructionTextForPc(pc: number | undefined, lines: DisasmLine[]): string {
  if (pc === undefined) {
    return "";
  }
  return lines.find((line) => !line.label && (line.pc >>> 0) === (pc >>> 0))?.text ?? "";
}

function translateRiscvToClike(instText: string): string {
  const normalized = instText.trim().replace(/\s+/g, " ");
  const tokens = normalized.replace(/,/g, " ").split(/\s+/);
  const op = (tokens[0] || "").toLowerCase();
  const a = tokens[1];
  const b = tokens[2];
  const c = tokens[3];

  const binOp = (symbol: string) => `${a} = ${b} ${symbol} ${c};`;
  const immOp = (symbol: string) => `${a} = ${b} ${symbol} ${c};`;

  if (op === "addi") return immOp("+");
  if (op === "add") return binOp("+");
  if (op === "sub") return binOp("-");
  if (op === "and") return binOp("&");
  if (op === "or") return binOp("|");
  if (op === "xor") return binOp("^");
  if (op === "sll") return binOp("<<");
  if (op === "srl") return `${a} = ((unsigned)${b}) >> ${c};`;
  if (op === "sra") return `${a} = ((int)${b}) >> ${c};`;
  if (op === "mul") return binOp("*");
  if (op === "div") return `${a} = ((int)${b}) / ((int)${c});`;
  if (op === "divu") return `${a} = ${b} / ${c};`;
  if (op === "rem") return `${a} = ((int)${b}) % ((int)${c});`;
  if (op === "remu") return `${a} = ${b} % ${c};`;
  if (op === "slti") return `${a} = ((int)${b} < ${c}) ? 1 : 0;`;
  if (op === "slt") return `${a} = ((int)${b} < (int)${c}) ? 1 : 0;`;
  if (op === "sltu") return `${a} = (${b} < ${c}) ? 1 : 0;`;

  const loadMatch = normalized.match(/^(\w+)\s+(\w+)\s*,\s*([^)]+)\((\w+)\)$/i);
  if (loadMatch) {
    const loadOp = loadMatch[1].toLowerCase();
    const rd = loadMatch[2];
    const imm = loadMatch[3];
    const rs1 = loadMatch[4];
    if (loadOp === "lw") return `${rd} = *(u32*)(${rs1} + ${imm});`;
    if (loadOp === "lh") return `${rd} = *(i16*)(${rs1} + ${imm});`;
    if (loadOp === "lhu") return `${rd} = *(u16*)(${rs1} + ${imm});`;
    if (loadOp === "lb") return `${rd} = *(i8*)(${rs1} + ${imm});`;
    if (loadOp === "lbu") return `${rd} = *(u8*)(${rs1} + ${imm});`;
    if (loadOp === "jalr") return `tmp = pc + 4; pc = (${rs1} + ${imm}) & ~1; ${rd} = tmp;`;
  }

  const storeMatch = normalized.match(/^(\w+)\s+(\w+)\s*,\s*([^)]+)\((\w+)\)$/i);
  if (storeMatch) {
    const storeOp = storeMatch[1].toLowerCase();
    const rs2 = storeMatch[2];
    const imm = storeMatch[3];
    const rs1 = storeMatch[4];
    if (storeOp === "sw") return `*(u32*)(${rs1} + ${imm}) = ${rs2};`;
    if (storeOp === "sh") return `*(u16*)(${rs1} + ${imm}) = ${rs2};`;
    if (storeOp === "sb") return `*(u8*)(${rs1} + ${imm}) = ${rs2};`;
  }

  if (op === "beq") return `if (${a} == ${b}) pc = ${c}; else pc += 4;`;
  if (op === "bne") return `if (${a} != ${b}) pc = ${c}; else pc += 4;`;
  if (op === "blt") return `if ((int)${a} < (int)${b}) pc = ${c}; else pc += 4;`;
  if (op === "bge") return `if ((int)${a} >= (int)${b}) pc = ${c}; else pc += 4;`;
  if (op === "bltu") return `if (${a} < ${b}) pc = ${c}; else pc += 4;`;
  if (op === "bgeu") return `if (${a} >= ${b}) pc = ${c}; else pc += 4;`;
  if (op === "jal") return `tmp = pc + 4; pc = ${c ?? b}; ${a ?? "x1"} = tmp;`;
  if (op === "lui") return `${a} = ${b} << 12;`;
  if (op === "auipc") return `${a} = pc + (${b} << 12);`;
  if (op === "ecall") return "trap_ecall();";

  return normalized;
}

function buildClikeMap(disasm: DisasmLine[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of disasm) {
    if (!line.label) {
      map.set(line.pc >>> 0, translateRiscvToClike(line.text));
    }
  }
  return map;
}

function parseRegisterValue(token: string | undefined, regs?: number[]): number | null {
  if (!token || !regs) {
    return null;
  }
  const normalized = token.trim().toLowerCase();
  let index = ABI_NAMES.findIndex((name) => name === normalized || name.startsWith(`${normalized}/`));
  if (index < 0 && /^x(?:[0-9]|[12][0-9]|3[01])$/.test(normalized)) {
    index = Number.parseInt(normalized.slice(1), 10);
  }
  return index >= 0 ? regs[index] >>> 0 : null;
}

function parseImmediate(token: string | undefined): number | null {
  if (!token) {
    return null;
  }
  const normalized = token.trim();
  const negative = normalized.startsWith("-");
  const body = negative ? normalized.slice(1) : normalized;
  const base = body.startsWith("0x") ? 16 : 10;
  const digits = body.startsWith("0x") ? body.slice(2) : body;
  if (!digits || !/^[0-9a-fA-F]+$/.test(digits)) {
    return null;
  }
  const value = Number.parseInt(digits, base);
  return negative ? -value : value;
}

function renderPseudoBody(expression: string, instText: string, regs?: number[]): string {
  const [mnemonic, ...operandParts] = instText.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  let body = renderClikeExpression(formatClikeExpression(expression));

  if (mnemonic === "beq" || mnemonic === "bne" || mnemonic === "blt" || mnemonic === "bge" || mnemonic === "bltu" || mnemonic === "bgeu") {
    const [lhs, rhs, target] = operandParts.join(" ").split(/\s+/);
    const leftValue = parseRegisterValue(lhs, regs);
    const rightValue = parseRegisterValue(rhs, regs);
    if (leftValue !== null && rightValue !== null) {
      let taken = false;
      switch (mnemonic) {
        case "beq":
          taken = leftValue === rightValue;
          break;
        case "bne":
          taken = leftValue !== rightValue;
          break;
        case "blt":
          taken = (leftValue | 0) < (rightValue | 0);
          break;
        case "bge":
          taken = (leftValue | 0) >= (rightValue | 0);
          break;
        case "bltu":
          taken = leftValue < rightValue;
          break;
        case "bgeu":
          taken = leftValue >= rightValue;
          break;
      }
      body = `
        <div class="mobile-pseudo-branch">
          <div>if (${escapeHtml(lhs)} ${escapeHtml(mnemonic === "beq" ? "==" : mnemonic === "bne" ? "!=" : mnemonic.includes("lt") ? "<" : ">=")} ${escapeHtml(rhs)})</div>
          <div class="mobile-pseudo-branch__taken${taken ? " is-active" : ""}">pc = ${escapeHtml(target)};</div>
          <div class="mobile-pseudo-branch__else">else</div>
          <div class="mobile-pseudo-branch__fallthrough${taken ? "" : " is-active"}">pc += 4;</div>
        </div>
      `;
    }
  }

  if (["lw", "lh", "lb", "lhu", "lbu", "sw", "sh", "sb"].includes(mnemonic)) {
    const memoryOperand = /([^,]+),\s*([^()]+)\(([^)]+)\)/.exec(instText);
    if (memoryOperand) {
      const imm = parseImmediate(memoryOperand[2]);
      const baseRegValue = parseRegisterValue(memoryOperand[3], regs);
      if (imm !== null && baseRegValue !== null) {
        body = `
          <div class="mobile-pseudo-loadstore">
            <div>${renderClikeExpression(formatClikeExpression(expression))}</div>
            <div class="mobile-pseudo-loadstore__comment">// addr = ${hex32((baseRegValue + imm) >>> 0)}</div>
          </div>
        `;
      }
    }
  }

  return body;
}

function reduceMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function scrollBehavior(): ScrollBehavior {
  return reduceMotion() ? "auto" : "smooth";
}

function cloneRegs(regs: number[]): number[] {
  return regs.map((value) => value >>> 0);
}

function createSnapshot(runtime: WasmRuntime, delta: WasmStateDelta | null): MobileSnapshot {
  return {
    pc: delta?.pc ?? runtime.pc(),
    regs: runtime.readRegisters().map((value) => value >>> 0),
    halted: delta?.halted ?? false,
    trap: delta?.trap ?? null,
    effects: delta?.effects ?? [],
  };
}

async function copyText(text: string, successMessage: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const temp = document.createElement("textarea");
      temp.value = text;
      temp.setAttribute("readonly", "true");
      temp.style.position = "absolute";
      temp.style.left = "-9999px";
      document.body.appendChild(temp);
      temp.select();
      document.execCommand("copy");
      temp.remove();
    }
    showNotification({
      id: `mobile-copy-${Date.now()}`,
      type: "lesson",
      title: successMessage,
      message: "Copied to clipboard.",
      icon: "🔗",
      duration: 2200,
      accentColor: "var(--accent)",
    });
  } catch {
    showNotification({
      id: `mobile-copy-failed-${Date.now()}`,
      type: "challenge",
      title: "Copy failed",
      message: "Clipboard access was blocked by the browser.",
      icon: "⚠️",
      duration: 3000,
      accentColor: "var(--warning)",
    });
  }
}

function resolveInitialSource(): { source: string; status: string; sampleValue: string } {
  const params = new URLSearchParams(window.location.search);
  const lessonId = params.get("lesson");
  if (lessonId) {
    const lesson = getLesson(lessonId);
    if (lesson) {
      const progress = loadProgress();
      const stepIndex = progress.lessons[lesson.id]?.currentStepIndex ?? 0;
      const preferred = lesson.steps[stepIndex];
      const codeStep = [preferred, ...lesson.steps].find((step) => step?.code && step.code.trim());
      if (codeStep?.code) {
        return {
          source: codeStep.code,
          status: `Lesson loaded · ${lesson.title}`,
          sampleValue: "",
        };
      }
    }
  }

  const challengeId = params.get("challenge");
  if (challengeId) {
    const challenge = getChallenge(challengeId);
    if (challenge) {
      return {
        source: challenge.starterCode,
        status: `Challenge loaded · ${challenge.title}`,
        sampleValue: "",
      };
    }
  }

  const labId = params.get("lab");
  if (labId) {
    const lab = getLab(labId);
    if (lab) {
      return {
        source: lab.starterCode,
        status: `Lab loaded · ${lab.title}`,
        sampleValue: "",
      };
    }
  }

  const fallbackSample = SAMPLE_OPTIONS[0]?.value ?? "arraySum";
  return {
    source: SAMPLE_PROGRAMS[fallbackSample] ?? "",
    status: "Sample loaded",
    sampleValue: fallbackSample,
  };
}

export async function initMobileSim(): Promise<void> {
  const root = document.getElementById("mobile-sim");
  if (!root) {
    return;
  }

  document.body.style.overflow = "hidden";
  document.body.style.position = "fixed";
  document.body.style.width = "100%";

  const statusEl = document.getElementById("mobile-status") as HTMLElement | null;
  const menuBtn = document.getElementById("mobile-menu-btn") as HTMLButtonElement | null;
  const sampleSelect = document.getElementById("mobile-sample-select") as HTMLSelectElement | null;
  const sourceEl = document.getElementById("mobile-source") as HTMLTextAreaElement | null;
  const keyboardRow = document.getElementById("mobile-keyboard-row") as HTMLElement | null;
  const regGrid = document.getElementById("mobile-reg-grid") as HTMLElement | null;
  const regFormatButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".mobile-format-btn"));
  const disasmList = document.getElementById("mobile-disasm-list") as HTMLElement | null;
  const pseudoCurrent = document.getElementById("mobile-pseudo-current") as HTMLElement | null;
  const pseudoHistoryEl = document.getElementById("mobile-pseudo-history") as HTMLElement | null;
  const contentEl = root.querySelector(".mobile-sim__content") as HTMLElement | null;
  const tabButtons = Array.from(root.querySelectorAll<HTMLButtonElement>(".mobile-tab"));
  const assembleBtn = document.getElementById("mobile-assemble-btn") as HTMLButtonElement | null;
  const stepBackBtn = document.getElementById("mobile-step-back-btn") as HTMLButtonElement | null;
  const stepBtn = document.getElementById("mobile-step-btn") as HTMLButtonElement | null;
  const runBtn = document.getElementById("mobile-run-btn") as HTMLButtonElement | null;
  const resetBtn = document.getElementById("mobile-reset-btn") as HTMLButtonElement | null;
  const menuSheet = document.getElementById("mobile-menu-sheet") as HTMLElement | null;
  const menuBackdrop = document.getElementById("mobile-menu-backdrop") as HTMLElement | null;
  const clearBtn = document.getElementById("mobile-menu-clear") as HTMLButtonElement | null;
  const permalinkBtn = document.getElementById("mobile-menu-permalink") as HTMLButtonElement | null;

  if (
    !statusEl ||
    !menuBtn ||
    !sampleSelect ||
    !sourceEl ||
    !keyboardRow ||
    !regGrid ||
    !disasmList ||
    !pseudoCurrent ||
    !pseudoHistoryEl ||
    !contentEl ||
    !assembleBtn ||
    !stepBackBtn ||
    !stepBtn ||
    !runBtn ||
    !resetBtn ||
    !menuSheet ||
    !menuBackdrop
  ) {
    return;
  }

  const mobileRoot = root;
  const mobileStatus = statusEl;
  const mobileSampleSelect = sampleSelect;
  const mobileSource = sourceEl;
  const mobileKeyboardRow = keyboardRow;
  const mobileRegGrid = regGrid;
  const mobileDisasmList = disasmList;
  const mobilePseudoCurrent = pseudoCurrent;
  const mobilePseudoHistory = pseudoHistoryEl;
  const mobileContent = contentEl;
  const mobileAssembleBtn = assembleBtn;
  const mobileStepBackBtn = stepBackBtn;
  const mobileStepBtn = stepBtn;
  const mobileRunBtn = runBtn;
  const mobileResetBtn = resetBtn;
  const mobileMenuSheet = menuSheet;
  const mobileMenuBackdrop = menuBackdrop;

  let runtime: WasmRuntime | null = null;
  let assembled = false;
  let stepCount = 0;
  let currentFormat: MobileRegisterFormat = "hex";
  let activeTab: MobileTab = "editor";
  let secondaryLandscapeTab: Exclude<MobileTab, "editor"> = "registers";
  let currentRegs: number[] = Array(32).fill(0);
  let previousRegs: number[] = Array(32).fill(0);
  let history: MobileSnapshot[] = [];
  let historyIndex = -1;
  let currentDisasm: DisasmLine[] = [];
  let clikeByPc = new Map<number, string>();
  let pseudoHistory: string[] = [];
  let changedRegs = new Set<number>();
  let changedFlashTimer: number | null = null;
  let previewPc: number | null = null;
  let runTimer: number | null = null;
  let running = false;
  let touchStartX = 0;
  let touchStartY = 0;

  mobileSampleSelect.innerHTML = `<option value="">Sample programs...</option>${sampleMarkup()}`;

  function setStatus(text: string, tone: "default" | "error" | "success" = "default"): void {
    mobileStatus.textContent = text;
    mobileStatus.classList.toggle("is-error", tone === "error");
    mobileStatus.classList.toggle("is-success", tone === "success");
  }

  function currentSnapshot(): MobileSnapshot | null {
    return historyIndex >= 0 ? history[historyIndex] : null;
  }

  function isLandscapeLayout(): boolean {
    return window.innerWidth > window.innerHeight && window.innerWidth < 1024;
  }

  function syncLandscapeClass(): void {
    document.body.classList.toggle("is-mobile-landscape", isLandscapeLayout());
  }

  function updateToolbarState(): void {
    const snapshot = currentSnapshot();
    const liveSnapshot = history[history.length - 1] ?? snapshot;
    const halted = snapshot?.halted === true || liveSnapshot?.halted === true || Boolean(snapshot?.trap) || Boolean(liveSnapshot?.trap);
    mobileAssembleBtn.disabled = runtime === null || running;
    mobileStepBtn.disabled = !assembled || runtime === null || running || halted;
    mobileRunBtn.disabled = !assembled || runtime === null || halted;
    mobileStepBackBtn.disabled = historyIndex <= 0 || running;
    mobileResetBtn.disabled = runtime === null || running;
    mobileRunBtn.querySelector("span")!.textContent = running ? "Stop" : "Run";
  }

  function renderRegisters(): void {
    mobileRegGrid.innerHTML = currentRegs
      .map((value, index) => {
        const abi = ABI_NAMES[index];
        const regToken = abi.split("/")[0];
        return `
          <div class="mobile-reg-cell${changedRegs.has(index) ? " is-changed" : ""}" data-reg="${escapeHtml(regToken)}">
            <div class="mobile-reg-cell__top">
              <span class="mobile-reg-cell__abi">${escapeHtml(abi)}</span>
              <span class="mobile-reg-cell__xnum">x${index}</span>
            </div>
            <div class="mobile-reg-cell__value">${escapeHtml(formatMobileRegisterValue(value, currentFormat))}</div>
          </div>
        `;
      })
      .join("");
  }

  function renderDisasm(): void {
    const currentPc = currentSnapshot()?.pc;
    mobileDisasmList.innerHTML = currentDisasm
      .map((line) => {
        if (line.label) {
          return `<span class="mobile-disasm-row__label">${escapeHtml(line.text)}</span>`;
        }
        const { mnemonic, operands } = splitInstruction(line.text);
        return `
          <button class="mobile-disasm-row${currentPc !== undefined && (line.pc >>> 0) === (currentPc >>> 0) ? " is-current" : ""}" type="button" data-pc="${line.pc >>> 0}">
            <span class="mobile-disasm-row__addr">${hex32(line.pc)}</span>
            <span class="mobile-disasm-row__mnemonic">${escapeHtml(mnemonic)}</span>
            <span class="mobile-disasm-row__operands">${escapeHtml(operands)}</span>
          </button>
        `;
      })
      .join("");

    const currentRow =
      currentPc !== undefined ? mobileDisasmList.querySelector<HTMLElement>(`.mobile-disasm-row[data-pc="${currentPc >>> 0}"]`) : null;
    if (currentRow) {
      window.requestAnimationFrame(() => {
        currentRow.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
      });
    }
  }

  function renderPseudo(): void {
    const snapshot = currentSnapshot();
    const pc = previewPc ?? snapshot?.pc ?? undefined;
    if (!snapshot || pc === undefined) {
      mobilePseudoCurrent.innerHTML = `<span class="mobile-pseudo-empty">Assemble a program and step to see the translation.</span>`;
      mobilePseudoHistory.innerHTML = "";
      return;
    }

    const instText = instructionTextForPc(pc, currentDisasm);
    const expression = clikeByPc.get(pc) ?? "";
    if (!expression) {
      mobilePseudoCurrent.innerHTML = `<span class="mobile-pseudo-empty">No translation available for this instruction.</span>`;
    } else {
      mobilePseudoCurrent.innerHTML = renderPseudoBody(expression, instText, snapshot.regs);
    }

    mobilePseudoHistory.innerHTML = pseudoHistory
      .map((entry) => `<div class="mobile-pseudo-history-item">${escapeHtml(entry)}</div>`)
      .join("");
  }

  function renderAll(): void {
    renderRegisters();
    renderDisasm();
    renderPseudo();
    updateToolbarState();
  }

  function clearChangedRegsAfterDelay(): void {
    if (changedFlashTimer !== null) {
      window.clearTimeout(changedFlashTimer);
    }
    changedFlashTimer = window.setTimeout(() => {
      changedRegs.clear();
      renderRegisters();
      changedFlashTimer = null;
    }, 650);
  }

  function setPanelVisibility(): void {
    const portraitActive = activeTab;
    const rightTab = secondaryLandscapeTab;
    for (const panel of Array.from(mobileRoot.querySelectorAll<HTMLElement>(".mobile-panel"))) {
      const panelTab = panel.id.replace("mobile-panel-", "") as MobileTab;
      const shouldShow = isLandscapeLayout()
        ? panelTab === "editor" || panelTab === rightTab
        : panelTab === portraitActive;
      panel.hidden = !shouldShow;
      panel.classList.toggle("mobile-panel--landscape-secondary", isLandscapeLayout() && panelTab === rightTab);
    }

    for (const button of tabButtons) {
      const tab = (button.dataset.tab as MobileTab | undefined) ?? "editor";
      const isActive = isLandscapeLayout() ? tab === rightTab || (tab === "editor" && portraitActive === "editor") : tab === portraitActive;
      button.classList.toggle("active", isActive);
    }
  }

  function animateTabSwitch(nextTab: MobileTab, direction: "left" | "right"): void {
    if (reduceMotion() || isLandscapeLayout()) {
      activeTab = nextTab;
      if (nextTab !== "editor") {
        secondaryLandscapeTab = nextTab;
      }
      setPanelVisibility();
      return;
    }

    const currentPanel = mobileRoot.querySelector<HTMLElement>(`.mobile-panel:not([hidden])`);
    const nextPanel = document.getElementById(`mobile-panel-${nextTab}`) as HTMLElement | null;
    activeTab = nextTab;
    if (nextTab !== "editor") {
      secondaryLandscapeTab = nextTab;
    }
    if (!currentPanel || !nextPanel || currentPanel === nextPanel) {
      setPanelVisibility();
      return;
    }
    nextPanel.hidden = false;
    nextPanel.classList.remove("is-entering-left", "is-entering-right");
    currentPanel.classList.remove("is-leaving-left", "is-leaving-right");
    nextPanel.classList.add(direction === "left" ? "is-entering-right" : "is-entering-left");
    currentPanel.classList.add(direction === "left" ? "is-leaving-left" : "is-leaving-right");
    window.setTimeout(() => {
      currentPanel.classList.remove("is-leaving-left", "is-leaving-right");
      nextPanel.classList.remove("is-entering-left", "is-entering-right");
      setPanelVisibility();
    }, 170);
  }

  function switchTab(nextTab: MobileTab, source: "tap" | "swipe" | "auto" = "tap"): void {
    const direction = MOBILE_TABS.indexOf(nextTab) >= MOBILE_TABS.indexOf(activeTab) ? "left" : "right";
    if (source === "auto" || isLandscapeLayout()) {
      activeTab = nextTab;
      if (nextTab !== "editor") {
        secondaryLandscapeTab = nextTab;
      }
      setPanelVisibility();
      return;
    }
    animateTabSwitch(nextTab, direction);
  }

  function resetStateForSource(status: string): void {
    assembled = false;
    stepCount = 0;
    previousRegs = Array(32).fill(0);
    currentRegs = Array(32).fill(0);
    history = [];
    historyIndex = -1;
    currentDisasm = [];
    clikeByPc = new Map<number, string>();
    pseudoHistory = [];
    previewPc = null;
    changedRegs.clear();
    if (runTimer !== null) {
      window.clearTimeout(runTimer);
      runTimer = null;
    }
    running = false;
    setStatus(status);
    renderAll();
  }

  async function assembleSource(): Promise<boolean> {
    if (!runtime) {
      setStatus("Loading runtime…");
      return false;
    }
    try {
      const parsed = parseAssembly(mobileSource.value);
      runtime.loadProgram(parsed.instructions);
      runtime.reset();
      currentDisasm = parsed.disasm;
      clikeByPc = buildClikeMap(parsed.disasm);
      const initial = createSnapshot(runtime, null);
      assembled = true;
      stepCount = 0;
      previousRegs = cloneRegs(initial.regs);
      currentRegs = cloneRegs(initial.regs);
      history = [initial];
      historyIndex = 0;
      pseudoHistory = [];
      previewPc = null;
      changedRegs.clear();
      setStatus(`Assembled · ${(parsed.disasm ?? []).filter((line) => !line.label).length} instructions`, "success");
      renderAll();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Assembly failed.";
      assembled = false;
      setStatus(message, "error");
      history = [];
      historyIndex = -1;
      currentDisasm = [];
      clikeByPc = new Map<number, string>();
      pseudoHistory = [];
      previewPc = null;
      renderAll();
      return false;
    }
  }

  function changedRegisterIndices(nextRegs: number[], prevRegs: number[]): number[] {
    const changed: number[] = [];
    for (let index = 0; index < Math.min(nextRegs.length, prevRegs.length); index += 1) {
      if ((nextRegs[index] >>> 0) !== (prevRegs[index] >>> 0)) {
        changed.push(index);
      }
    }
    return changed;
  }

  function snapshotAt(index: number): MobileSnapshot | null {
    return index >= 0 && index < history.length ? history[index] : null;
  }

  function liveStep(): void {
    if (!runtime || !assembled) {
      return;
    }

    if (historyIndex < history.length - 1) {
      historyIndex += 1;
      const replay = snapshotAt(historyIndex);
      if (replay) {
        currentRegs = cloneRegs(replay.regs);
        renderAll();
      }
      return;
    }

    const before = currentSnapshot();
    const beforePc = before?.pc ?? runtime.pc();
    const previousExpression = clikeByPc.get(beforePc) ?? "";
    const delta = runtime.step();
    const snapshot = createSnapshot(runtime, delta);
    history.push(snapshot);
    historyIndex = history.length - 1;
    stepCount += 1;
    previousRegs = before ? cloneRegs(before.regs) : cloneRegs(currentRegs);
    currentRegs = cloneRegs(snapshot.regs);
    changedRegs = new Set(changedRegisterIndices(currentRegs, previousRegs));
    if (previousExpression) {
      pseudoHistory = pushPseudoHistory(pseudoHistory, previousExpression);
    }
    previewPc = null;

    if (changedRegs.size > 0 && activeTab === "editor") {
      switchTab("registers", "auto");
    } else if (changedRegs.size > 0 && isLandscapeLayout() && secondaryLandscapeTab !== "registers") {
      secondaryLandscapeTab = "registers";
    }

    if (snapshot.trap) {
      setStatus(`Trap · ${snapshot.trap.message}`, "error");
    } else if (snapshot.halted) {
      setStatus(`Halted · ${stepCount} instructions`);
    } else {
      setStatus(`Step ${stepCount} · ${hex32(snapshot.pc)}`);
    }

    renderAll();
    clearChangedRegsAfterDelay();
  }

  function stepBackward(): void {
    if (historyIndex <= 0) {
      return;
    }
    historyIndex -= 1;
    previewPc = null;
    const snapshot = snapshotAt(historyIndex);
    if (!snapshot) {
      return;
    }
    currentRegs = cloneRegs(snapshot.regs);
    setStatus(`Back · ${hex32(snapshot.pc)}`);
    renderAll();
  }

  function stopRun(): void {
    running = false;
    if (runTimer !== null) {
      window.clearTimeout(runTimer);
      runTimer = null;
    }
    updateToolbarState();
  }

  function runUntilHalt(): void {
    if (!assembled || !runtime) {
      return;
    }

    if (running) {
      stopRun();
      setStatus("Run paused");
      return;
    }

    if (historyIndex < history.length - 1) {
      historyIndex = history.length - 1;
      const latest = snapshotAt(historyIndex);
      if (latest) {
        currentRegs = cloneRegs(latest.regs);
      }
    }

    running = true;
    updateToolbarState();
    setStatus("Running");

    let steps = 0;
    const tick = () => {
      if (!running) {
        return;
      }
      const beforeIndex = historyIndex;
      liveStep();
      steps += historyIndex > beforeIndex ? 1 : 0;
      const snapshot = currentSnapshot();
      if (!snapshot || snapshot.halted || snapshot.trap || steps >= 500) {
        stopRun();
        switchTab("registers", "auto");
        setStatus(
          snapshot?.trap ? `Trap · ${snapshot.trap.message}` : snapshot?.halted ? `Halted · ${stepCount} instructions` : `Run paused · ${steps} instructions`,
          snapshot?.trap ? "error" : "success"
        );
        renderAll();
        return;
      }
      runTimer = window.setTimeout(tick, 140);
    };

    runTimer = window.setTimeout(tick, 140);
  }

  async function resetProgram(): Promise<void> {
    if (!runtime) {
      return;
    }
    if (!assembled) {
      resetStateForSource("Ready");
      return;
    }
    await assembleSource();
    switchTab("editor", "auto");
  }

  function buildKeyboard(): void {
    mobileKeyboardRow.innerHTML = MOBILE_KEYBOARD_KEYS.map((key) => {
      const classNames = ["mobile-key"];
      if (key.kind === "mnemonic") classNames.push("mobile-key--mnemonic");
      if (key.kind === "register") classNames.push("mobile-key--register");
      if (key.kind === "symbol") classNames.push("mobile-key--symbol");
      return `<button class="${classNames.join(" ")}" type="button" data-key-label="${escapeHtml(key.label)}">${escapeHtml(key.label)}</button>`;
    }).join("");
  }

  function openMenu(): void {
    mobileMenuBackdrop.hidden = false;
    mobileMenuSheet.hidden = false;
    window.requestAnimationFrame(() => {
      mobileMenuBackdrop.classList.add("is-open");
      mobileMenuSheet.classList.add("is-open");
    });
  }

  function closeMenu(): void {
    mobileMenuBackdrop.classList.remove("is-open");
    mobileMenuSheet.classList.remove("is-open");
    window.setTimeout(() => {
      mobileMenuBackdrop.hidden = true;
      mobileMenuSheet.hidden = true;
    }, 220);
  }

  buildKeyboard();
  setPanelVisibility();
  setStatus("Loading runtime…");
  updateToolbarState();

  mobileSource.addEventListener("input", () => {
    if (assembled) {
      resetStateForSource("Source edited");
    }
  });

  mobileKeyboardRow.addEventListener("click", (event) => {
    const keyEl = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-key-label]");
    if (!keyEl) {
      return;
    }
    const key = MOBILE_KEYBOARD_KEYS.find((candidate) => candidate.label === keyEl.dataset.keyLabel);
    if (!key) {
      return;
    }
    if (key.action === "tab") {
      insertAtCursor(mobileSource, "    ");
      return;
    }
    if (key.action === "newline") {
      insertAtCursor(mobileSource, "\n");
      return;
    }
    if (key.action === "backspace") {
      deleteBackwardAtCursor(mobileSource);
      return;
    }
    insertAtCursor(mobileSource, key.value ?? "");
  });

  mobileSampleSelect.addEventListener("change", () => {
    const value = mobileSampleSelect.value;
    if (!value) {
      return;
    }
    mobileSource.value = SAMPLE_PROGRAMS[value] ?? "";
    mobileSource.blur();
    resetStateForSource("Program loaded");
  });

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const next = resolveTabSwitch(activeTab, button.dataset.tab ?? "editor");
      if (next === "editor" && isLandscapeLayout()) {
        mobileSource.focus();
        return;
      }
      switchTab(next, "tap");
    });
  });

  regFormatButtons.forEach((button) => {
    button.addEventListener("click", () => {
      currentFormat = (button.dataset.format as MobileRegisterFormat) || "hex";
      regFormatButtons.forEach((candidate) => candidate.classList.toggle("active", candidate === button));
      renderRegisters();
    });
  });

  mobileDisasmList.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(".mobile-disasm-row[data-pc]");
    if (!row) {
      return;
    }
    previewPc = Number(row.dataset.pc ?? "0") >>> 0;
    switchTab("pseudo", "auto");
    renderPseudo();
  });

  mobileAssembleBtn.addEventListener("click", () => {
    void assembleSource();
  });
  mobileStepBtn.addEventListener("click", () => {
    liveStep();
  });
  mobileStepBackBtn.addEventListener("click", () => {
    stepBackward();
  });
  mobileRunBtn.addEventListener("click", () => {
    runUntilHalt();
  });
  mobileResetBtn.addEventListener("click", () => {
    void resetProgram();
  });

  menuBtn.addEventListener("click", () => {
    if (mobileMenuSheet.hidden) {
      openMenu();
    } else {
      closeMenu();
    }
  });
  mobileMenuBackdrop.addEventListener("click", closeMenu);
  clearBtn?.addEventListener("click", () => {
    mobileSource.value = "";
    resetStateForSource("Editor cleared");
    closeMenu();
  });
  permalinkBtn?.addEventListener("click", async () => {
    await pushToUrl(mobileSource.value);
    await copyText(window.location.href, "Permalink copied");
    closeMenu();
  });

  mobileContent.addEventListener(
    "touchstart",
    (event) => {
      const touch = event.touches[0];
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
    },
    { passive: true }
  );

  mobileContent.addEventListener(
    "touchend",
    (event) => {
      const touch = event.changedTouches[0];
      const next = nextTabFromSwipe(activeTab, touch.clientX - touchStartX, touch.clientY - touchStartY);
      if (next !== activeTab) {
        switchTab(next, "swipe");
      }
    },
    { passive: true }
  );

  const syncOrientation = () => {
    syncLandscapeClass();
    setPanelVisibility();
  };
  window.addEventListener("resize", syncOrientation);
  window.addEventListener("orientationchange", () => {
    window.setTimeout(syncOrientation, 100);
  });

  try {
    runtime = await WasmRuntime.create();
    setStatus("Ready");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Runtime failed to load.", "error");
    updateToolbarState();
    return;
  }

  const sharedProgram = await readFromUrl();
  const initial = resolveInitialSource();
  mobileSource.value = sharedProgram ?? initial.source;
  mobileSampleSelect.value = sharedProgram ? "" : initial.sampleValue;
  setStatus(sharedProgram ? "Loaded from shared link" : initial.status);
  syncLandscapeClass();
  setPanelVisibility();
  updateToolbarState();
}

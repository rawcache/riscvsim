import { parseAssembly } from "./asm";
import type { InstructionWire } from "./types";

export interface LintWarning {
  line: number;
  col?: number;
  code: string;
  message: string;
  severity: "warning" | "info";
}

export type ParsedProgram = ReturnType<typeof parseAssembly>;

const REG_ALIASES: Record<string, number> = {
  zero: 0,
  ra: 1,
  sp: 2,
  gp: 3,
  tp: 4,
  t0: 5,
  t1: 6,
  t2: 7,
  s0: 8,
  fp: 8,
  s1: 9,
  a0: 10,
  a1: 11,
  a2: 12,
  a3: 13,
  a4: 14,
  a5: 15,
  a6: 16,
  a7: 17,
  s2: 18,
  s3: 19,
  s4: 20,
  s5: 21,
  s6: 22,
  s7: 23,
  s8: 24,
  s9: 25,
  s10: 26,
  s11: 27,
  t3: 28,
  t4: 29,
  t5: 30,
  t6: 31,
};

const RD_WRITES = new Set([
  "add",
  "addi",
  "sub",
  "lui",
  "auipc",
  "and",
  "andi",
  "or",
  "ori",
  "xor",
  "xori",
  "sll",
  "slli",
  "srl",
  "srli",
  "sra",
  "srai",
  "slt",
  "slti",
  "sltu",
  "sltiu",
  "jal",
  "jalr",
  "mul",
  "mulh",
  "mulhu",
  "mulhsu",
  "div",
  "divu",
  "rem",
  "remu",
]);

const LOAD_OPS = new Set(["lb", "lbu", "lh", "lhu", "lw"]);
const BRANCH_OPS = new Set(["beq", "bne", "blt", "bge", "bltu", "bgeu"]);
const STORE_OPS = new Set(["sb", "sh", "sw"]);
const IMM_OPS = new Set(["addi", "slti", "sltiu", "andi", "ori", "xori", "slli", "srli", "srai"]);

function stripComment(line: string): string {
  let inString = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "#") {
      return line.slice(0, index).trimEnd();
    }
  }

  return line.trimEnd();
}

function parseRegister(token: string): number | null {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (/^x(?:[0-9]|[12][0-9]|3[01])$/.test(normalized)) {
    return Number.parseInt(normalized.slice(1), 10);
  }
  return REG_ALIASES[normalized] ?? null;
}

function parseImmediate(token: string): number | null {
  const normalized = token.trim();
  if (!normalized) {
    return null;
  }
  const negative = normalized.startsWith("-");
  const body = negative ? normalized.slice(1) : normalized;
  const isHex = /^0x[0-9a-fA-F]+$/.test(body);
  const isDec = /^\d+$/.test(body);
  if (!isHex && !isDec) {
    return null;
  }
  const value = Number.parseInt(isHex ? body.slice(2) : body, isHex ? 16 : 10);
  return negative ? -value : value;
}

function parseMemoryOperand(token: string): { imm: number; rs1: number } | null {
  const match = /^([^()]+)\(([^)]+)\)$/.exec(token.trim());
  if (!match) {
    return null;
  }
  const imm = parseImmediate(match[1]);
  const rs1 = parseRegister(match[2]);
  if (imm === null || rs1 === null) {
    return null;
  }
  return { imm, rs1 };
}

function instructionReads(inst: InstructionWire): number[] {
  const op = inst.op.toLowerCase();
  if (LOAD_OPS.has(op)) {
    return inst.rs1 !== undefined ? [inst.rs1] : [];
  }
  if (STORE_OPS.has(op)) {
    return [inst.rs1, inst.rs2].filter((value): value is number => value !== undefined);
  }
  if (BRANCH_OPS.has(op)) {
    return [inst.rs1, inst.rs2].filter((value): value is number => value !== undefined);
  }
  if (op === "jalr") {
    return inst.rs1 !== undefined ? [inst.rs1] : [];
  }
  if (IMM_OPS.has(op)) {
    return inst.rs1 !== undefined ? [inst.rs1] : [];
  }
  if (RD_WRITES.has(op)) {
    return [inst.rs1, inst.rs2].filter((value): value is number => value !== undefined);
  }
  return [];
}

function instructionWrites(inst: InstructionWire): number[] {
  const op = inst.op.toLowerCase();
  if (RD_WRITES.has(op) || LOAD_OPS.has(op)) {
    return inst.rd !== undefined ? [inst.rd] : [];
  }
  return [];
}

function addWarning(
  bucket: Map<string, LintWarning>,
  warning: LintWarning
): void {
  const key = `${warning.code}:${warning.line}:${warning.col ?? 0}`;
  if (!bucket.has(key)) {
    bucket.set(key, warning);
  }
}

function lintZeroWrites(parsed: ParsedProgram, warnings: Map<string, LintWarning>): void {
  for (const inst of parsed.instructions ?? []) {
    const op = inst.op.toLowerCase();
    const line = (inst.src_line ?? 0) + 1;
    if (inst.rd === 0 && RD_WRITES.has(op)) {
      addWarning(warnings, {
        line,
        code: "WARN001",
        message: "Writing to x0 has no effect (x0 is always 0)",
        severity: "warning",
      });
    }
    if (inst.rd === 0 && LOAD_OPS.has(op)) {
      addWarning(warnings, {
        line,
        code: "WARN002",
        message: "Load result discarded (destination is x0)",
        severity: "warning",
      });
    }
  }
}

function lintReadBeforeWrite(parsed: ParsedProgram, warnings: Map<string, LintWarning>): void {
  const written = new Set<number>([0, 1, 2]);

  for (const inst of parsed.instructions ?? []) {
    const line = (inst.src_line ?? 0) + 1;
    for (const reg of instructionReads(inst)) {
      if (written.has(reg)) {
        continue;
      }
      addWarning(warnings, {
        line,
        code: "WARN006",
        message: `x${reg} read before any write in this program`,
        severity: "warning",
      });
    }
    for (const reg of instructionWrites(inst)) {
      written.add(reg);
    }
  }
}

function lintStackRestore(parsed: ParsedProgram, warnings: Map<string, LintWarning>): void {
  let balance = 0;
  let firstDecrementLine: number | null = null;

  for (const inst of parsed.instructions ?? []) {
    const op = inst.op.toLowerCase();
    if (op === "addi" && inst.rd === 2 && inst.rs1 === 2 && typeof inst.imm === "number") {
      balance += inst.imm;
      if (inst.imm < 0 && firstDecrementLine === null) {
        firstDecrementLine = (inst.src_line ?? 0) + 1;
      }
    }
    if (op === "ecall" && balance < 0 && firstDecrementLine !== null) {
      addWarning(warnings, {
        line: firstDecrementLine,
        code: "WARN007",
        message: "Stack pointer decremented but never restored",
        severity: "warning",
      });
      return;
    }
  }

  if (balance < 0 && firstDecrementLine !== null) {
    addWarning(warnings, {
      line: firstDecrementLine,
      code: "WARN007",
      message: "Stack pointer decremented but never restored",
      severity: "warning",
    });
  }
}

function lintSourcePatterns(source: string, warnings: Map<string, LintWarning>): void {
  const lines = source.split("\n");
  let unreachable = false;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = stripComment(lines[index]).trim();
    if (!raw) {
      continue;
    }

    const labelMatch = /^([A-Za-z_.$][\w.$]*):\s*(.*)$/.exec(raw);
    if (labelMatch) {
      unreachable = false;
      if (!labelMatch[2]) {
        continue;
      }
    } else if (unreachable) {
      addWarning(warnings, {
        line: lineNumber,
        code: "WARN003",
        message: "Unreachable code after unconditional branch",
        severity: "warning",
      });
    }

    const working = labelMatch ? labelMatch[2].trim() : raw;
    if (!working || working.startsWith(".")) {
      continue;
    }

    const tokens = working.replace(/,/g, " ").trim().split(/\s+/);
    const op = (tokens[0] ?? "").toLowerCase();

    if (op === "lw" || op === "lh") {
      const memoryOperand = tokens[2] ? parseMemoryOperand(tokens[2]) : null;
      if (memoryOperand) {
        const align = op === "lw" ? 4 : 2;
        if (memoryOperand.imm % align !== 0) {
          addWarning(warnings, {
            line: lineNumber,
            code: "WARN004",
            message: `Offset ${memoryOperand.imm} may cause misaligned access for ${op}`,
            severity: "warning",
          });
        }
      }
    }

    if (op === "addi") {
      const imm = tokens[3] ? parseImmediate(tokens[3]) : null;
      if (imm !== null && (imm < -2048 || imm > 2047)) {
        addWarning(warnings, {
          line: lineNumber,
          code: "WARN005",
          message: `Immediate ${imm} exceeds 12-bit range, use li or lui+addi`,
          severity: "warning",
        });
      }
    }

    const isUnconditional =
      op === "j" ||
      op === "ret" ||
      (op === "jal" && tokens[1]?.toLowerCase() === "x0");

    unreachable = isUnconditional;
  }
}

export function lintProgram(source: string, parsed: ParsedProgram): LintWarning[] {
  const warnings = new Map<string, LintWarning>();

  lintZeroWrites(parsed, warnings);
  lintReadBeforeWrite(parsed, warnings);
  lintStackRestore(parsed, warnings);
  lintSourcePatterns(source, warnings);

  return Array.from(warnings.values()).sort((left, right) => {
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    return left.code.localeCompare(right.code);
  });
}

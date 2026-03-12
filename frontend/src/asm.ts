import type { DisasmLine, InstructionWire } from "./types";

type ParsedProgram = {
  instructions: InstructionWire[];
  disasm: DisasmLine[];
};

type PendingEntry = {
  labels: string[];
  text: string | null;
  srcLine: number;
  pc: number;
};

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

const OFF_BASE = /^(-?(?:0x[0-9a-fA-F]+|\d+))\(([^)]+)\)$/;
const LABEL_PREFIX = /^([A-Za-z_]\w*):\s*(.*)$/;
const SYMBOL_RE = /^([A-Za-z_]\w*)$/;

function fail(srcLine: number, msg: string): never {
  throw new Error(`${msg} on line ${srcLine + 1}`);
}

function stripComment(line: string): string {
  const hash = line.indexOf("#");
  const slash = line.indexOf("//");
  let cut = -1;
  if (hash >= 0 && slash >= 0) {
    cut = Math.min(hash, slash);
  } else if (hash >= 0) {
    cut = hash;
  } else if (slash >= 0) {
    cut = slash;
  }
  return (cut >= 0 ? line.slice(0, cut) : line).trim();
}

function parseReg(tok: string, srcLine: number): number {
  const t = tok.trim().toLowerCase();
  if (t.startsWith("x")) {
    const n = Number.parseInt(t.slice(1), 10);
    if (Number.isInteger(n) && n >= 0 && n <= 31) return n;
  }
  const ali = REG_ALIASES[t];
  if (ali !== undefined) return ali;
  fail(srcLine, `Bad register "${tok}"`);
}

function parseImm(tok: string, srcLine: number): number {
  const t = tok.trim().toLowerCase();
  const negative = t.startsWith("-");
  const body = negative ? t.slice(1) : t;

  const base = body.startsWith("0x") ? 16 : 10;
  const digits = body.startsWith("0x") ? body.slice(2) : body;
  const parsed = Number.parseInt(digits, base);
  if (!Number.isFinite(parsed)) {
    fail(srcLine, `Bad immediate "${tok}"`);
  }
  const val = negative ? -parsed : parsed;
  return val | 0;
}

function parseOffsetBase(expr: string, srcLine: number): { imm: number; rs1: number } {
  const m = OFF_BASE.exec(expr.trim());
  if (!m) {
    fail(srcLine, `Bad memory operand "${expr}"`);
  }
  return {
    imm: parseImm(m[1], srcLine),
    rs1: parseReg(m[2], srcLine),
  };
}

function parseSymDirective(rawTrim: string, symbols: Map<string, number>, srcLine: number): void {
  const rest = rawTrim.slice(4).trim();
  const m = /^([A-Za-z_]\w*)\s*(?:=|\s)\s*(0x[0-9a-fA-F]+|\d+)$/.exec(rest);
  if (!m) {
    fail(srcLine, "Bad #sym format");
  }
  const val = m[2].toLowerCase().startsWith("0x")
    ? Number.parseInt(m[2].slice(2), 16)
    : Number.parseInt(m[2], 10);
  symbols.set(m[1], val | 0);
}

function estimateWords(text: string, srcLine: number): number {
  const tokens = text.replace(/,/g, " ").trim().split(/\s+/);
  const op = tokens[0]?.toLowerCase();
  if (op === "li") {
    if (tokens.length !== 3) fail(srcLine, "Bad li");
    const imm = parseImm(tokens[2], srcLine);
    return imm >= -2048 && imm <= 2047 ? 1 : 2;
  }
  return 1;
}

function formatInstruction(inst: InstructionWire): string {
  const op = inst.op;
  if (op === "ecall") return "ecall";
  if (op === "lui" || op === "auipc") return `${op} x${inst.rd}, ${inst.imm}`;
  if (op === "jal") return `${op} x${inst.rd}, ${inst.target_pc}`;
  if (op === "jalr") return `${op} x${inst.rd}, ${inst.imm}(x${inst.rs1})`;
  if (["beq", "bne", "blt", "bge", "bltu", "bgeu"].includes(op)) {
    return `${op} x${inst.rs1}, x${inst.rs2}, ${inst.target_pc}`;
  }
  if (["lb", "lbu", "lh", "lhu", "lw"].includes(op)) {
    return `${op} x${inst.rd}, ${inst.imm}(x${inst.rs1})`;
  }
  if (["sb", "sh", "sw"].includes(op)) {
    return `${op} x${inst.rs2}, ${inst.imm}(x${inst.rs1})`;
  }
  if (
    [
      "addi",
      "slti",
      "sltiu",
      "andi",
      "ori",
      "xori",
      "slli",
      "srli",
      "srai",
    ].includes(op)
  ) {
    return `${op} x${inst.rd}, x${inst.rs1}, ${inst.imm}`;
  }
  return `${op} x${inst.rd}, x${inst.rs1}, x${inst.rs2}`;
}

function decodeTarget(
  tok: string,
  labels: Map<string, number>,
  symbols: Map<string, number>,
  srcLine: number
): number {
  if (labels.has(tok)) return labels.get(tok) as number;
  if (symbols.has(tok)) return symbols.get(tok) as number;
  if (SYMBOL_RE.test(tok)) {
    fail(srcLine, `Unknown label "${tok}"`);
  }
  const target = parseImm(tok, srcLine);
  if ((target & 3) !== 0) {
    fail(srcLine, "Branch/jump target must be word-aligned");
  }
  return target;
}

function parseEntry(
  entry: PendingEntry,
  labels: Map<string, number>,
  symbols: Map<string, number>
): InstructionWire[] {
  if (!entry.text) return [];
  const tokens = entry.text.replace(/,/g, " ").trim().split(/\s+/);
  const op = tokens[0].toLowerCase();
  const src_line = entry.srcLine;

  const targetOf = (tok: string) => decodeTarget(tok, labels, symbols, src_line);

  if (op === "nop") {
    return [{ op: "addi", rd: 0, rs1: 0, imm: 0, src_line }];
  }
  if (op === "mv") {
    if (tokens.length !== 3) fail(src_line, "Bad mv");
    return [{ op: "addi", rd: parseReg(tokens[1], src_line), rs1: parseReg(tokens[2], src_line), imm: 0, src_line }];
  }
  if (op === "j") {
    if (tokens.length !== 2) fail(src_line, "Bad j");
    return [{ op: "jal", rd: 0, target_pc: targetOf(tokens[1]), src_line }];
  }
  if (op === "call") {
    if (tokens.length !== 2) fail(src_line, "Bad call");
    return [{ op: "jal", rd: 1, target_pc: targetOf(tokens[1]), src_line }];
  }
  if (op === "ret") {
    if (tokens.length !== 1) fail(src_line, "Bad ret");
    return [{ op: "jalr", rd: 0, rs1: 1, imm: 0, src_line }];
  }
  if (op === "li") {
    if (tokens.length !== 3) fail(src_line, "Bad li");
    const rd = parseReg(tokens[1], src_line);
    const imm = parseImm(tokens[2], src_line);
    if (imm >= -2048 && imm <= 2047) {
      return [{ op: "addi", rd, rs1: 0, imm, src_line }];
    }
    const hi = (imm + 0x800) >> 12;
    const lo = imm - (hi << 12);
    return [
      { op: "lui", rd, imm: hi, src_line },
      { op: "addi", rd, rs1: rd, imm: lo, src_line },
    ];
  }

  const regRegReg = new Set([
    "add",
    "sub",
    "slt",
    "sltu",
    "mul",
    "mulh",
    "mulhsu",
    "mulhu",
    "div",
    "divu",
    "rem",
    "remu",
    "and",
    "or",
    "xor",
    "sll",
    "srl",
    "sra",
  ]);
  if (regRegReg.has(op)) {
    if (tokens.length !== 4) fail(src_line, `Bad ${op}`);
    return [{
      op,
      rd: parseReg(tokens[1], src_line),
      rs1: parseReg(tokens[2], src_line),
      rs2: parseReg(tokens[3], src_line),
      src_line,
    }];
  }

  const regRegImm = new Set(["addi", "slti", "sltiu", "andi", "ori", "xori", "slli", "srli", "srai"]);
  if (regRegImm.has(op)) {
    if (tokens.length !== 4) fail(src_line, `Bad ${op}`);
    return [{
      op,
      rd: parseReg(tokens[1], src_line),
      rs1: parseReg(tokens[2], src_line),
      imm: parseImm(tokens[3], src_line),
      src_line,
    }];
  }

  if (op === "lui" || op === "auipc") {
    if (tokens.length !== 3) fail(src_line, `Bad ${op}`);
    return [{
      op,
      rd: parseReg(tokens[1], src_line),
      imm: parseImm(tokens[2], src_line),
      src_line,
    }];
  }

  if (op === "ecall") {
    if (tokens.length !== 1) fail(src_line, "Bad ecall");
    return [{ op, src_line }];
  }

  if (op === "jal") {
    if (tokens.length !== 2 && tokens.length !== 3) fail(src_line, "Bad jal");
    const rd = tokens.length === 3 ? parseReg(tokens[1], src_line) : 1;
    const targetTok = tokens.length === 3 ? tokens[2] : tokens[1];
    return [{ op, rd, target_pc: targetOf(targetTok), src_line }];
  }

  if (op === "jalr") {
    if (tokens.length !== 2 && tokens.length !== 3) fail(src_line, "Bad jalr");
    const rd = tokens.length === 3 ? parseReg(tokens[1], src_line) : 1;
    const { imm, rs1 } = parseOffsetBase(tokens[tokens.length - 1], src_line);
    return [{ op, rd, rs1, imm, src_line }];
  }

  const loadOps = new Set(["lb", "lbu", "lh", "lhu", "lw"]);
  if (loadOps.has(op)) {
    if (tokens.length !== 3) fail(src_line, `Bad ${op}`);
    const { imm, rs1 } = parseOffsetBase(tokens[2], src_line);
    return [{ op, rd: parseReg(tokens[1], src_line), rs1, imm, src_line }];
  }

  const storeOps = new Set(["sb", "sh", "sw"]);
  if (storeOps.has(op)) {
    if (tokens.length !== 3) fail(src_line, `Bad ${op}`);
    const { imm, rs1 } = parseOffsetBase(tokens[2], src_line);
    return [{ op, rs2: parseReg(tokens[1], src_line), rs1, imm, src_line }];
  }

  const branchOps = new Set(["beq", "bne", "blt", "bge", "bltu", "bgeu"]);
  if (branchOps.has(op)) {
    if (tokens.length !== 4) fail(src_line, `Bad ${op}`);
    return [{
      op,
      rs1: parseReg(tokens[1], src_line),
      rs2: parseReg(tokens[2], src_line),
      target_pc: targetOf(tokens[3]),
      src_line,
    }];
  }

  fail(src_line, `Unsupported instruction "${op}"`);
}

export function parseAssembly(source: string): ParsedProgram {
  const lines = source.split(/\r?\n/);
  const symbols = new Map<string, number>();
  const labels = new Map<string, number>();
  const pending: PendingEntry[] = [];

  let pc = 0;
  for (let srcLine = 0; srcLine < lines.length; srcLine++) {
    const raw = lines[srcLine];
    const rawTrim = raw.trim();

    if (rawTrim.startsWith("#sym")) {
      parseSymDirective(rawTrim, symbols, srcLine);
      continue;
    }

    const stripped = stripComment(raw);
    if (!stripped) continue;

    let rest = stripped;
    const lineLabels: string[] = [];
    while (true) {
      const m = LABEL_PREFIX.exec(rest);
      if (!m) break;
      if (labels.has(m[1])) {
        fail(srcLine, `Duplicate label "${m[1]}"`);
      }
      labels.set(m[1], pc);
      lineLabels.push(m[1]);
      rest = m[2].trim();
    }

    if (!rest) {
      pending.push({ labels: lineLabels, text: null, srcLine, pc });
      continue;
    }

    pending.push({ labels: lineLabels, text: rest, srcLine, pc });
    pc += estimateWords(rest, srcLine) * 4;
  }

  const instructions: InstructionWire[] = [];
  const disasm: DisasmLine[] = [];

  for (const entry of pending) {
    for (const label of entry.labels) {
      disasm.push({
        pc: entry.pc >>> 0,
        text: `${label}:`,
        label: true,
      });
    }
    const emitted = parseEntry(entry, labels, symbols);
    let linePc = entry.pc;
    for (const inst of emitted) {
      instructions.push(inst);
      disasm.push({
        pc: linePc >>> 0,
        text: formatInstruction(inst),
      });
      linePc += 4;
    }
  }

  return { instructions, disasm };
}

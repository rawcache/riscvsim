import { DATA_BASE, TEXT_BASE } from "./memory-map";
import { encodeInstructionProgram } from "./riscv-encode";
import type { DisasmLine, InstructionWire } from "./types";

type Section = "text" | "data";

type ProgramImage = {
  text: Uint8Array;
  data: Uint8Array;
};

type InstructionListWithSegments = InstructionWire[] & ProgramImage;

type ParsedProgram = ProgramImage & {
  instructions: InstructionListWithSegments;
  disasm: DisasmLine[];
};

type LabelInfo = {
  address: number;
  section: Section;
};

type PendingTextEntry = {
  kind: "text";
  labels: string[];
  text: string | null;
  srcLine: number;
  pc: number;
};

type PendingDataEntry = {
  kind: "data";
  directive: DataDirective;
  srcLine: number;
  addr: number;
};

type PendingEntry = PendingTextEntry | PendingDataEntry;

type ValueRef =
  | { kind: "number"; value: number }
  | { kind: "symbol"; name: string };

type DataDirective =
  | { kind: "word"; values: ValueRef[] }
  | { kind: "half"; values: ValueRef[] }
  | { kind: "byte"; values: ValueRef[] }
  | { kind: "ascii"; bytes: Uint8Array }
  | { kind: "asciz"; bytes: Uint8Array }
  | { kind: "space"; size: number }
  | { kind: "align"; power: number };

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
  let inString = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "#") {
      return line.slice(0, i).trim();
    }
    if (ch === "/" && line[i + 1] === "/") {
      return line.slice(0, i).trim();
    }
  }
  return line.trim();
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

function parseNonNegativeImm(tok: string, srcLine: number, name: string): number {
  const value = parseImm(tok, srcLine);
  if (value < 0) {
    fail(srcLine, `${name} expects a non-negative value`);
  }
  return value;
}

export function isValidImm12(n: number): boolean {
  return n >= -2048 && n <= 2047;
}

function assertValidImm12(op: string, imm: number, srcLine: number): void {
  if (!isValidImm12(imm)) {
    fail(srcLine, `${op} immediate ${imm} out of range (valid range: -2048 to 2047)`);
  }
}

function splitPcRelativeOffset(offset: number): { hi: number; lo: number } {
  const hi = (offset + 0x800) >> 12;
  const lo = offset - (hi << 12);
  return { hi, lo };
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
    return isValidImm12(imm) ? 1 : 2;
  }
  if (op === "call" || op === "la") {
    if (op === "call" && tokens.length !== 2) fail(srcLine, "Bad call");
    if (op === "la" && tokens.length !== 3) fail(srcLine, "Bad la");
    return 2;
  }
  return 1;
}

function formatInstruction(inst: InstructionWire): string {
  const op = inst.op;
  if (op === "ecall") return "ecall";
  if (op === "ebreak") return "ebreak";
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
  labels: Map<string, LabelInfo>,
  symbols: Map<string, number>,
  srcLine: number
): number {
  if (labels.has(tok)) return labels.get(tok)?.address as number;
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

function resolveDataLabel(name: string, labels: Map<string, LabelInfo>, srcLine: number): number {
  const label = labels.get(name);
  if (!label) {
    fail(srcLine, `Undefined label "${name}"`);
  }
  if (label.section !== "data") {
    fail(srcLine, `la target "${name}" must be defined in .data`);
  }
  return label.address;
}

function resolveValueRef(
  value: ValueRef,
  labels: Map<string, LabelInfo>,
  symbols: Map<string, number>
): number {
  if (value.kind === "number") {
    return value.value;
  }
  const label = labels.get(value.name);
  if (label) {
    return label.address;
  }
  const symbol = symbols.get(value.name);
  if (symbol !== undefined) {
    return symbol;
  }
  throw new Error(`undefined:${value.name}`);
}

function parseTextEntry(
  entry: PendingTextEntry,
  labels: Map<string, LabelInfo>,
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
    const offset = targetOf(tokens[1]) - entry.pc;
    const { hi, lo } = splitPcRelativeOffset(offset);
    return [
      { op: "auipc", rd: 1, imm: hi, src_line },
      { op: "jalr", rd: 1, rs1: 1, imm: lo, src_line },
    ];
  }
  if (op === "la") {
    if (tokens.length !== 3) fail(src_line, "Bad la");
    const rd = parseReg(tokens[1], src_line);
    const target = resolveDataLabel(tokens[2], labels, src_line);
    const offset = target - entry.pc;
    const { hi, lo } = splitPcRelativeOffset(offset);
    return [
      { op: "auipc", rd, imm: hi, src_line },
      { op: "addi", rd, rs1: rd, imm: lo, src_line },
    ];
  }
  if (op === "ret") {
    if (tokens.length !== 1) fail(src_line, "Bad ret");
    return [{ op: "jalr", rd: 0, rs1: 1, imm: 0, src_line }];
  }
  if (op === "li") {
    if (tokens.length !== 3) fail(src_line, "Bad li");
    const rd = parseReg(tokens[1], src_line);
    const imm = parseImm(tokens[2], src_line);
    if (isValidImm12(imm)) {
      return [{ op: "addi", rd, rs1: 0, imm, src_line }];
    }
    const { hi, lo } = splitPcRelativeOffset(imm);
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
    const imm = parseImm(tokens[3], src_line);
    assertValidImm12(op, imm, src_line);
    return [{
      op,
      rd: parseReg(tokens[1], src_line),
      rs1: parseReg(tokens[2], src_line),
      imm,
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

  if (op === "ebreak") {
    if (tokens.length !== 1) fail(src_line, "Bad ebreak");
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
    assertValidImm12(op, imm, src_line);
    return [{ op, rd, rs1, imm, src_line }];
  }

  const loadOps = new Set(["lb", "lbu", "lh", "lhu", "lw"]);
  if (loadOps.has(op)) {
    if (tokens.length !== 3) fail(src_line, `Bad ${op}`);
    const { imm, rs1 } = parseOffsetBase(tokens[2], src_line);
    assertValidImm12(op, imm, src_line);
    return [{ op, rd: parseReg(tokens[1], src_line), rs1, imm, src_line }];
  }

  const storeOps = new Set(["sb", "sh", "sw"]);
  if (storeOps.has(op)) {
    if (tokens.length !== 3) fail(src_line, `Bad ${op}`);
    const { imm, rs1 } = parseOffsetBase(tokens[2], src_line);
    assertValidImm12(op, imm, src_line);
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

function parseValueRefList(text: string, srcLine: number, directive: string): ValueRef[] {
  const values = text
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    fail(srcLine, `${directive} requires at least one value`);
  }
  return values.map((value) =>
    SYMBOL_RE.test(value) ? { kind: "symbol", name: value } : { kind: "number", value: parseImm(value, srcLine) }
  );
}

function parseStringLiteral(raw: string, srcLine: number, directive: string): Uint8Array {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("\"")) {
    fail(srcLine, `${directive} requires a string literal`);
  }
  const bytes: number[] = [];
  let escaped = false;
  for (let i = 1; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      switch (ch) {
        case "n":
          bytes.push(0x0a);
          break;
        case "r":
          bytes.push(0x0d);
          break;
        case "t":
          bytes.push(0x09);
          break;
        case "0":
          bytes.push(0x00);
          break;
        case "\"":
          bytes.push(0x22);
          break;
        case "\\":
          bytes.push(0x5c);
          break;
        default:
          bytes.push(ch.charCodeAt(0));
          break;
      }
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      const trailing = trimmed.slice(i + 1).trim();
      if (trailing.length > 0) {
        fail(srcLine, `${directive} has unexpected trailing text`);
      }
      return Uint8Array.from(bytes);
    }
    bytes.push(ch.charCodeAt(0));
  }
  fail(srcLine, `${directive} has an unterminated string literal`);
}

function parseDataDirective(text: string, srcLine: number, section: Section): DataDirective {
  const match = /^(\.\w+)\b(.*)$/.exec(text.trim());
  if (!match) {
    fail(srcLine, `Unsupported directive "${text}"`);
  }
  const directive = match[1].toLowerCase();
  const rest = match[2].trim();

  if (section !== "data" && [".word", ".half", ".byte", ".ascii", ".asciz", ".string", ".space", ".align"].includes(directive)) {
    fail(srcLine, `${directive} is only valid in .data`);
  }

  if (directive === ".word") {
    return { kind: "word", values: parseValueRefList(rest, srcLine, ".word") };
  }
  if (directive === ".half") {
    return { kind: "half", values: parseValueRefList(rest, srcLine, ".half") };
  }
  if (directive === ".byte") {
    return { kind: "byte", values: parseValueRefList(rest, srcLine, ".byte") };
  }
  if (directive === ".ascii") {
    return { kind: "ascii", bytes: parseStringLiteral(rest, srcLine, ".ascii") };
  }
  if (directive === ".asciz" || directive === ".string") {
    return { kind: "asciz", bytes: parseStringLiteral(rest, srcLine, directive) };
  }
  if (directive === ".space") {
    return { kind: "space", size: parseNonNegativeImm(rest, srcLine, ".space") };
  }
  if (directive === ".align") {
    const power = parseNonNegativeImm(rest, srcLine, ".align");
    if (power > 12) {
      fail(srcLine, ".align value must be <= 12");
    }
    return { kind: "align", power };
  }
  fail(srcLine, `Unsupported directive "${directive}"`);
}

function alignPadding(offset: number, power: number): number {
  const align = 1 << power;
  return (align - (offset % align)) % align;
}

function directiveSize(directive: DataDirective, offset: number): number {
  switch (directive.kind) {
    case "word":
      return directive.values.length * 4;
    case "half":
      return directive.values.length * 2;
    case "byte":
      return directive.values.length;
    case "ascii":
      return directive.bytes.length;
    case "asciz":
      return directive.bytes.length + 1;
    case "space":
      return directive.size;
    case "align":
      return alignPadding(offset, directive.power);
  }
}

function pushScalar(bytes: number[], value: number, width: 1 | 2 | 4): void {
  if (width === 1) {
    bytes.push(value & 0xff);
    return;
  }
  if (width === 2) {
    bytes.push(value & 0xff, (value >>> 8) & 0xff);
    return;
  }
  bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function emitDataDirective(
  directive: DataDirective,
  labels: Map<string, LabelInfo>,
  symbols: Map<string, number>,
  srcLine: number,
  offset: number,
  bytes: number[]
): void {
  const resolveOrFail = (value: ValueRef, directiveName: string): number => {
    try {
      return resolveValueRef(value, labels, symbols);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("undefined:")) {
        const name = error.message.slice("undefined:".length);
        fail(srcLine, `${directiveName} references undefined label "${name}"`);
      }
      throw error;
    }
  };

  switch (directive.kind) {
    case "word":
      for (const value of directive.values) {
        pushScalar(bytes, resolveOrFail(value, ".word"), 4);
      }
      return;
    case "half":
      for (const value of directive.values) {
        pushScalar(bytes, resolveOrFail(value, ".half"), 2);
      }
      return;
    case "byte":
      for (const value of directive.values) {
        pushScalar(bytes, resolveOrFail(value, ".byte"), 1);
      }
      return;
    case "ascii":
      bytes.push(...directive.bytes);
      return;
    case "asciz":
      bytes.push(...directive.bytes, 0);
      return;
    case "space":
      for (let i = 0; i < directive.size; i++) {
        bytes.push(0);
      }
      return;
    case "align":
      for (let i = 0; i < alignPadding(offset, directive.power); i++) {
        bytes.push(0);
      }
      return;
  }
}

export function parseAssembly(source: string): ParsedProgram {
  const lines = source.split(/\r?\n/);
  const symbols = new Map<string, number>();
  const labels = new Map<string, LabelInfo>();
  const pending: PendingEntry[] = [];

  let section: Section = "text";
  let textPc = TEXT_BASE;
  let dataPc = DATA_BASE;
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
      const address = section === "text" ? textPc : dataPc;
      labels.set(m[1], { address, section });
      lineLabels.push(m[1]);
      rest = m[2].trim();
    }

    if (!rest) {
      if (section === "text") {
        pending.push({ kind: "text", labels: lineLabels, text: null, srcLine, pc: textPc });
      }
      continue;
    }

    const lowerRest = rest.toLowerCase();
    if (lowerRest === ".text") {
      if (lineLabels.length > 0) {
        fail(srcLine, "Labels cannot appear on the same line as .text");
      }
      section = "text";
      continue;
    }
    if (lowerRest === ".data") {
      if (lineLabels.length > 0) {
        fail(srcLine, "Labels cannot appear on the same line as .data");
      }
      section = "data";
      continue;
    }

    if (section === "text") {
      if (rest.startsWith(".")) {
        fail(srcLine, `Unsupported directive "${rest}"`);
      }
      pending.push({ kind: "text", labels: lineLabels, text: rest, srcLine, pc: textPc });
      textPc += estimateWords(rest, srcLine) * 4;
      continue;
    }

    if (!rest.startsWith(".")) {
      fail(srcLine, `Instructions are only valid in .text, found "${rest}" in .data`);
    }
    const directive = parseDataDirective(rest, srcLine, section);
    pending.push({ kind: "data", directive, srcLine, addr: dataPc });
    dataPc += directiveSize(directive, dataPc - DATA_BASE);
  }

  const instructions: InstructionWire[] = [];
  const disasm: DisasmLine[] = [];
  const dataBytes: number[] = [];

  for (const entry of pending) {
    if (entry.kind === "text") {
      for (const label of entry.labels) {
        disasm.push({
          pc: entry.pc >>> 0,
          text: `${label}:`,
          label: true,
        });
      }
      const emitted = parseTextEntry(entry, labels, symbols);
      let linePc = entry.pc;
      for (const inst of emitted) {
        instructions.push(inst);
        disasm.push({
          pc: linePc >>> 0,
          text: formatInstruction(inst),
        });
        linePc += 4;
      }
      continue;
    }
    emitDataDirective(
      entry.directive,
      labels,
      symbols,
      entry.srcLine,
      entry.addr - DATA_BASE,
      dataBytes
    );
  }

  const text = encodeInstructionProgram(instructions, TEXT_BASE);
  const data = Uint8Array.from(dataBytes);
  Object.defineProperties(instructions, {
    text: { value: text, enumerable: false },
    data: { value: data, enumerable: false },
  });

  return {
    instructions: instructions as InstructionListWithSegments,
    disasm,
    text,
    data,
  };
}

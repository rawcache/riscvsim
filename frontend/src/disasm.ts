import { escapeHtml, hex32 } from "./format";
import type { Breakpoint } from "./breakpoints";
import type { DisasmLine } from "./types";

function splitInstruction(text: string): { mnemonic: string; operands: string; comment: string } {
  const [instPart, commentPart] = text.split("#", 2);
  const trimmed = instPart.trim();
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace < 0) {
    return {
      mnemonic: trimmed,
      operands: "",
      comment: commentPart?.trim() ?? "",
    };
  }
  return {
    mnemonic: trimmed.slice(0, firstSpace),
    operands: trimmed.slice(firstSpace).trim(),
    comment: commentPart?.trim() ?? "",
  };
}

function classifyOperand(token: string): string {
  if (/^x(?:[0-9]|[12][0-9]|3[01])$/i.test(token) || /^(?:zero|ra|sp|gp|tp|t[0-6]|s(?:[0-9]|1[01])|a[0-7]|fp)$/i.test(token)) {
    return "is-register";
  }
  if (/^-?(?:0x[0-9a-fA-F]+|\d+)$/.test(token)) {
    return "is-immediate";
  }
  return "is-label";
}

function renderOperands(operands: string): string {
  if (!operands) {
    return "";
  }
  const parts = operands.split(/(\s*,\s*|\(|\))/).filter((part) => part.length > 0);
  return parts
    .map((part) => {
      if (/^\s*,\s*$/.test(part) || part === "(" || part === ")") {
        return `<span class="disasm-punct">${escapeHtml(part)}</span>`;
      }
      const cls = classifyOperand(part.trim());
      return `<span class="disasm-operand ${cls}">${escapeHtml(part)}</span>`;
    })
    .join("");
}

function opType(mnemonic: string): string {
  const op = mnemonic.toLowerCase();
  if (["add", "sub", "and", "or", "xor", "sll", "srl", "sra", "slt", "sltu", "mul", "div", "rem"].includes(op)) {
    return "R-type register arithmetic";
  }
  if (["addi", "andi", "ori", "xori", "slti", "sltiu", "slli", "srli", "srai"].includes(op)) {
    return "I-type immediate arithmetic";
  }
  if (["lw", "lh", "lb", "lhu", "lbu", "jalr"].includes(op)) {
    return "I-type load / indirect jump";
  }
  if (["sw", "sh", "sb"].includes(op)) {
    return "S-type store";
  }
  if (["beq", "bne", "blt", "bge", "bltu", "bgeu"].includes(op)) {
    return "B-type conditional branch";
  }
  if (["jal"].includes(op)) {
    return "J-type jump";
  }
  if (["lui", "auipc"].includes(op)) {
    return "U-type upper immediate";
  }
  return "Pseudo / system instruction";
}

function opDescription(mnemonic: string, operands: string): string {
  const op = mnemonic.toLowerCase();
  const [a, b, c] = operands.split(/\s*,\s*/);
  switch (op) {
    case "addi":
      return `rd = rs1 + sign_extend(imm12)`;
    case "add":
      return `rd = rs1 + rs2`;
    case "sub":
      return `rd = rs1 - rs2`;
    case "lw":
      return `rd = *(u32*)(rs1 + imm12)`;
    case "sw":
      return `*(u32*)(rs1 + imm12) = rs2`;
    case "beq":
      return `if (${a} == ${b}) pc = ${c}`;
    case "bne":
      return `if (${a} != ${b}) pc = ${c}`;
    case "jal":
      return `rd = pc + 4; pc = target`;
    case "jalr":
      return `rd = pc + 4; pc = (rs1 + imm) & ~1`;
    case "mul":
      return `rd = low32(rs1 * rs2)`;
    case "div":
      return `rd = rs1 / rs2`;
    case "rem":
      return `rd = rs1 % rs2`;
    default:
      return operands ? `${mnemonic} ${operands}` : mnemonic;
  }
}

function parseRegisterValue(token: string, regs?: number[]): number | null {
  if (!regs) {
    return null;
  }
  const normalized = token.trim().toLowerCase();
  const aliases: Record<string, number> = {
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
  let index = aliases[normalized];
  if (index === undefined && /^x(?:[0-9]|[12][0-9]|3[01])$/.test(normalized)) {
    index = Number.parseInt(normalized.slice(1), 10);
  }
  if (index === undefined) {
    return null;
  }
  return regs[index] >>> 0;
}

function parseImmediate(token: string): number | null {
  const normalized = token.trim();
  if (!normalized) {
    return null;
  }
  const negative = normalized.startsWith("-");
  const body = negative ? normalized.slice(1) : normalized;
  const base = body.startsWith("0x") ? 16 : 10;
  const digits = body.startsWith("0x") ? body.slice(2) : body;
  if (!/^[0-9a-fA-F]+$/.test(digits)) {
    return null;
  }
  const value = Number.parseInt(digits, base);
  return negative ? -value : value;
}

function branchNote(mnemonic: string, operands: string, regs?: number[]): string {
  if (!regs) {
    return "";
  }
  const [lhs, rhs, label] = operands.split(/\s*,\s*/);
  const leftValue = parseRegisterValue(lhs, regs);
  const rightValue = parseRegisterValue(rhs, regs);
  if (leftValue === null || rightValue === null) {
    return "";
  }
  const signedLeft = leftValue | 0;
  const signedRight = rightValue | 0;
  let taken = false;
  switch (mnemonic.toLowerCase()) {
    case "beq":
      taken = leftValue === rightValue;
      break;
    case "bne":
      taken = leftValue !== rightValue;
      break;
    case "blt":
      taken = signedLeft < signedRight;
      break;
    case "bge":
      taken = signedLeft >= signedRight;
      break;
    case "bltu":
      taken = leftValue < rightValue;
      break;
    case "bgeu":
      taken = leftValue >= rightValue;
      break;
  }
  return `${taken ? "Taken" : "Not taken"} · ${lhs} (${hex32(leftValue)}) vs ${rhs} (${hex32(rightValue)}) → ${label}`;
}

function memoryNote(operands: string, regs?: number[]): string {
  if (!regs) {
    return "";
  }
  const match = /([^,]+),\s*([^()]+)\(([^)]+)\)/.exec(operands);
  if (!match) {
    return "";
  }
  const imm = parseImmediate(match[2]);
  const baseReg = parseRegisterValue(match[3], regs);
  if (imm === null || baseReg === null) {
    return "";
  }
  return `Address = ${match[3]} + ${match[2]} = ${hex32((baseReg + imm) >>> 0)}`;
}

function renderEncodingBits(encoding: string): string {
  const padded = encoding.padStart(8, "0");
  const value = Number.parseInt(padded, 16) >>> 0;
  const binary = value.toString(2).padStart(32, "0");
  const segments = [
    { name: "imm", value: binary.slice(0, 12), className: "is-imm" },
    { name: "rs1", value: binary.slice(12, 17), className: "is-reg" },
    { name: "funct3", value: binary.slice(17, 20), className: "is-funct" },
    { name: "rd", value: binary.slice(20, 25), className: "is-reg" },
    { name: "opcode", value: binary.slice(25), className: "is-opcode" },
  ];

  return `
    <div class="disasm-tooltip__bits">
      ${segments
        .map(
          (segment) => `
            <div class="disasm-tooltip__field ${segment.className}">
              <div class="disasm-tooltip__field-bits">${segment.value}</div>
              <div class="disasm-tooltip__field-name">${segment.name}</div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderTooltip(mnemonic: string, operands: string, encoding: string, regs?: number[]): string {
  const branch = ["beq", "bne", "blt", "bge", "bltu", "bgeu"].includes(mnemonic.toLowerCase())
    ? branchNote(mnemonic, operands, regs)
    : "";
  const memory = ["lw", "lh", "lb", "lhu", "lbu", "sw", "sh", "sb", "jalr"].includes(mnemonic.toLowerCase())
    ? memoryNote(operands, regs)
    : "";

  return `
    <div class="disasm-tooltip">
      <div class="disasm-tooltip__title">${escapeHtml(mnemonic.toUpperCase())}</div>
      <div class="disasm-tooltip__type">${escapeHtml(opType(mnemonic))}</div>
      <div class="disasm-tooltip__op">${escapeHtml(opDescription(mnemonic, operands))}</div>
      ${renderEncodingBits(encoding)}
      ${branch ? `<div class="disasm-tooltip__note">${escapeHtml(branch)}</div>` : ""}
      ${memory ? `<div class="disasm-tooltip__note">${escapeHtml(memory)}</div>` : ""}
    </div>
  `;
}

export function renderDisasm(
  pc: number | undefined,
  prevPc: number | undefined,
  disasm?: DisasmLine[],
  encodings: ReadonlyMap<number, string> = new Map<number, string>(),
  breakpoints: Breakpoint[] = [],
  regs?: number[]
): string {
  if (!disasm || disasm.length === 0) {
    return `
      <div class="disasm-empty">
        <div class="empty-state empty-state--note"><em>Disassembly will appear after assembly.</em></div>
      </div>
    `;
  }

  return disasm
    .map((line) => {
      if (line.label) {
        return `
          <div class="disasm-line disasm-line--label">
            <span class="disasm-label">${escapeHtml(line.text)}</span>
          </div>
        `;
      }

      const encoding = escapeHtml(encodings.get(line.pc) ?? "--------");
      const { mnemonic, operands, comment } = splitInstruction(line.text);
      const classes = ["disasm-line"];
      if (pc !== undefined && line.pc === pc) {
        classes.push("disasm-pc-current");
      } else if (prevPc !== undefined && line.pc === prevPc) {
        classes.push("disasm-pc-prev");
      }
      const breakpoint = breakpoints.find(
        (candidate) => candidate.address !== undefined && (candidate.address >>> 0) === (line.pc >>> 0)
      );
      return `
        <div class="${classes.join(" ")}" data-pc="${line.pc >>> 0}">
          <span class="disasm-bp">${breakpoint ? '<span class="disasm-bp__dot"></span>' : ""}${pc === line.pc ? '<span class="disasm-bp__pc">▶</span>' : ""}</span>
          <span class="disasm-addr">${hex32(line.pc)}</span>
          <span class="disasm-encoding">${encoding}</span>
          <span class="disasm-mnemonic">${escapeHtml(mnemonic)}</span>
          <span class="disasm-operands">${renderOperands(operands)}</span>
          <span class="disasm-comment">${escapeHtml(comment)}</span>
          ${renderTooltip(mnemonic, operands, encoding, regs)}
        </div>
      `;
    })
    .join("");
}

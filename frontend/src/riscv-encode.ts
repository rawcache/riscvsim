import type { InstructionWire } from "./types";

function requiredNumber(value: number | undefined, field: string, op: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Instruction "${op}" is missing numeric field "${field}"`);
  }
  return value | 0;
}

function encodeR(rd: number, rs1: number, rs2: number, funct3: number, funct7: number, opcode: number): number {
  return (
    ((funct7 & 0x7f) << 25) |
    ((rs2 & 0x1f) << 20) |
    ((rs1 & 0x1f) << 15) |
    ((funct3 & 0x7) << 12) |
    ((rd & 0x1f) << 7) |
    (opcode & 0x7f)
  ) >>> 0;
}

function encodeI(rd: number, rs1: number, imm: number, funct3: number, opcode: number): number {
  return (
    (((imm & 0x0fff) << 20) >>> 0) |
    ((rs1 & 0x1f) << 15) |
    ((funct3 & 0x7) << 12) |
    ((rd & 0x1f) << 7) |
    (opcode & 0x7f)
  ) >>> 0;
}

function encodeS(rs1: number, rs2: number, imm: number, funct3: number, opcode: number): number {
  const imm12 = imm & 0x0fff;
  return (
    (((imm12 >> 5) & 0x7f) << 25) |
    ((rs2 & 0x1f) << 20) |
    ((rs1 & 0x1f) << 15) |
    ((funct3 & 0x7) << 12) |
    ((imm12 & 0x1f) << 7) |
    (opcode & 0x7f)
  ) >>> 0;
}

function encodeB(rs1: number, rs2: number, offset: number, funct3: number, opcode: number): number {
  if ((offset & 1) !== 0) {
    throw new Error(`Branch offset must be even, got ${offset}`);
  }
  if (offset < -4096 || offset > 4094) {
    throw new Error(`Branch offset out of range: ${offset}`);
  }
  const imm13 = offset & 0x1fff;
  return (
    (((imm13 >> 12) & 0x1) << 31) |
    (((imm13 >> 5) & 0x3f) << 25) |
    ((rs2 & 0x1f) << 20) |
    ((rs1 & 0x1f) << 15) |
    ((funct3 & 0x7) << 12) |
    (((imm13 >> 1) & 0x0f) << 8) |
    (((imm13 >> 11) & 0x1) << 7) |
    (opcode & 0x7f)
  ) >>> 0;
}

function encodeU(rd: number, imm20: number, opcode: number): number {
  return ((((imm20 & 0x000f_ffff) << 12) >>> 0) | ((rd & 0x1f) << 7) | (opcode & 0x7f)) >>> 0;
}

function encodeJ(rd: number, offset: number, opcode: number): number {
  if ((offset & 1) !== 0) {
    throw new Error(`Jump offset must be even, got ${offset}`);
  }
  if (offset < -1_048_576 || offset > 1_048_574) {
    throw new Error(`Jump offset out of range: ${offset}`);
  }
  const imm21 = offset & 0x1f_ffff;
  return (
    (((imm21 >> 20) & 0x1) << 31) |
    (((imm21 >> 1) & 0x03ff) << 21) |
    (((imm21 >> 11) & 0x1) << 20) |
    (((imm21 >> 12) & 0x00ff) << 12) |
    ((rd & 0x1f) << 7) |
    (opcode & 0x7f)
  ) >>> 0;
}

export function encodeInstruction(inst: InstructionWire, pc: number): number {
  const op = inst.op.toLowerCase();
  const rEncodings: Record<string, { funct3: number; funct7: number }> = {
    add: { funct3: 0x0, funct7: 0x00 },
    sub: { funct3: 0x0, funct7: 0x20 },
    sll: { funct3: 0x1, funct7: 0x00 },
    slt: { funct3: 0x2, funct7: 0x00 },
    sltu: { funct3: 0x3, funct7: 0x00 },
    xor: { funct3: 0x4, funct7: 0x00 },
    srl: { funct3: 0x5, funct7: 0x00 },
    sra: { funct3: 0x5, funct7: 0x20 },
    or: { funct3: 0x6, funct7: 0x00 },
    and: { funct3: 0x7, funct7: 0x00 },
    mul: { funct3: 0x0, funct7: 0x01 },
    mulh: { funct3: 0x1, funct7: 0x01 },
    mulhsu: { funct3: 0x2, funct7: 0x01 },
    mulhu: { funct3: 0x3, funct7: 0x01 },
    div: { funct3: 0x4, funct7: 0x01 },
    divu: { funct3: 0x5, funct7: 0x01 },
    rem: { funct3: 0x6, funct7: 0x01 },
    remu: { funct3: 0x7, funct7: 0x01 },
  };

  const iAluEncodings: Record<string, number> = {
    addi: 0x0,
    slti: 0x2,
    sltiu: 0x3,
    xori: 0x4,
    ori: 0x6,
    andi: 0x7,
  };

  const loadEncodings: Record<string, number> = {
    lb: 0x0,
    lh: 0x1,
    lw: 0x2,
    lbu: 0x4,
    lhu: 0x5,
  };

  const storeEncodings: Record<string, number> = {
    sb: 0x0,
    sh: 0x1,
    sw: 0x2,
  };

  const branchEncodings: Record<string, number> = {
    beq: 0x0,
    bne: 0x1,
    blt: 0x4,
    bge: 0x5,
    bltu: 0x6,
    bgeu: 0x7,
  };

  if (op in rEncodings) {
    const encoding = rEncodings[op];
    return encodeR(
      requiredNumber(inst.rd, "rd", op),
      requiredNumber(inst.rs1, "rs1", op),
      requiredNumber(inst.rs2, "rs2", op),
      encoding.funct3,
      encoding.funct7,
      0x33
    );
  }

  if (op in iAluEncodings) {
    return encodeI(
      requiredNumber(inst.rd, "rd", op),
      requiredNumber(inst.rs1, "rs1", op),
      requiredNumber(inst.imm, "imm", op),
      iAluEncodings[op],
      0x13
    );
  }

  if (op === "slli") {
    const imm = requiredNumber(inst.imm, "imm", op);
    return encodeI(
      requiredNumber(inst.rd, "rd", op),
      requiredNumber(inst.rs1, "rs1", op),
      imm & 0x1f,
      0x1,
      0x13
    );
  }

  if (op === "srli") {
    const imm = requiredNumber(inst.imm, "imm", op);
    return encodeI(
      requiredNumber(inst.rd, "rd", op),
      requiredNumber(inst.rs1, "rs1", op),
      imm & 0x1f,
      0x5,
      0x13
    );
  }

  if (op === "srai") {
    const imm = requiredNumber(inst.imm, "imm", op) & 0x1f;
    return encodeI(
      requiredNumber(inst.rd, "rd", op),
      requiredNumber(inst.rs1, "rs1", op),
      imm | 0x400,
      0x5,
      0x13
    );
  }

  if (op in loadEncodings) {
    return encodeI(
      requiredNumber(inst.rd, "rd", op),
      requiredNumber(inst.rs1, "rs1", op),
      requiredNumber(inst.imm, "imm", op),
      loadEncodings[op],
      0x03
    );
  }

  if (op in storeEncodings) {
    return encodeS(
      requiredNumber(inst.rs1, "rs1", op),
      requiredNumber(inst.rs2, "rs2", op),
      requiredNumber(inst.imm, "imm", op),
      storeEncodings[op],
      0x23
    );
  }

  if (op in branchEncodings) {
    const targetPc = requiredNumber(inst.target_pc, "target_pc", op);
    const offset = targetPc - pc;
    return encodeB(
      requiredNumber(inst.rs1, "rs1", op),
      requiredNumber(inst.rs2, "rs2", op),
      offset,
      branchEncodings[op],
      0x63
    );
  }

  if (op === "lui") {
    return encodeU(requiredNumber(inst.rd, "rd", op), requiredNumber(inst.imm, "imm", op), 0x37);
  }

  if (op === "auipc") {
    return encodeU(requiredNumber(inst.rd, "rd", op), requiredNumber(inst.imm, "imm", op), 0x17);
  }

  if (op === "jal") {
    const targetPc = requiredNumber(inst.target_pc, "target_pc", op);
    const offset = targetPc - pc;
    return encodeJ(requiredNumber(inst.rd, "rd", op), offset, 0x6f);
  }

  if (op === "jalr") {
    return encodeI(
      requiredNumber(inst.rd, "rd", op),
      requiredNumber(inst.rs1, "rs1", op),
      requiredNumber(inst.imm, "imm", op),
      0x0,
      0x67
    );
  }

  if (op === "ecall") {
    return 0x0000_0073;
  }

  if (op === "ebreak") {
    return 0x0010_0073;
  }

  throw new Error(`Unsupported instruction for binary encoding: "${op}"`);
}

export function encodeInstructionProgram(program: InstructionWire[], basePc = 0): Uint8Array {
  const bytes = new Uint8Array(program.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < program.length; i++) {
    const pc = basePc + i * 4;
    const word = encodeInstruction(program[i], pc);
    view.setUint32(i * 4, word, true);
  }
  return bytes;
}


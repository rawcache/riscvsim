//! Binary encoding and decoding of assembled RV32IM / RV64IM instructions.
//!
//! Formats follow the RISC-V Unprivileged ISA specification, chapter
//! "RV32I Base Integer Instruction Set" (R, I, S, B, U, J formats) and the
//! RV64I and M-extension chapters. Immediates are stored the way the
//! assemblers store them: sign-extended byte offsets for I/S/B/J, and the
//! raw 20-bit field for LUI/AUIPC.

use crate::assembler::{AsmInstr, Op, Program};
use crate::assembler64::{AsmInstr64, Op64, Program64};

/// Decoded fields of one instruction (register numbers and immediate).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fields {
    pub op: Op64,
    pub rd: u8,
    pub rs1: u8,
    pub rs2: u8,
    pub imm: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodeError {
    pub message: String,
}

fn err(message: String) -> EncodeError {
    EncodeError { message }
}

/// The RV32 operation set is a subset of the RV64 one.
pub fn op32_to_op64(op: Op) -> Op64 {
    match op {
        Op::Lui => Op64::Lui,
        Op::Auipc => Op64::Auipc,
        Op::Jal => Op64::Jal,
        Op::Jalr => Op64::Jalr,
        Op::Beq => Op64::Beq,
        Op::Bne => Op64::Bne,
        Op::Blt => Op64::Blt,
        Op::Bge => Op64::Bge,
        Op::Bltu => Op64::Bltu,
        Op::Bgeu => Op64::Bgeu,
        Op::Lb => Op64::Lb,
        Op::Lh => Op64::Lh,
        Op::Lw => Op64::Lw,
        Op::Lbu => Op64::Lbu,
        Op::Lhu => Op64::Lhu,
        Op::Sb => Op64::Sb,
        Op::Sh => Op64::Sh,
        Op::Sw => Op64::Sw,
        Op::Addi => Op64::Addi,
        Op::Slti => Op64::Slti,
        Op::Sltiu => Op64::Sltiu,
        Op::Xori => Op64::Xori,
        Op::Ori => Op64::Ori,
        Op::Andi => Op64::Andi,
        Op::Slli => Op64::Slli,
        Op::Srli => Op64::Srli,
        Op::Srai => Op64::Srai,
        Op::Add => Op64::Add,
        Op::Sub => Op64::Sub,
        Op::Sll => Op64::Sll,
        Op::Slt => Op64::Slt,
        Op::Sltu => Op64::Sltu,
        Op::Xor => Op64::Xor,
        Op::Srl => Op64::Srl,
        Op::Sra => Op64::Sra,
        Op::Or => Op64::Or,
        Op::And => Op64::And,
        Op::Mul => Op64::Mul,
        Op::Mulh => Op64::Mulh,
        Op::Mulhsu => Op64::Mulhsu,
        Op::Mulhu => Op64::Mulhu,
        Op::Div => Op64::Div,
        Op::Divu => Op64::Divu,
        Op::Rem => Op64::Rem,
        Op::Remu => Op64::Remu,
        Op::Ecall => Op64::Ecall,
        Op::Ebreak => Op64::Ebreak,
        Op::Fence => Op64::Fence,
    }
}

/// Inverse of [`op32_to_op64`]; `None` for RV64-only operations.
pub fn op64_to_op32(op: Op64) -> Option<Op> {
    use Op64 as O;
    Some(match op {
        O::Lui => Op::Lui,
        O::Auipc => Op::Auipc,
        O::Jal => Op::Jal,
        O::Jalr => Op::Jalr,
        O::Beq => Op::Beq,
        O::Bne => Op::Bne,
        O::Blt => Op::Blt,
        O::Bge => Op::Bge,
        O::Bltu => Op::Bltu,
        O::Bgeu => Op::Bgeu,
        O::Lb => Op::Lb,
        O::Lh => Op::Lh,
        O::Lw => Op::Lw,
        O::Lbu => Op::Lbu,
        O::Lhu => Op::Lhu,
        O::Sb => Op::Sb,
        O::Sh => Op::Sh,
        O::Sw => Op::Sw,
        O::Addi => Op::Addi,
        O::Slti => Op::Slti,
        O::Sltiu => Op::Sltiu,
        O::Xori => Op::Xori,
        O::Ori => Op::Ori,
        O::Andi => Op::Andi,
        O::Slli => Op::Slli,
        O::Srli => Op::Srli,
        O::Srai => Op::Srai,
        O::Add => Op::Add,
        O::Sub => Op::Sub,
        O::Sll => Op::Sll,
        O::Slt => Op::Slt,
        O::Sltu => Op::Sltu,
        O::Xor => Op::Xor,
        O::Srl => Op::Srl,
        O::Sra => Op::Sra,
        O::Or => Op::Or,
        O::And => Op::And,
        O::Mul => Op::Mul,
        O::Mulh => Op::Mulh,
        O::Mulhsu => Op::Mulhsu,
        O::Mulhu => Op::Mulhu,
        O::Div => Op::Div,
        O::Divu => Op::Divu,
        O::Rem => Op::Rem,
        O::Remu => Op::Remu,
        O::Ecall => Op::Ecall,
        O::Ebreak => Op::Ebreak,
        O::Fence => Op::Fence,
        _ => return None,
    })
}

const OP_IMM: u32 = 0x13;
const OP_IMM_32: u32 = 0x1b;
const OP: u32 = 0x33;
const OP_32: u32 = 0x3b;
const LOAD: u32 = 0x03;
const STORE: u32 = 0x23;
const BRANCH: u32 = 0x63;
const LUI: u32 = 0x37;
const AUIPC: u32 = 0x17;
const JAL: u32 = 0x6f;
const JALR: u32 = 0x67;
const SYSTEM: u32 = 0x73;
const MISC_MEM: u32 = 0x0f;

/// (opcode, funct3, funct7) for R-type operations.
fn r_fields(op: Op64) -> Option<(u32, u32, u32)> {
    use Op64 as O;
    Some(match op {
        O::Add => (OP, 0, 0x00),
        O::Sub => (OP, 0, 0x20),
        O::Sll => (OP, 1, 0x00),
        O::Slt => (OP, 2, 0x00),
        O::Sltu => (OP, 3, 0x00),
        O::Xor => (OP, 4, 0x00),
        O::Srl => (OP, 5, 0x00),
        O::Sra => (OP, 5, 0x20),
        O::Or => (OP, 6, 0x00),
        O::And => (OP, 7, 0x00),
        O::Mul => (OP, 0, 0x01),
        O::Mulh => (OP, 1, 0x01),
        O::Mulhsu => (OP, 2, 0x01),
        O::Mulhu => (OP, 3, 0x01),
        O::Div => (OP, 4, 0x01),
        O::Divu => (OP, 5, 0x01),
        O::Rem => (OP, 6, 0x01),
        O::Remu => (OP, 7, 0x01),
        O::Addw => (OP_32, 0, 0x00),
        O::Subw => (OP_32, 0, 0x20),
        O::Sllw => (OP_32, 1, 0x00),
        O::Srlw => (OP_32, 5, 0x00),
        O::Sraw => (OP_32, 5, 0x20),
        O::Mulw => (OP_32, 0, 0x01),
        O::Divw => (OP_32, 4, 0x01),
        O::Divuw => (OP_32, 5, 0x01),
        O::Remw => (OP_32, 6, 0x01),
        O::Remuw => (OP_32, 7, 0x01),
        _ => return None,
    })
}

/// (opcode, funct3) for I-type arithmetic, loads and jalr.
fn i_fields(op: Op64) -> Option<(u32, u32)> {
    use Op64 as O;
    Some(match op {
        O::Addi => (OP_IMM, 0),
        O::Slti => (OP_IMM, 2),
        O::Sltiu => (OP_IMM, 3),
        O::Xori => (OP_IMM, 4),
        O::Ori => (OP_IMM, 6),
        O::Andi => (OP_IMM, 7),
        O::Addiw => (OP_IMM_32, 0),
        O::Lb => (LOAD, 0),
        O::Lh => (LOAD, 1),
        O::Lw => (LOAD, 2),
        O::Ld => (LOAD, 3),
        O::Lbu => (LOAD, 4),
        O::Lhu => (LOAD, 5),
        O::Lwu => (LOAD, 6),
        O::Jalr => (JALR, 0),
        _ => return None,
    })
}

/// (opcode, funct3, high bits of imm[11:5 or 11:6]) for immediate shifts.
fn shift_fields(op: Op64) -> Option<(u32, u32, u32, bool)> {
    use Op64 as O;
    // last field: true when the shift is a 32-bit W operation
    Some(match op {
        O::Slli => (OP_IMM, 1, 0x00, false),
        O::Srli => (OP_IMM, 5, 0x00, false),
        O::Srai => (OP_IMM, 5, 0x20, false),
        O::Slliw => (OP_IMM_32, 1, 0x00, true),
        O::Srliw => (OP_IMM_32, 5, 0x00, true),
        O::Sraiw => (OP_IMM_32, 5, 0x20, true),
        _ => return None,
    })
}

fn store_funct3(op: Op64) -> Option<u32> {
    use Op64 as O;
    Some(match op {
        O::Sb => 0,
        O::Sh => 1,
        O::Sw => 2,
        O::Sd => 3,
        _ => return None,
    })
}

fn branch_funct3(op: Op64) -> Option<u32> {
    use Op64 as O;
    Some(match op {
        O::Beq => 0,
        O::Bne => 1,
        O::Blt => 4,
        O::Bge => 5,
        O::Bltu => 6,
        O::Bgeu => 7,
        _ => return None,
    })
}

fn fits_signed(value: i64, bits: u32) -> bool {
    let min = -(1i64 << (bits - 1));
    let max = (1i64 << (bits - 1)) - 1;
    (min..=max).contains(&value)
}

/// Encode one instruction for the given XLEN (32 or 64).
pub fn encode_fields(f: Fields, xlen: u32) -> Result<u32, EncodeError> {
    let (rd, rs1, rs2) = (f.rd as u32, f.rs1 as u32, f.rs2 as u32);
    if rd > 31 || rs1 > 31 || rs2 > 31 {
        return Err(err("register number above x31".to_string()));
    }
    let imm = f.imm;
    if xlen == 32 && op64_to_op32(f.op).is_none() {
        return Err(err(format!("{:?} is an RV64-only instruction", f.op).to_lowercase()));
    }
    if let Some((opcode, funct3, funct7)) = r_fields(f.op) {
        return Ok((funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
    }
    if let Some((opcode, funct3, high, word)) = shift_fields(f.op) {
        let max = if word || xlen == 32 { 31 } else { 63 };
        if !(0..=max).contains(&imm) {
            return Err(err(format!("shift amount {imm} is outside 0..={max}")));
        }
        return Ok((high << 25) | ((imm as u32) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
    }
    if let Some((opcode, funct3)) = i_fields(f.op) {
        if !fits_signed(imm, 12) {
            return Err(err(format!("I-type immediate {imm} is outside -2048..=2047")));
        }
        let imm = (imm as u32) & 0xfff;
        return Ok((imm << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
    }
    if let Some(funct3) = store_funct3(f.op) {
        if !fits_signed(imm, 12) {
            return Err(err(format!("S-type immediate {imm} is outside -2048..=2047")));
        }
        let imm = (imm as u32) & 0xfff;
        return Ok(((imm >> 5) << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | ((imm & 0x1f) << 7) | STORE);
    }
    if let Some(funct3) = branch_funct3(f.op) {
        if !fits_signed(imm, 13) || imm % 2 != 0 {
            return Err(err(format!("branch offset {imm} is not an even value in -4096..=4094")));
        }
        let i = (imm as u32) & 0x1fff;
        let word = (((i >> 12) & 1) << 31)
            | (((i >> 5) & 0x3f) << 25)
            | (rs2 << 20)
            | (rs1 << 15)
            | (funct3 << 12)
            | (((i >> 1) & 0xf) << 8)
            | (((i >> 11) & 1) << 7)
            | BRANCH;
        return Ok(word);
    }
    match f.op {
        Op64::Lui | Op64::Auipc => {
            if !(0..=0xfffff).contains(&imm) {
                return Err(err(format!("U-type immediate {imm} is outside 0..=0xfffff")));
            }
            let opcode = if f.op == Op64::Lui { LUI } else { AUIPC };
            Ok(((imm as u32) << 12) | (rd << 7) | opcode)
        }
        Op64::Jal => {
            if !fits_signed(imm, 21) || imm % 2 != 0 {
                return Err(err(format!("jump offset {imm} is not an even value in -1048576..=1048574")));
            }
            let i = (imm as u32) & 0x1f_ffff;
            Ok((((i >> 20) & 1) << 31)
                | (((i >> 1) & 0x3ff) << 21)
                | (((i >> 11) & 1) << 20)
                | (((i >> 12) & 0xff) << 12)
                | (rd << 7)
                | JAL)
        }
        Op64::Ecall => Ok(SYSTEM),
        Op64::Ebreak => Ok((1 << 20) | SYSTEM),
        // fence iorw, iorw (the canonical full fence)
        Op64::Fence => Ok(0x0ff0_000f),
        _ => Err(err("internal: unhandled operation".to_string())),
    }
}

fn sext(value: u32, bits: u32) -> i64 {
    let shift = 64 - bits;
    ((value as u64) << shift) as i64 >> shift
}

/// Decode one 32-bit instruction word; `None` for anything outside the
/// supported RV32IM (xlen 32) or RV64IM (xlen 64) set.
pub fn decode(word: u32, xlen: u32) -> Option<Fields> {
    let opcode = word & 0x7f;
    let rd = ((word >> 7) & 31) as u8;
    let funct3 = (word >> 12) & 7;
    let rs1 = ((word >> 15) & 31) as u8;
    let rs2 = ((word >> 20) & 31) as u8;
    let funct7 = word >> 25;
    let i_imm = sext(word >> 20, 12);
    let mk = |op: Op64, rd: u8, rs1: u8, rs2: u8, imm: i64| Some(Fields { op, rd, rs1, rs2, imm });
    use Op64 as O;
    let fields = match opcode {
        OP | OP_32 => {
            let op = [
                O::Add, O::Sub, O::Sll, O::Slt, O::Sltu, O::Xor, O::Srl, O::Sra, O::Or, O::And,
                O::Mul, O::Mulh, O::Mulhsu, O::Mulhu, O::Div, O::Divu, O::Rem, O::Remu, O::Addw,
                O::Subw, O::Sllw, O::Srlw, O::Sraw, O::Mulw, O::Divw, O::Divuw, O::Remw, O::Remuw,
            ]
            .into_iter()
            .find(|&op| r_fields(op) == Some((opcode, funct3, funct7)))?;
            mk(op, rd, rs1, rs2, 0)
        }
        OP_IMM | OP_IMM_32 if funct3 == 1 || funct3 == 5 => {
            let word_op = opcode == OP_IMM_32;
            let wide = xlen == 64 && !word_op;
            let (shamt, high) = if wide {
                ((word >> 20) & 63, (word >> 26) << 1)
            } else {
                ((word >> 20) & 31, word >> 25)
            };
            let op = [O::Slli, O::Srli, O::Srai, O::Slliw, O::Srliw, O::Sraiw]
                .into_iter()
                .find(|&op| shift_fields(op) == Some((opcode, funct3, high, word_op)))?;
            mk(op, rd, rs1, 0, shamt as i64)
        }
        OP_IMM | OP_IMM_32 | LOAD | JALR => {
            let op = [
                O::Addi, O::Slti, O::Sltiu, O::Xori, O::Ori, O::Andi, O::Addiw, O::Lb, O::Lh,
                O::Lw, O::Ld, O::Lbu, O::Lhu, O::Lwu, O::Jalr,
            ]
            .into_iter()
            .find(|&op| i_fields(op) == Some((opcode, funct3)))?;
            mk(op, rd, rs1, 0, i_imm)
        }
        STORE => {
            let op = [O::Sb, O::Sh, O::Sw, O::Sd]
                .into_iter()
                .find(|&op| store_funct3(op) == Some(funct3))?;
            let imm = sext(((word >> 25) << 5) | ((word >> 7) & 0x1f), 12);
            mk(op, 0, rs1, rs2, imm)
        }
        BRANCH => {
            let op = [O::Beq, O::Bne, O::Blt, O::Bge, O::Bltu, O::Bgeu]
                .into_iter()
                .find(|&op| branch_funct3(op) == Some(funct3))?;
            let imm = (((word >> 31) & 1) << 12)
                | (((word >> 7) & 1) << 11)
                | (((word >> 25) & 0x3f) << 5)
                | (((word >> 8) & 0xf) << 1);
            mk(op, 0, rs1, rs2, sext(imm, 13))
        }
        LUI => mk(O::Lui, rd, 0, 0, (word >> 12) as i64),
        AUIPC => mk(O::Auipc, rd, 0, 0, (word >> 12) as i64),
        JAL => {
            let imm = (((word >> 31) & 1) << 20)
                | (((word >> 12) & 0xff) << 12)
                | (((word >> 20) & 1) << 11)
                | (((word >> 21) & 0x3ff) << 1);
            mk(O::Jal, rd, 0, 0, sext(imm, 21))
        }
        SYSTEM if word == SYSTEM => mk(O::Ecall, 0, 0, 0, 0),
        SYSTEM if word == (1 << 20) | SYSTEM => mk(O::Ebreak, 0, 0, 0, 0),
        MISC_MEM if funct3 == 0 => mk(O::Fence, 0, 0, 0, 0),
        _ => None,
    }?;
    if xlen == 32 && op64_to_op32(fields.op).is_none() {
        return None;
    }
    Some(fields)
}

/// Canonical field values: registers an operation does not use are zero.
pub fn canonical(f: Fields) -> Fields {
    let mut f = f;
    use Op64 as O;
    let uses_rs2 = r_fields(f.op).is_some() || store_funct3(f.op).is_some() || branch_funct3(f.op).is_some();
    let uses_rs1 = !matches!(f.op, O::Lui | O::Auipc | O::Jal | O::Ecall | O::Ebreak | O::Fence);
    let writes_rd = store_funct3(f.op).is_none()
        && branch_funct3(f.op).is_none()
        && !matches!(f.op, O::Ecall | O::Ebreak | O::Fence);
    if !uses_rs2 {
        f.rs2 = 0;
    }
    if !uses_rs1 {
        f.rs1 = 0;
    }
    if !writes_rd {
        f.rd = 0;
    }
    if matches!(f.op, O::Ecall | O::Ebreak | O::Fence) || r_fields(f.op).is_some() {
        f.imm = 0;
    }
    f
}

pub fn fields32(i: &AsmInstr) -> Fields {
    canonical(Fields { op: op32_to_op64(i.op), rd: i.rd, rs1: i.rs1, rs2: i.rs2, imm: i.imm as i64 })
}

pub fn fields64(i: &AsmInstr64) -> Fields {
    canonical(Fields { op: i.op, rd: i.rd, rs1: i.rs1, rs2: i.rs2, imm: i.imm })
}

pub fn encode32(i: &AsmInstr) -> Result<u32, EncodeError> {
    encode_fields(fields32(i), 32)
}

pub fn encode64(i: &AsmInstr64) -> Result<u32, EncodeError> {
    encode_fields(fields64(i), 64)
}

/// Little-endian machine code for a whole RV32 program's text segment.
pub fn program_bytes32(p: &Program) -> Result<Vec<u8>, EncodeError> {
    let mut out = Vec::with_capacity(p.instrs.len() * 4);
    for i in &p.instrs {
        out.extend_from_slice(&encode32(i)?.to_le_bytes());
    }
    Ok(out)
}

/// Little-endian machine code for a whole RV64 program's text segment.
pub fn program_bytes64(p: &Program64) -> Result<Vec<u8>, EncodeError> {
    let mut out = Vec::with_capacity(p.instrs.len() * 4);
    for i in &p.instrs {
        out.extend_from_slice(&encode64(i)?.to_le_bytes());
    }
    Ok(out)
}

/// Render decoded fields back to canonical assembly text that both
/// assemblers accept (a disassembler). Branch and jump targets are written
/// as absolute addresses computed from `pc`.
pub fn disassemble(f: Fields, pc: u64) -> String {
    use Op64 as O;
    let name = format!("{:?}", f.op).to_lowercase();
    let r = |n: u8| format!("x{n}");
    match f.op {
        O::Lui | O::Auipc => format!("{name} {}, {}", r(f.rd), f.imm),
        O::Jal => format!("{name} {}, {}", r(f.rd), pc.wrapping_add(f.imm as u64)),
        O::Ecall | O::Ebreak | O::Fence => name,
        _ if branch_funct3(f.op).is_some() => format!(
            "{name} {}, {}, {}",
            r(f.rs1),
            r(f.rs2),
            pc.wrapping_add(f.imm as u64)
        ),
        _ if store_funct3(f.op).is_some() => format!("{name} {}, {}({})", r(f.rs2), f.imm, r(f.rs1)),
        O::Lb | O::Lh | O::Lw | O::Ld | O::Lbu | O::Lhu | O::Lwu | O::Jalr => {
            format!("{name} {}, {}({})", r(f.rd), f.imm, r(f.rs1))
        }
        _ if r_fields(f.op).is_some() => format!("{name} {}, {}, {}", r(f.rd), r(f.rs1), r(f.rs2)),
        _ => format!("{name} {}, {}, {}", r(f.rd), r(f.rs1), f.imm),
    }
}

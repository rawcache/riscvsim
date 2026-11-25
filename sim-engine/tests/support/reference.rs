//! Reference (functional, one-instruction-at-a-time) interpreters for RV32IM
//! and RV64IM. They are written directly from the RISC-V unprivileged
//! specification and share no code with the pipelines, so they serve as the
//! oracle for differential tests.
//!
//! Memory semantics mirror the documented simulator contract:
//! data segment [DATA_BASE, DATA_BASE + DATA_SIZE) and stack
//! [STACK_LIMIT, stack top]; anything else, or a misaligned access, ends the
//! run with an error. Fetching outside .text ends the run as "complete".
#![allow(dead_code)]

use sim_engine::assembler::Op;
use sim_engine::{Op64, Program, Program64, DATA_BASE, DATA_SIZE, STACK_LIMIT, STACK_TOP};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// ecall / ebreak retired, or execution fell off the end of .text.
    Complete,
    /// Memory fault or misaligned control transfer.
    Error,
    /// Step budget exhausted.
    StepLimit,
}

#[derive(Debug, Clone)]
pub struct State<W> {
    pub regs: [W; 32],
    /// Non-zero bytes only, so it compares equal to the pipeline's view.
    pub mem: BTreeMap<u64, u8>,
    pub pc: u64,
    pub outcome: Outcome,
    pub retired: u64,
}

fn region_ok(addr: u64, len: u64, stack_top_incl: u64) -> bool {
    let Some(end) = addr.checked_add(len - 1) else {
        return false;
    };
    let db = DATA_BASE as u64;
    (addr >= db && end < db + DATA_SIZE as u64) || (addr >= STACK_LIMIT as u64 && end <= stack_top_incl)
}

fn load(mem: &BTreeMap<u64, u8>, addr: u64, len: u64) -> u64 {
    (0..len).fold(0, |acc, i| acc | (u64::from(*mem.get(&(addr + i)).unwrap_or(&0)) << (8 * i)))
}

fn store(mem: &mut BTreeMap<u64, u8>, addr: u64, len: u64, value: u64) {
    for i in 0..len {
        let b = (value >> (8 * i)) as u8;
        if b == 0 {
            mem.remove(&(addr + i));
        } else {
            mem.insert(addr + i, b);
        }
    }
}

fn initial_mem(data: &[u8]) -> BTreeMap<u64, u8> {
    data.iter()
        .enumerate()
        .filter(|(_, b)| **b != 0)
        .map(|(i, b)| (DATA_BASE as u64 + i as u64, *b))
        .collect()
}

pub fn run32(program: &Program, max_steps: u64) -> State<u32> {
    let mut regs = [0u32; 32];
    regs[2] = STACK_TOP;
    let mut mem = initial_mem(&program.data);
    let top = STACK_TOP as u64 + 3;
    let mut pc: u32 = 0;
    let mut retired = 0;
    let outcome = loop {
        if retired >= max_steps {
            break Outcome::StepLimit;
        }
        let Some(ins) = program.instr_at(pc) else {
            break Outcome::Complete;
        };
        let a = regs[ins.rs1 as usize];
        let b = regs[ins.rs2 as usize];
        let imm = ins.imm as u32;
        let mut next = pc.wrapping_add(4);
        let mut rd: Option<u32> = None;
        let ea = a.wrapping_add(imm);
        let mut fault = false;
        match ins.op {
            Op::Lui => rd = Some(imm << 12),
            Op::Auipc => rd = Some(pc.wrapping_add(imm << 12)),
            Op::Jal => {
                rd = Some(next);
                next = pc.wrapping_add(imm);
            }
            Op::Jalr => {
                rd = Some(next);
                next = ea & !1;
            }
            Op::Beq | Op::Bne | Op::Blt | Op::Bge | Op::Bltu | Op::Bgeu => {
                let taken = match ins.op {
                    Op::Beq => a == b,
                    Op::Bne => a != b,
                    Op::Blt => (a as i32) < (b as i32),
                    Op::Bge => (a as i32) >= (b as i32),
                    Op::Bltu => a < b,
                    _ => a >= b,
                };
                if taken {
                    next = pc.wrapping_add(imm);
                }
            }
            Op::Lb | Op::Lh | Op::Lw | Op::Lbu | Op::Lhu => {
                let len = match ins.op {
                    Op::Lb | Op::Lbu => 1,
                    Op::Lh | Op::Lhu => 2,
                    _ => 4,
                };
                if ea % len != 0 || !region_ok(ea as u64, len as u64, top) {
                    fault = true;
                } else {
                    let v = load(&mem, ea as u64, len as u64) as u32;
                    rd = Some(match ins.op {
                        Op::Lb => v as u8 as i8 as i32 as u32,
                        Op::Lh => v as u16 as i16 as i32 as u32,
                        _ => v,
                    });
                }
            }
            Op::Sb | Op::Sh | Op::Sw => {
                let len = match ins.op {
                    Op::Sb => 1,
                    Op::Sh => 2,
                    _ => 4,
                };
                if ea % len != 0 || !region_ok(ea as u64, len as u64, top) {
                    fault = true;
                } else {
                    store(&mut mem, ea as u64, len as u64, b as u64);
                }
            }
            Op::Addi => rd = Some(ea),
            Op::Slti => rd = Some(((a as i32) < (imm as i32)) as u32),
            Op::Sltiu => rd = Some((a < imm) as u32),
            Op::Xori => rd = Some(a ^ imm),
            Op::Ori => rd = Some(a | imm),
            Op::Andi => rd = Some(a & imm),
            Op::Slli => rd = Some(a << (imm & 31)),
            Op::Srli => rd = Some(a >> (imm & 31)),
            Op::Srai => rd = Some(((a as i32) >> (imm & 31)) as u32),
            Op::Add => rd = Some(a.wrapping_add(b)),
            Op::Sub => rd = Some(a.wrapping_sub(b)),
            Op::Sll => rd = Some(a << (b & 31)),
            Op::Slt => rd = Some(((a as i32) < (b as i32)) as u32),
            Op::Sltu => rd = Some((a < b) as u32),
            Op::Xor => rd = Some(a ^ b),
            Op::Srl => rd = Some(a >> (b & 31)),
            Op::Sra => rd = Some(((a as i32) >> (b & 31)) as u32),
            Op::Or => rd = Some(a | b),
            Op::And => rd = Some(a & b),
            Op::Mul => rd = Some(a.wrapping_mul(b)),
            Op::Mulh => rd = Some(((a as i32 as i64 * b as i32 as i64) >> 32) as u32),
            Op::Mulhsu => rd = Some(((a as i32 as i64 * b as i64) >> 32) as u32),
            Op::Mulhu => rd = Some(((a as u64 * b as u64) >> 32) as u32),
            Op::Div => rd = Some(if b == 0 { u32::MAX } else { (a as i32).wrapping_div(b as i32) as u32 }),
            Op::Divu => rd = Some(if b == 0 { u32::MAX } else { a / b }),
            Op::Rem => rd = Some(if b == 0 { a } else { (a as i32).wrapping_rem(b as i32) as u32 }),
            Op::Remu => rd = Some(if b == 0 { a } else { a % b }),
            Op::Ecall | Op::Ebreak => {
                retired += 1;
                pc = next;
                break Outcome::Complete;
            }
            Op::Fence => {}
        }
        if fault {
            break Outcome::Error;
        }
        if let Some(v) = rd {
            if ins.rd != 0 {
                regs[ins.rd as usize] = v;
            }
        }
        retired += 1;
        if next % 4 != 0 {
            pc = next;
            break Outcome::Error;
        }
        pc = next;
    };
    State { regs, mem, pc: pc as u64, outcome, retired }
}

pub fn run64(program: &Program64, max_steps: u64) -> State<u64> {
    let mut regs = [0u64; 32];
    regs[2] = sim_engine::pipeline64::STACK_TOP64;
    let mut mem = initial_mem(&program.data);
    let top = sim_engine::pipeline64::STACK_TOP64 + 7;
    let sext32 = |v: u64| v as u32 as i32 as i64 as u64;
    let mut pc: u64 = 0;
    let mut retired = 0;
    let outcome = loop {
        if retired >= max_steps {
            break Outcome::StepLimit;
        }
        let Some(ins) = program.instr_at(pc) else {
            break Outcome::Complete;
        };
        let a = regs[ins.rs1 as usize];
        let b = regs[ins.rs2 as usize];
        let imm = ins.imm as u64;
        let ea = a.wrapping_add(imm);
        let sh = (b & 63) as u32;
        let mut next = pc.wrapping_add(4);
        let mut rd: Option<u64> = None;
        let mut fault = false;
        match ins.op {
            Op64::Lui => rd = Some(sext32(imm << 12)),
            Op64::Auipc => rd = Some(pc.wrapping_add(sext32(imm << 12))),
            Op64::Jal => {
                rd = Some(next);
                next = pc.wrapping_add(imm);
            }
            Op64::Jalr => {
                rd = Some(next);
                next = ea & !1;
            }
            Op64::Beq | Op64::Bne | Op64::Blt | Op64::Bge | Op64::Bltu | Op64::Bgeu => {
                let taken = match ins.op {
                    Op64::Beq => a == b,
                    Op64::Bne => a != b,
                    Op64::Blt => (a as i64) < (b as i64),
                    Op64::Bge => (a as i64) >= (b as i64),
                    Op64::Bltu => a < b,
                    _ => a >= b,
                };
                if taken {
                    next = pc.wrapping_add(imm);
                }
            }
            Op64::Lb | Op64::Lh | Op64::Lw | Op64::Ld | Op64::Lbu | Op64::Lhu | Op64::Lwu => {
                let len = match ins.op {
                    Op64::Lb | Op64::Lbu => 1,
                    Op64::Lh | Op64::Lhu => 2,
                    Op64::Lw | Op64::Lwu => 4,
                    _ => 8,
                };
                if ea % len != 0 || !region_ok(ea, len, top) {
                    fault = true;
                } else {
                    let v = load(&mem, ea, len);
                    rd = Some(match ins.op {
                        Op64::Lb => v as u8 as i8 as i64 as u64,
                        Op64::Lh => v as u16 as i16 as i64 as u64,
                        Op64::Lw => sext32(v),
                        _ => v,
                    });
                }
            }
            Op64::Sb | Op64::Sh | Op64::Sw | Op64::Sd => {
                let len = match ins.op {
                    Op64::Sb => 1,
                    Op64::Sh => 2,
                    Op64::Sw => 4,
                    _ => 8,
                };
                if ea % len != 0 || !region_ok(ea, len, top) {
                    fault = true;
                } else {
                    store(&mut mem, ea, len, b);
                }
            }
            Op64::Addi => rd = Some(ea),
            Op64::Addiw => rd = Some(sext32(ea)),
            Op64::Slti => rd = Some(((a as i64) < (imm as i64)) as u64),
            Op64::Sltiu => rd = Some((a < imm) as u64),
            Op64::Xori => rd = Some(a ^ imm),
            Op64::Ori => rd = Some(a | imm),
            Op64::Andi => rd = Some(a & imm),
            Op64::Slli => rd = Some(a << (imm & 63)),
            Op64::Srli => rd = Some(a >> (imm & 63)),
            Op64::Srai => rd = Some(((a as i64) >> (imm & 63)) as u64),
            Op64::Slliw => rd = Some(sext32(((a as u32) << (imm as u32 & 31)) as u64)),
            Op64::Srliw => rd = Some(sext32(((a as u32) >> (imm as u32 & 31)) as u64)),
            Op64::Sraiw => rd = Some(((a as u32 as i32) >> (imm as u32 & 31)) as i64 as u64),
            Op64::Add => rd = Some(a.wrapping_add(b)),
            Op64::Sub => rd = Some(a.wrapping_sub(b)),
            Op64::Addw => rd = Some(sext32(a.wrapping_add(b))),
            Op64::Subw => rd = Some(sext32(a.wrapping_sub(b))),
            Op64::Sll => rd = Some(a << sh),
            Op64::Srl => rd = Some(a >> sh),
            Op64::Sra => rd = Some(((a as i64) >> sh) as u64),
            Op64::Sllw => rd = Some(sext32(((a as u32) << (b as u32 & 31)) as u64)),
            Op64::Srlw => rd = Some(sext32(((a as u32) >> (b as u32 & 31)) as u64)),
            Op64::Sraw => rd = Some(((a as u32 as i32) >> (b as u32 & 31)) as i64 as u64),
            Op64::Slt => rd = Some(((a as i64) < (b as i64)) as u64),
            Op64::Sltu => rd = Some((a < b) as u64),
            Op64::Xor => rd = Some(a ^ b),
            Op64::Or => rd = Some(a | b),
            Op64::And => rd = Some(a & b),
            Op64::Mul => rd = Some(a.wrapping_mul(b)),
            Op64::Mulh => rd = Some(((a as i64 as i128 * b as i64 as i128) >> 64) as u64),
            Op64::Mulhsu => rd = Some(((a as i64 as i128 * b as i128) >> 64) as u64),
            Op64::Mulhu => rd = Some(((a as u128 * b as u128) >> 64) as u64),
            Op64::Div => rd = Some(if b == 0 { u64::MAX } else { (a as i64).wrapping_div(b as i64) as u64 }),
            Op64::Divu => rd = Some(if b == 0 { u64::MAX } else { a / b }),
            Op64::Rem => rd = Some(if b == 0 { a } else { (a as i64).wrapping_rem(b as i64) as u64 }),
            Op64::Remu => rd = Some(if b == 0 { a } else { a % b }),
            Op64::Mulw => rd = Some(sext32((a as u32).wrapping_mul(b as u32) as u64)),
            Op64::Divw => {
                let (x, y) = (a as i32, b as i32);
                rd = Some(if y == 0 { u64::MAX } else { x.wrapping_div(y) as i64 as u64 })
            }
            Op64::Divuw => {
                let (x, y) = (a as u32, b as u32);
                rd = Some(if y == 0 { u64::MAX } else { sext32((x / y) as u64) })
            }
            Op64::Remw => {
                let (x, y) = (a as i32, b as i32);
                rd = Some(if y == 0 { x as i64 as u64 } else { x.wrapping_rem(y) as i64 as u64 })
            }
            Op64::Remuw => {
                let (x, y) = (a as u32, b as u32);
                rd = Some(sext32(if y == 0 { x } else { x % y } as u64))
            }
            Op64::Ecall | Op64::Ebreak => {
                retired += 1;
                pc = next;
                break Outcome::Complete;
            }
            Op64::Fence => {}
        }
        if fault {
            break Outcome::Error;
        }
        if let Some(v) = rd {
            if ins.rd != 0 {
                regs[ins.rd as usize] = v;
            }
        }
        retired += 1;
        if next % 4 != 0 {
            pc = next;
            break Outcome::Error;
        }
        pc = next;
    };
    State { regs, mem, pc, outcome, retired }
}

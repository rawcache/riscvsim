use serde::Serialize;
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

const TEXT_BASE: u32 = 0x0000_0000;
const TEXT_END: u32 = 0x0fff_ffff;
const DATA_BASE: u32 = 0x1000_0000;
const DATA_END: u32 = 0x1fff_ffff;
const STACK_BASE: u32 = 0x7f00_0000;
const STACK_END: u32 = 0x7fff_ffff;
const STACK_POINTER_INIT: u32 = 0x7fff_fffc;

#[derive(Debug, Clone, Serialize)]
struct StepDelta {
    pc: u32,
    halted: bool,
    trap: Option<StepTrap>,
    effects: Vec<StepEffect>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum StepEffect {
    Reg { reg: u8, before: u32, after: u32 },
    Mem { addr: u32, before: u8, after: u8 },
    Pc { before: u32, after: u32 },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct StepTrap {
    cause: String,
    tval: Option<u32>,
    mode: String,
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TrapInfo {
    cause: &'static str,
    tval: Option<u32>,
    mode: &'static str,
    message: String,
}

impl TrapInfo {
    fn machine(cause: &'static str, tval: Option<u32>, message: impl Into<String>) -> Self {
        Self {
            cause,
            tval,
            mode: "machine",
            message: message.into(),
        }
    }

    fn simulator(cause: &'static str, message: impl Into<String>) -> Self {
        Self {
            cause,
            tval: None,
            mode: "simulator",
            message: message.into(),
        }
    }

    fn illegal_instruction(instruction: u32, message: impl Into<String>) -> Self {
        Self::machine("illegal_instruction", Some(instruction), message)
    }

    fn into_step_trap(self) -> StepTrap {
        StepTrap {
            cause: self.cause.to_string(),
            tval: self.tval,
            mode: self.mode.to_string(),
            message: self.message,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AccessKind {
    Instruction,
    Load,
    Store,
}

impl AccessKind {
    fn misaligned_cause(self) -> &'static str {
        match self {
            Self::Instruction => "instruction_address_misaligned",
            Self::Load => "load_address_misaligned",
            Self::Store => "store_address_misaligned",
        }
    }

    fn access_fault_cause(self) -> &'static str {
        match self {
            Self::Instruction => "instruction_access_fault",
            Self::Load => "load_access_fault",
            Self::Store => "store_access_fault",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Instruction => "Instruction fetch",
            Self::Load => "Load",
            Self::Store => "Store",
        }
    }
}

impl StepDelta {
    fn ok(pc: u32, halted: bool, effects: Vec<StepEffect>) -> Self {
        Self {
            pc,
            halted,
            trap: None,
            effects,
        }
    }

    fn trap(pc: u32, effects: Vec<StepEffect>, trap: TrapInfo) -> Self {
        Self {
            pc,
            halted: true,
            trap: Some(trap.into_step_trap()),
            effects,
        }
    }
}

#[wasm_bindgen]
pub struct Simulator {
    registers: [u32; 32],
    pc: u32,
    memory: BTreeMap<u32, u8>,
    halted: bool,
}

#[wasm_bindgen]
impl Simulator {
    #[wasm_bindgen(constructor)]
    pub fn new(_memory_size: usize) -> Self {
        let mut sim = Self {
            registers: [0; 32],
            pc: TEXT_BASE,
            memory: BTreeMap::new(),
            halted: false,
        };
        sim.reset();
        sim
    }

    pub fn reset(&mut self) {
        self.registers = [0; 32];
        self.registers[2] = STACK_POINTER_INIT;
        self.pc = TEXT_BASE;
        self.halted = false;
    }

    pub fn load_program(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        self.load_program_internal(bytes)
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn load_data(&mut self, bytes: &[u8], base: u32) -> Result<(), JsValue> {
        self.load_segment(bytes, base)
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn step(&mut self) -> Result<JsValue, JsValue> {
        let delta = self.step_internal();
        serde_wasm_bindgen::to_value(&delta)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize step delta: {e}")))
    }

    pub fn get_registers(&self) -> Box<[u32]> {
        self.registers.to_vec().into_boxed_slice()
    }

    pub fn get_register(&self, index: usize) -> u32 {
        self.registers.get(index).copied().unwrap_or(0)
    }

    pub fn pc(&self) -> u32 {
        self.pc
    }

    pub fn halted(&self) -> bool {
        self.halted
    }

    pub fn read_memory(&self, addr: u32, len: usize) -> Box<[u8]> {
        if len == 0 || !Self::range_is_valid(addr, len) {
            return Vec::new().into_boxed_slice();
        }
        let mut bytes = Vec::with_capacity(len);
        for offset in 0..len {
            bytes.push(self.read_byte_raw(addr + offset as u32));
        }
        bytes.into_boxed_slice()
    }
}

impl Simulator {
    fn load_program_internal(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.memory.clear();
        self.load_segment(bytes, TEXT_BASE)?;
        self.reset();
        Ok(())
    }

    fn load_segment(&mut self, bytes: &[u8], base: u32) -> Result<(), String> {
        if !Self::range_is_valid(base, bytes.len()) {
            let end = base.saturating_add(bytes.len() as u32);
            return Err(format!(
                "Segment load out of bounds: [0x{base:08x}..0x{end:08x})"
            ));
        }
        for (offset, byte) in bytes.iter().copied().enumerate() {
            let addr = base + offset as u32;
            self.write_byte_raw(addr, byte);
        }
        Ok(())
    }

    fn step_internal(&mut self) -> StepDelta {
        if self.halted {
            return StepDelta::trap(
                self.pc,
                Vec::new(),
                TrapInfo::simulator("halted", "Simulator is halted; call reset() to continue."),
            );
        }

        let pc_before = self.pc;
        let mut effects = Vec::new();

        let instruction = match self.read_u32(pc_before, AccessKind::Instruction) {
            Ok(word) => word,
            Err(trap) => {
                self.halted = true;
                effects.push(StepEffect::Pc {
                    before: pc_before,
                    after: self.pc,
                });
                return StepDelta::trap(self.pc, effects, trap);
            }
        };

        match self.execute(instruction, pc_before, &mut effects) {
            Ok(new_pc) => {
                self.pc = new_pc;
                self.registers[0] = 0;
                effects.push(StepEffect::Pc {
                    before: pc_before,
                    after: self.pc,
                });
                StepDelta::ok(self.pc, self.halted, effects)
            }
            Err(trap) => {
                self.halted = true;
                self.registers[0] = 0;
                effects.push(StepEffect::Pc {
                    before: pc_before,
                    after: self.pc,
                });
                StepDelta::trap(self.pc, effects, trap)
            }
        }
    }

    fn execute(
        &mut self,
        instruction: u32,
        pc: u32,
        effects: &mut Vec<StepEffect>,
    ) -> Result<u32, TrapInfo> {
        let opcode = instruction & 0x7f;
        let rd = ((instruction >> 7) & 0x1f) as usize;
        let funct3 = ((instruction >> 12) & 0x07) as u8;
        let rs1 = ((instruction >> 15) & 0x1f) as usize;
        let rs2 = ((instruction >> 20) & 0x1f) as usize;
        let funct7 = ((instruction >> 25) & 0x7f) as u8;

        let mut next_pc = pc.wrapping_add(4);

        match opcode {
            0x33 => {
                let a = self.registers[rs1];
                let b = self.registers[rs2];
                let value = match (funct7, funct3) {
                    (0x00, 0x0) => a.wrapping_add(b),
                    (0x20, 0x0) => a.wrapping_sub(b),
                    (0x00, 0x1) => a.wrapping_shl(b & 0x1f),
                    (0x00, 0x2) => (as_i32(a) < as_i32(b)) as u32,
                    (0x00, 0x3) => (a < b) as u32,
                    (0x00, 0x4) => a ^ b,
                    (0x00, 0x5) => a.wrapping_shr(b & 0x1f),
                    (0x20, 0x5) => (as_i32(a) >> (b & 0x1f)) as u32,
                    (0x00, 0x6) => a | b,
                    (0x00, 0x7) => a & b,
                    (0x01, 0x0) => a.wrapping_mul(b),
                    (0x01, 0x1) => (((as_i32(a) as i64) * (as_i32(b) as i64)) >> 32) as i32 as u32,
                    (0x01, 0x2) => (((as_i32(a) as i128) * (b as i128)) >> 32) as i32 as u32,
                    (0x01, 0x3) => (((a as u64) * (b as u64)) >> 32) as u32,
                    (0x01, 0x4) => {
                        let lhs = as_i32(a);
                        let rhs = as_i32(b);
                        if rhs == 0 {
                            u32::MAX
                        } else if lhs == i32::MIN && rhs == -1 {
                            i32::MIN as u32
                        } else {
                            (lhs / rhs) as u32
                        }
                    }
                    (0x01, 0x5) => {
                        if b == 0 {
                            u32::MAX
                        } else {
                            a / b
                        }
                    }
                    (0x01, 0x6) => {
                        let lhs = as_i32(a);
                        let rhs = as_i32(b);
                        if rhs == 0 {
                            lhs as u32
                        } else if lhs == i32::MIN && rhs == -1 {
                            0
                        } else {
                            (lhs % rhs) as u32
                        }
                    }
                    (0x01, 0x7) => {
                        if b == 0 {
                            a
                        } else {
                            a % b
                        }
                    }
                    _ => {
                        return Err(TrapInfo::illegal_instruction(
                            instruction,
                            format!("Illegal R-type instruction 0x{instruction:08x}"),
                        ))
                    }
                };
                self.write_reg(rd, value, effects);
            }
            0x13 => {
                let imm = imm_i(instruction);
                let a = self.registers[rs1];
                let value = match funct3 {
                    0x0 => a.wrapping_add(imm as u32),
                    0x2 => (as_i32(a) < imm) as u32,
                    0x3 => (a < imm as u32) as u32,
                    0x4 => a ^ (imm as u32),
                    0x6 => a | (imm as u32),
                    0x7 => a & (imm as u32),
                    0x1 => {
                        if funct7 != 0x00 {
                            return Err(TrapInfo::illegal_instruction(
                                instruction,
                                format!("Illegal SLLI encoding 0x{instruction:08x}"),
                            ));
                        }
                        a.wrapping_shl((instruction >> 20) & 0x1f)
                    }
                    0x5 => match funct7 {
                        0x00 => a.wrapping_shr((instruction >> 20) & 0x1f),
                        0x20 => (as_i32(a) >> ((instruction >> 20) & 0x1f)) as u32,
                        _ => {
                            return Err(TrapInfo::illegal_instruction(
                                instruction,
                                format!("Illegal SRLI/SRAI encoding 0x{instruction:08x}"),
                            ))
                        }
                    },
                    _ => {
                        return Err(TrapInfo::illegal_instruction(
                            instruction,
                            format!("Illegal I-type ALU instruction 0x{instruction:08x}"),
                        ))
                    }
                };
                self.write_reg(rd, value, effects);
            }
            0x03 => {
                let imm = imm_i(instruction);
                let addr = self.registers[rs1].wrapping_add(imm as u32);
                let value = match funct3 {
                    0x0 => self.read_u8(addr, AccessKind::Load)? as i8 as i32 as u32,
                    0x1 => self.read_u16(addr, AccessKind::Load)? as i16 as i32 as u32,
                    0x2 => self.read_u32(addr, AccessKind::Load)?,
                    0x4 => self.read_u8(addr, AccessKind::Load)? as u32,
                    0x5 => self.read_u16(addr, AccessKind::Load)? as u32,
                    _ => {
                        return Err(TrapInfo::illegal_instruction(
                            instruction,
                            format!("Illegal load instruction 0x{instruction:08x}"),
                        ))
                    }
                };
                self.write_reg(rd, value, effects);
            }
            0x23 => {
                let imm = imm_s(instruction);
                let addr = self.registers[rs1].wrapping_add(imm as u32);
                let value = self.registers[rs2];
                match funct3 {
                    0x0 => self.write_u8(addr, value as u8, effects)?,
                    0x1 => self.write_u16(addr, value as u16, effects)?,
                    0x2 => self.write_u32(addr, value, effects)?,
                    _ => {
                        return Err(TrapInfo::illegal_instruction(
                            instruction,
                            format!("Illegal store instruction 0x{instruction:08x}"),
                        ))
                    }
                }
            }
            0x63 => {
                let imm = imm_b(instruction);
                let target = pc.wrapping_add(imm as u32);
                let a = self.registers[rs1];
                let b = self.registers[rs2];
                let take = match funct3 {
                    0x0 => a == b,
                    0x1 => a != b,
                    0x4 => as_i32(a) < as_i32(b),
                    0x5 => as_i32(a) >= as_i32(b),
                    0x6 => a < b,
                    0x7 => a >= b,
                    _ => {
                        return Err(TrapInfo::illegal_instruction(
                            instruction,
                            format!("Illegal branch instruction 0x{instruction:08x}"),
                        ))
                    }
                };
                if take {
                    next_pc = target;
                }
            }
            0x37 => {
                let imm = instruction & 0xfffff000;
                self.write_reg(rd, imm, effects);
            }
            0x17 => {
                let imm = instruction & 0xfffff000;
                self.write_reg(rd, pc.wrapping_add(imm), effects);
            }
            0x6f => {
                let imm = imm_j(instruction);
                let target = pc.wrapping_add(imm as u32);
                Self::check_alignment(target, 4, AccessKind::Instruction)?;
                self.write_reg(rd, pc.wrapping_add(4), effects);
                next_pc = target;
            }
            0x67 => {
                if funct3 != 0x0 {
                    return Err(TrapInfo::illegal_instruction(
                        instruction,
                        format!("Illegal JALR instruction 0x{instruction:08x}"),
                    ));
                }
                let imm = imm_i(instruction);
                let target = self.registers[rs1].wrapping_add(imm as u32) & !1u32;
                Self::check_alignment(target, 4, AccessKind::Instruction)?;
                self.write_reg(rd, pc.wrapping_add(4), effects);
                next_pc = target;
            }
            0x73 => match instruction {
                0x0000_0073 => {
                    return Err(TrapInfo::machine("environment_call", None, "ECALL trap"))
                }
                0x0010_0073 => return Err(TrapInfo::machine("breakpoint", None, "EBREAK trap")),
                _ => {
                    return Err(TrapInfo::illegal_instruction(
                        instruction,
                        format!("Illegal SYSTEM instruction 0x{instruction:08x}"),
                    ))
                }
            },
            _ => {
                return Err(TrapInfo::illegal_instruction(
                    instruction,
                    format!("Illegal opcode 0x{opcode:02x} in 0x{instruction:08x}"),
                ))
            }
        }

        if (next_pc & 0x3) != 0 {
            return Err(TrapInfo::machine(
                "instruction_address_misaligned",
                Some(next_pc),
                format!("Instruction-address misaligned: 0x{next_pc:08x}"),
            ));
        }

        Ok(next_pc)
    }

    fn write_reg(&mut self, reg: usize, value: u32, effects: &mut Vec<StepEffect>) {
        if reg == 0 {
            return;
        }
        let before = self.registers[reg];
        if before != value {
            self.registers[reg] = value;
            effects.push(StepEffect::Reg {
                reg: reg as u8,
                before,
                after: value,
            });
        }
    }

    fn check_alignment(addr: u32, align: u32, access: AccessKind) -> Result<(), TrapInfo> {
        if (addr & (align - 1)) != 0 {
            return Err(TrapInfo::machine(
                access.misaligned_cause(),
                Some(addr),
                format!(
                    "{} misaligned at 0x{addr:08x}; required alignment {align}",
                    access.label()
                ),
            ));
        }
        Ok(())
    }

    fn range_end(addr: u32, size: usize, access: AccessKind) -> Result<u32, TrapInfo> {
        addr.checked_add(size as u32).ok_or_else(|| {
            TrapInfo::machine(
                access.access_fault_cause(),
                Some(addr),
                format!("{} address overflow at 0x{addr:08x}", access.label()),
            )
        })
    }

    fn range_is_valid(addr: u32, size: usize) -> bool {
        if size == 0 {
            return true;
        }
        let end_inclusive = match addr.checked_add(size as u32 - 1) {
            Some(value) => value,
            None => return false,
        };
        (addr >= TEXT_BASE && end_inclusive <= TEXT_END)
            || (addr >= DATA_BASE && end_inclusive <= DATA_END)
            || (addr >= STACK_BASE && end_inclusive <= STACK_END)
    }

    fn checked_range(&self, addr: u32, size: usize, access: AccessKind) -> Result<(), TrapInfo> {
        let end = Self::range_end(addr, size, access)?;
        if !Self::range_is_valid(addr, size) {
            return Err(TrapInfo::machine(
                access.access_fault_cause(),
                Some(addr),
                format!(
                    "{} out of bounds: [0x{addr:08x}..0x{end:08x})",
                    access.label()
                ),
            ));
        }
        Ok(())
    }

    fn read_byte_raw(&self, addr: u32) -> u8 {
        self.memory.get(&addr).copied().unwrap_or(0)
    }

    fn write_byte_raw(&mut self, addr: u32, value: u8) {
        if value == 0 {
            self.memory.remove(&addr);
        } else {
            self.memory.insert(addr, value);
        }
    }

    fn read_u8(&self, addr: u32, access: AccessKind) -> Result<u8, TrapInfo> {
        self.checked_range(addr, 1, access)?;
        Ok(self.read_byte_raw(addr))
    }

    fn read_u16(&self, addr: u32, access: AccessKind) -> Result<u16, TrapInfo> {
        Self::check_alignment(addr, 2, access)?;
        self.checked_range(addr, 2, access)?;
        Ok(u16::from_le_bytes([
            self.read_byte_raw(addr),
            self.read_byte_raw(addr + 1),
        ]))
    }

    fn read_u32(&self, addr: u32, access: AccessKind) -> Result<u32, TrapInfo> {
        Self::check_alignment(addr, 4, access)?;
        self.checked_range(addr, 4, access)?;
        Ok(u32::from_le_bytes([
            self.read_byte_raw(addr),
            self.read_byte_raw(addr + 1),
            self.read_byte_raw(addr + 2),
            self.read_byte_raw(addr + 3),
        ]))
    }

    fn write_u8(
        &mut self,
        addr: u32,
        value: u8,
        effects: &mut Vec<StepEffect>,
    ) -> Result<(), TrapInfo> {
        self.checked_range(addr, 1, AccessKind::Store)?;
        self.write_bytes_at(addr, &[value], effects);
        Ok(())
    }

    fn write_u16(
        &mut self,
        addr: u32,
        value: u16,
        effects: &mut Vec<StepEffect>,
    ) -> Result<(), TrapInfo> {
        Self::check_alignment(addr, 2, AccessKind::Store)?;
        self.checked_range(addr, 2, AccessKind::Store)?;
        self.write_bytes_at(addr, &value.to_le_bytes(), effects);
        Ok(())
    }

    fn write_u32(
        &mut self,
        addr: u32,
        value: u32,
        effects: &mut Vec<StepEffect>,
    ) -> Result<(), TrapInfo> {
        Self::check_alignment(addr, 4, AccessKind::Store)?;
        self.checked_range(addr, 4, AccessKind::Store)?;
        self.write_bytes_at(addr, &value.to_le_bytes(), effects);
        Ok(())
    }

    fn write_bytes_at(&mut self, addr: u32, bytes: &[u8], effects: &mut Vec<StepEffect>) {
        for (offset, after) in bytes.iter().copied().enumerate() {
            let byte_addr = addr + offset as u32;
            let before = self.read_byte_raw(byte_addr);
            if before == after {
                continue;
            }
            self.write_byte_raw(byte_addr, after);
            effects.push(StepEffect::Mem {
                addr: byte_addr,
                before,
                after,
            });
        }
    }
}

fn as_i32(v: u32) -> i32 {
    v as i32
}

fn sign_extend(value: u32, bits: u8) -> i32 {
    let shift = 32 - bits as u32;
    ((value << shift) as i32) >> shift
}

fn imm_i(instruction: u32) -> i32 {
    sign_extend(instruction >> 20, 12)
}

fn imm_s(instruction: u32) -> i32 {
    let imm = ((instruction >> 25) << 5) | ((instruction >> 7) & 0x1f);
    sign_extend(imm, 12)
}

fn imm_b(instruction: u32) -> i32 {
    let bit12 = ((instruction >> 31) & 0x1) << 12;
    let bit11 = ((instruction >> 7) & 0x1) << 11;
    let bits10_5 = ((instruction >> 25) & 0x3f) << 5;
    let bits4_1 = ((instruction >> 8) & 0x0f) << 1;
    sign_extend(bit12 | bit11 | bits10_5 | bits4_1, 13)
}

fn imm_j(instruction: u32) -> i32 {
    let bit20 = ((instruction >> 31) & 0x1) << 20;
    let bits19_12 = ((instruction >> 12) & 0xff) << 12;
    let bit11 = ((instruction >> 20) & 0x1) << 11;
    let bits10_1 = ((instruction >> 21) & 0x03ff) << 1;
    sign_extend(bit20 | bits19_12 | bit11 | bits10_1, 21)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_i(imm: i32, rs1: u32, funct3: u32, rd: u32, opcode: u32) -> u32 {
        (((imm as u32) & 0x0fff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode
    }

    fn encode_s(imm: i32, rs2: u32, rs1: u32, funct3: u32, opcode: u32) -> u32 {
        let imm12 = (imm as u32) & 0x0fff;
        ((imm12 >> 5) << 25)
            | (rs2 << 20)
            | (rs1 << 15)
            | (funct3 << 12)
            | ((imm12 & 0x1f) << 7)
            | opcode
    }

    fn write_word(mem: &mut [u8], byte_offset: usize, instruction: u32) {
        let bytes = instruction.to_le_bytes();
        mem[byte_offset] = bytes[0];
        mem[byte_offset + 1] = bytes[1];
        mem[byte_offset + 2] = bytes[2];
        mem[byte_offset + 3] = bytes[3];
    }

    #[test]
    fn addi_and_sw_lw_round_trip() {
        let mut sim = Simulator::new(1024);
        let mut program = vec![0u8; 20];

        let addi_x1_base = encode_i(64, 0, 0x0, 1, 0x13);
        let addi_x2_val = encode_i(123, 0, 0x0, 2, 0x13);
        let sw_x2_0_x1 = encode_s(0, 2, 1, 0x2, 0x23);
        let lw_x3_0_x1 = encode_i(0, 1, 0x2, 3, 0x03);
        let addi_x4_x3_1 = encode_i(1, 3, 0x0, 4, 0x13);

        write_word(&mut program, 0, addi_x1_base);
        write_word(&mut program, 4, addi_x2_val);
        write_word(&mut program, 8, sw_x2_0_x1);
        write_word(&mut program, 12, lw_x3_0_x1);
        write_word(&mut program, 16, addi_x4_x3_1);

        sim.load_program_internal(&program)
            .expect("program load should work");

        for _ in 0..5 {
            let step = sim.step_internal();
            assert!(step.trap.is_none(), "unexpected trap: {:?}", step.trap);
        }

        assert_eq!(sim.get_register(3), 123);
        assert_eq!(sim.get_register(4), 124);
        assert_eq!(
            sim.read_u32(64, AccessKind::Load)
                .expect("word should be readable"),
            123
        );
    }

    #[test]
    fn instruction_fetch_is_little_endian() {
        let mut sim = Simulator::new(256);
        let mut program = vec![0u8; 4];
        write_word(&mut program, 0, 0x00a0_0093);
        sim.load_program_internal(&program)
            .expect("program load should work");
        let step = sim.step_internal();
        assert!(step.trap.is_none(), "unexpected trap: {:?}", step.trap);
        assert_eq!(
            step.effects,
            vec![
                StepEffect::Reg {
                    reg: 1,
                    before: 0,
                    after: 10
                },
                StepEffect::Pc {
                    before: 0,
                    after: 4
                }
            ]
        );
        assert_eq!(sim.get_register(1), 10);
    }

    #[test]
    fn store_word_emits_byte_level_memory_effects() {
        let mut sim = Simulator::new(256);
        let mut program = vec![0u8; 4];
        let sw_x2_0_x1 = encode_s(0, 2, 1, 0x2, 0x23);
        write_word(&mut program, 0, sw_x2_0_x1);
        sim.load_program_internal(&program)
            .expect("program load should work");
        sim.registers[1] = 64;
        sim.registers[2] = 0x1234_5678;

        let step = sim.step_internal();

        assert!(step.trap.is_none(), "unexpected trap: {:?}", step.trap);
        assert_eq!(
            step.effects,
            vec![
                StepEffect::Mem {
                    addr: 64,
                    before: 0,
                    after: 0x78
                },
                StepEffect::Mem {
                    addr: 65,
                    before: 0,
                    after: 0x56
                },
                StepEffect::Mem {
                    addr: 66,
                    before: 0,
                    after: 0x34
                },
                StepEffect::Mem {
                    addr: 67,
                    before: 0,
                    after: 0x12
                },
                StepEffect::Pc {
                    before: 0,
                    after: 4
                }
            ]
        );
    }

    #[test]
    fn misaligned_load_reports_structured_trap() {
        let mut sim = Simulator::new(256);
        let mut program = vec![0u8; 4];
        let lw_x1_2_x0 = encode_i(2, 0, 0x2, 1, 0x03);
        write_word(&mut program, 0, lw_x1_2_x0);
        sim.load_program_internal(&program)
            .expect("program load should work");

        let step = sim.step_internal();

        assert_eq!(
            step.trap,
            Some(StepTrap {
                cause: "load_address_misaligned".to_string(),
                tval: Some(2),
                mode: "machine".to_string(),
                message: "Load misaligned at 0x00000002; required alignment 4".to_string(),
            })
        );
        assert_eq!(
            step.effects,
            vec![StepEffect::Pc {
                before: 0,
                after: 0
            }]
        );
    }

    #[test]
    fn jalr_alignment_trap_does_not_commit_link_register() {
        let mut sim = Simulator::new(256);
        let mut program = vec![0u8; 4];
        let jalr_x1_2_x2 = encode_i(2, 2, 0x0, 1, 0x67);
        write_word(&mut program, 0, jalr_x1_2_x2);
        sim.load_program_internal(&program)
            .expect("program load should work");
        sim.registers[2] = 0;

        let step = sim.step_internal();

        assert_eq!(
            step.trap,
            Some(StepTrap {
                cause: "instruction_address_misaligned".to_string(),
                tval: Some(2),
                mode: "machine".to_string(),
                message: "Instruction fetch misaligned at 0x00000002; required alignment 4"
                    .to_string(),
            })
        );
        assert_eq!(sim.get_register(1), 0);
        assert_eq!(
            step.effects,
            vec![StepEffect::Pc {
                before: 0,
                after: 0
            }]
        );
    }

    #[test]
    fn reset_initializes_stack_pointer() {
        let mut sim = Simulator::new(256);
        sim.registers[2] = 0;
        sim.reset();
        assert_eq!(sim.get_register(2), STACK_POINTER_INIT);
    }
}

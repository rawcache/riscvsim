use serde::Serialize;
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Serialize)]
struct StepDelta {
    instruction_hex: String,
    new_pc: u32,
    changed_registers: BTreeMap<String, u32>,
    halted: bool,
    trap: Option<String>,
}

impl StepDelta {
    fn ok(instruction: u32, new_pc: u32, changed_registers: BTreeMap<String, u32>, halted: bool) -> Self {
        Self {
            instruction_hex: format!("0x{instruction:08x}"),
            new_pc,
            changed_registers,
            halted,
            trap: None,
        }
    }

    fn trap(instruction: u32, new_pc: u32, changed_registers: BTreeMap<String, u32>, trap: String) -> Self {
        Self {
            instruction_hex: format!("0x{instruction:08x}"),
            new_pc,
            changed_registers,
            halted: true,
            trap: Some(trap),
        }
    }
}

#[wasm_bindgen]
pub struct Simulator {
    registers: [u32; 32],
    pc: u32,
    memory: Vec<u8>,
    halted: bool,
}

#[wasm_bindgen]
impl Simulator {
    #[wasm_bindgen(constructor)]
    pub fn new(memory_size: usize) -> Self {
        let mut sim = Self {
            registers: [0; 32],
            pc: 0,
            memory: vec![0; memory_size.max(4096)],
            halted: false,
        };
        sim.reset();
        sim
    }

    pub fn reset(&mut self) {
        self.registers = [0; 32];
        self.pc = 0;
        self.halted = false;
    }

    pub fn load_program(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        self.load_program_internal(bytes).map_err(|e| JsValue::from_str(&e))
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

    pub fn memory_ptr(&self) -> *const u8 {
        self.memory.as_ptr()
    }

    pub fn memory_len(&self) -> usize {
        self.memory.len()
    }

    pub fn registers_ptr(&self) -> *const u32 {
        self.registers.as_ptr()
    }

    pub fn registers_len(&self) -> usize {
        self.registers.len()
    }
}

impl Simulator {
    fn load_program_internal(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > self.memory.len() {
            return Err(format!(
                "Program is too large: {} bytes > {} bytes of memory",
                bytes.len(),
                self.memory.len()
            ));
        }
        self.memory.fill(0);
        self.memory[..bytes.len()].copy_from_slice(bytes);
        self.reset();
        Ok(())
    }

    fn step_internal(&mut self) -> StepDelta {
        if self.halted {
            return StepDelta::trap(
                0,
                self.pc,
                BTreeMap::new(),
                "Simulator is halted; call reset() to continue.".to_string(),
            );
        }

        let pc_before = self.pc;
        let mut changed_registers = BTreeMap::new();

        let instruction = match self.read_u32(pc_before) {
            Ok(word) => word,
            Err(err) => {
                self.halted = true;
                return StepDelta::trap(0, self.pc, changed_registers, err);
            }
        };

        match self.execute(instruction, pc_before, &mut changed_registers) {
            Ok(new_pc) => {
                self.pc = new_pc;
                self.registers[0] = 0;
                StepDelta::ok(instruction, self.pc, changed_registers, self.halted)
            }
            Err(err) => {
                self.halted = true;
                self.registers[0] = 0;
                StepDelta::trap(instruction, self.pc, changed_registers, err)
            }
        }
    }

    fn execute(
        &mut self,
        instruction: u32,
        pc: u32,
        changed_registers: &mut BTreeMap<String, u32>,
    ) -> Result<u32, String> {
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
                    _ => return Err(format!("Illegal R-type instruction 0x{instruction:08x}")),
                };
                self.write_reg(rd, value, changed_registers);
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
                            return Err(format!("Illegal SLLI encoding 0x{instruction:08x}"));
                        }
                        a.wrapping_shl((instruction >> 20) & 0x1f)
                    }
                    0x5 => match funct7 {
                        0x00 => a.wrapping_shr((instruction >> 20) & 0x1f),
                        0x20 => (as_i32(a) >> ((instruction >> 20) & 0x1f)) as u32,
                        _ => return Err(format!("Illegal SRLI/SRAI encoding 0x{instruction:08x}")),
                    },
                    _ => return Err(format!("Illegal I-type ALU instruction 0x{instruction:08x}")),
                };
                self.write_reg(rd, value, changed_registers);
            }
            0x03 => {
                let imm = imm_i(instruction);
                let addr = self.registers[rs1].wrapping_add(imm as u32);
                let value = match funct3 {
                    0x0 => self.read_u8(addr)? as i8 as i32 as u32,
                    0x1 => self.read_u16(addr)? as i16 as i32 as u32,
                    0x2 => self.read_u32(addr)?,
                    0x4 => self.read_u8(addr)? as u32,
                    0x5 => self.read_u16(addr)? as u32,
                    _ => return Err(format!("Illegal load instruction 0x{instruction:08x}")),
                };
                self.write_reg(rd, value, changed_registers);
            }
            0x23 => {
                let imm = imm_s(instruction);
                let addr = self.registers[rs1].wrapping_add(imm as u32);
                let value = self.registers[rs2];
                match funct3 {
                    0x0 => self.write_u8(addr, value as u8)?,
                    0x1 => self.write_u16(addr, value as u16)?,
                    0x2 => self.write_u32(addr, value)?,
                    _ => return Err(format!("Illegal store instruction 0x{instruction:08x}")),
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
                    _ => return Err(format!("Illegal branch instruction 0x{instruction:08x}")),
                };
                if take {
                    next_pc = target;
                }
            }
            0x37 => {
                let imm = instruction & 0xfffff000;
                self.write_reg(rd, imm, changed_registers);
            }
            0x17 => {
                let imm = instruction & 0xfffff000;
                self.write_reg(rd, pc.wrapping_add(imm), changed_registers);
            }
            0x6f => {
                let imm = imm_j(instruction);
                let target = pc.wrapping_add(imm as u32);
                self.write_reg(rd, pc.wrapping_add(4), changed_registers);
                next_pc = target;
            }
            0x67 => {
                if funct3 != 0x0 {
                    return Err(format!("Illegal JALR instruction 0x{instruction:08x}"));
                }
                let imm = imm_i(instruction);
                let target = self.registers[rs1].wrapping_add(imm as u32) & !1u32;
                self.write_reg(rd, pc.wrapping_add(4), changed_registers);
                next_pc = target;
            }
            0x73 => match instruction {
                0x0000_0073 => return Err("ECALL trap".to_string()),
                0x0010_0073 => return Err("EBREAK trap".to_string()),
                _ => return Err(format!("Illegal SYSTEM instruction 0x{instruction:08x}")),
            },
            _ => return Err(format!("Illegal opcode 0x{opcode:02x} in 0x{instruction:08x}")),
        }

        if (next_pc & 0x3) != 0 {
            return Err(format!("Instruction-address misaligned: 0x{next_pc:08x}"));
        }

        Ok(next_pc)
    }

    fn write_reg(&mut self, reg: usize, value: u32, changed_registers: &mut BTreeMap<String, u32>) {
        if reg == 0 {
            return;
        }
        if self.registers[reg] != value {
            self.registers[reg] = value;
            changed_registers.insert(reg.to_string(), value);
        }
    }

    fn checked_index(&self, addr: u32, size: usize) -> Result<usize, String> {
        let start = addr as usize;
        let end = start
            .checked_add(size)
            .ok_or_else(|| format!("Memory access overflow at 0x{addr:08x}"))?;
        if end > self.memory.len() {
            return Err(format!(
                "Memory access out of bounds: [0x{addr:08x}..0x{:08x}) with memory size {}",
                end as u32,
                self.memory.len()
            ));
        }
        Ok(start)
    }

    fn check_alignment(addr: u32, align: u32) -> Result<(), String> {
        if (addr & (align - 1)) != 0 {
            return Err(format!(
                "Misaligned access at 0x{addr:08x}; required alignment {align}"
            ));
        }
        Ok(())
    }

    fn read_u8(&self, addr: u32) -> Result<u8, String> {
        let i = self.checked_index(addr, 1)?;
        Ok(self.memory[i])
    }

    fn read_u16(&self, addr: u32) -> Result<u16, String> {
        Self::check_alignment(addr, 2)?;
        let i = self.checked_index(addr, 2)?;
        Ok(u16::from_le_bytes([self.memory[i], self.memory[i + 1]]))
    }

    fn read_u32(&self, addr: u32) -> Result<u32, String> {
        Self::check_alignment(addr, 4)?;
        let i = self.checked_index(addr, 4)?;
        Ok(u32::from_le_bytes([
            self.memory[i],
            self.memory[i + 1],
            self.memory[i + 2],
            self.memory[i + 3],
        ]))
    }

    fn write_u8(&mut self, addr: u32, value: u8) -> Result<(), String> {
        let i = self.checked_index(addr, 1)?;
        self.memory[i] = value;
        Ok(())
    }

    fn write_u16(&mut self, addr: u32, value: u16) -> Result<(), String> {
        Self::check_alignment(addr, 2)?;
        let i = self.checked_index(addr, 2)?;
        let bytes = value.to_le_bytes();
        self.memory[i] = bytes[0];
        self.memory[i + 1] = bytes[1];
        Ok(())
    }

    fn write_u32(&mut self, addr: u32, value: u32) -> Result<(), String> {
        Self::check_alignment(addr, 4)?;
        let i = self.checked_index(addr, 4)?;
        let bytes = value.to_le_bytes();
        self.memory[i] = bytes[0];
        self.memory[i + 1] = bytes[1];
        self.memory[i + 2] = bytes[2];
        self.memory[i + 3] = bytes[3];
        Ok(())
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

        sim.load_program_internal(&program).expect("program load should work");

        for _ in 0..5 {
            let step = sim.step_internal();
            assert!(step.trap.is_none(), "unexpected trap: {:?}", step.trap);
        }

        assert_eq!(sim.get_register(3), 123);
        assert_eq!(sim.get_register(4), 124);
        assert_eq!(sim.read_u32(64).expect("word should be readable"), 123);
    }

    #[test]
    fn instruction_fetch_is_little_endian() {
        let mut sim = Simulator::new(256);
        let mut program = vec![0u8; 4];
        write_word(&mut program, 0, 0x00a0_0093); // addi x1, x0, 10
        sim.load_program_internal(&program).expect("program load should work");
        let step = sim.step_internal();
        assert!(step.trap.is_none(), "unexpected trap: {:?}", step.trap);
        assert_eq!(step.instruction_hex, "0x00a00093");
        assert_eq!(sim.get_register(1), 10);
    }
}

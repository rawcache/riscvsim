use sim_engine::{assemble64, Pipeline64, DATA_BASE};

fn run(source: &str) -> Pipeline64 {
    let program = assemble64(source).expect("RV64 program should assemble");
    let mut pipeline = Pipeline64::new(program);
    assert!(pipeline.run(100_000), "RV64 program should complete");
    let halt = pipeline.snapshot().halt.expect("halt status");
    assert_eq!(halt.kind, "complete", "{}", halt.message);
    pipeline
}

#[test]
fn executes_values_beyond_rv32_register_width() {
    let pipeline = run("li x1, 0x123456789abcdef0\n\
         li x2, 0x100000000\n\
         add x3, x1, x2\n\
         sub x4, x3, x1\n\
         ecall\n");
    let registers = pipeline.registers();
    assert_eq!(registers[1], 0x1234_5678_9abc_def0);
    assert_eq!(registers[3], 0x1234_5679_9abc_def0);
    assert_eq!(registers[4], 0x1_0000_0000);
}

#[test]
fn stores_and_loads_all_eight_bytes() {
    let pipeline = run(".data\nslot: .space 8\n.text\n\
         la x1, slot\n\
         li x2, 0xfedcba9876543210\n\
         sd x2, 0(x1)\n\
         ld x3, 0(x1)\n\
         ecall\n");
    assert_eq!(pipeline.registers()[3], 0xfedc_ba98_7654_3210);
    assert_eq!(
        pipeline.read_memory(DATA_BASE as u64, 8),
        0xfedc_ba98_7654_3210u64.to_le_bytes()
    );
}

#[test]
fn distinguishes_signed_and_unsigned_word_loads() {
    let pipeline = run(".data\nvalue: .word 0xdeadbeef\n.text\n\
         la x1, value\n\
         lw x2, 0(x1)\n\
         lwu x3, 0(x1)\n\
         ecall\n");
    assert_eq!(pipeline.registers()[2], 0xffff_ffff_dead_beef);
    assert_eq!(pipeline.registers()[3], 0x0000_0000_dead_beef);
}

#[test]
fn executes_rv64m_and_word_operations() {
    let pipeline = run("li x1, 0x100000003\n\
         li x2, 7\n\
         mul x3, x1, x2\n\
         divu x4, x3, x2\n\
         addiw x5, x1, -4\n\
         mulw x6, x1, x2\n\
         ecall\n");
    let registers = pipeline.registers();
    assert_eq!(registers[3], 0x7_0000_0015);
    assert_eq!(registers[4], 0x1_0000_0003);
    assert_eq!(registers[5], u64::MAX);
    assert_eq!(registers[6], 21);
}

#[test]
fn calls_and_branches_preserve_64_bit_values() {
    let pipeline = run("li a0, 0x100000000\n\
         call twice\n\
         li x5, 0x200000000\n\
         bne a0, x5, wrong\n\
         ecall\n\
         wrong: li a0, -1\n\
         ecall\n\
         twice: add a0, a0, a0\n\
         ret\n");
    assert_eq!(pipeline.registers()[10], 0x2_0000_0000);
}

// ---------------------------------------------------------------------------
// Pipeline vs functional reference (regression E9)
//
// `reference_run` is a deliberately naive, test-only ISA interpreter: one
// instruction at a time, no pipeline, no forwarding, no prediction. It exists
// only to check that the 5-stage Pipeline64 (which is what the browser and
// the CLI both run) ends in the same architectural state.
// ---------------------------------------------------------------------------

use sim_engine::pipeline64::STACK_TOP64;
use sim_engine::Op64;
use std::collections::HashMap;

fn reference_run(source: &str) -> [u64; 32] {
    let program = assemble64(source).expect("reference program should assemble");
    let mut regs = [0u64; 32];
    regs[2] = STACK_TOP64;
    let mut mem: HashMap<u64, u8> = HashMap::new();
    for (i, byte) in program.data.iter().enumerate() {
        mem.insert(DATA_BASE as u64 + i as u64, *byte);
    }
    let load = |mem: &HashMap<u64, u8>, addr: u64, len: u64| -> u64 {
        (0..len).fold(0u64, |acc, i| {
            acc | (u64::from(*mem.get(&(addr + i)).unwrap_or(&0)) << (8 * i))
        })
    };
    let sext32 = |v: u64| v as u32 as i32 as i64 as u64;
    let mut pc = 0u64;
    for _ in 0..100_000 {
        let Some(ins) = program.instr_at(pc).cloned() else {
            return regs;
        };
        let a = regs[ins.rs1 as usize];
        let b = regs[ins.rs2 as usize];
        let imm = ins.imm as u64;
        let sh = (b & 63) as u32;
        let mut next = pc.wrapping_add(4);
        let mut rd: Option<u64> = None;
        match ins.op {
            // The assembler stores the raw 20-bit U-immediate.
            Op64::Lui => rd = Some(sext32(imm << 12)),
            Op64::Auipc => rd = Some(pc.wrapping_add(sext32(imm << 12))),
            Op64::Jal => {
                rd = Some(next);
                next = pc.wrapping_add(imm);
            }
            Op64::Jalr => {
                rd = Some(next);
                next = a.wrapping_add(imm) & !1;
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
            Op64::Lb => rd = Some(load(&mem, a.wrapping_add(imm), 1) as u8 as i8 as i64 as u64),
            Op64::Lh => rd = Some(load(&mem, a.wrapping_add(imm), 2) as u16 as i16 as i64 as u64),
            Op64::Lw => rd = Some(sext32(load(&mem, a.wrapping_add(imm), 4))),
            Op64::Ld => rd = Some(load(&mem, a.wrapping_add(imm), 8)),
            Op64::Lbu => rd = Some(load(&mem, a.wrapping_add(imm), 1)),
            Op64::Lhu => rd = Some(load(&mem, a.wrapping_add(imm), 2)),
            Op64::Lwu => rd = Some(load(&mem, a.wrapping_add(imm), 4)),
            Op64::Sb | Op64::Sh | Op64::Sw | Op64::Sd => {
                let len = match ins.op {
                    Op64::Sb => 1,
                    Op64::Sh => 2,
                    Op64::Sw => 4,
                    _ => 8,
                };
                let addr = a.wrapping_add(imm);
                for i in 0..len {
                    mem.insert(addr + i, (b >> (8 * i)) as u8);
                }
            }
            Op64::Addi => rd = Some(a.wrapping_add(imm)),
            Op64::Addiw => rd = Some(sext32(a.wrapping_add(imm))),
            Op64::Slti => rd = Some(((a as i64) < (imm as i64)) as u64),
            Op64::Sltiu => rd = Some((a < imm) as u64),
            Op64::Xori => rd = Some(a ^ imm),
            Op64::Ori => rd = Some(a | imm),
            Op64::Andi => rd = Some(a & imm),
            Op64::Slli => rd = Some(a << (imm & 63)),
            Op64::Srli => rd = Some(a >> (imm & 63)),
            Op64::Srai => rd = Some(((a as i64) >> (imm & 63)) as u64),
            Op64::Slliw => rd = Some(sext32((a as u32).wrapping_shl(imm as u32 & 31) as u64)),
            Op64::Srliw => rd = Some(sext32(((a as u32) >> (imm as u32 & 31)) as u64)),
            Op64::Sraiw => rd = Some(((a as u32 as i32) >> (imm as u32 & 31)) as i64 as u64),
            Op64::Add => rd = Some(a.wrapping_add(b)),
            Op64::Sub => rd = Some(a.wrapping_sub(b)),
            Op64::Addw => rd = Some(sext32(a.wrapping_add(b))),
            Op64::Subw => rd = Some(sext32(a.wrapping_sub(b))),
            Op64::Sll => rd = Some(a << sh),
            Op64::Srl => rd = Some(a >> sh),
            Op64::Sra => rd = Some(((a as i64) >> sh) as u64),
            Op64::Sllw => rd = Some(sext32((a as u32).wrapping_shl(b as u32 & 31) as u64)),
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
            Op64::Div => {
                rd = Some(if b == 0 {
                    u64::MAX
                } else {
                    (a as i64).wrapping_div(b as i64) as u64
                })
            }
            Op64::Divu => rd = Some(if b == 0 { u64::MAX } else { a / b }),
            Op64::Rem => {
                rd = Some(if b == 0 {
                    a
                } else {
                    (a as i64).wrapping_rem(b as i64) as u64
                })
            }
            Op64::Remu => rd = Some(if b == 0 { a } else { a % b }),
            Op64::Mulw => rd = Some(sext32((a as u32).wrapping_mul(b as u32) as u64)),
            Op64::Divw => {
                let (x, y) = (a as i32, b as i32);
                rd = Some(if y == 0 {
                    u64::MAX
                } else {
                    x.wrapping_div(y) as i64 as u64
                })
            }
            Op64::Divuw => {
                let (x, y) = (a as u32, b as u32);
                rd = Some(if y == 0 {
                    u64::MAX
                } else {
                    sext32((x / y) as u64)
                })
            }
            Op64::Remw => {
                let (x, y) = (a as i32, b as i32);
                rd = Some(if y == 0 {
                    x as i64 as u64
                } else {
                    x.wrapping_rem(y) as i64 as u64
                })
            }
            Op64::Remuw => {
                let (x, y) = (a as u32, b as u32);
                rd = Some(if y == 0 {
                    sext32(x as u64)
                } else {
                    sext32((x % y) as u64)
                })
            }
            Op64::Ecall | Op64::Ebreak => return regs,
            Op64::Fence => {}
        }
        if let Some(value) = rd {
            if ins.rd != 0 {
                regs[ins.rd as usize] = value;
            }
        }
        pc = next;
    }
    panic!("reference run did not halt");
}

/// Load-use hazard (ld feeding the next add) inside a counted loop (bne),
/// with values that only fit in 64 bits.
pub const HAZARD_SAMPLE: &str = "\
.data
vals: .dword 0x7fffffffffffffff, -3, 10
.text
    la   t0, vals
    li   t1, 3
    li   a0, 0
loop:
    ld   t2, 0(t0)
    add  a0, a0, t2
    addi t0, t0, 8
    addi t1, t1, -1
    bne  t1, x0, loop
    mul  a1, a0, a0
    mulh a2, a0, a0
    addiw a3, a0, 1
    ecall
";

#[test]
fn pipeline_matches_functional_reference_with_load_use_and_branch() {
    let pipeline = run(HAZARD_SAMPLE);
    let stats = pipeline.stats();
    assert!(stats.stalls > 0, "sample must exercise a load-use stall");
    assert!(stats.branches > 0, "sample must exercise a branch");
    let expected = reference_run(HAZARD_SAMPLE);
    assert_eq!(pipeline.registers(), expected);
    // 0x7fff_ffff_ffff_ffff + (-3) + 10 wraps past i64::MAX.
    assert_eq!(expected[10], 0x8000_0000_0000_0006);
}

#[test]
fn pipeline_matches_functional_reference_across_rv64im() {
    let source = "\
.data
buf: .space 16
.text
    li   x5, 0x7fffffffffffffff
    addi x6, x5, 1
    li   x7, -7
    li   x8, 2
    sub  x9, x7, x5
    sll  x10, x7, x8
    srl  x11, x7, x8
    sra  x12, x7, x8
    addw x13, x5, x8
    subw x14, x7, x8
    slliw x15, x5, 31
    sraiw x16, x7, 1
    mul  x17, x5, x7
    mulh x18, x5, x7
    mulhu x19, x5, x7
    mulhsu x20, x7, x5
    div  x21, x7, x8
    rem  x22, x7, x8
    div  x23, x7, x0
    rem  x24, x7, x0
    divu x25, x7, x8
    remuw x26, x7, x8
    la   x27, buf
    sd   x6, 0(x27)
    lw   x28, 4(x27)
    lwu  x29, 4(x27)
    ld   x30, 0(x27)
    ecall
";
    assert_eq!(run(source).registers(), reference_run(source));
}

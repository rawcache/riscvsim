//! PART C: assembler and encoding for RV32IM and RV64IM.

mod support;

use sim_engine::encoding::{decode, disassemble, encode_fields, fields32, fields64, program_bytes32, program_bytes64, Fields};
use sim_engine::{assemble, assemble64, Op64};
use support::reference::{run32, run64, Outcome};
use support::Rng;

fn asm32(src: &str) -> sim_engine::Program {
    assemble(src).unwrap_or_else(|e| panic!("RV32 should assemble {src:?}: {}", e[0].message))
}
fn asm64(src: &str) -> sim_engine::Program64 {
    assemble64(src).unwrap_or_else(|e| panic!("RV64 should assemble {src:?}: {}", e[0].message))
}
fn err32(src: &str) -> (usize, String) {
    let e = assemble(src).err().unwrap_or_else(|| panic!("RV32 should reject {src:?}"));
    (e[0].line, e[0].message.clone())
}
fn err64(src: &str) -> (usize, String) {
    let e = assemble64(src).err().unwrap_or_else(|| panic!("RV64 should reject {src:?}"));
    (e[0].line, e[0].message.clone())
}
fn word32(src: &str) -> u32 {
    let bytes = program_bytes32(&asm32(src)).expect("encodable");
    u32::from_le_bytes(bytes[..4].try_into().unwrap())
}
fn word64(src: &str) -> u32 {
    let bytes = program_bytes64(&asm64(src)).expect("encodable");
    u32::from_le_bytes(bytes[..4].try_into().unwrap())
}

// ---------------------------------------------------------------------------
// Known-good encodings, derived by hand from the base formats in the RISC-V
// Unprivileged ISA specification:
//   R: funct7[31:25] rs2[24:20] rs1[19:15] funct3[14:12] rd[11:7] opcode[6:0]
//   I: imm[11:0][31:20] rs1 funct3 rd opcode
//   S: imm[11:5][31:25] rs2 rs1 funct3 imm[4:0][11:7] opcode
//   B: imm[12][31] imm[10:5][30:25] rs2 rs1 funct3 imm[4:1][11:8] imm[11][7] opcode
//   U: imm[31:12] rd opcode
//   J: imm[20][31] imm[10:1][30:21] imm[11][20] imm[19:12][19:12] rd opcode
// Opcodes: OP=0x33 OP-32=0x3b OP-IMM=0x13 OP-IMM-32=0x1b LOAD=0x03
// STORE=0x23 BRANCH=0x63 LUI=0x37 AUIPC=0x17 JAL=0x6f JALR=0x67 SYSTEM=0x73.
// ---------------------------------------------------------------------------

/// (source, expected word, derivation)
const KNOWN_RV32: &[(&str, u32, &str)] = &[
    // R-type
    ("add x1, x2, x3", 0x0031_00b3, "rs2=3<<20 | rs1=2<<15 | rd=1<<7 | 0x33"),
    ("sub x5, x6, x7", 0x4073_02b3, "f7=0x20<<25 | 7<<20 | 6<<15 | 5<<7 | 0x33"),
    ("and a0, a1, a2", 0x00c5_f533, "12<<20 | 11<<15 | f3=7<<12 | 10<<7 | 0x33"),
    // I-type
    ("addi x0, x0, 0", 0x0000_0013, "canonical nop"),
    ("addi x1, x0, -1", 0xfff0_0093, "imm=0xfff<<20 | 1<<7 | 0x13"),
    ("addi a0, a0, 2047", 0x7ff5_0513, "0x7ff<<20 | 10<<15 | 10<<7 | 0x13"),
    ("lw a0, 8(sp)", 0x0081_2503, "8<<20 | 2<<15 | f3=2<<12 | 10<<7 | 0x03"),
    ("jalr x0, 0(x1)", 0x0000_8067, "ret: 1<<15 | 0x67"),
    // S-type
    ("sw a0, 8(sp)", 0x00a1_2423, "rs2=10<<20 | 2<<15 | 2<<12 | imm[4:0]=8<<7 | 0x23"),
    ("sb x0, -1(x0)", 0xfe00_0fa3, "imm[11:5]=0x7f<<25 | imm[4:0]=0x1f<<7 | 0x23"),
    ("sh t0, 32(t1)", 0x0253_1023, "imm[11:5]=1<<25 | 5<<20 | 6<<15 | 1<<12 | 0x23"),
    // B-type (branch at address 0, targets are absolute)
    ("beq x0, x0, 0", 0x0000_0063, "all-zero offset"),
    ("blt x1, x2, 8", 0x0020_c463, "imm[4:1]=4<<8 | 2<<20 | 1<<15 | f3=4<<12 | 0x63"),
    // U-type
    ("lui a0, 0x12345", 0x1234_5537, "0x12345<<12 | 10<<7 | 0x37"),
    ("auipc x1, 0", 0x0000_0097, "1<<7 | 0x17"),
    ("lui x31, 0xfffff", 0xffff_ffb7, "0xfffff<<12 | 31<<7 | 0x37"),
    // J-type
    ("jal x0, 0", 0x0000_006f, "all-zero offset"),
    ("jal ra, 8", 0x0080_00ef, "imm[10:1]=4<<21 | 1<<7 | 0x6f"),
    // Shifts (RV32: 5-bit shamt)
    ("slli a0, a0, 3", 0x0035_1513, "3<<20 | 10<<15 | 1<<12 | 10<<7 | 0x13"),
    ("srai a0, a0, 31", 0x41f5_5513, "0x20<<25 | 31<<20 | 10<<15 | 5<<12 | 10<<7 | 0x13"),
    ("srli x1, x1, 1", 0x0010_d093, "1<<20 | 1<<15 | 5<<12 | 1<<7 | 0x13"),
    // M-extension
    ("mul a0, a0, a1", 0x02b5_0533, "f7=1<<25 | 11<<20 | 10<<15 | 10<<7 | 0x33"),
    ("div x1, x2, x3", 0x0231_40b3, "1<<25 | 3<<20 | 2<<15 | 4<<12 | 1<<7 | 0x33"),
    ("remu a0, a1, a2", 0x02c5_f533, "1<<25 | 12<<20 | 11<<15 | 7<<12 | 10<<7 | 0x33"),
    // System
    ("ecall", 0x0000_0073, "SYSTEM, all fields zero"),
    ("ebreak", 0x0010_0073, "imm=1<<20 | 0x73"),
];

const KNOWN_RV64: &[(&str, u32, &str)] = &[
    ("sd ra, 24(sp)", 0x0011_3c23, "1<<20 | 2<<15 | f3=3<<12 | imm[4:0]=24<<7 | 0x23"),
    ("ld a0, 0(a1)", 0x0005_b503, "11<<15 | f3=3<<12 | 10<<7 | 0x03"),
    ("lwu t0, 4(sp)", 0x0041_6283, "4<<20 | 2<<15 | f3=6<<12 | 5<<7 | 0x03"),
    // RV64 shifts: 6-bit shamt, funct6 in [31:26]
    ("srli x1, x1, 63", 0x03f0_d093, "63<<20 | 1<<15 | 5<<12 | 1<<7 | 0x13"),
    ("srai x1, x1, 63", 0x43f0_d093, "0x10<<26 | 63<<20 | 1<<15 | 5<<12 | 1<<7 | 0x13"),
    ("slli a0, a0, 32", 0x0205_1513, "32<<20 | 10<<15 | 1<<12 | 10<<7 | 0x13"),
    // W-ops
    ("addw a0, a0, a1", 0x00b5_053b, "11<<20 | 10<<15 | 10<<7 | 0x3b"),
    ("subw x1, x2, x3", 0x4031_00bb, "0x20<<25 | 3<<20 | 2<<15 | 1<<7 | 0x3b"),
    ("addiw a0, a0, -1", 0xfff5_051b, "0xfff<<20 | 10<<15 | 10<<7 | 0x1b"),
    ("sext.w a0, a0", 0x0005_051b, "addiw a0, a0, 0"),
    ("sraiw a0, a0, 31", 0x41f5_551b, "0x20<<25 | 31<<20 | 10<<15 | 5<<12 | 10<<7 | 0x1b"),
    // M W-ops
    ("mulw a0, a0, a1", 0x02b5_053b, "1<<25 | 11<<20 | 10<<15 | 10<<7 | 0x3b"),
    ("divuw x1, x2, x3", 0x0231_50bb, "1<<25 | 3<<20 | 2<<15 | 5<<12 | 1<<7 | 0x3b"),
    ("remw t0, t1, t2", 0x0273_62bb, "1<<25 | 7<<20 | 6<<15 | 6<<12 | 5<<7 | 0x3b"),
];

#[test]
fn known_good_encodings_rv32() {
    for (src, expected, why) in KNOWN_RV32 {
        assert_eq!(word32(src), *expected, "RV32 {src} ({why})");
        // Every RV32 encoding is also valid RV64 except the 5-bit shift rule.
        assert_eq!(word64(src), *expected, "RV64 {src} ({why})");
    }
}

#[test]
fn known_good_encodings_rv64() {
    for (src, expected, why) in KNOWN_RV64 {
        assert_eq!(word64(src), *expected, "{src} ({why})");
    }
}

#[test]
fn known_good_branch_and_jump_backwards() {
    // bne a0, a1, -4 at address 4 -> target 0.
    //   offset -4 = 0x1ffc (13 bits): imm[12]=1, imm[11]=1, imm[10:5]=0x3f, imm[4:1]=0xe
    let p = asm32("nop\nbne a0, a1, 0\n");
    assert_eq!(sim_engine::encoding::encode32(&p.instrs[1]).unwrap(), 0xfeb5_1ee3);
    // j -4 (jal x0) at address 4: imm[20]=1, imm[10:1]=0x3fe, imm[11]=1, imm[19:12]=0xff
    let p = asm32("nop\nj 0\n");
    assert_eq!(sim_engine::encoding::encode32(&p.instrs[1]).unwrap(), 0xffdf_f06f);
}

const REG_EXTREMES: [u8; 4] = [0, 1, 17, 31];

fn every_op64() -> Vec<Op64> {
    use Op64::*;
    vec![
        Lui, Auipc, Jal, Jalr, Beq, Bne, Blt, Bge, Bltu, Bgeu, Lb, Lh, Lw, Ld, Lbu, Lhu, Lwu, Sb,
        Sh, Sw, Sd, Addi, Addiw, Slti, Sltiu, Xori, Ori, Andi, Slli, Srli, Srai, Slliw, Srliw,
        Sraiw, Add, Sub, Addw, Subw, Sll, Sllw, Slt, Sltu, Xor, Srl, Sra, Srlw, Sraw, Or, And, Mul,
        Mulh, Mulhsu, Mulhu, Div, Divu, Rem, Remu, Mulw, Divw, Divuw, Remw, Remuw, Ecall, Ebreak,
        Fence,
    ]
}

fn imm_extremes(op: Op64, xlen: u32) -> Vec<i64> {
    use Op64::*;
    match op {
        Lui | Auipc => vec![0, 1, 0x7ffff, 0x80000, 0xfffff],
        Jal => vec![0, 2, -2, 1_048_574, -1_048_576],
        Beq | Bne | Blt | Bge | Bltu | Bgeu => vec![0, 2, -2, 4094, -4096],
        Slli | Srli | Srai if xlen == 64 => vec![0, 1, 31, 32, 63],
        Slli | Srli | Srai | Slliw | Srliw | Sraiw => vec![0, 1, 30, 31],
        Ecall | Ebreak | Fence => vec![0],
        _ => vec![0, 1, -1, 2047, -2048],
    }
}

#[test]
fn encode_decode_round_trip_for_every_instruction_and_extreme() {
    let mut checked = 0;
    for xlen in [32u32, 64] {
        for op in every_op64() {
            if xlen == 32 && sim_engine::encoding::op64_to_op32(op).is_none() {
                assert!(encode_fields(Fields { op, rd: 1, rs1: 1, rs2: 1, imm: 0 }, 32).is_err());
                continue;
            }
            for &rd in &REG_EXTREMES {
                for &rs1 in &REG_EXTREMES {
                    for &rs2 in &REG_EXTREMES {
                        for imm in imm_extremes(op, xlen) {
                            let f = sim_engine::encoding::canonical(Fields { op, rd, rs1, rs2, imm });
                            let word = encode_fields(f, xlen).unwrap_or_else(|e| panic!("{op:?} {f:?}: {}", e.message));
                            let back = decode(word, xlen).unwrap_or_else(|| panic!("{op:?} {word:#x} does not decode"));
                            assert_eq!(back, f, "xlen {xlen}: {word:#010x}");
                            checked += 1;
                        }
                    }
                }
            }
        }
    }
    assert!(checked > 10_000, "{checked}");
}

#[test]
fn out_of_range_fields_do_not_encode() {
    use Op64::*;
    let bad = [
        (Addi, 2048),
        (Addi, -2049),
        (Sw, 2048),
        (Beq, 4096),
        (Beq, -4098),
        (Beq, 3),
        (Jal, 1_048_576),
        (Jal, 1),
        (Lui, -1),
        (Lui, 0x100000),
        (Slliw, 32),
    ];
    for (op, imm) in bad {
        assert!(encode_fields(Fields { op, rd: 1, rs1: 1, rs2: 1, imm }, 64).is_err(), "{op:?} {imm}");
    }
    assert!(encode_fields(Fields { op: Slli, rd: 1, rs1: 1, rs2: 0, imm: 32 }, 32).is_err());
    assert!(encode_fields(Fields { op: Slli, rd: 1, rs1: 1, rs2: 0, imm: 32 }, 64).is_ok());
    assert!(encode_fields(Fields { op: Ld, rd: 1, rs1: 1, rs2: 0, imm: 0 }, 32).is_err());
    // RV64-only encodings are not RV32 instructions.
    assert_eq!(decode(0x0005_b503, 32), None); // ld
    assert_eq!(decode(0x0205_1513, 32), None); // slli by 32
    assert_eq!(decode(0xffff_ffff, 64), None);
    assert_eq!(decode(0, 64), None);
}

/// Text for one instruction with the given operands, for the assembler.
fn instruction_text(f: Fields, pc: u64) -> String {
    disassemble(f, pc)
}

#[test]
fn assemble_disassemble_assemble_is_identical() {
    let mut rng = Rng::new(0xD15A);
    for xlen in [32u32, 64] {
        // Lay the instructions out after 1100 nops so branch targets stay in
        // range and positive.
        let base = 1100u64;
        let mut lines: Vec<String> = (0..base).map(|_| "nop".to_string()).collect();
        let mut pc = base * 4;
        for op in every_op64() {
            if xlen == 32 && sim_engine::encoding::op64_to_op32(op).is_none() {
                continue;
            }
            for imm in imm_extremes(op, xlen) {
                // Without the C extension, targets are multiples of 4.
                let imm = match op {
                    Op64::Jal => imm.clamp(-4096, 4092) & !3,
                    _ if op.is_branch() => imm & !3,
                    _ => imm,
                };
                let f = sim_engine::encoding::canonical(Fields {
                    op,
                    rd: *rng.pick(&REG_EXTREMES),
                    rs1: *rng.pick(&REG_EXTREMES),
                    rs2: *rng.pick(&REG_EXTREMES),
                    imm,
                });
                lines.push(instruction_text(f, pc));
                pc += 4;
            }
        }
        lines.extend((0..1100).map(|_| "nop".to_string()));
        let src = lines.join("\n") + "\n";
        let (first, listing): (Vec<u8>, Vec<(Fields, u64)>) = if xlen == 32 {
            let p = asm32(&src);
            (program_bytes32(&p).unwrap(), p.instrs.iter().map(|i| (fields32(i), i.addr as u64)).collect())
        } else {
            let p = asm64(&src);
            (program_bytes64(&p).unwrap(), p.instrs.iter().map(|i| (fields64(i), i.addr)).collect())
        };
        // Disassemble the machine code and assemble that text again.
        let words: Vec<u32> = first.chunks(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
        let again_src: String = words
            .iter()
            .zip(&listing)
            .map(|(w, (_, addr))| disassemble(decode(*w, xlen).expect("decodes"), *addr) + "\n")
            .collect();
        let second = if xlen == 32 {
            program_bytes32(&asm32(&again_src)).unwrap()
        } else {
            program_bytes64(&asm64(&again_src)).unwrap()
        };
        assert_eq!(first, second, "xlen {xlen}: bytes differ after a disassembly round trip");
    }
}

// ---------------------------------------------------------------------------
// Immediate range checks: the limit passes, one past it fails clearly.
// ---------------------------------------------------------------------------

#[test]
fn immediate_ranges_are_enforced_at_the_boundary() {
    let cases: &[(&str, &str, &str)] = &[
        ("addi a0, a0, 2047", "addi a0, a0, 2048", "out of range"),
        ("addi a0, a0, -2048", "addi a0, a0, -2049", "out of range"),
        ("sw a0, 2047(sp)", "sw a0, 2048(sp)", "out of range"),
        ("lw a0, -2048(sp)", "lw a0, -2049(sp)", "out of range"),
        ("lui a0, 0xfffff", "lui a0, 0x100000", "out of range"),
        ("lui a0, 0", "lui a0, -1", "out of range"),
        ("slli a0, a0, 31", "slli a0, a0, 32", "out of range"),
        ("srai a0, a0, 0", "srai a0, a0, -1", "out of range"),
    ];
    for (ok, bad, needle) in cases {
        asm32(ok);
        let (line, msg) = err32(bad);
        assert_eq!(line, 1);
        assert!(msg.contains(needle), "{bad}: {msg}");
    }
    // RV64: 6-bit shifts, 5-bit W shifts.
    asm64("slli a0, a0, 63");
    assert!(err64("slli a0, a0, 64").1.contains("out of range"));
    asm64("slliw a0, a0, 31");
    assert!(err64("slliw a0, a0, 32").1.contains("out of range"));
    asm64("sraiw a0, a0, 31");
    assert!(err64("srliw a0, a0, 32").1.contains("out of range"));
}

#[test]
fn branch_and_jump_ranges_and_alignment() {
    // Branch reach is -4096..=4094 bytes.
    let far = |n: usize, back: bool| {
        if back {
            format!("top:\n{}beq x0, x0, top\n", "nop\n".repeat(n))
        } else {
            format!("beq x0, x0, end\n{}end: nop\n", "nop\n".repeat(n))
        }
    };
    asm32(&far(1022, false)); // offset +4092
    asm32(&far(1024, true)); // offset -4096
    assert!(err32(&far(1023, false)).1.contains("out of range")); // +4096
    assert!(err32(&far(1025, true)).1.contains("out of range")); // -4100
    // Misaligned numeric targets.
    assert!(err32("beq x0, x0, 2\n").1.contains("misaligned"));
    assert!(err32("jal x0, 6\nnop\n").1.contains("multiples of 4"));
    assert!(err64("beq x0, x0, 3\n").1.contains("misaligned"));
}

// ---------------------------------------------------------------------------
// Pseudo-instructions, checked by executing them on the reference model.
// ---------------------------------------------------------------------------

fn regs32(src: &str) -> [u32; 32] {
    let s = run32(&asm32(src), 10_000);
    assert_eq!(s.outcome, Outcome::Complete, "{src}");
    s.regs
}
fn regs64(src: &str) -> [u64; 32] {
    let s = run64(&asm64(src), 10_000);
    assert_eq!(s.outcome, Outcome::Complete, "{src}");
    s.regs
}

#[test]
fn every_pseudo_instruction_behaves_as_specified() {
    let prelude = "li t0, 7\nli t1, -3\nli t2, 0\n";
    let cases: &[(&str, usize, i64)] = &[
        ("nop", 10, 0),
        ("mv a0, t0", 10, 7),
        ("not a0, t0", 10, !7),
        ("neg a0, t0", 10, -7),
        ("seqz a0, t2", 10, 1),
        ("seqz a0, t0", 10, 0),
        ("snez a0, t1", 10, 1),
        ("sltz a0, t1", 10, 1),
        ("sltz a0, t0", 10, 0),
        ("sgtz a0, t0", 10, 1),
        ("sgtz a0, t1", 10, 0),
        ("li a0, 1\nbeqz t2, 1f\nli a0, 2\n1:", 10, 1),
        ("li a0, 1\nbnez t2, 1f\nli a0, 2\n1:", 10, 2),
        ("li a0, 1\nblez t1, 1f\nli a0, 2\n1:", 10, 1),
        ("li a0, 1\nbgez t2, 1f\nli a0, 2\n1:", 10, 1),
        ("li a0, 1\nbltz t1, 1f\nli a0, 2\n1:", 10, 1),
        ("li a0, 1\nbgtz t0, 1f\nli a0, 2\n1:", 10, 1),
        ("li a0, 1\nbgt t0, t1, 1f\nli a0, 2\n1:", 10, 1),
        ("li a0, 1\nble t1, t0, 1f\nli a0, 2\n1:", 10, 1),
        ("li a0, 1\nbgtu t1, t0, 1f\nli a0, 2\n1:", 10, 1),
        ("li a0, 1\nbleu t0, t1, 1f\nli a0, 2\n1:", 10, 1),
        ("li a0, 1\nj 1f\nli a0, 2\n1:", 10, 1),
        ("jal 1f\n1: mv a0, ra", 10, 4 * 4),
        ("la a1, 1f\nli a0, 5\njr a1\nli a0, 6\n1:", 10, 5),
        ("la a1, 1f\nli a0, 5\njalr a1\nli a0, 6\n1:", 10, 5),
        ("la a1, 1f\nli a0, 5\njalr ra, 0(a1)\nli a0, 6\n1:", 10, 5),
        ("la a1, 1f\nli a0, 5\njalr ra, a1, 0\nli a0, 6\n1:", 10, 5),
        ("li a0, 0\ncall f\nj 2f\nf: li a0, 9\nret\n2:", 10, 9),
        ("li a0, 0\ncall f\nj 2f\nf: tail g\ng: li a0, 11\nret\n2:", 10, 11),
    ];
    for (body, reg, expected) in cases {
        let src = format!("{prelude}{body}\necall\n");
        assert_eq!(regs32(&src)[*reg] as i32 as i64, *expected, "RV32 {body}");
        assert_eq!(regs64(&src)[*reg] as i64, *expected, "RV64 {body}");
    }
    // RV64-only pseudos.
    let r = regs64("li t0, 0x80000000\nnegw a0, t0\nsext.w a1, t0\nli t1, 5\nnegw a2, t1\necall\n");
    assert_eq!(r[10] as i64, i32::MIN as i64, "negw of 0x80000000 wraps in 32 bits");
    assert_eq!(r[11] as i64, i32::MIN as i64, "sext.w sign-extends bit 31");
    assert_eq!(r[12] as i64, -5);
    assert!(err32("sext.w a0, a0\n").1.contains("RV64-only"));
}

fn boundary_constants() -> Vec<i64> {
    let mut v = vec![0, 1, -1, 2047, 2048, -2048, -2049, 4095, 4096, 0x7ff, 0x800, 0xfff, 0x1000];
    for bits in 0..64u32 {
        let p = 1i64.wrapping_shl(bits);
        v.extend([p, p.wrapping_sub(1), p.wrapping_add(1), p.wrapping_neg(), !p]);
    }
    v.extend([i32::MIN as i64, i32::MAX as i64, u32::MAX as i64, i64::MIN, i64::MAX]);
    v.extend([0x7fff_f800, 0x7fff_ffff, 0x8000_0000, -0x8000_0800, 0x1234_5678_9abc_def0]);
    v
}

#[test]
fn li_materializes_every_64_bit_constant_minimally() {
    let mut rng = Rng::new(0x11);
    let mut values = boundary_constants();
    for _ in 0..support::iterations(2000, 50_000) {
        let v = rng.next_u64() as i64;
        // Mix in sparse and short values, which have different sequences.
        values.push(match rng.below(4) {
            0 => v,
            1 => v >> rng.below(64),
            2 => v & (0xfff << rng.below(52)),
            _ => (v as i32) as i64,
        });
    }
    for v in values {
        let src = format!("li a0, {v}\necall\n");
        let p = asm64(&src);
        let steps = p.instrs.len() - 1;
        assert!(steps <= 8, "li {v:#x} takes {steps} instructions");
        if (i32::MIN as i64..=i32::MAX as i64).contains(&v) {
            assert!(steps <= 2, "32-bit li {v:#x} takes {steps} instructions");
        }
        let s = run64(&p, 100);
        assert_eq!(s.regs[10] as i64, v, "li {v:#x}");
        // Also as an unsigned hex literal.
        let s = run64(&asm64(&format!("li a0, {:#x}\necall\n", v as u64)), 100);
        assert_eq!(s.regs[10] as i64, v);
    }
}

#[test]
fn li_materializes_every_32_bit_constant_on_rv32() {
    let mut rng = Rng::new(0x32);
    let mut values: Vec<i64> = boundary_constants()
        .into_iter()
        .filter(|v| (i32::MIN as i64..=u32::MAX as i64).contains(v))
        .collect();
    values.extend((0..2000).map(|_| rng.next_u64() as u32 as i64));
    for v in values {
        let p = asm32(&format!("li a0, {v}\necall\n"));
        assert!(p.instrs.len() - 1 <= 2);
        assert_eq!(run32(&p, 100).regs[10], v as u32, "li {v}");
    }
    assert!(err32("li a0, 0x100000000\n").1.contains("0x100000000") || err32("li a0, 0x100000000\n").1.contains("4294967296"));
}

// ---------------------------------------------------------------------------
// Directives, number formats, comments, labels, %hi/%lo, register names.
// ---------------------------------------------------------------------------

fn data32(src: &str, len: usize) -> Vec<u8> {
    asm32(src).data[..len].to_vec()
}

#[test]
fn data_directives() {
    let d = data32(".data\n.byte 1, -1, 0xff\n.half 0x1234\n.word -2\n.dword 0x0102030405060708\n.text\nnop\n", 24);
    assert_eq!(&d[..3], &[1, 0xff, 0xff]);
    assert_eq!(&d[4..6], &[0x34, 0x12]);
    assert_eq!(&d[8..12], &[0xfe, 0xff, 0xff, 0xff]);
    assert_eq!(&d[16..24], &[8, 7, 6, 5, 4, 3, 2, 1]);
    let d = data32(".data\n.string \"hi\"\n.asciz \"a\\n\"\n.ascii \"z\"\n.text\nnop\n", 7);
    assert_eq!(d, b"hi\0a\n\0z");
    let p = asm32(".data\na: .byte 1\n.align 3\nb: .byte 2\n.balign 16\nc: .byte 3\n.space 5\nd: .zero 2\ne: .byte 4\n.text\nnop\n");
    let addr = |n: &str| p.labels.iter().find(|(l, _)| l == n).unwrap().1 - 0x1000_0000;
    assert_eq!((addr("a"), addr("b"), addr("c"), addr("d"), addr("e")), (0, 8, 16, 22, 24));
    // .bss reserves zeroed space after .data
    let p = asm32(".data\nx: .word 5\n.bss\nbuf: .space 8\n.text\nla a0, buf\n");
    assert_eq!(p.labels.iter().find(|(l, _)| l == "buf").unwrap().1, 0x1000_0004);
    // .section names
    asm32(".section .rodata\nmsg: .string \"x\"\n.section .text\nnop\n");
    asm32(".globl main\n.global main\nmain: nop\n");
    // value range per width
    assert!(err32(".data\n.byte 256\n.text\nnop\n").1.contains("does not fit"));
    assert!(err32(".data\n.half -32769\n.text\nnop\n").1.contains("does not fit"));
    data32(".data\n.byte -128, 255\n.half -32768, 65535\n.text\nnop\n", 6);
    assert!(err32(".data\n.balign 3\n.text\nnop\n").1.contains("power of two"));
    // RV64 .dword with unsigned max
    let d = asm64(".data\n.dword 0xffffffffffffffff, -1\n.text\nnop\n").data;
    assert_eq!(&d[..16], &[0xff; 16]);
}

#[test]
fn equ_and_set_define_constants() {
    let r = regs32(".equ SIZE, 16\n.set NEG, -SIZE\n.equ CH, 'A'\nli a0, SIZE\nli a1, NEG\naddi a2, x0, CH\necall\n");
    assert_eq!((r[10], r[11] as i32, r[12]), (16, -16, 65));
    assert!(err32(".equ , 5\nnop\n").1.contains(".equ"));
    assert!(err32(".equ X, hello\nnop\n").1.contains("expected an integer"));
}

#[test]
fn number_formats() {
    let r = regs32("li a0, 0x1F\nli a1, 0b101\nli a2, 017\nli a3, 0o17\nli a4, -42\nli a5, +7\nli a6, 'a'\nli a7, '\\n'\nli s2, '\\''\nli s3, '\\\\'\nli s4, '#'\necall\n");
    assert_eq!(&r[10..18], &[31, 5, 15, 15, (-42i32) as u32, 7, 97, 10]);
    assert_eq!((r[18], r[19], r[20]), (39, 92, 35));
    assert!(err32("li a0, 0x\n").1.contains("invalid"));
    assert!(err32("li a0, 0x-1\n").1.contains("invalid"));
    assert!(err32("li a0, 09\n").1.contains("invalid"));
}

#[test]
fn comments_of_every_kind() {
    let r = regs32("li a0, 1 # hash\nli a1, 2 // slashes\n/* block */ li a2, 3\nli a3, /* inline */ 4\n/* multi\nline\ncomment */\nli a4, 5\necall\n");
    assert_eq!(&r[10..15], &[1, 2, 3, 4, 5]);
    // Line numbers survive multi-line comments.
    assert_eq!(err32("/*\n\n*/\nbogus a0\n").0, 4);
    assert!(err32("nop\n/* never closed\nnop\n").1.contains("unterminated"));
    // Comment characters inside strings are data.
    let d = data32(".data\n.string \"# not /* a comment\"\n.text\nnop\n", 18);
    assert_eq!(&d, b"# not /* a comment");
}

#[test]
fn local_numeric_labels() {
    let src = "li a0, 0\nli t0, 3\n1: addi a0, a0, 1\naddi t0, t0, -1\nbnez t0, 1b\nj 1f\nli a0, 99\n1: li a1, 5\n1: nop\necall\n";
    let r = regs32(src);
    assert_eq!((r[10], r[11]), (3, 5));
    assert_eq!(regs64(src)[10], 3);
    let (line, msg) = err32("j 2f\nnop\n");
    assert_eq!(line, 1);
    assert!(msg.contains("'2f'"), "{msg}");
    // Listings show the user's own spelling.
    let p = asm32("1: j 1b\n");
    assert_eq!(p.instrs[0].text, "j 1b");
}

#[test]
fn hi_lo_relocations() {
    let src = ".data\npad: .space 0x900\nval: .word 1234\n.text\nlui a0, %hi(val)\naddi a0, a0, %lo(val)\nlw a1, 0(a0)\nlui a2, %hi(val)\nlw a3, %lo(val)(a2)\necall\n";
    let r = regs32(src);
    assert_eq!(r[10], 0x1000_0900);
    assert_eq!((r[11], r[13]), (1234, 1234));
    assert_eq!(regs64(src)[11], 1234);
}

#[test]
fn register_names() {
    let abi = [
        "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2", "s0", "s1", "a0", "a1", "a2", "a3", "a4",
        "a5", "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "t3", "t4",
        "t5", "t6",
    ];
    for (i, name) in abi.iter().enumerate() {
        let p = asm32(&format!("addi {name}, x{i}, 1\n"));
        assert_eq!((p.instrs[0].rd as usize, p.instrs[0].rs1 as usize), (i, i), "{name}");
        let p = asm64(&format!("addi x{i}, {name}, 1\n"));
        assert_eq!(p.instrs[0].rd as usize, i);
    }
    assert_eq!(asm32("mv fp, a0\n").instrs[0].rd, 8);
    assert!(err32("addi x32, x0, 1\n").1.contains("x32"));
    assert!(err32("addi a8, x0, 1\n").1.contains("a8"));
}

// ---------------------------------------------------------------------------
// Diagnostics: every error names the line and says what to fix.
// ---------------------------------------------------------------------------

#[test]
fn error_messages_are_specific() {
    let (line, msg) = err32("nop\nadd a0, a1\n");
    assert_eq!(line, 2);
    assert!(msg.contains("expects 3 operand") && msg.contains("got 2"), "{msg}");
    let (_, msg) = err32("addd a0, a1, a2\n");
    assert!(msg.contains("unknown instruction 'addd'") && msg.contains("did you mean 'add'"), "{msg}");
    let (_, msg) = err64("lwz a0, 0(sp)\n");
    assert!(msg.contains("did you mean"), "{msg}");
    let (_, msg) = err32("add a0, a1, q9\n");
    assert!(msg.contains("invalid register 'q9'"), "{msg}");
    let (line, msg) = err32("x: nop\nx: nop\n");
    assert_eq!(line, 2);
    assert!(msg.contains("duplicate label 'x'"), "{msg}");
    let (_, msg) = err32("j nowhere\n");
    assert!(msg.contains("label 'nowhere' not found"), "{msg}");
    let (_, msg) = err32("addi a0, a0, 5000\n");
    assert!(msg.contains("5000") && msg.contains("[-2048, 2047]"), "{msg}");
    for rv64_only in ["ld a0, 0(sp)", "sd a0, 0(sp)", "addw a0, a0, a1", "lwu a0, 0(sp)", "addiw a0, a0, 1"] {
        let (_, msg) = err32(&format!("{rv64_only}\n"));
        assert!(msg.contains("RV64-only") && msg.contains("not valid for RV32"), "{rv64_only}: {msg}");
    }
    let (_, msg) = err64("fadd.s f0, f1, f2\n");
    assert!(msg.contains("RV64IM"), "{msg}");
}

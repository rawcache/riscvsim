//! PART D: specification corner cases, the memory contract, step-back
//! parity and pinned pipeline timing, for RV32IM and RV64IM.

mod support;

use sim_engine::{assemble, assemble64, Pipeline, Pipeline64};
use support::programs::Generator;
use support::reference::{run32, run64, Outcome};
use support::{iterations, Rng};

fn p32(src: &str) -> Pipeline {
    let mut p = Pipeline::new(assemble(src).unwrap_or_else(|e| panic!("{}: {src}", e[0].message)));
    assert!(p.run(100_000), "did not halt: {src}");
    p
}
fn p64(src: &str) -> Pipeline64 {
    let mut p = Pipeline64::new(assemble64(src).unwrap_or_else(|e| panic!("{}: {src}", e[0].message)));
    assert!(p.run(100_000), "did not halt: {src}");
    p
}
/// Run on both the pipeline and the reference; they must agree.
fn r32(src: &str) -> [u32; 32] {
    let regs = p32(src).registers();
    assert_eq!(regs, run32(&assemble(src).unwrap(), 100_000).regs, "reference disagrees: {src}");
    regs
}
fn r64(src: &str) -> [u64; 32] {
    let regs = p64(src).registers();
    assert_eq!(regs, run64(&assemble64(src).unwrap(), 100_000).regs, "reference disagrees: {src}");
    regs
}

#[test]
fn division_by_zero() {
    let r = r32("li a1, 7\ndiv a2, a1, x0\ndivu a3, a1, x0\nrem a4, a1, x0\nremu a5, a1, x0\nli a1, -7\nrem a6, a1, x0\necall\n");
    assert_eq!((r[12], r[13]), (u32::MAX, u32::MAX), "quotient is all ones");
    assert_eq!((r[14], r[15]), (7, 7), "remainder is the dividend");
    assert_eq!(r[16] as i32, -7);
    let r = r64("li a1, -7\ndiv a2, a1, x0\ndivu a3, a1, x0\nrem a4, a1, x0\nremu a5, a1, x0\ndivw a6, a1, x0\ndivuw a7, a1, x0\nremw s2, a1, x0\nremuw s3, a1, x0\necall\n");
    assert_eq!((r[12], r[13]), (u64::MAX, u64::MAX));
    assert_eq!((r[14] as i64, r[15] as i64), (-7, -7));
    assert_eq!((r[16], r[17]), (u64::MAX, u64::MAX), "W divide by zero is all ones too");
    assert_eq!((r[18] as i64, r[19] as i64), (-7, -7), "W remainder: sign-extended low word of the dividend");
}

#[test]
fn signed_division_overflow() {
    let r = r32("li a1, 0x80000000\nli a2, -1\ndiv a3, a1, a2\nrem a4, a1, a2\necall\n");
    assert_eq!((r[13], r[14]), (0x8000_0000, 0), "MIN / -1 = MIN, remainder 0");
    let r = r64("li a1, 0x8000000000000000\nli a2, -1\ndiv a3, a1, a2\nrem a4, a1, a2\nli a5, 0x80000000\ndivw a6, a5, a2\nremw a7, a5, a2\necall\n");
    assert_eq!((r[13], r[14]), (1 << 63, 0));
    assert_eq!((r[16] as i64, r[17]), (i32::MIN as i64, 0));
}

#[test]
fn high_multiplies() {
    let r = r32("li a1, -2\nli a2, 3\nmulh a3, a1, a2\nmulhsu a4, a1, a2\nmulhu a5, a1, a2\nmulhsu a6, a2, a1\necall\n");
    assert_eq!(r[13] as i32, -1, "(-2*3)>>32 signed");
    assert_eq!(r[14] as i32, -1, "signed -2 times unsigned 3");
    assert_eq!(r[15], 2, "0xfffffffe*3 = 0x2_fffffffa");
    assert_eq!(r[16], 2, "3 times unsigned 0xfffffffe");
    let r = r64("li a1, -2\nli a2, 3\nmulh a3, a1, a2\nmulhsu a4, a1, a2\nmulhu a5, a1, a2\necall\n");
    assert_eq!((r[13] as i64, r[14] as i64, r[15]), (-1, -1, 2));
}

#[test]
fn shift_amounts_are_masked() {
    let r = r32("li a1, 1\nli a2, 33\nsll a3, a1, a2\nli a4, -1\nsrl a5, a4, a2\nsra a6, a4, a2\necall\n");
    assert_eq!((r[13], r[15], r[16] as i32), (2, 0x7fff_ffff, -1));
    let r = r64("li a1, 1\nli a2, 65\nsll a3, a1, a2\nli a2, 33\nsllw a4, a1, a2\nli a5, -1\nsrlw a6, a5, a2\necall\n");
    assert_eq!(r[13], 2, "64-bit shifts use 6 bits");
    assert_eq!(r[14], 2, "W shifts use 5 bits");
    assert_eq!(r[16], 0x7fff_ffff);
}

#[test]
fn word_operations_sign_extend_bit_31() {
    let r = r64("li a1, 0x7fffffff\naddiw a2, a1, 1\naddw a3, a1, a1\nli a4, 0xffffffff00000001\nsubw a5, x0, a4\nslliw a6, a1, 1\nmulw a7, a1, a1\nli s2, 0x100000000\naddw s3, s2, x0\necall\n");
    assert_eq!(r[12] as i64, i32::MIN as i64);
    assert_eq!(r[13] as i64, -2);
    assert_eq!(r[15] as i64, -1, "upper bits ignored, result sign-extended");
    assert_eq!(r[16] as i64, -2);
    assert_eq!(r[17] as i64, 1);
    assert_eq!(r[19], 0, "addw ignores bits above 31");
}

#[test]
fn loads_extend_correctly() {
    let data = ".data\nv: .word 0x8081f2f3\nd: .dword 0x80000000fffffffe\n.text\nla t0, v\n";
    let ops = "lb a1, 0(t0)\nlbu a2, 0(t0)\nlh a3, 0(t0)\nlhu a4, 0(t0)\nlw a5, 0(t0)\nlb a6, 3(t0)\n";
    let r = r32(&format!("{data}{ops}ecall\n"));
    assert_eq!((r[11] as i32, r[12]), (0xf3u8 as i8 as i32, 0xf3));
    assert_eq!((r[13] as i32, r[14]), (0xf2f3u16 as i16 as i32, 0xf2f3));
    assert_eq!(r[15], 0x8081_f2f3);
    assert_eq!(r[16] as i32, -128);
    let r = r64(&format!("{data}{ops}lwu a7, 0(t0)\nld s2, 8(t0)\nlw s3, 8(t0)\nlwu s4, 8(t0)\necall\n"));
    assert_eq!(r[15] as i64, 0x8081_f2f3u32 as i32 as i64, "lw sign-extends on RV64");
    assert_eq!(r[17], 0x8081_f2f3, "lwu zero-extends");
    assert_eq!(r[18], 0x8000_0000_ffff_fffe);
    assert_eq!((r[19] as i64, r[20]), (-2, 0xffff_fffe));
}

#[test]
fn rv64_store_double() {
    let r = r64(".data\nb: .space 16\n.text\nla t0, b\nli t1, 0x0123456789abcdef\nsd t1, 8(t0)\nlw a0, 8(t0)\nlw a1, 12(t0)\nld a2, 8(t0)\nsw x0, 8(t0)\nld a3, 8(t0)\necall\n");
    assert_eq!((r[10] as i64, r[11]), (0x89ab_cdefu32 as i32 as i64, 0x0123_4567));
    assert_eq!(r[12], 0x0123_4567_89ab_cdef);
    assert_eq!(r[13], 0x0123_4567_0000_0000);
}

#[test]
fn lui_and_auipc_sign_extend_on_rv64() {
    let r = r64("lui a0, 0x80000\nlui a1, 0x7ffff\nauipc a2, 0x80000\necall\n");
    assert_eq!(r[10], 0xffff_ffff_8000_0000);
    assert_eq!(r[11], 0x7fff_f000);
    assert_eq!(r[12], 8u64.wrapping_add(0xffff_ffff_8000_0000));
    let r = r32("lui a0, 0x80000\nauipc a1, 1\necall\n");
    assert_eq!((r[10], r[11]), (0x8000_0000, 0x1004));
}

#[test]
fn x0_never_changes() {
    let src = "li x0, 5\naddi x0, x0, 1\nlui x0, 1\njal x0, 1f\n1: add x0, x0, x0\nadd a0, x0, x0\necall\n";
    assert_eq!(r32(src)[0], 0);
    assert_eq!(r32(src)[10], 0);
    assert_eq!(r64(src)[0], 0);
    // Loads into x0 are discarded too.
    assert_eq!(r32(".data\nv: .word 9\n.text\nla t0, v\nlw x0, 0(t0)\nadd a0, x0, x0\necall\n")[10], 0);
}

#[test]
fn jalr_clears_the_low_bit() {
    let src = "la t0, 1f\naddi t0, t0, 1\njalr ra, 0(t0)\nli a0, 9\necall\n1: li a0, 5\necall\n";
    assert_eq!(r32(src)[10], 5);
    assert_eq!(r64(src)[10], 5);
}

#[test]
fn ecall_ebreak_and_fence() {
    let mut p = p32("li a0, 3\nfence\nfence.i\necall\nli a0, 4\n");
    assert_eq!(p.registers()[10], 3, "ecall ends the program; fence is a no-op");
    assert_eq!(p.snapshot().halt.unwrap().kind, "complete");
    p = p32("li a0, 1\nebreak\nli a0, 2\n");
    let halt = p.snapshot().halt.unwrap();
    assert_eq!((halt.kind, p.registers()[10]), ("complete", 1));
    assert!(halt.message.contains("ebreak"));
    // Falling off the end of .text completes normally.
    assert_eq!(p32("li a0, 6\n").snapshot().halt.unwrap().kind, "complete");
}

/// The documented memory contract (see docs): data segment and stack only;
/// misaligned or outside accesses stop the run with a clear error and never
/// touch host memory.
#[test]
fn memory_faults_are_clean_errors() {
    let cases = [
        ("li t0, 0x10000001\nlw a0, 0(t0)\n", "misaligned load"),
        ("li t0, 0x10000002\nsw a0, 0(t0)\n", "misaligned store"),
        ("li t0, 0x10000001\nlh a0, 0(t0)\n", "misaligned load"),
        ("li t0, 0x20000000\nlw a0, 0(t0)\n", "out of bounds"),
        ("lw a0, 0(x0)\n", "out of bounds"),
        ("li t0, -4\nsw a0, 0(t0)\n", "out of bounds"),
        ("la t0, 1f\naddi t0, t0, 2\njr t0\n1: nop\n", "misaligned"),
    ];
    for (body, needle) in cases {
        let src = format!("{body}li a0, 77\necall\n");
        for halt in [
            {
                let mut p = Pipeline::new(assemble(&src).unwrap());
                p.run(1000);
                assert_ne!(p.registers()[10], 77, "{body}: execution must stop at the fault");
                p.snapshot().halt.unwrap()
            },
        ] {
            assert_eq!(halt.kind, "error", "{body}");
            assert!(halt.message.contains(needle), "{body}: {}", halt.message);
            assert!(halt.message.starts_with("line "), "names the line: {}", halt.message);
        }
        let mut p = Pipeline64::new(assemble64(&src).unwrap());
        p.run(1000);
        let halt = p.snapshot().halt.unwrap();
        assert_eq!(halt.kind, "error", "rv64 {body}");
        assert!(halt.message.contains(needle), "rv64 {body}: {}", halt.message);
        assert_eq!(run64(&assemble64(&src).unwrap(), 1000).outcome, Outcome::Error);
    }
}

#[test]
fn step_back_restores_the_full_architectural_state() {
    let mut rng = Rng::new(0x5BAC);
    for case in 0..iterations(60, 1000) {
        let xlen = if case % 2 == 0 { 32 } else { 64 };
        let src = Generator::new(&mut rng, xlen).program();
        let n = 1 + rng.below(300);
        if xlen == 32 {
            let mut p = Pipeline::new(assemble(&src).unwrap());
            for _ in 0..rng.below(50) {
                p.step_cycle();
            }
            let before = (p.registers(), p.snapshot().pc, p.stats().cycles, p.read_memory(0x1000_0000, 256), p.read_memory(0x7fff_ff00, 256), p.halted());
            let mut taken = 0;
            for _ in 0..n {
                if p.halted() {
                    break;
                }
                p.step_cycle();
                taken += 1;
            }
            let after_fwd = (p.registers(), p.snapshot().pc, p.stats().cycles);
            for _ in 0..taken {
                assert!(p.step_back(), "case {case}: history ran out");
            }
            let restored = (p.registers(), p.snapshot().pc, p.stats().cycles, p.read_memory(0x1000_0000, 256), p.read_memory(0x7fff_ff00, 256), p.halted());
            assert_eq!(restored, before, "case {case}: state differs after {taken} steps back\n{src}");
            // Replaying forward reaches the identical state again.
            for _ in 0..taken {
                p.step_cycle();
            }
            assert_eq!((p.registers(), p.snapshot().pc, p.stats().cycles), after_fwd, "case {case}: replay differs");
        } else {
            let mut p = Pipeline64::new(assemble64(&src).unwrap());
            let top = sim_engine::pipeline64::STACK_TOP64 - 248;
            let before = (p.registers(), p.snapshot().pc, p.stats().cycles, p.read_memory(0x1000_0000, 256), p.read_memory(top, 256));
            let mut taken = 0;
            for _ in 0..n {
                if p.halted() {
                    break;
                }
                p.step_cycle();
                taken += 1;
            }
            for _ in 0..taken {
                assert!(p.step_back());
            }
            let restored = (p.registers(), p.snapshot().pc, p.stats().cycles, p.read_memory(0x1000_0000, 256), p.read_memory(top, 256));
            assert_eq!(restored, before, "case {case}: rv64 state differs\n{src}");
        }
    }
}

/// Pinned timing for the documented 5-stage model: 4 fill cycles, a 1-cycle
/// load-use stall, EX-stage branch resolution with a 2-cycle mispredict
/// penalty, and a 2-bit predictor that starts at "not taken".
/// Columns: cycles, retired, stalls, flushed slots, branches, mispredictions.
const TIMING: &[(&str, &str, [u64; 6])] = &[
    ("independent", "addi x1, x0, 1\naddi x2, x0, 2\naddi x3, x0, 3\necall\n", [8, 4, 0, 0, 0, 0]),
    ("forward_chain", "addi x1, x0, 1\nadd x2, x1, x1\nadd x3, x2, x1\nadd x4, x3, x2\necall\n", [9, 5, 0, 0, 0, 0]),
    ("load_use", ".data\nv: .word 7\n.text\nla x5, v\nlw x1, 0(x5)\nadd x2, x1, x1\necall\n", [10, 5, 1, 0, 0, 0]),
    ("load_gap", ".data\nv: .word 7\n.text\nla x5, v\nlw x1, 0(x5)\nnop\nadd x2, x1, x1\necall\n", [10, 6, 0, 0, 0, 0]),
    ("loop", "li x1, 5\nloop: addi x1, x1, -1\nbnez x1, loop\necall\n", [20, 12, 0, 3, 5, 2]),
    ("call", "li a0, 1\ncall f\naddi a0, a0, 1\necall\nf: addi a0, a0, 10\nret\n", [14, 6, 0, 2, 2, 2]),
    ("not_taken", "li x1, 1\nbeqz x1, skip\naddi x2, x0, 5\nskip: ecall\n", [8, 4, 0, 0, 1, 0]),
    ("taken_once", "li x1, 0\nbeqz x1, skip\naddi x2, x0, 5\nskip: ecall\n", [9, 3, 0, 2, 1, 1]),
];

#[test]
fn pipeline_timing_is_pinned() {
    for (name, src, want) in TIMING {
        let s = p32(src).stats();
        assert_eq!([s.cycles, s.instructions, s.stalls, s.flushes, s.branches, s.mispredictions], *want, "RV32 {name}");
        let s = p64(src).stats();
        assert_eq!([s.cycles, s.instructions, s.stalls, s.flushes, s.branches, s.mispredictions], *want, "RV64 {name}");
    }
}

#[test]
fn runs_are_deterministic() {
    let mut rng = Rng::new(0xDE7);
    for _ in 0..50 {
        let src = Generator::new(&mut rng, 64).program();
        let a = p64(&src);
        let b = p64(&src);
        assert_eq!((a.registers(), a.stats().cycles, a.stats().stalls), (b.registers(), b.stats().cycles, b.stats().stalls));
    }
}

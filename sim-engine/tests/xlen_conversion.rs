use sim_engine::{
    assemble, assemble64, rv32_to_rv64, rv64_to_rv32, Pipeline, Pipeline64, XlenConvertError,
    DATA_BASE,
};

fn run32(source: &str) -> Pipeline {
    let program = assemble(source).expect("RV32 source should assemble");
    let mut pipeline = Pipeline::new(program);
    assert!(pipeline.run(100_000), "RV32 source should complete");
    pipeline
}

fn run64(source: &str) -> Pipeline64 {
    let program = assemble64(source).expect("RV64 source should assemble");
    let mut pipeline = Pipeline64::new(program);
    assert!(pipeline.run(100_000), "RV64 source should complete");
    pipeline
}

fn canonical32(value: u32) -> u64 {
    value as i32 as i64 as u64
}

fn assert_widened_registers(source: &str, registers: &[usize]) -> String {
    let converted = rv32_to_rv64(source).expect("RV32 source should widen");
    let rv32 = run32(source);
    let rv64 = run64(&converted);
    for &register in registers {
        assert_eq!(
            rv64.registers()[register],
            canonical32(rv32.registers()[register]),
            "x{register} differs after widening\n{converted}"
        );
    }
    converted
}

fn assert_narrowed_registers(source: &str, registers: &[usize]) -> String {
    let converted = rv64_to_rv32(source).expect("RV64 source should narrow");
    let rv64 = run64(source);
    let rv32 = run32(&converted);
    for &register in registers {
        assert_eq!(
            canonical32(rv32.registers()[register]),
            rv64.registers()[register],
            "x{register} differs after narrowing\n{converted}"
        );
    }
    converted
}

fn assert_narrowing_rejected(source: &str, line: usize, reason: &str) {
    let error: XlenConvertError =
        rv64_to_rv32(source).expect_err("unsafe RV64 input must not produce RV32 output");
    assert_eq!(error.line, line);
    assert!(
        error.message.contains(reason),
        "expected rejection containing {reason:?}, got {:?}",
        error.message
    );
}

macro_rules! narrowing_rejection_test {
    ($name:ident, $source:expr, $line:expr, $reason:expr) => {
        #[test]
        fn $name() {
            assert_narrowing_rejected($source, $line, $reason);
        }
    };
}

narrowing_rejection_test!(
    narrowing_rejects_wide_data_directives,
    ".data\nvalue: .dword 0x100000000\n.text\necall\n",
    2,
    "use .word data and narrow load/store instructions"
);

narrowing_rejection_test!(
    narrowing_rejects_64_bit_memory_transfers,
    "ld x1, 0(x2)\necall\n",
    1,
    "64-bit memory transfers have no RV32 equivalent; use lw/sw"
);

narrowing_rejection_test!(
    narrowing_rejects_unsigned_word_loads,
    "lwu x1, 0(x2)\necall\n",
    1,
    "zero-extension above bit 31 is observable"
);

narrowing_rejection_test!(
    narrowing_rejects_full_width_add_immediates,
    "addi x1, x0, 1\necall\n",
    1,
    "use addiw to declare 32-bit wraparound intent"
);

narrowing_rejection_test!(
    narrowing_rejects_full_width_register_arithmetic,
    "add x1, x2, x3\necall\n",
    1,
    "use the corresponding addw/subw operation"
);

narrowing_rejection_test!(
    narrowing_rejects_full_width_immediate_shifts,
    "slli x1, x2, 32\necall\n",
    1,
    "use the corresponding word-immediate shift"
);

narrowing_rejection_test!(
    narrowing_rejects_full_width_register_shifts,
    "sll x1, x2, x3\necall\n",
    1,
    "use the corresponding word register shift"
);

narrowing_rejection_test!(
    narrowing_rejects_full_width_rv64m_operations,
    "mul x1, x2, x3\necall\n",
    1,
    "use the corresponding RV64M word operation"
);

narrowing_rejection_test!(
    narrowing_rejects_high_half_multiplication,
    "mulh x1, x2, x3\necall\n",
    1,
    "the high half of a 64-bit product has no RV32 equivalent"
);

narrowing_rejection_test!(
    narrowing_rejects_full_width_negation,
    "neg x1, x2\necall\n",
    1,
    "write subw rd, x0, rs to declare 32-bit negation"
);

narrowing_rejection_test!(
    narrowing_rejects_noncanonical_32_bit_literals,
    "li x1, 0x100000000\necall\n",
    1,
    "not a sign-extended 32-bit value"
);

narrowing_rejection_test!(
    narrowing_rejects_numeric_control_targets,
    "jal x1, 8\necall\n",
    1,
    "numeric branch and jump targets are not conversion-safe; use a label"
);

#[test]
fn widening_preserves_overflow_and_signed_control_flow() {
    let source = "li x1, 0x7fffffff\n\
                  addi x1, x1, 1\n\
                  blt x1, x0, negative\n\
                  li a0, 0\n\
                  j done\n\
                  negative: li a0, 0xffffffff\n\
                  done: ecall\n";
    let converted = assert_widened_registers(source, &[1, 10]);
    assert!(converted.contains("addiw x1, x1, 1"));
    assert!(converted.contains("li a0, -1"));
}

#[test]
fn widening_preserves_high_multiply_and_bitwise_results() {
    let source = "li x1, -2\n\
                  li x2, 0xffffffff\n\
                  mulh x3, x1, x2\n\
                  mulhsu x4, x1, x2\n\
                  mulhu x5, x1, x2\n\
                  xori x6, x2, 0x7ff\n\
                  ecall\n";
    assert_widened_registers(source, &[1, 2, 3, 4, 5, 6, 31]);
}

#[test]
fn widening_preserves_data_memory_and_function_results() {
    let source = ".data\n\
                  value: .word 0x80000000\n\
                  output: .word 0\n\
                  .text\n\
                  la x5, value\n\
                  lw a0, 0(x5)\n\
                  call increment\n\
                  la x6, output\n\
                  sw a0, 0(x6)\n\
                  ecall\n\
                  increment: addi a0, a0, 1\n\
                  ret\n";
    let converted = rv32_to_rv64(source).unwrap();
    let rv32 = run32(source);
    let rv64 = run64(&converted);
    assert_eq!(rv64.registers()[10], canonical32(rv32.registers()[10]));
    assert_eq!(
        rv64.read_memory(DATA_BASE as u64, 8),
        rv32.read_memory(DATA_BASE, 8)
    );
}

#[test]
fn narrowing_preserves_word_arithmetic_and_signedness() {
    let source = "li x1, 2147483647\n\
                  addiw x2, x1, 1\n\
                  sraiw x3, x2, 31\n\
                  li x4, 7\n\
                  mulw x5, x2, x4\n\
                  divw a0, x5, x4\n\
                  ecall\n";
    assert_narrowed_registers(source, &[1, 2, 3, 4, 5, 10]);
}

#[test]
fn narrowing_preserves_memory_and_branches_for_safe_source() {
    let source = ".data\n\
                  value: .word 0x80000000\n\
                  .text\n\
                  la x1, value\n\
                  lw x2, 0(x1)\n\
                  bgez x2, wrong\n\
                  addiw a0, x2, 1\n\
                  ecall\n\
                  wrong: li a0, 0\n\
                  ecall\n";
    assert_narrowed_registers(source, &[2, 10]);
}

#[test]
fn widen_then_narrow_round_trip_executes_equivalently() {
    let source = "li x1, 0x7fffffff\n\
                  addi x2, x1, 1\n\
                  xor x3, x2, x1\n\
                  srai x4, x2, 4\n\
                  mul x5, x3, x4\n\
                  bne x5, x0, done\n\
                  li x5, 1\n\
                  done: mv a0, x5\n\
                  ecall\n";
    let widened = rv32_to_rv64(source).unwrap();
    let narrowed = rv64_to_rv32(&widened).unwrap();
    let original = run32(source);
    let round_trip = run32(&narrowed);
    for register in [1, 2, 3, 4, 5, 10] {
        assert_eq!(
            round_trip.registers()[register],
            original.registers()[register],
            "x{register} differs after round trip\n{narrowed}"
        );
    }
}

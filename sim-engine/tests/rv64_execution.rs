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

//! Stage 1 item 2: hand-written assembly calling translated C, and
//! translated C calling hand-written assembly (psABI scalar signatures),
//! on RV32 and RV64. The C side declares assembly functions with a
//! prototype that has no body; the two texts are concatenated.

mod support;

use support::{run_asm32, run_asm64};

/// C half: calls into assembly (`add3`, `clobber`, `apply`, `sum_words`)
/// and offers `scale` for assembly to call.
const C_SIDE: &str = "\
int add3(int a, int b, int c);
int clobber(int x);
int apply(int x);
int sum_words(int *a, int n);
long widen(long x);
int scale(int x) { return x * 10; }
int keep(int x) { return x + 1; }
int main() {
    int v[4] = {1, 2, 3, 4};
    int r = add3(1, 2, 3);
    r = r + 7 * (r + clobber(3));
    r = r + apply(4);
    r = r + sum_words(v, 4);
    r = r + widen(-2);
    return r;
}
";

/// Expected: add3 = 6; 6 + 7 * (6 + 3) = 69; apply(4) = scale(4) + 1 = 41
/// -> 110; sum_words = 10 -> 120; widen(-2) = -4 -> 116.
const EXPECTED: i64 = 116;

const ASM32: &str = "\
.text
add3:
    add a0, a0, a1
    add a0, a0, a2
    ret
# returns its argument but trashes every caller-saved temporary
clobber:
    li t0, -1
    li t1, -1
    li t2, -1
    li t3, -1
    li t4, -1
    li t5, -1
    li t6, -1
    ret
# apply(x) = scale(x) + 1: assembly calling translated C; s1 must survive
apply:
    addi sp, sp, -16
    sw ra, 12(sp)
    sw s1, 8(sp)
    li s1, 1234
    call scale
    li t0, 1234
    bne s1, t0, broken
    addi a0, a0, 1
    lw s1, 8(sp)
    lw ra, 12(sp)
    addi sp, sp, 16
    ret
broken:
    li a0, -1000
    lw s1, 8(sp)
    lw ra, 12(sp)
    addi sp, sp, 16
    ret
sum_words:
    li t0, 0
sum_loop:
    beqz a1, sum_done
    lw t1, 0(a0)
    add t0, t0, t1
    addi a0, a0, 4
    addi a1, a1, -1
    j sum_loop
sum_done:
    mv a0, t0
    ret
widen:
    add a0, a0, a0
    ret
";

const ASM64: &str = "\
.text
add3:
    addw a0, a0, a1
    addw a0, a0, a2
    ret
clobber:
    li t0, -1
    li t1, -1
    li t2, -1
    li t3, -1
    li t4, -1
    li t5, -1
    li t6, -1
    ret
apply:
    addi sp, sp, -16
    sd ra, 8(sp)
    sd s1, 0(sp)
    li s1, 1234
    call scale
    li t0, 1234
    bne s1, t0, broken
    addiw a0, a0, 1
    ld s1, 0(sp)
    ld ra, 8(sp)
    addi sp, sp, 16
    ret
broken:
    li a0, -1000
    ld s1, 0(sp)
    ld ra, 8(sp)
    addi sp, sp, 16
    ret
sum_words:
    li t0, 0
sum_loop:
    beqz a1, sum_done
    lw t1, 0(a0)
    addw t0, t0, t1
    addi a0, a0, 4
    addi a1, a1, -1
    j sum_loop
sum_done:
    mv a0, t0
    ret
widen:
    add a0, a0, a0
    ret
";

fn link(c_asm: &str, hand: &str) -> String {
    format!("{c_asm}\n{hand}")
}

#[test]
fn c_and_assembly_call_each_other_on_rv32() {
    let c_asm = sim_engine::c_to_asm(C_SIDE).unwrap_or_else(|e| panic!("line {}: {}", e.line, e.message));
    assert!(c_asm.contains("# external: add3()"), "{c_asm}");
    assert_eq!(run_asm32(&link(&c_asm, ASM32)), Ok(EXPECTED));
}

#[test]
fn c_and_assembly_call_each_other_on_rv64() {
    let c_asm = sim_engine::c_to_asm64(C_SIDE).unwrap_or_else(|e| panic!("line {}: {}", e.line, e.message));
    assert_eq!(run_asm64(&link(&c_asm, ASM64)), Ok(EXPECTED));
}

/// RV64 psABI: a 32-bit `unsigned` travels sign-extended, and the C side
/// re-canonicalizes what an assembly function returns.
#[test]
fn rv64_abi_extension_rules_hold_across_the_boundary() {
    let c = "unsigned passthrough(unsigned x);
unsigned char low(int x);
int main() {
    unsigned u = 4294967295u;
    unsigned r = passthrough(u);
    return (r == 4294967295u) + 10 * (low(511) == 255) + 100 * (low(256) == 0);
}
";
    let asm = "\
.text
passthrough:
    # psABI: the unsigned value arrives sign-extended (all ones)
    li t0, -1
    bne a0, t0, bad
    ret
bad:
    li a0, 0
    ret
# returns garbage above bit 7; the C side must truncate to unsigned char
low:
    ret
";
    let c_asm = sim_engine::c_to_asm64(c).unwrap_or_else(|e| panic!("{}", e.message));
    assert_eq!(run_asm64(&link(&c_asm, asm)), Ok(111));
    let c_asm = sim_engine::c_to_asm(c).unwrap_or_else(|e| panic!("{}", e.message));
    assert_eq!(run_asm32(&link(&c_asm, asm)), Ok(111));
}

#[test]
fn a_missing_assembly_definition_is_reported_at_assembly_time() {
    let c_asm = sim_engine::c_to_asm("int ext(int x);\nint main() { return ext(1); }").unwrap();
    let err = run_asm32(&c_asm).unwrap_err();
    assert!(err.contains("ext"), "{err}");
    // without a prototype, the C compiler itself names the problem
    let err = sim_engine::c_to_asm("int main() { return ext(1); }").unwrap_err();
    assert!(err.message.contains("only functions defined in this snippet"), "{}", err.message);
    // conflicting prototypes for the same external function
    let err = sim_engine::c_to_asm("int ext(int x);\nint ext(int x, int y);\nint main() { return ext(1); }").unwrap_err();
    assert!(err.message.contains("conflicting prototypes") || err.message.contains("expects"), "{}", err.message);
}

#[test]
fn programs_without_external_prototypes_are_unchanged() {
    let asm = sim_engine::c_to_asm("int f(int x);\nint f(int x) { return x; }\nint main() { return f(2); }").unwrap();
    assert!(!asm.contains("# external"), "{asm}");
    assert_eq!(run_asm32(&asm), Ok(2));
}

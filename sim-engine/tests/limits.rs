//! Every documented limit is enforced exactly at its boundary: the limit
//! itself is accepted and limit + 1 is rejected with a message naming it.

mod support;

use sim_engine::limits::*;
use sim_engine::{assemble, assemble64, c_to_asm, rust_to_asm, Pipeline, Pipeline64};

fn first_error32(src: &str) -> Option<String> {
    assemble(src).err().map(|e| e[0].message.clone())
}
fn first_error64(src: &str) -> Option<String> {
    assemble64(src).err().map(|e| e[0].message.clone())
}

/// A source of exactly `len` bytes made of comment padding.
fn padded(prefix: &str, len: usize) -> String {
    let mut s = prefix.to_string();
    while s.len() + 60 < len {
        s.push_str("# padding padding padding padding padding padding padding\n");
    }
    while s.len() < len {
        s.push('\n');
    }
    s
}

#[test]
fn source_size_limit_boundary() {
    let ok = padded("nop\n", MAX_SOURCE_BYTES);
    assert_eq!(ok.len(), MAX_SOURCE_BYTES);
    assert_eq!(first_error32(&ok), None);
    assert_eq!(first_error64(&ok), None);
    let over = format!("{ok}\n");
    for msg in [first_error32(&over), first_error64(&over)] {
        let msg = msg.expect("limit + 1 must fail");
        assert!(msg.contains("source is too large") && msg.contains(&MAX_SOURCE_BYTES.to_string()), "{msg}");
    }
    let c_ok = padded("int main() { return 0; }\n", MAX_SOURCE_BYTES).replace("# ", "//");
    assert!(c_to_asm(&c_ok).is_ok());
    let c_over = format!("{c_ok}\n");
    assert!(c_to_asm(&c_over).unwrap_err().message.contains("source is too large"));
}

#[test]
fn line_length_limit_boundary() {
    let line = |n: usize| format!("nop # {}\n", "x".repeat(n - 6));
    assert_eq!(first_error32(&line(MAX_LINE_LENGTH)), None);
    let msg = first_error32(&line(MAX_LINE_LENGTH + 1)).expect("too long");
    assert!(msg.contains("too long") && msg.contains(&MAX_LINE_LENGTH.to_string()), "{msg}");
    let msg = first_error64(&line(MAX_LINE_LENGTH + 1)).expect("too long");
    assert!(msg.contains("too long"), "{msg}");
}

#[test]
fn nesting_depth_limit_boundary() {
    let nested = |d: usize| format!("int main() {{ return {}1{}; }}", "(".repeat(d), ")".repeat(d));
    // main's own body brace counts as one level.
    assert!(c_to_asm(&nested(MAX_NESTING_DEPTH - 1)).is_ok());
    let err = c_to_asm(&nested(MAX_NESTING_DEPTH)).unwrap_err();
    assert!(err.message.contains("nested too deeply") && err.message.contains(&MAX_NESTING_DEPTH.to_string()), "{}", err.message);
    let rust = |d: usize| format!("fn main() -> i32 {{ {}1{} }}", "(".repeat(d), ")".repeat(d));
    assert!(rust_to_asm(&rust(MAX_NESTING_DEPTH - 1)).is_ok());
    assert!(rust_to_asm(&rust(MAX_NESTING_DEPTH)).unwrap_err().message.contains("nested too deeply"));
    // Prefix-operator chains have no brackets; the parser backstop rejects them.
    let unary = format!("int main() {{ return {}1; }}", "- ".repeat(MAX_NESTING_DEPTH * 4));
    assert!(c_to_asm(&unary).unwrap_err().message.contains("nested too deeply"));
}

#[test]
fn label_count_limit_boundary() {
    let labels = |n: usize| (0..n).map(|i| format!("l{i}:\n")).collect::<String>() + "nop\n";
    assert_eq!(first_error32(&labels(MAX_LABELS)), None);
    let msg = first_error32(&labels(MAX_LABELS + 1)).expect("too many labels");
    assert!(msg.contains("too many labels") && msg.contains(&MAX_LABELS.to_string()), "{msg}");
    assert!(first_error64(&labels(MAX_LABELS + 1)).unwrap().contains("too many labels"));
}

#[test]
fn string_literal_limit_boundary() {
    let s = |n: usize| format!(".data\nmsg: .ascii \"{}\"\n.text\nnop\n", "a".repeat(n));
    assert_eq!(first_error32(&s(MAX_STRING_LITERAL_BYTES)), None);
    let msg = first_error32(&s(MAX_STRING_LITERAL_BYTES + 1)).expect("too long");
    assert!(msg.contains("string literal is too long") && msg.contains(&MAX_STRING_LITERAL_BYTES.to_string()), "{msg}");
    assert!(first_error64(&s(MAX_STRING_LITERAL_BYTES + 1)).is_some());
}

#[test]
fn instruction_count_limit_boundary() {
    // `li` with a large constant expands to two instructions on RV32.
    let n = |count: usize| "nop\n".repeat(count);
    let at = n(MAX_INSTRUCTIONS);
    assert!(at.len() <= MAX_SOURCE_BYTES);
    assert_eq!(first_error32(&at), None);
    let msg = first_error32(&n(MAX_INSTRUCTIONS + 1)).expect("too long");
    assert!(msg.contains("program is too long") && msg.contains(&MAX_INSTRUCTIONS.to_string()), "{msg}");
    assert!(first_error64(&n(MAX_INSTRUCTIONS + 1)).unwrap().contains("program is too long"));
}

#[test]
fn data_size_limit_boundary() {
    let space = |n: usize| format!(".data\nbuf: .space {n}\n.text\nnop\n");
    assert_eq!(first_error32(&space(MAX_DATA_BYTES)), None);
    let msg = first_error32(&space(MAX_DATA_BYTES + 1)).expect("too big");
    assert!(msg.contains("static data is too large") && msg.contains(&MAX_DATA_BYTES.to_string()), "{msg}");
    assert!(first_error64(&space(MAX_DATA_BYTES + 1)).unwrap().contains("static data is too large"));
    // A huge request must fail fast, without allocating it.
    let start = std::time::Instant::now();
    assert!(first_error32(&space(usize::MAX / 4)).is_some());
    assert!(start.elapsed().as_secs() < 2);
}

#[test]
fn step_limit_stops_an_infinite_loop_with_a_clear_result() {
    let src = "loop: j loop\n";
    let mut p = Pipeline::new(assemble(src).unwrap());
    assert!(!p.run(5_000), "an infinite loop must not report a clean halt");
    let halt = p.snapshot().halt.expect("halt info");
    assert_eq!(halt.kind, "error");
    assert!(halt.message.starts_with("step limit reached"), "{}", halt.message);
    assert!(halt.message.contains("5000"));
    assert_eq!(p.stats().cycles, 5_000, "stops exactly at the limit");

    let mut p = Pipeline64::new(assemble64(src).unwrap());
    assert!(!p.run(DEFAULT_STEP_LIMIT));
    assert!(p.snapshot().halt.unwrap().message.starts_with("step limit reached"));
    assert_eq!(p.stats().cycles, DEFAULT_STEP_LIMIT);
}

#[test]
fn step_limit_of_exactly_the_needed_cycles_completes() {
    let src = "addi a0, x0, 1\naddi a0, a0, 1\necall\n";
    let mut probe = Pipeline::new(assemble(src).unwrap());
    assert!(probe.run(1_000));
    let needed = probe.stats().cycles;
    let mut exact = Pipeline::new(assemble(src).unwrap());
    assert!(exact.run(needed), "a budget of exactly {needed} cycles is enough");
    let mut short = Pipeline::new(assemble(src).unwrap());
    assert!(!short.run(needed - 1), "one cycle fewer must hit the limit");
}

#[test]
fn simulator_memory_is_bounded() {
    // Stores anywhere outside the data segment and stack end the run cleanly.
    for addr in ["0x0", "0x0ffffffc", "0x20000000", "0x7fbffffc", "0x80000000", "0xfffffffc"] {
        let src = format!("li t0, {addr}\nsw t0, 0(t0)\necall\n");
        let mut p = Pipeline::new(assemble(&src).unwrap());
        p.run(1_000);
        let halt = p.snapshot().halt.unwrap();
        assert_eq!(halt.kind, "error", "{addr}");
        assert!(halt.message.contains("out of bounds"), "{addr}: {}", halt.message);
    }
}

#[test]
fn memory_reads_are_capped() {
    let p = Pipeline::new(assemble("nop\n").unwrap());
    assert_eq!(p.read_memory(0x1000_0000, usize::MAX).len(), MAX_MEMORY_READ_BYTES);
    let p = Pipeline64::new(assemble64("nop\n").unwrap());
    assert_eq!(p.read_memory(0x1000_0000, 16).len(), 16);
}

/// Shapes that brackets do not show are bounded too, each with a plain
/// message instead of a stack overflow.
#[test]
fn chains_ladders_and_macro_nesting_are_bounded() {
    let sum = |terms: usize| format!("int main() {{ return {}; }}", vec!["1"; terms].join(" + "));
    assert_eq!(support::run_c32(&sum(40)), Ok(40));
    let err = c_to_asm(&sum(2_000)).unwrap_err();
    assert!(err.message.contains("too long or nested too deeply"), "{}", err.message);
    assert!(err.message.contains("split it into smaller pieces"), "{}", err.message);

    let ladder = |arms: usize| {
        format!("int main() {{ int x = 3; {} x = 9; return x; }}", "if (x == 1) x = 1; else ".repeat(arms))
    };
    assert!(c_to_asm(&ladder(40)).is_ok());
    assert!(c_to_asm(&ladder(500)).unwrap_err().message.contains("nested too deeply"));
    let rust_ladder = format!(
        "fn main() -> i32 {{ let mut x = 0; {} {{ x = 2; }} x }}",
        "if x == 1 { x = 1; } else ".repeat(500)
    );
    assert!(rust_to_asm(&rust_ladder).unwrap_err().message.contains("nested too deeply"));

    let macro_args = format!("#define G(a) a\nint main() {{ return {}1{}; }}", "G(".repeat(500), ")".repeat(500));
    assert!(c_to_asm(&macro_args).unwrap_err().message.contains("macro expansion is nested too deeply"));
    let pp_unary = format!("#if {}1\nint main() {{ return 1; }}\n#endif\n", "- ".repeat(5_000));
    assert!(c_to_asm(&pp_unary).is_ok(), "an even count of '-' is 1, so the #if is true");
}

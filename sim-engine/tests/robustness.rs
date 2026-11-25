//! PART B robustness floor: no public text entry point may panic or hang,
//! whatever bytes it is given.
//!
//! Every input runs on a thread with a 1 MiB stack (about what a browser
//! gives a WASM module), inside `catch_unwind`, with a wall-clock bound.

mod support;

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::{Duration, Instant};
use support::{entry_points, iterations, sample, vocabulary, Lang, Rng, TextFn};

/// Stack per fuzz call. Release code at the nesting limit fits in 512 KiB,
/// half of a typical browser WASM stack (1 MiB); unoptimized debug frames are
/// several times larger, so debug runs get 2 MiB.
const DEFAULT_STACK: usize = if cfg!(debug_assertions) { 2 << 20 } else { 512 << 10 };
const PER_CALL_BOUND: Duration = Duration::from_secs(3);

/// Run `f(input)` and fail with the entry point name if it panics or is slow.
fn must_not_panic(name: &str, f: TextFn, input: &str) -> Result<String, String> {
    if std::env::var("ROBUST_TRACE").is_ok() { eprintln!("TRACE {name} {}", input.len()); }
    let start = Instant::now();
    let owned = input.to_string();
    let result = std::thread::Builder::new()
        .stack_size(std::env::var("ROBUST_STACK").ok().and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_STACK))
        .spawn(move || catch_unwind(AssertUnwindSafe(|| f(&owned))))
        .expect("spawn")
        .join();
    let elapsed = start.elapsed();
    let outcome = match result {
        Ok(Ok(r)) => r,
        _ => panic!(
            "{name} panicked on input ({} bytes): {:?}",
            input.len(),
            input.chars().take(300).collect::<String>()
        ),
    };
    assert!(
        elapsed < PER_CALL_BOUND,
        "{name} took {elapsed:?} on a {}-byte input",
        input.len()
    );
    outcome
}

/// Errors must be plain English: no Rust debug formatting leaking through.
fn assert_plain_message(name: &str, input: &str, outcome: &Result<String, String>) {
    if let Err(msg) = outcome {
        assert!(!msg.trim().is_empty(), "{name} returned an empty error for {input:?}");
        for leak in ["Some(", "None", "Ok(", "Err(", "Sym(", "Ident(", "Kw(", "Tok::", "SpTok"] {
            assert!(
                !msg.contains(leak),
                "{name} error leaks debug formatting ({leak}): {msg}"
            );
        }
    }
}

fn garbage(rng: &mut Rng, max_len: u64) -> String {
    let len = rng.below(max_len) as usize;
    let bytes: Vec<u8> = (0..len)
        .map(|_| match rng.below(10) {
            0..=5 => b" \n\t(){}[];,:=+-*/%<>!&|^~#.'\"\\0123456789abcxyzAZ_"
                [rng.below(49) as usize],
            6 => 0,
            _ => rng.next_u64() as u8,
        })
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn token_soup(rng: &mut Rng, lang: Lang, max_tokens: u64) -> String {
    let vocab = vocabulary(lang);
    let n = rng.below(max_tokens);
    let mut out = String::new();
    for _ in 0..n {
        out.push_str(*rng.pick::<&str>(vocab));
        out.push(if rng.chance(15) { '\n' } else { ' ' });
    }
    out
}

/// Token soup spliced into a valid program: exercises deep parser states.
fn mutated_sample(rng: &mut Rng, lang: Lang) -> String {
    let base = sample(lang);
    let cut = base
        .char_indices()
        .map(|(i, _)| i)
        .nth(rng.below(base.len() as u64) as usize)
        .unwrap_or(0);
    let mut s = base[..cut].to_string();
    s.push_str(&token_soup(rng, lang, 6));
    let resume = base
        .char_indices()
        .map(|(i, _)| i)
        .find(|&i| i >= cut + rng.below(20) as usize)
        .unwrap_or(base.len());
    s.push_str(&base[resume..]);
    s
}

#[test]
fn garbage_bytes_never_panic() {
    let mut rng = Rng::new(0xB0B);
    for (name, _, f) in entry_points() {
        for _ in 0..iterations(60, 2000) {
            let input = garbage(&mut rng, 400);
            let out = must_not_panic(name, f, &input);
            assert_plain_message(name, &input, &out);
        }
    }
}

#[test]
fn token_soup_never_panics() {
    let mut rng = Rng::new(0x5077);
    for (name, lang, f) in entry_points() {
        for _ in 0..iterations(150, 5000) {
            let input = token_soup(&mut rng, lang, 60);
            let out = must_not_panic(name, f, &input);
            assert_plain_message(name, &input, &out);
        }
    }
}

#[test]
fn mutated_valid_programs_never_panic() {
    let mut rng = Rng::new(0x3117);
    for (name, lang, f) in entry_points() {
        for _ in 0..iterations(150, 5000) {
            let input = mutated_sample(&mut rng, lang);
            let out = must_not_panic(name, f, &input);
            assert_plain_message(name, &input, &out);
        }
    }
}

#[test]
fn samples_are_accepted_by_their_entry_points() {
    for (name, lang, f) in entry_points() {
        // Narrowing is deliberately strict; feed it a widened RV32 program.
        let widened = sim_engine::rv32_to_rv64(support::ASM32_SAMPLE).expect("widen sample");
        let input = if name == "rv64_to_rv32" { widened.as_str() } else { sample(lang) };
        let out = must_not_panic(name, f, input);
        assert!(out.is_ok(), "{name} rejected its sample: {:?}", out.err());
    }
}

#[test]
fn truncated_programs_at_every_byte_offset_never_panic() {
    for (name, lang, f) in entry_points() {
        let src = sample(lang);
        for cut in 0..=src.len() {
            if src.is_char_boundary(cut) {
                let _ = must_not_panic(name, f, &src[..cut]);
            }
        }
    }
}

#[test]
fn empty_and_whitespace_input_never_panic() {
    for (name, _, f) in entry_points() {
        for input in ["", " ", "\n", "\n\n\t  \r\n", "\0", "\u{feff}", "\r"] {
            let out = must_not_panic(name, f, input);
            assert_plain_message(name, input, &out);
        }
    }
}

#[test]
fn nul_bytes_and_replacement_characters_never_panic() {
    for (name, lang, f) in entry_points() {
        let src = sample(lang);
        let mid = src.len() / 2;
        let mid = (mid..src.len()).find(|&i| src.is_char_boundary(i)).unwrap_or(0);
        for insert in ["\0", "\u{fffd}", "\u{1F600}", "é", "\u{200b}"] {
            let input = format!("{}{insert}{}", &src[..mid], &src[mid..]);
            let out = must_not_panic(name, f, &input);
            assert_plain_message(name, &input, &out);
        }
    }
}

fn nested_expression(lang: Lang, depth: usize) -> String {
    let expr = format!("{}1{}", "(".repeat(depth), ")".repeat(depth));
    match lang {
        Lang::Rust => format!("fn main() -> i32 {{ {expr} }}\n"),
        Lang::Asm32 | Lang::Asm64 => format!("addi a0, x0, {expr}\n"),
        _ => format!("int main() {{ return {expr}; }}\n"),
    }
}

fn nested_blocks(lang: Lang, depth: usize) -> String {
    let body = format!("{}{}", "{ ".repeat(depth), " }".repeat(depth));
    match lang {
        Lang::Rust => format!("fn main() -> i32 {{ {body} 0 }}\n"),
        Lang::Asm32 | Lang::Asm64 => body,
        _ => format!("int main() {{ {body} return 0; }}\n"),
    }
}

fn nested_unary(lang: Lang, depth: usize) -> String {
    let expr = format!("{}1", "-".repeat(depth));
    match lang {
        Lang::Rust => format!("fn main() -> i32 {{ {} }}\n", "- ".repeat(depth) + "1"),
        Lang::Asm32 | Lang::Asm64 => format!("li a0, {expr}\n"),
        _ => format!("int main() {{ return {}1; }}\n", "- ".repeat(depth)),
    }
}

fn nested_ifs(lang: Lang, depth: usize) -> String {
    match lang {
        Lang::Rust => format!(
            "fn main() -> i32 {{ let mut x = 0; {} x = 1; {} x }}\n",
            "if x == 0 { ".repeat(depth),
            "}".repeat(depth)
        ),
        Lang::Asm32 | Lang::Asm64 => "nop\n".repeat(depth),
        _ => format!(
            "int main() {{ int x = 0; {} x = 1; {} return x; }}\n",
            "if (x == 0) { ".repeat(depth),
            "}".repeat(depth)
        ),
    }
}

#[test]
fn deeply_nested_input_is_rejected_cleanly_or_accepted() {
    for depth in [10, 100, 127, 128, 129, 255, 256, 257, 1_000, 10_000, 100_000] {
        for (name, lang, f) in entry_points() {
            for input in [
                nested_expression(lang, depth),
                nested_blocks(lang, depth),
                nested_unary(lang, depth),
                nested_ifs(lang, depth),
            ] {
                let out = must_not_panic(name, f, &input);
                assert_plain_message(name, &input[..input.len().min(40)], &out);
            }
        }
    }
}

#[test]
fn oversized_input_is_rejected_with_a_clear_limit_error() {
    let limit = sim_engine::limits::MAX_SOURCE_BYTES;
    for (name, lang, f) in entry_points() {
        let mut input = sample(lang).to_string();
        while input.len() <= limit {
            input.push_str("\n// padding padding padding padding padding padding padding\n");
        }
        let out = must_not_panic(name, f, &input);
        let msg = out.expect_err("oversized input must be rejected");
        assert!(msg.contains("source is too large"), "{name}: {msg}");
        assert!(msg.contains(&limit.to_string()), "{name} must name the limit: {msg}");
    }
}

#[test]
fn every_entry_point_is_deterministic() {
    for (name, lang, f) in entry_points() {
        let first = f(sample(lang));
        for _ in 0..3 {
            assert_eq!(first, f(sample(lang)), "{name} output differs between runs");
        }
    }
    // Determinism under mutation as well (error paths included).
    let mut rng = Rng::new(7);
    for (name, lang, f) in entry_points() {
        for _ in 0..20 {
            let input = mutated_sample(&mut rng, lang);
            assert_eq!(f(&input), f(&input), "{name} not deterministic on {input:?}");
        }
    }
}

/// Hand-picked adversarial inputs aimed at arithmetic overflow, huge
/// allocations and extreme literals.
#[test]
fn adversarial_inputs_never_panic() {
    let c_like = [
        "int main() { int a[2000000000]; return 0; }",
        "int main() { int a[99999999999999999999]; return 0; }",
        "int main() { int a[0]; return 0; }",
        "int main() { int a[-1]; return 0; }",
        "int main() { int a[3] = {1,2,3,4,5}; return a[7]; }",
        "int main() { return 99999999999999999999; }",
        "int main() { return 2147483648; }",
        "int main() { return -2147483648 / -1; }",
        "int main() { return -2147483648 % -1; }",
        "int main() { return 1 / 0; }",
        "int main() { return 1 % 0; }",
        "int main() { return 1 << 64; }",
        "int main() { return 1 << -1; }",
        "int main() { return -(-2147483648); }",
        "int main() { return 2147483647 + 1; }",
        "int main() { return 2147483647 * 2147483647; }",
        "int main() { int x = 0x7fffffff; x++; return x; }",
        "int f(int a,int b,int c,int d,int e,int f2,int g,int h,int i,int j) { return a; } int main() { return f(1,2,3,4,5,6,7,8,9,10); }",
        "int main() { return main(); }",
        "int main() { for (;;) {} }",
        "int main() { while (1) { } return 0; }",
        "int main() { int x; return x; }",
        "int main() { return y; }",
        "int main() { return f(); }",
        "int main()",
        "int main() {",
        "int main() { return 0; } int main() { return 1; }",
        "int f(int x); int main() { return f(1); }",
    ];
    let rust = [
        "fn main() -> i32 { let a = [0; 2000000000]; 0 }",
        "fn main() -> i32 { let a = [0; 99999999999999999999]; 0 }",
        "fn main() -> i32 { 99999999999999999999 }",
        "fn main() -> i32 { -2147483648 / -1 }",
        "fn main() -> i32 { 1 << 64 }",
        "fn main() -> i32 { 1 / 0 }",
        "fn main() -> i32 { for i in 0..99999999999 {} 0 }",
        "fn main() -> i32 { for i in 5..0 {} 0 }",
        "fn main() -> i32 { main() }",
        "fn main() -> i32 { loop {} }",
        "fn main() -> i32 { let x: i32; x }",
        "fn main() -> i32 { let a = [1, 2]; a[5] }",
    ];
    let asm = [
        "li a0, 0xffffffffffffffffffff",
        "li a0, -9223372036854775808",
        "li a0, 18446744073709551615",
        "addi a0, a0, 99999999999999999999",
        "addi a0, a0, 2048",
        "slli a0, a0, 64",
        "slli a0, a0, -1",
        "lw a0, 99999999999(a0)",
        "lw a0, -99999999999(sp)",
        ".data\n.space 99999999999999\n",
        ".data\n.space -1\n",
        ".data\n.align 99999999\n.word 1\n",
        ".data\n.align -5\n.word 1\n",
        ".data\n.word 99999999999999999999\n",
        ".data\n.dword 0x1ffffffffffffffff\n",
        ".data\n.string \"\\\"\n",
        ".data\n.string \"abc\n",
        ".data\n.string \"\\x\"\n",
        "beq a0, a1, 99999999999999",
        "jal ra, -99999999999",
        "j 3",
        "lui a0, 0x100000",
        "lui a0, -1",
        "x: x: nop",
        "jalr",
        "jalr a0, 0(",
        "lw a0, (",
        "lw a0, )a0(",
        "la a0",
        "call",
        "ret a0",
        "li",
        "mv a0",
        "add a0, a1",
        "add a0, a1, a2, a3",
        "addi x32, x0, 1",
        "addi x-1, x0, 1",
        "1: j 1b\n j 1f\n",
        "%hi(x)",
        "lui a0, %hi(",
        "addi a0, a0, %lo(missing)",
    ];
    let mut failures = Vec::new();
    for (name, lang, f) in entry_points() {
        let inputs: Vec<String> = match lang {
            Lang::C | Lang::Cpp => c_like.iter().map(|s| s.to_string()).collect(),
            Lang::Rust => rust.iter().map(|s| s.to_string()).collect(),
            Lang::Asm32 | Lang::Asm64 => asm.iter().map(|s| format!("{s}\n")).collect(),
        };
        for input in inputs {
            let owned = input.clone();
            let joined = std::thread::Builder::new()
                .stack_size(DEFAULT_STACK)
                .spawn(move || catch_unwind(AssertUnwindSafe(|| f(&owned))))
                .expect("spawn")
                .join();
            match joined {
                Ok(Ok(out)) => {
                    if let Err(msg) = &out {
                        if msg.contains("Some(") || msg.contains("None") || msg.trim().is_empty() {
                            failures.push(format!("{name}: unclear message {msg:?} for {input:?}"));
                        }
                    }
                }
                _ => failures.push(format!("{name}: panicked on {input:?}")),
            }
        }
    }
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
}

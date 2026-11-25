//! Shared test support: a seeded xorshift generator, the list of every
//! public text entry point, and sample programs. Included with `mod support;`
//! from integration tests.
#![allow(dead_code)]

pub mod programs;
pub mod reference;

/// Small deterministic xorshift64* generator (no external crates).
#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next_u64() % n
        }
    }
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }
    pub fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
}

/// True when the heavy randomized mode is requested.
pub fn stress() -> bool {
    std::env::var("RISCVSIM_STRESS").map(|v| v == "1").unwrap_or(false)
}

/// Iteration count: `normal` by default, `heavy` under RISCVSIM_STRESS=1.
pub fn iterations(normal: usize, heavy: usize) -> usize {
    if stress() {
        heavy
    } else {
        normal
    }
}

/// Source language accepted by an entry point (used to choose token soup).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Asm32,
    Asm64,
    C,
    Cpp,
    Rust,
}

pub type TextFn = fn(&str) -> Result<String, String>;

fn ok_asm32(s: &str) -> Result<String, String> {
    sim_engine::assemble(s)
        .map(|p| format!("{}", p.instrs.len()))
        .map_err(|e| e.first().map(|e| e.message.clone()).unwrap_or_default())
}
fn ok_asm64(s: &str) -> Result<String, String> {
    sim_engine::assemble64(s)
        .map(|p| format!("{}", p.instrs.len()))
        .map_err(|e| e.first().map(|e| e.message.clone()).unwrap_or_default())
}

macro_rules! tr {
    ($f:path) => {{
        fn wrapped(s: &str) -> Result<String, String> {
            $f(s).map_err(|e| e.message)
        }
        wrapped as TextFn
    }};
}

/// Every public text entry point: both assemblers and all 16 translators.
pub fn entry_points() -> Vec<(&'static str, Lang, TextFn)> {
    use sim_engine::*;
    vec![
        ("assemble", Lang::Asm32, ok_asm32 as TextFn),
        ("assemble64", Lang::Asm64, ok_asm64 as TextFn),
        ("asm_to_c", Lang::Asm32, tr!(asm_to_c)),
        ("asm64_to_c", Lang::Asm64, tr!(asm64_to_c)),
        ("c_to_asm", Lang::C, tr!(c_to_asm)),
        ("c_to_asm64", Lang::C, tr!(c_to_asm64)),
        ("cpp_to_asm", Lang::Cpp, tr!(cpp_to_asm)),
        ("cpp_to_asm64", Lang::Cpp, tr!(cpp_to_asm64)),
        ("c_to_cpp", Lang::C, tr!(c_to_cpp)),
        ("cpp_to_c", Lang::Cpp, tr!(cpp_to_c)),
        ("c_to_rust", Lang::C, tr!(c_to_rust)),
        ("cpp_to_rust", Lang::Cpp, tr!(cpp_to_rust)),
        ("rust_to_c", Lang::Rust, tr!(rust_to_c)),
        ("rust_to_cpp", Lang::Rust, tr!(rust_to_cpp)),
        ("rust_to_asm", Lang::Rust, tr!(rust_to_asm)),
        ("rust_to_asm64", Lang::Rust, tr!(rust_to_asm64)),
        ("rv32_to_rv64", Lang::Asm32, tr!(rv32_to_rv64)),
        ("rv64_to_rv32", Lang::Asm64, tr!(rv64_to_rv32)),
    ]
}

pub const ASM32_SAMPLE: &str = "\
.data
arr: .word 5, -3, 7, 0x10
msg: .string \"hi\"
.text
main:
    la   t0, arr
    li   t1, 4
    li   a0, 0
loop:
    lw   t2, 0(t0)
    add  a0, a0, t2
    addi t0, t0, 4
    addi t1, t1, -1
    bnez t1, loop
    mul  a1, a0, a0
    jal  ra, helper
    ecall
helper:
    addi a0, a0, 1
    ret
";

pub const ASM64_SAMPLE: &str = "\
.data
arr: .dword 5, -3, 7, 0x10
.text
main:
    la   t0, arr
    li   t1, 4
    li   a0, 0
loop:
    ld   t2, 0(t0)
    add  a0, a0, t2
    addi t0, t0, 8
    addi t1, t1, -1
    bnez t1, loop
    addiw a1, a0, 3
    jal  ra, helper
    ecall
helper:
    addi a0, a0, 1
    ret
";

pub const C_SAMPLE: &str = "\
int fib(int n) {
    if (n < 2) { return n; }
    return fib(n - 1) + fib(n - 2);
}
int main() {
    int a[4] = {1, 2, 3, 4};
    int s = 0;
    for (int i = 0; i < 4; i++) { s = s + a[i] * 2; }
    while (s > 100) { s = s - 7; if (s == 3) break; }
    return fib(6) + s;
}
";

pub const CPP_SAMPLE: &str = "\
int fib(int n) {
    if (n < 2) { return n; }
    return fib(n - 1) + fib(n - 2);
}
int main() {
    bool ok = true;
    int s = 0;
    for (int i = 0; i < 4; i++) { s += i; }
    if (ok && s > 2) { s = s * 2; }
    return fib(6) + s;
}
";

pub const RUST_SAMPLE: &str = "\
fn fib(n: i32) -> i32 {
    if n < 2 { return n; }
    fib(n - 1) + fib(n - 2)
}
fn main() -> i32 {
    let mut s = 0;
    for i in 0..4 { s += i; }
    let a = [1, 2, 3];
    s = s + a[1];
    fib(6) + s
}
";

pub fn sample(lang: Lang) -> &'static str {
    match lang {
        Lang::Asm32 => ASM32_SAMPLE,
        Lang::Asm64 => ASM64_SAMPLE,
        Lang::C => C_SAMPLE,
        Lang::Cpp => CPP_SAMPLE,
        Lang::Rust => RUST_SAMPLE,
    }
}

pub fn vocabulary(lang: Lang) -> &'static [&'static str] {
    match lang {
        Lang::Asm32 | Lang::Asm64 => &[
            "add", "addi", "lw", "sw", "ld", "sd", "li", "la", "beq", "bnez", "j", "jal", "jalr",
            "ret", "call", "lui", "auipc", "x0", "a0", "t0", "sp", "ra", "x31", "zero", ",", "(",
            ")", ":", "loop", "main", "0", "-1", "2047", "-2048", "0x7fffffff", "99999999999999999999",
            "%hi(", "%lo(", ".data", ".text", ".word", ".dword", ".string", "\"", ".space",
            ".align", "#", "\n", "1b", "1f", "1:", "'a'", "ecall", "ebreak", "slli", "addiw",
            "mulh", "divu", "remw", "fence", "-", "+",
        ],
        Lang::C | Lang::Cpp => &[
            "int", "unsigned", "char", "long", "bool", "void", "struct", "return", "if", "else",
            "while", "for", "do", "switch", "case", "default", "break", "continue", "goto",
            "main", "f", "x", "y", "(", ")", "{", "}", "[", "]", ";", ",", "=", "==", "+", "-",
            "*", "/", "%", "<<", ">>", "&", "|", "^", "!", "~", "&&", "||", "?", ":", "++", "--",
            "+=", "0", "1", "2147483647", "-2147483648", "99999999999999999999", "0x10", "'a'",
            "\"s\"", "#define", "#include", "\n", "true", "false", "auto", "sizeof", "/*", "//",
        ],
        Lang::Rust => &[
            "fn", "let", "mut", "if", "else", "while", "loop", "for", "in", "..", "..=", "match",
            "return", "break", "continue", "main", "f", "x", "y", "i32", "u8", "i64", "bool",
            "as", "->", "=>", "(", ")", "{", "}", "[", "]", ";", ",", ":", "=", "==", "+", "-",
            "*", "/", "%", "<<", ">>", "&", "|", "^", "!", "&&", "||", "+=", "0", "1",
            "2147483647", "99999999999999999999", "true", "false", "_", "struct", "enum",
            "println!", "\"s\"", "'c'", "//", "/*", "\n",
        ],
    }
}

/// Run generated RV32 assembly; returns a0 (sign-extended) or an error.
pub fn run_asm32(asm: &str) -> Result<i64, String> {
    let program = sim_engine::assemble(asm).map_err(|e| format!("generated asm does not assemble: {}\n{asm}", e[0].message))?;
    let mut p = sim_engine::Pipeline::new(program);
    if !p.run(5_000_000) {
        return Err("step limit reached".to_string());
    }
    let halt = p.snapshot().halt.ok_or("no halt")?;
    if halt.kind != "complete" {
        return Err(halt.message);
    }
    Ok(p.registers()[10] as i32 as i64)
}

/// Run generated RV64 assembly; returns a0 or an error.
pub fn run_asm64(asm: &str) -> Result<i64, String> {
    let program = sim_engine::assemble64(asm).map_err(|e| format!("generated asm does not assemble: {}\n{asm}", e[0].message))?;
    let mut p = sim_engine::Pipeline64::new(program);
    if !p.run(5_000_000) {
        return Err("step limit reached".to_string());
    }
    let halt = p.snapshot().halt.ok_or("no halt")?;
    if halt.kind != "complete" {
        return Err(halt.message);
    }
    Ok(p.registers()[10] as i64)
}

pub fn run_c32(src: &str) -> Result<i64, String> {
    let asm = sim_engine::c_to_asm(src).map_err(|e| format!("line {}: {}", e.line, e.message))?;
    run_asm32(&asm)
}

pub fn run_c64(src: &str) -> Result<i64, String> {
    let asm = sim_engine::c_to_asm64(src).map_err(|e| format!("line {}: {}", e.line, e.message))?;
    run_asm64(&asm)
}

/// True when a host tool can be run (used to auto-skip native differential tests).
pub fn host_tool(name: &str) -> bool {
    std::process::Command::new(name)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

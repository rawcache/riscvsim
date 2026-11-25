//! PART E (priority 1): the C integer type system on RV32 (ILP32) and RV64
//! (LP64), with `char` unsigned as the RISC-V psABI specifies.

mod support;

use support::{run_c32, run_c64, Rng};

/// (program, expected main() result, also valid on RV32)
const PROGRAMS: &[(&str, i64, bool)] = &[
    ("int main() { char c = 200; return c; }", 200, true),
    ("int main() { char c = -1; return c; }", 255, true),
    ("int main() { signed char c = -1; return c; }", -1, true),
    ("int main() { signed char c = 200; return c; }", -56, true),
    ("int main() { unsigned char c = 255; c = c + 1; return c; }", 0, true),
    ("int main() { unsigned char c = 250; c += 10; return c; }", 4, true),
    ("int main() { short s = 32767; s++; return s; }", -32768, true),
    ("int main() { unsigned short s = 0; s--; return s; }", 65535, true),
    ("int main() { unsigned x = 0; x = x - 1; return x == 4294967295u; }", 1, true),
    ("int main() { unsigned x = 4294967295u; return x / 2 == 2147483647; }", 1, true),
    ("int main() { unsigned x = 7; unsigned y = 2; return x / y; }", 3, true),
    ("int main() { int x = -7; unsigned y = 2; return x / y; }", 2147483644, true),
    ("int main() { int x = -7; return x / 2; }", -3, true),
    ("int main() { int x = -7; return x % 2; }", -1, true),
    ("int main() { unsigned x = -7; return x % 10; }", 9, true),
    ("int main() { int x = -1; unsigned y = 1; return x < y; }", 0, true),
    ("int main() { int x = -1; int y = 1; return x < y; }", 1, true),
    ("int main() { unsigned x = 0x80000000; return x >> 31; }", 1, true),
    ("int main() { int x = 0x80000000; return x >> 31; }", -1, true),
    ("int main() { unsigned x = 1; return (x << 31) > 0; }", 1, true),
    ("int main() { char c = 'A'; return c + 1; }", 66, true),
    ("int main() { return (unsigned char)300; }", 44, true),
    ("int main() { return (signed char)300; }", 44, true),
    ("int main() { return (signed char)200; }", -56, true),
    ("int main() { return (short)70000; }", 4464, true),
    ("int main() { return (unsigned short)-1; }", 65535, true),
    ("int main() { int a = 100000; int b = 100000; return a * b; }", 1410065408, true),
    ("int main() { unsigned a = 100000; return a * a / 7; }", 201437915, true),
    ("int main() { unsigned char a[4] = {250, 251, 252, 253}; int s = 0; for (int i = 0; i < 4; i++) { s += a[i]; } return s; }", 1006, true),
    ("int main() { signed char a[3] = {-1, -2, -3}; return a[0] + a[1] + a[2]; }", -6, true),
    ("int main() { short a[3]; a[0] = 40000; a[1] = 1; return a[0]; }", -25536, true),
    ("int main() { unsigned short a[2] = {65535, 1}; a[1] += a[0]; return a[1]; }", 0, true),
    ("int main() { unsigned x = 5; int y = -x; return y; }", -5, true),
    ("int main() { unsigned char c = 1; return ~c; }", -2, true),
    ("int main() { unsigned c = 1; return ~c == 4294967294u; }", 1, true),
    ("int main() { return sizeof(char) + sizeof(short) * 10 + sizeof(int) * 100; }", 421, true),
    ("int main() { unsigned char c = 255; int i = c; return i; }", 255, true),
    ("int main() { int i = -1; unsigned char c = i; return c; }", 255, true),
    ("unsigned char f(unsigned char x) { return x + 1; } int main() { return f(255); }", 0, true),
    ("short f(int x) { return x; } int main() { return f(65535); }", -1, true),
    ("unsigned f(unsigned x, unsigned y) { return x - y; } int main() { return f(1, 2) == 4294967295u; }", 1, true),
    ("int main() { unsigned x = 10; x -= 20; x /= 2; return x == 2147483643; }", 1, true),
    ("int main() { int x = 1; x <<= 31; return x < 0; }", 1, true),
    ("int main() { char c = 0; c--; return c; }", 255, true),
    // 64-bit (RV64 only)
    ("int main() { long long x = 2147483647; x = x + 1; return x > 0; }", 1, false),
    ("int main() { long x = 2147483647; x = x + 1; return x == 2147483648; }", 1, false),
    ("int main() { long long x = 1; x = x << 40; return x >> 38; }", 4, false),
    ("int main() { unsigned long long x = 0; x--; return x == 18446744073709551615ull; }", 1, false),
    ("int main() { unsigned long long x = 0; x--; return x >> 60; }", 15, false),
    ("int main() { long long x = -1; return x >> 63; }", -1, false),
    ("int main() { long long a = 3000000000; long long b = 3; return a * b / 1000000000; }", 9, false),
    ("int main() { long long a = 9000000000; return (int)(a % 1000000007); }", 999999944, false),
    ("int main() { unsigned x = 4294967295u; long long y = x; return y > 0; }", 1, false),
    ("int main() { int x = -1; unsigned long long y = x; return y == 18446744073709551615ull; }", 1, false),
    ("int main() { int x = -1; unsigned y = x; long long z = y; return z == 4294967295; }", 1, false),
    ("int main() { long long x = 0x100000001; int y = x; return y; }", 1, false),
    ("long long sq(long long x) { return x * x; } int main() { return sq(100000) / 1000000; }", 10000, false),
    ("unsigned f(unsigned x) { return x; } int main() { long long r = f(4294967295u); return r == 4294967295; }", 1, false),
    ("int main() { long long a[3] = {5000000000, 2, 3}; a[1] = a[0] + a[2]; return a[1] / 1000; }", 5000000, false),
    ("int main() { return sizeof(long) * 10 + sizeof(long long); }", 88, false),
    ("int main() { unsigned long long x = 1; return (x << 63) > 0; }", 1, false),
];

#[test]
fn c_integer_types_rv64() {
    for (src, expected, _) in PROGRAMS {
        assert_eq!(run_c64(src), Ok(*expected), "RV64: {src}");
    }
}

#[test]
fn c_integer_types_rv32() {
    for (src, expected, rv32) in PROGRAMS {
        if *rv32 {
            assert_eq!(run_c32(src), Ok(*expected), "RV32: {src}");
        }
    }
}

#[test]
fn data_models_and_sizeof() {
    let sizes = |run: fn(&str) -> Result<i64, String>| -> Vec<i64> {
        ["char", "signed char", "unsigned char", "short", "unsigned short", "int", "unsigned int", "long", "unsigned long"]
            .iter()
            .map(|t| run(&format!("int main() {{ return sizeof({t}); }}")).unwrap())
            .collect()
    };
    assert_eq!(sizes(run_c32), vec![1, 1, 1, 2, 2, 4, 4, 4, 4], "ILP32");
    assert_eq!(sizes(run_c64), vec![1, 1, 1, 2, 2, 4, 4, 8, 8], "LP64");
    assert_eq!(run_c64("int main() { return sizeof(long long) + sizeof(unsigned long long); }"), Ok(16));
    assert_eq!(run_c32("int main() { int a[5]; return sizeof(a); }"), Ok(20));
    // long follows the data model: 32 bits on RV32, 64 on RV64.
    let wraps = "int main() { long x = 2147483647; x = x + 1; return x > 0; }";
    assert_eq!(run_c32(wraps), Ok(0));
    assert_eq!(run_c64(wraps), Ok(1));
    assert_eq!(run_c64("int main() { char a[5]; long b; return sizeof(a) * 10 + sizeof b; }"), Ok(58));
}

#[test]
fn char_is_unsigned() {
    for run in [run_c32 as fn(&str) -> Result<i64, String>, run_c64] {
        assert_eq!(run("int main() { char c = 0xff; return c > 0; }"), Ok(1));
        assert_eq!(run("int main() { char c = -128; return c; }"), Ok(128));
    }
}

#[test]
fn rv64_int_keeps_32_bit_wraparound() {
    let cases = [
        ("int main() { int x = 2147483647; x++; return x == -2147483647 - 1; }", 1),
        ("int main() { int x = 65536; int y = x * x; return y; }", 0),
        ("int main() { unsigned x = 4294967295u; x++; return x; }", 0),
        ("int main() { unsigned x = 3000000000u; unsigned y = x + x; return y == 1705032704; }", 1),
        ("int main() { int x = -2147483647 - 1; return x / -1 == x; }", 1),
        ("int main() { unsigned x = 2147483648u; return (int)x < 0; }", 1),
        ("int main() { int x = 1; return (x << 32) == 1; }", 1),
    ];
    for (src, expected) in cases {
        assert_eq!(run_c64(src), Ok(expected), "{src}");
        if !src.contains("<< 32") {
            assert_eq!(run_c32(src), Ok(expected), "{src}");
        }
    }
}

#[test]
fn literals_follow_c_typing_rules() {
    let cases = [
        ("int main() { return 0x7fffffff + 0 > 0; }", 1),
        ("int main() { return 0xffffffff > 0; }", 1), // unsigned int
        ("int main() { return -1 < 0u; }", 0),         // -1 converts to UINT_MAX
        ("int main() { return 010 + 0x10 + 0; }", 24),
        ("int main() { return '\\n' + '\\0' + '\\x41'; }", 75),
        ("int main() { return 5u / 2; }", 2),
        ("int main() { return 4294967295 > 0; }", 1), // long long on RV64
    ];
    for (src, expected) in cases {
        assert_eq!(run_c64(src), Ok(expected), "{src}");
    }
    assert!(run_c64("int main() { return 09; }").unwrap_err().contains("octal"));
    assert!(run_c64("int main() { return 1x; }").unwrap_err().contains("suffix"));
    assert!(run_c64("int main() { return 99999999999999999999; }").unwrap_err().contains("too large"));
    assert!(run_c64("int main() { return 'ab'; }").unwrap_err().contains("character literal"));
}

#[test]
fn invalid_types_and_rv32_long_long_are_clear_errors() {
    let err = run_c32("int main() { long long x = 1; return x; }").unwrap_err();
    assert!(err.contains("unsupported on RV32") && err.contains("long long") && err.contains("RV64"), "{err}");
    let err = run_c32("int main() { return (unsigned long long)1; }").unwrap_err();
    assert!(err.contains("unsupported on RV32"), "{err}");
    for bad in ["short char", "signed unsigned", "long long long", "short long", "char int"] {
        let err = run_c64(&format!("int main() {{ {bad} x = 1; return x; }}")).unwrap_err();
        assert!(err.contains("is not a valid C integer type"), "{bad}: {err}");
    }
}

// ---------------------------------------------------------------------------
// Differential test against the host C compiler (auto-skipped without cc).
// The host is LP64, so its results are compared with RV64. Expressions avoid
// undefined behaviour: -fwrapv defines signed overflow, divisors are forced
// positive and nonzero, shift counts are masked, left shifts are unsigned.
// ---------------------------------------------------------------------------

const TYPES: &[&str] = &[
    "char", "signed char", "unsigned char", "short", "unsigned short", "int", "unsigned int",
    "long", "unsigned long", "long long", "unsigned long long",
];

fn random_expr(rng: &mut Rng, vars: &[(String, &str)], depth: u32) -> String {
    if depth == 0 || rng.chance(25) {
        return if rng.chance(70) {
            rng.pick(vars).0.clone()
        } else {
            format!("{}", rng.below(2000) as i64 - 1000)
        };
    }
    let a = random_expr(rng, vars, depth - 1);
    let b = random_expr(rng, vars, depth - 1);
    match rng.below(14) {
        0 => format!("({a} + {b})"),
        1 => format!("({a} - {b})"),
        2 => format!("({a} * {b})"),
        3 => format!("({a} / ((int)(({b}) & 127) + 1))"),
        4 => format!("({a} % ((int)(({b}) & 127) + 1))"),
        5 => format!("({a} & {b})"),
        6 => format!("({a} | {b})"),
        7 => format!("({a} ^ {b})"),
        8 => format!("((unsigned long long)({a}) << (({b}) & 31))"),
        9 => format!("({a} >> (({b}) & 15))"),
        10 => format!("({a} < {b})"),
        11 => format!("({a} == {b})"),
        12 => format!("(({}){a})", rng.pick(TYPES)),
        _ => format!("(-({a}))"),
    }
}

fn random_program(rng: &mut Rng) -> String {
    let mut vars = Vec::new();
    let mut body = String::new();
    for i in 0..5 {
        let t = *rng.pick(TYPES);
        let name = format!("v{i}");
        let init = rng.next_u64() as i64 >> rng.below(64);
        body.push_str(&format!("    {t} {name} = ({t}){init}ll;\n"));
        vars.push((name, t));
    }
    for _ in 0..3 {
        let target = rng.pick(&vars).0.clone();
        let e = random_expr(rng, &vars, 3);
        body.push_str(&format!("    {target} = {e};\n"));
    }
    let e = random_expr(rng, &vars, 3);
    body.push_str(&format!("    unsigned long long r = {e};\n    r = r ^ (r >> 32);\n    return (int)r;\n"));
    format!("int main() {{\n{body}}}\n")
}

#[test]
fn native_differential_against_host_cc() {
    if !support::host_tool("cc") {
        eprintln!("SKIP native C differential: no host cc");
        return;
    }
    let dir = std::env::temp_dir().join(format!("riscvsim-c-diff-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut rng = Rng::new(0xC0DE);
    let count = support::iterations(40, 400);
    let programs: Vec<String> = (0..count).map(|_| random_program(&mut rng)).collect();
    // One native binary prints every program's result.
    let mut native = String::from("#include <stdio.h>\n");
    for (i, p) in programs.iter().enumerate() {
        native.push_str(&p.replacen("int main()", &format!("static int t{i}(void)"), 1));
    }
    native.push_str("int main(void) {\n");
    for i in 0..programs.len() {
        native.push_str(&format!("    printf(\"%d\\n\", t{i}());\n"));
    }
    native.push_str("    return 0;\n}\n");
    let c_path = dir.join("diff.c");
    let exe = dir.join("diff");
    std::fs::write(&c_path, native).unwrap();
    let status = std::process::Command::new("cc")
        .args(["-O0", "-funsigned-char", "-fwrapv", "-w", "-o"])
        .arg(&exe)
        .arg(&c_path)
        .status();
    if !status.map(|s| s.success()).unwrap_or(false) {
        eprintln!("SKIP native C differential: host cc could not build the driver");
        return;
    }
    let output = std::process::Command::new(&exe).output().expect("run native driver");
    let expected: Vec<i64> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().parse().unwrap())
        .collect();
    assert_eq!(expected.len(), programs.len());
    for (i, (p, want)) in programs.iter().zip(&expected).enumerate() {
        assert_eq!(run_c64(p), Ok(*want), "program {i} differs from host cc:\n{p}");
    }
    let _ = std::fs::remove_dir_all(&dir);
    eprintln!("native C differential: {} programs compared", programs.len());
}

#[test]
fn typed_programs_survive_c_and_cpp_round_trips() {
    for (src, expected, rv32) in PROGRAMS {
        let cpp = sim_engine::c_to_cpp(src).unwrap_or_else(|e| panic!("c_to_cpp: {} for {src}", e.message));
        let asm = sim_engine::cpp_to_asm64(&cpp).unwrap_or_else(|e| panic!("cpp_to_asm64: {}\n{cpp}", e.message));
        assert_eq!(support::run_asm64(&asm), Ok(*expected), "C -> C++ -> RV64: {src}\n{cpp}");
        let back = sim_engine::cpp_to_c(&cpp).unwrap_or_else(|e| panic!("cpp_to_c: {}\n{cpp}", e.message));
        assert_eq!(run_c64(&back), Ok(*expected), "C -> C++ -> C -> RV64: {src}\n{back}");
        if *rv32 {
            let asm = sim_engine::cpp_to_asm(&cpp).unwrap_or_else(|e| panic!("cpp_to_asm: {}\n{cpp}", e.message));
            assert_eq!(support::run_asm32(&asm), Ok(*expected), "C -> C++ -> RV32: {src}");
        }
    }
}

#[test]
fn rust_directions_reject_wider_c_types_clearly() {
    for src in [
        "int main() { unsigned char c = 1; return c; }",
        "int main() { return (short)5; }",
        "int main() { return sizeof(int); }",
        "unsigned f(unsigned x) { return x; } int main() { return f(1); }",
    ] {
        let err = sim_engine::c_to_rust(src).unwrap_err();
        assert!(err.message.contains("from C to Rust is not supported yet"), "{src}: {}", err.message);
        assert_eq!(err.line, 1);
        let err = sim_engine::cpp_to_rust(src).unwrap_err();
        assert!(err.message.contains("from C++ to Rust"), "{src}: {}", err.message);
    }
}

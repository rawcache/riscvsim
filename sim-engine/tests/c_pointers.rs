//! Stage 1 item 1: C pointers (`&`, `*`, pointer arithmetic scaled by the
//! element size, arrays decaying to pointers), globals and string literals
//! in read-only data, on RV32 (ILP32) and RV64 (LP64).

mod support;

use support::{run_c32, run_c64};

/// (program, expected main() result on RV32, on RV64)
const PROGRAMS: &[(&str, i64, i64)] = &[
    // & and *
    ("int main() { int x = 5; int *p = &x; return *p; }", 5, 5),
    ("int main() { int x = 5; int *p = &x; *p = 9; return x; }", 9, 9),
    ("int main() { int x = 1; int *p = &x; *p += 41; return x; }", 42, 42),
    ("int main() { int x = 1; int *p = &x; (*p)++; ++*p; return x; }", 3, 3),
    ("int main() { int x = 7; int *p = &x; int **pp = &p; **pp = 11; return x; }", 11, 11),
    ("int main() { int x = 3; int *p = &x; return *&*p + *&x; }", 6, 6),
    ("int main() { int x = 1; int y = 2; int *p = &x; p = &y; return *p; }", 2, 2),
    ("int main() { int *p = 0; return p == 0; }", 1, 1),
    ("int main() { int x = 0; int *p = &x; if (p) { return 1; } return 2; }", 1, 1),
    ("int main() { int x = 0; int *p = &x; return !p; }", 0, 0),
    // natural-width locals behind pointers
    ("int main() { signed char c = -1; signed char *p = &c; *p = 5; return c; }", 5, 5),
    ("int main() { short s = -2; short *p = &s; *p = *p * 3; return s; }", -6, -6),
    ("int main() { unsigned char c = 250; unsigned char *p = &c; *p += 10; return c; }", 4, 4),
    ("int main() { long v = 1; long *p = &v; *p = *p << 20; return v >> 10; }", 1024, 1024),
    // arrays decay, pointer arithmetic is scaled
    ("int main() { int a[4] = {10, 20, 30, 40}; int *p = a; return *(p + 2); }", 30, 30),
    ("int main() { int a[4] = {10, 20, 30, 40}; int *p = a + 3; return p[-1]; }", 30, 30),
    ("int main() { int a[4] = {10, 20, 30, 40}; int *p = &a[1]; p++; return *p; }", 30, 30),
    ("int main() { int a[4] = {10, 20, 30, 40}; int *p = &a[3]; p -= 2; return *p; }", 20, 20),
    ("int main() { int a[4] = {1, 2, 3, 4}; int *p = a; int *q = &a[3]; return q - p; }", 3, 3),
    ("int main() { char a[8]; char *p = a; char *q = a + 5; return q - p; }", 5, 5),
    ("int main() { long a[3] = {1, 2, 3}; long *p = a; p += 2; return *p + (p - a); }", 5, 5),
    ("int main() { short a[3] = {5, 6, 7}; short *p = a; return *(1 + p) + p[2]; }", 13, 13),
    ("int main() { int a[3] = {1, 2, 3}; int *p = a; int *q = a + 2; return (p < q) + (q > p) * 2 + (p != q) * 4 + (p == a) * 8; }", 15, 15),
    ("int main() { int a[5] = {1, 2, 3, 4, 5}; int s = 0; for (int *p = a; p < a + 5; p++) { s += *p; } return s; }", 15, 15),
    ("int main() { int a[3]; int *p = a; *p++ = 4; *p++ = 5; *p = 6; return a[0] * 100 + a[1] * 10 + a[2]; }", 456, 456),
    ("int main() { int a[3] = {1, 2, 3}; int *p = a; p[1] = 9; return a[1]; }", 9, 9),
    // pointers through functions
    ("int swap(int *a, int *b) { int t = *a; *a = *b; *b = t; return 0; } int main() { int x = 1; int y = 2; swap(&x, &y); return x * 10 + y; }", 21, 21),
    ("int sum(int *a, int n) { int s = 0; for (int i = 0; i < n; i++) { s += a[i]; } return s; } int main() { int v[4] = {1, 2, 3, 4}; return sum(v, 4); }", 10, 10),
    ("int *pick(int *a, int i) { return a + i; } int main() { int v[3] = {7, 8, 9}; return *pick(v, 2); }", 9, 9),
    ("int fill(char *s, int n, char c) { for (int i = 0; i < n; i++) { s[i] = c; } return n; } int main() { char b[4]; fill(b, 4, 'z'); return b[3]; }", 122, 122),
    ("int set(int **pp, int *t) { *pp = t; return 0; } int main() { int x = 4; int *p = 0; set(&p, &x); return *p; }", 4, 4),
    // sizeof
    ("int main() { int *p = 0; return sizeof(p); }", 4, 8),
    ("int main() { char *p = 0; int a[3]; return sizeof(*p) + sizeof(a); }", 13, 13),
    // globals
    ("int g = 5; int main() { return g; }", 5, 5),
    ("int g; int main() { g = 3; g += 4; return g; }", 7, 7),
    ("int counter = 0; int bump() { counter++; return counter; } int main() { bump(); bump(); bump(); return counter; }", 3, 3),
    ("int t[4] = {1, 2, 3}; int main() { return t[0] + t[1] + t[2] + t[3]; }", 6, 6),
    ("int t[4]; int main() { for (int i = 0; i < 4; i++) { t[i] = i * i; } return t[3]; }", 9, 9),
    ("char c = 300; signed char d = -1; int main() { return c + d; }", 43, 43),
    ("long big = -5; int main() { return big; }", -5, -5),
    ("int g = 2; int *gp = &g; int main() { *gp = 8; return g; }", 8, 8),
    ("int t[3] = {4, 5, 6}; int *tp = t; int main() { return tp[2]; }", 6, 6),
    ("int g = 1; int main() { int *p = &g; *p = 6; return g; }", 6, 6),
    ("int t[3] = {4, 5, 6}; int main() { int *p = t + 1; return *p; }", 5, 5),
    ("int main() { return sizeof(t); } int t[5];", 20, 20),
    ("int a0 = 1; int ret = 2; int main() { return a0 + ret; }", 3, 3),
    // strings
    ("int main() { char *s = \"hello\"; return s[1]; }", 101, 101),
    ("int main() { return \"abc\"[2]; }", 99, 99),
    ("int len(char *s) { int n = 0; while (*s) { s++; n++; } return n; } int main() { return len(\"hello, world\"); }", 12, 12),
    ("int main() { char *s = \"a\\tb\\n\\x41\\\\\"; return s[1] + s[3] + s[4] + s[5]; }", 9 + 10 + 65 + 92, 9 + 10 + 65 + 92),
    ("int main() { char *s = \"ab\" \"cd\"; return s[3]; }", 100, 100),
    ("int main() { return sizeof(\"four\"); }", 5, 5),
    ("char *msg = \"hey\"; int main() { return msg[2]; }", 121, 121),
    ("int main() { char *a = \"same\"; char *b = \"same\"; return a == b; }", 1, 1),
    ("int main() { char s[] = \"hi\"; s[0] = 'H'; return s[0] + s[2] + sizeof(s); }", 75, 75),
    ("int main() { char s[3] = \"abc\"; return s[2]; }", 99, 99),
    ("int main() { char s[6] = \"ab\"; return s[1] + s[5]; }", 98, 98),
    ("int main() { int a[] = {3, 4, 5}; return sizeof(a) + a[2]; }", 17, 17),
    ("int count(char *s, char c) { int n = 0; for (; *s; s++) { if (*s == c) n++; } return n; } int main() { return count(\"mississippi\", 's'); }", 4, 4),
    // casts of pointers to integers
    ("int main() { int a[2]; long d = (long)&a[1] - (long)&a[0]; return d; }", 4, 4),
    // recursion with pointers
    ("int sum(int *a, int n) { if (n == 0) { return 0; } return *a + sum(a + 1, n - 1); } int main() { int v[5] = {1, 2, 3, 4, 5}; return sum(v, 5); }", 15, 15),
];

#[test]
fn pointer_programs_run_on_rv32_and_rv64() {
    for (src, want32, want64) in PROGRAMS {
        assert_eq!(run_c32(src), Ok(*want32), "RV32: {src}");
        assert_eq!(run_c64(src), Ok(*want64), "RV64: {src}");
    }
}

#[test]
fn string_literals_live_in_read_only_data() {
    let asm = sim_engine::c_to_asm("int main() { char *s = \"hi\"; return s[0]; }").unwrap();
    let rodata = asm.find(".section .rodata").expect("rodata section");
    let label = asm.find("__str0:").expect("string label");
    assert!(label > rodata, "{asm}");
    assert!(asm[label..].contains(".byte 104, 105, 0"), "{asm}");
    // writable globals are in .data, before the read-only strings
    let asm = sim_engine::c_to_asm64("int g = 3; char *m = \"x\"; int main() { return g; }").unwrap();
    let data = asm.find("\n.data").expect(".data");
    assert!(data < asm.find(".section .rodata").unwrap(), "{asm}");
    assert!(asm.contains(".dword __str0"), "{asm}");
}

#[test]
fn programs_without_pointers_keep_their_exact_assembly() {
    // The legacy lowering is untouched unless the unit uses memory features.
    let src = "int main() { int a[3] = {1, 2, 3}; int s = 0; for (int i = 0; i < 3; i++) { s += a[i]; } return s; }";
    let asm = sim_engine::c_to_asm(src).unwrap();
    assert!(!asm.contains(".data") && !asm.contains("la "), "{asm}");
}

/// Every still-unsupported pointer form fails with a clear message.
#[test]
fn unsupported_pointer_forms_are_rejected_clearly() {
    let cases: &[(&str, &str)] = &[
        ("int main() { int x = 1; int *p = (int *)x; return *p; }", "casts to pointer types"),
        ("int main() { void *p = 0; return 0; }", "void pointers are not"),
        ("int main() { int a[2]; int *p = &a; return 0; }", "pointer to a whole array"),
        ("int main() { int x = 1; return *x; }", "not a pointer"),
        ("int main() { int x = 1; int *p = x; return 0; }", "only the constant 0 converts to a pointer"),
        ("int main() { int x = 1; int *p = &x; int y = p; return y; }", "cannot convert 'int *' to 'int'"),
        ("int main() { char c = 1; int *p = &c; return 0; }", "incompatible pointer types"),
        ("int main() { int a[2]; int *p = a; return p * 2; }", "invalid operands to '*'"),
        ("int main() { int a[2]; int *p = a; int *q = a; return p + q; }", "invalid operands to '+'"),
        ("int main() { int x = 1; int *p = &x; return p < 5; }", "compare pointers with pointers, or with 0"),
        ("int main() { int a[2]; int *p = a; p *= 2; return 0; }", "invalid pointer arithmetic"),
        ("int main() { int x = 1; int *****p = 0; return 0; }", "deeper than 4"),
        ("int g = 1; int main() { int g = 2; return g; }", "already a global variable"),
        ("int g = 1; int f(int g) { return g; } int main() { return f(1); }", "same name as a global"),
        ("int g = 1; int g = 2; int main() { return g; }", "defined twice"),
        ("int x = 1; int g = x; int main() { return g; }", "global initializers must be constants"),
        ("int g = 1; int g2 = 2; int main() { return g; } int g3() { return 0; } int g3x = g;", "global initializers must be constants"),
        ("int main() { char *s = \"abc; return 0; }", "unterminated string literal"),
        ("int main() { char *s = \"\\q\"; return 0; }", "invalid escape"),
        ("int main() { int s[2] = \"ab\"; return 0; }", "only char arrays"),
        ("int main() { char s[2] = \"abc\"; return 0; }", "longer than the array"),
    ];
    for (src, needle) in cases {
        for result in [sim_engine::c_to_asm(src), sim_engine::c_to_asm64(src)] {
            match result {
                Err(e) => assert!(e.message.contains(needle), "{src}: {}", e.message),
                Ok(asm) => panic!("{src} compiled:\n{asm}"),
            }
        }
    }
}

#[test]
fn source_translations_reject_memory_features_clearly() {
    for src in [
        "int main() { int x = 1; int *p = &x; return *p; }",
        "int g = 1; int main() { return g; }",
        "int main() { char *s = \"x\"; return s[0]; }",
    ] {
        for (to, result) in [("C++", sim_engine::c_to_cpp(src)), ("Rust", sim_engine::c_to_rust(src))] {
            let err = result.expect_err(src);
            assert!(err.message.contains(&format!("from C to {to} is not supported yet")), "{src}: {}", err.message);
            assert!(err.message.contains("pointers, globals and strings"), "{}", err.message);
            assert_eq!(err.line, 1);
        }
    }
    // C++ and Rust still reject pointers with their historical messages
    assert!(sim_engine::cpp_to_asm("int main() { int x = 1; int *p = &x; return 0; }").unwrap_err().message.contains("pointer"));
    assert!(sim_engine::cpp_to_asm("int main() { return \"s\"[0]; }").is_err());
}

#[test]
fn native_differential_against_host_cc() {
    if !support::host_tool("cc") {
        eprintln!("SKIP native C pointer differential: no host cc");
        return;
    }
    let dir = std::env::temp_dir().join(format!("riscvsim-c-ptr-diff-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut compared = 0;
    for (i, (src, _, want64)) in PROGRAMS.iter().enumerate() {
        // not valid C on a host: uses `t` before declaring it, or depends on
        // whether the host merges identical string literals
        if src.ends_with("int t[5];") || src.contains("a == b") {
            continue;
        }
        // The host is LP64 like RV64. Each program is its own file; its main
        // is renamed so a driver can print the full int result.
        let native = format!(
            "#include <stdio.h>\n#define main prog_main\n{src}\n#undef main\nint main(void) {{ printf(\"%d\\n\", prog_main()); return 0; }}\n"
        );
        let c_path = dir.join(format!("p{i}.c"));
        let exe = dir.join(format!("p{i}"));
        std::fs::write(&c_path, native).unwrap();
        let status = std::process::Command::new("cc")
            .args(["-O0", "-funsigned-char", "-fwrapv", "-w", "-o"])
            .arg(&exe)
            .arg(&c_path)
            .status();
        assert!(status.map(|s| s.success()).unwrap_or(false), "host cc rejected: {src}");
        let output = std::process::Command::new(&exe).output().expect("run native program");
        let got: i64 = String::from_utf8_lossy(&output.stdout).trim().parse().unwrap();
        assert_eq!(got, *want64, "host cc disagrees with the expected RV64 result: {src}");
        compared += 1;
    }
    let _ = std::fs::remove_dir_all(&dir);
    eprintln!("native C pointer differential: {compared} programs compared");
}

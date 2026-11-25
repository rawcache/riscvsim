//! PART E (priority 4): do/while and switch, on both XLENs and through the
//! C <-> C++ directions.

mod support;

use support::{run_c32, run_c64};

const PROGRAMS: &[(&str, i64)] = &[
    ("int main() { int i = 0; do { i++; } while (i < 5); return i; }", 5),
    ("int main() { int i = 10; do { i++; } while (i < 5); return i; }", 11),
    ("int main() { int i = 0; int s = 0; do { i++; if (i == 2) continue; s += i; } while (i < 4); return s; }", 8),
    ("int main() { int i = 0; do { i++; if (i == 3) break; } while (1); return i; }", 3),
    ("int main() { int x = 2; int r = 0; switch (x) { case 1: r = 10; break; case 2: r = 20; break; default: r = 30; } return r; }", 20),
    ("int main() { int x = 7; int r = 0; switch (x) { case 1: r = 10; break; default: r = 30; } return r; }", 30),
    ("int main() { int x = 7; int r = 5; switch (x) { case 1: r = 10; break; } return r; }", 5),
    ("int main() { int x = 1; int r = 0; switch (x) { case 1: r += 1; case 2: r += 2; break; case 3: r += 4; } return r; }", 3),
    ("int main() { int x = 9; int r = 0; switch (x) { default: r += 1; case 2: r += 2; break; case 3: r += 4; } return r; }", 3),
    ("int main() { int x = 3; int r = 0; switch (x) { default: r += 1; case 2: r += 2; break; case 3: r += 4; } return r; }", 4),
    ("int main() { int r = 0; switch ('b') { case 'a': r = 1; break; case 'b': r = 2; break; } return r; }", 2),
    ("int main() { int r = 0; switch (-1) { case -1: r = 7; break; case 1: r = 8; } return r; }", 7),
    ("int main() { int s = 0; for (int i = 0; i < 6; i++) { switch (i % 3) { case 0: s += 1; break; case 1: s += 10; break; default: s += 100; } } return s; }", 222),
    ("int f(int x) { switch (x) { case 0: return 5; case 1: return 6; } return 7; } int main() { return f(0) + f(1) * 10 + f(2) * 100; }", 765),
    ("int main() { int a = 0; int b = 0; switch (1) { case 1: switch (2) { case 2: a = 1; break; } b = 2; break; } return a + b; }", 3),
    ("int main() { unsigned char c = 200; int r = 0; switch (c) { case 200: r = 1; break; } return r; }", 1),
];

#[test]
fn do_while_and_switch_rv32_and_rv64() {
    for (src, expected) in PROGRAMS {
        assert_eq!(run_c32(src), Ok(*expected), "RV32: {src}");
        assert_eq!(run_c64(src), Ok(*expected), "RV64: {src}");
        let cpp = sim_engine::cpp_to_asm64(src).map_err(|e| e.message);
        assert_eq!(cpp.and_then(|a| support::run_asm64(&a)), Ok(*expected), "C++ RV64: {src}");
        let via_cpp = sim_engine::c_to_cpp(src).unwrap();
        assert_eq!(run_c64(&sim_engine::cpp_to_c(&via_cpp).unwrap()), Ok(*expected), "C -> C++ -> C: {src}");
    }
}

#[test]
fn switch_errors_are_clear() {
    let cases = [
        ("int main() { switch (1) { case 1: return 1; case 1: return 2; } return 0; }", "duplicate case value 1"),
        ("int main() { switch (1) { default: return 1; default: return 2; } return 0; }", "only have one default"),
        ("int main() { switch (1) { return 1; } return 0; }", "must follow a 'case' or 'default'"),
        ("int main() { int x = 1; switch (1) { case x: return 1; } return 0; }", "integer constants"),
        ("int main() { case 1: return 1; }", "only allowed inside a switch"),
        ("int main() { int i = 0; do i++; return i; }", "expected 'while"),
        ("int main() { goto end; end: return 0; }", "goto is not supported"),
    ];
    for (src, needle) in cases {
        let err = run_c64(src).unwrap_err();
        assert!(err.contains(needle), "{src}: {err}");
    }
}

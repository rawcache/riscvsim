//! Block scopes, continue inside switch and void functions flow through
//! the C -> C++ and C -> Rust translators: the translated program gives the
//! same result, or the translator rejects it with a clear, line-numbered
//! error. Pointer casts and void * are memory features, which other
//! languages reject clearly.

mod support;

/// (source, result) — valid on both RV32 and RV64, no pointers.
const PROGRAMS: &[(&str, i64)] = &[
    ("int main() { int s = 0; for (int i = 0; i < 3; i++) s += i; for (int i = 0; i < 4; i++) s += i * 10; return s; }", 63),
    ("int main() { int x = 1; { int x = 2; x += 5; } return x; }", 1),
    ("int main() { int v = 1; int s = 0; { int v = 10; s += v; { int v = 100; s += v; } s += v; } return s + v; }", 121),
    ("int f(int n) { int r = n; { int n = 5; r += n; } return r + n; } int main() { return f(3); }", 11),
    ("int main() { int i = 7; int s = 0; for (int i = 0; i < 3; i++) { s += i; } return s + i; }", 10),
    ("int main() { int s = 0; for (int i = 0; i < 5; i++) { switch (i) { case 1: continue; case 3: continue; default: break; } s += i; } return s; }", 6),
    ("int main() { int s = 0; for (int i = 0; i < 4; i++) { switch (i) { case 2: break; default: s += 1; } s += 10; } return s; }", 43),
    ("int main() { int s = 0; for (int i = 0; i < 3; i++) { for (int j = 0; j < 3; j++) { switch (j) { case 1: continue; } s += i * 10 + j; } } return s; }", 66),
    ("void down(int n) { if (n == 0) return; down(n - 1); } int main() { down(7); return 7; }", 7),
    ("void check(int v) { int w = v * 2; if (w > 4) { return; } } int sq(int v) { check(v); return v * v; } int main() { int s = 0; for (int i = 0; i < 4; i++) { check(i); s += sq(i); } return s; }", 14),
];

fn run_cpp(src: &str) -> Result<i64, String> {
    let asm = sim_engine::cpp_to_asm(src).map_err(|e| format!("line {}: {}", e.line, e.message))?;
    support::run_asm32(&asm)
}

fn run_rust(src: &str) -> Result<i64, String> {
    let asm = sim_engine::rust_to_asm(src).map_err(|e| format!("line {}: {}", e.line, e.message))?;
    support::run_asm32(&asm)
}

#[test]
fn c_to_cpp_keeps_results() {
    for (src, want) in PROGRAMS {
        assert_eq!(support::run_c32(src), Ok(*want), "C: {src}");
        assert_eq!(run_cpp(src), Ok(*want), "C++ source directly: {src}");
        let cpp = sim_engine::c_to_cpp(src).unwrap_or_else(|e| panic!("c_to_cpp {src}: {}", e.message));
        assert_eq!(run_cpp(&cpp), Ok(*want), "C -> C++:\n{cpp}");
    }
}

#[test]
fn c_to_rust_keeps_results_or_fails_clearly() {
    let mut translated = 0;
    for (src, want) in PROGRAMS {
        match sim_engine::c_to_rust(src) {
            Ok(rust) => {
                assert_eq!(run_rust(&rust), Ok(*want), "C -> Rust:\n{rust}");
                translated += 1;
            }
            Err(e) => {
                assert!(e.line > 0, "Rust rejection needs a line: {}", e.message);
                assert!(!e.message.contains("__"), "internal names leak: {}", e.message);
            }
        }
    }
    assert!(translated >= PROGRAMS.len() / 2, "only {translated} programs reached Rust");
}

#[test]
fn memory_features_are_rejected_by_source_translators() {
    let src = "int main() {\n  int x = 7;\n  void *v = &x;\n  return *(int *)v;\n}";
    for result in [sim_engine::c_to_cpp(src), sim_engine::c_to_rust(src)] {
        let err = result.unwrap_err();
        assert_eq!(err.line, 3, "{}", err.message);
        assert!(err.message.contains("assembly"), "{}", err.message);
    }
}

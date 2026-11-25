//! `continue` inside a switch inside a loop continues the loop; `break`
//! inside a switch only leaves the switch.

mod support;

/// (source, RV32 result, RV64 result)
const PROGRAMS: &[(&str, i64, i64)] = &[
    ("int main() { int s = 0; for (int i = 0; i < 5; i++) { switch (i) { case 1: continue; case 3: continue; default: break; } s += i; } return s; }", 6, 6),
    ("int main() { int i = 0; int s = 0; while (i < 6) { i++; switch (i % 3) { case 0: continue; default: s += i; } } return s; }", 12, 12),
    ("int main() { int i = 0; int s = 0; do { i++; switch (i) { case 2: continue; case 4: continue; } s += i; } while (i < 5); return s; }", 9, 9),
    // break leaves only the switch: the code after it still runs
    ("int main() { int s = 0; for (int i = 0; i < 4; i++) { switch (i) { case 2: break; default: s += 1; } s += 10; } return s; }", 43, 43),
    // continue inside a switch nested in another switch
    ("int main() { int s = 0; for (int i = 0; i < 4; i++) { switch (i % 2) { case 0: switch (i) { case 2: continue; default: s += 100; } break; case 1: s += 1; } s += 10; } return s; }", 132, 132),
    // continue inside an if inside a case
    ("int main() { int s = 0; for (int i = 0; i < 6; i++) { switch (i & 1) { case 0: if (i > 2) continue; s += i; break; case 1: s += 100; } } return s; }", 302, 302),
    // a loop inside the switch keeps its own continue
    ("int main() { int s = 0; for (int i = 0; i < 2; i++) { switch (i) { case 1: for (int j = 0; j < 5; j++) { if (j == 2) continue; s += j; } break; default: s += 100; } } return s; }", 108, 108),
    // fallthrough into a continue
    ("int main() { int s = 0; for (int i = 0; i < 4; i++) { switch (i) { case 0: s += 1; case 1: s += 2; continue; case 2: s += 4; } s += 8; } return s; }", 25, 25),
    // continue in default
    ("int main() { int s = 0; int i = 0; while (i < 5) { i++; switch (i) { case 5: s += 50; break; default: continue; } s += 1; } return s; }", 51, 51),
    // a tiny tokenizer over a string literal
    ("int main() { char *s = \"a1b22c\"; int digits = 0; int letters = 0; for (int i = 0; s[i] != 0; i++) { switch (s[i]) { case '1': case '2': digits++; continue; default: break; } letters++; } return digits * 10 + letters; }", 33, 33),
    ("int main() { long t = 0; for (long i = 0; i < 10; i++) { switch ((int)(i % 4)) { case 0: continue; case 1: t += i; break; default: t += 2 * i; } } return (int)t; }", 51, 51),
    // two switches in one loop body
    ("int main() { int s = 0; for (int i = 0; i < 6; i++) { switch (i) { case 1: continue; } switch (i) { case 4: continue; } s += i; } return s; }", 10, 10),
    // continue targets the innermost loop
    ("int main() { int s = 0; for (int i = 0; i < 3; i++) { for (int j = 0; j < 3; j++) { switch (j) { case 1: continue; } s += i * 10 + j; } } return s; }", 66, 66),
    // return from inside the switch still works next to continue
    ("int f(int n) { int c = 0; for (int i = 0; i < n; i++) { switch (i % 3) { case 0: continue; case 2: if (i > 7) return c; } c++; } return c; } int main() { return f(12); }", 5, 5),
    ("int main() { int a[6] = {3, 0, 2, 0, 5, 1}; int s = 0; for (int i = 0; i < 6; i++) { switch (a[i]) { case 0: continue; default: s += a[i] * i; } } return s; }", 29, 29),
    // continue in a do-while still evaluates the condition
    ("int main() { int i = 10; int n = 0; do { n++; switch (n) { case 1: continue; } i--; } while (i > 8); return n * 100 + i; }", 308, 308),
    ("int main() { int a[5] = {5, 1, 4, 2, 3}; int cnt = 0; for (int i = 0; i < 5; i++) { switch (a[i] % 2) { case 1: continue; } cnt += a[i]; } return cnt; }", 6, 6),
    ("int evens(int n) { int s = 0; int i = 0; while (i < n) { int v = i; i++; switch (v % 2) { case 1: continue; } s += v; } return s; } int main() { return evens(10) + evens(5); }", 26, 26),
    ("int main() { unsigned s = 0; for (unsigned i = 0; i < 4; i++) { switch (i) { case 0: case 3: continue; } s += i; } return s; }", 3, 3),
    // continue still runs the for step
    ("int main() { int i; int n = 0; for (i = 0; i < 20; i += 3) { switch (i % 2) { case 0: continue; } n++; } return n * 100 + i; }", 321, 321),
    ("int main() { int n = 0; for (int i = 0; i < 3; i++) { switch (i) { default: break; } n++; } return n; }", 3, 3),
    // bubble sort that skips already-equal neighbours with a switch
    ("int main() { int a[5] = {4, 4, 1, 3, 1}; for (int i = 0; i < 5; i++) { for (int j = 0; j + 1 < 5 - i; j++) { switch (a[j] == a[j + 1]) { case 1: continue; } if (a[j] > a[j + 1]) { int t = a[j]; a[j] = a[j + 1]; a[j + 1] = t; } } } return a[0] * 10000 + a[1] * 1000 + a[2] * 100 + a[3] * 10 + a[4]; }", 11344, 11344),
];

#[test]
fn continue_and_break_in_switch_execute_on_rv32_and_rv64() {
    support::check_c_programs("switch continue", PROGRAMS);
}

#[test]
fn continue_and_break_in_switch_match_the_host_compiler() {
    support::host_cc_differential("c-switch-continue", PROGRAMS);
}

#[test]
fn continue_in_a_switch_outside_any_loop_is_a_clear_error() {
    let err = sim_engine::c_to_asm("int main() { switch (1) { case 1: continue; } return 0; }").unwrap_err();
    assert!(err.message.contains("continue"), "{}", err.message);
    assert!(!err.message.contains("__"), "internal names must not leak: {}", err.message);
}

/// C and C++ give the same result for the same source.
#[test]
fn cpp_gives_the_same_results() {
    for (src, want32, want64) in PROGRAMS.iter().filter(|(src, _, _)| !src.contains('*') && !src.contains("long") && !src.contains("unsigned")) {
        let asm32 = sim_engine::cpp_to_asm(src).unwrap_or_else(|e| panic!("{src}: {}", e.message));
        assert_eq!(support::run_asm32(&asm32), Ok(*want32), "{src}");
        let asm64 = sim_engine::cpp_to_asm64(src).unwrap_or_else(|e| panic!("{src}: {}", e.message));
        assert_eq!(support::run_asm64(&asm64), Ok(*want64), "{src}");
    }
}

//! S1: C enums. Explicit values and auto-increment, typedef enum,
//! enumerators as constants (array sizes, case labels, initializers),
//! enum variables behaving as int, on RV32 (ILP32) and RV64 (LP64).

mod support;

use support::{check_c_errors, check_c_programs, host_cc_differential};

/// (program, expected main() result on RV32, on RV64)
const PROGRAMS: &[(&str, i64, i64)] = &[
    ("enum Color { RED, GREEN, BLUE }; int main() { return BLUE; }", 2, 2),
    ("enum { A = 5, B, C = 10, D }; int main() { return A + B + C + D; }", 32, 32),
    ("enum E { X = -3, Y, Z }; int main() { return X * 100 + Y * 10 + Z; }", -321, -321),
    ("enum Flags { F1 = 1 << 0, F2 = 1 << 1, F3 = 1 << 2, ALL = F1 | F2 | F3 }; int main() { return ALL; }", 7, 7),
    ("enum { BASE = 10, NEXT = BASE * 2 + 1 }; int main() { return NEXT; }", 21, 21),
    ("typedef enum { OFF, ON } Switch; int main() { Switch s = ON; return s; }", 1, 1),
    ("typedef enum Mode { READ = 4, WRITE = 2 } Mode; int main() { Mode m = READ; enum Mode n = WRITE; return m | n; }", 6, 6),
    ("enum Color { RED, GREEN, BLUE }; int main() { enum Color c = GREEN; c = c + 1; return c == BLUE; }", 1, 1),
    // enumerators as array sizes
    ("enum { N = 4 }; int main() { int a[N]; for (int i = 0; i < N; i++) a[i] = i * i; return a[N - 1]; }", 9, 9),
    ("enum { ROWS = 2, COLS = 3 }; int main() { int m[ROWS * COLS] = {1, 2, 3, 4, 5, 6}; return m[1 * COLS + 2]; }", 6, 6),
    ("enum { SIZE = 3 }; int g[SIZE] = {7, 8, 9}; int main() { return g[SIZE - 1]; }", 9, 9),
    // enumerators as case labels
    ("enum Op { ADD, SUB, MUL }; int apply(int op, int a, int b) { switch (op) { case ADD: return a + b; case SUB: return a - b; case MUL: return a * b; } return 0; } int main() { return apply(MUL, 6, 7) + apply(SUB, 1, 3); }", 40, 40),
    ("enum { NEG = -2 }; int main() { int x = -2; switch (x) { case NEG: return 1; default: return 0; } }", 1, 1),
    ("enum { NEG = 2 }; int main() { int x = -2; switch (x) { case -NEG: return 1; default: return 0; } }", 1, 1),
    // enumerators in global initializers
    ("enum { START = 40 }; int g = START + 2; int main() { return g; }", 42, 42),
    // enum parameters and results behave as int
    ("enum Dir { N, E, S, W }; enum Dir turn(enum Dir d) { return (d + 1) % 4; } int main() { return turn(W) * 10 + turn(E); }", 2, 2),
    ("typedef enum { LOW = 1, HIGH = 9 } Level; Level pick(int x) { if (x > 5) return HIGH; return LOW; } int main() { return pick(7) + pick(3); }", 10, 10),
    // block scope: an inner enumerator or variable shadows an outer one
    ("enum { V = 1 }; int main() { int r = V; { enum { V = 5 }; r = r * 10 + V; } return r * 10 + V; }", 151, 151),
    ("enum { K = 3 }; int main() { int s = K; { int K = 8; s += K; } return s + K; }", 14, 14),
    ("int main() { enum Local { P = 7, Q }; return P + Q; }", 15, 15),
    // an enum value as a sizeof operand and in arithmetic with long
    ("enum Color { RED }; int main() { enum Color c = RED; return sizeof(c) + sizeof(enum Color); }", 8, 8),
    ("enum { BIG = 100000 }; int main() { long x = BIG; return x / 1000; }", 100, 100),
    // a small state machine
    ("enum State { IDLE, RUN, DONE }; int main() { enum State s = IDLE; int steps = 0; while (s != DONE) { switch (s) { case IDLE: s = RUN; break; case RUN: steps++; if (steps == 3) s = DONE; break; default: break; } } return steps; }", 3, 3),
    ("enum Weekday { MON = 1, TUE, WED, THU, FRI, SAT, SUN }; int weekend(enum Weekday d) { return d == SAT || d == SUN; } int main() { int n = 0; for (int d = MON; d <= SUN; d++) n += weekend(d); return n; }", 2, 2),
];

#[test]
fn enums_execute_on_rv32_and_rv64() {
    check_c_programs("enums", PROGRAMS);
}

#[test]
fn enums_match_the_host_cc() {
    host_cc_differential("enums", PROGRAMS);
}

#[test]
fn enum_mistakes_fail_clearly() {
    check_c_errors(
        "enum errors",
        &[
            ("enum { A, B, A }; int main() { return 0; }", "'A' is already defined in this scope"),
            ("enum E { A }; enum F { A }; int main() { return 0; }", "'A' is already defined in this scope"),
            ("int main() { int x = 3; enum { A = x }; return A; }", "the value of 'A' must be a constant number"),
            ("enum { A = 3000000000 }; int main() { return 0; }", "does not fit in an int"),
            ("int main() { enum Missing m; return 0; }", "'Missing' is not a declared enum here"),
            ("enum E { A }; enum E { B }; int main() { return 0; }", "'E' is defined twice in the same scope (as an enum)"),
            ("typedef enum { A } T; int main() { return T; }", "'T' is a type name"),
            ("enum { A }; int main() { int n = 3; int a[n]; return 0; }", "variable-length arrays"),
            ("enum { A = 0 }; int main() { int a[A]; return 0; }", "array size must be a constant between 1 and 4096"),
        ],
    );
}

#[test]
fn enum_errors_point_at_a_line() {
    let e = sim_engine::c_to_asm("int main() {\n  enum { A, B, A };\n  return 0;\n}\n").unwrap_err();
    assert_eq!(e.line, 2, "{e:?}");
    assert!(e.message.contains("'A'"), "the message quotes the token so the caret can find it: {}", e.message);
}

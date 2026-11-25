//! C block scopes and shadowing: every `{ }` block, `for` header and
//! statement body is a scope; inner declarations may shadow outer, global
//! and parameter names; redeclaring in the same scope stays an error.

mod support;

/// (source, RV32 result, RV64 result)
const PROGRAMS: &[(&str, i64, i64)] = &[
    // two loops in one function both declare i
    ("int main() { int s = 0; for (int i = 0; i < 3; i++) s += i; for (int i = 0; i < 4; i++) s += i * 10; return s; }", 63, 63),
    // an inner block shadows a local; the outer one is untouched
    ("int main() { int x = 1; { int x = 2; x += 5; } return x; }", 1, 1),
    // a local shadows a global inside a block only
    ("int x = 7; int main() { int r = x; { int x = 3; r += x; } return r + x; }", 17, 17),
    // the for-init variable ends with the loop, so the name is free again
    ("int main() { int t = 0; for (int i = 0; i < 5; i++) { t += i; } int i = 100; return t + i; }", 110, 110),
    // three levels of shadowing
    ("int main() { int v = 1; int s = 0; { int v = 10; s += v; { int v = 100; s += v; } s += v; } return s + v; }", 121, 121),
    // an inner block shadows a parameter
    ("int f(int n) { int r = n; { int n = 5; r += n; } return r + n; } int main() { return f(3); }", 11, 11),
    // a parameter shadows a global
    ("int n = 50; int f(int n) { return n * 2; } int main() { return f(4) + n; }", 58, 58),
    // sibling blocks reuse a name with different types
    ("int main() { int s = 0; { char c = 200; s += c; } { int c = -5; s += c; } return s; }", 195, 195),
    // a declaration in a loop body is fresh on every iteration
    ("int main() { int i = 0; int s = 0; while (i < 4) { int sq = i * i; s += sq; i++; } return s; }", 14, 14),
    // both branches of an if declare the same name
    ("int main() { int a = 3; int r = 0; if (a > 2) { int t = a * 2; r = t; } else { int t = a * 3; r = t; } return r; }", 6, 6),
    // matrix in a flat array: nested loops, then another loop reusing i
    ("int main() { int m[9]; for (int i = 0; i < 3; i++) { for (int j = 0; j < 3; j++) { m[i * 3 + j] = i * 3 + j + 1; } } int tr = 0; for (int i = 0; i < 3; i++) { tr += m[i * 3 + i]; } return tr; }", 15, 15),
    // matrix multiply in flat arrays with a block-local accumulator
    ("int main() { int a[4] = {1, 2, 3, 4}; int b[4] = {5, 6, 7, 8}; int c[4]; for (int i = 0; i < 2; i++) { for (int j = 0; j < 2; j++) { int s = 0; for (int k = 0; k < 2; k++) { s += a[i * 2 + k] * b[k * 2 + j]; } c[i * 2 + j] = s; } } return c[0] + c[3]; }", 69, 69),
    // an inner array shadows an outer array
    ("int main() { int a[3] = {1, 2, 3}; int s = 0; { int a[2] = {10, 20}; s += a[1]; } return s + a[2]; }", 23, 23),
    // an int shadows a pointer of the same name
    ("int main() { int x = 4; int *p = &x; { int p = 9; x += p; } return *p; }", 13, 13),
    // do-while body declarations
    ("int main() { int n = 0; int s = 0; do { int d = n * 2; s += d; n++; } while (n < 4); return s; }", 12, 12),
    // renaming never collides with a name the program already uses
    ("int main() { int i_2 = 40; int s = 0; for (int i = 0; i < 2; i++) { s += i; } for (int i = 0; i < 3; i++) { s += i; } return s + i_2; }", 44, 44),
    // block-local names in a recursive function
    ("int fact(int n) { if (n < 2) { int one = 1; return one; } { int sub = fact(n - 1); return n * sub; } } int main() { return fact(5); }", 120, 120),
    // each case block declares its own k
    ("int main() { int r = 0; for (int i = 0; i < 3; i++) { switch (i) { case 0: { int k = 1; r += k; break; } case 1: { int k = 10; r += k; break; } default: { int k = 100; r += k; } } } return r; }", 111, 111),
    // the for-init i shadows an outer i, which keeps its value
    ("int main() { int i = 7; int s = 0; for (int i = 0; i < 3; i++) { s += i; } return s + i; }", 10, 10),
    // before the inner declaration, the name still means the outer variable
    ("int main() { int x = 5; int r = 0; { r = x; int x = 2; r += x; } return r; }", 7, 7),
    // a local array shadows a global array used by another function
    ("int g[3] = {1, 2, 3}; int sum(void) { return g[0] + g[1] + g[2]; } int main() { int g[3] = {10, 20, 30}; return g[1] + sum(); }", 26, 26),
    // linked list on a global array pool, two loops both using i
    ("int next[8]; int val[8]; int head = -1; int used = 0;\n\
int push(int v) { int n = used; used = used + 1; val[n] = v; next[n] = head; head = n; return n; }\n\
int main() { for (int i = 1; i <= 5; i++) { push(i * i); } int s = 0; for (int i = head; i != -1; i = next[i]) { s = s * 2 + val[i] % 7; } return s; }", 97, 97),
    // a long shadows an int; RV32 and RV64 agree on the value
    ("int main() { int v = 3; long t = 0; { long v = 1000000; t = v * 2; } return (int)(t / 1000) + v; }", 2003, 2003),
];

#[test]
fn block_scopes_execute_on_rv32_and_rv64() {
    support::check_c_programs("block scopes", PROGRAMS);
}

#[test]
fn block_scopes_match_the_host_compiler() {
    support::host_cc_differential("c-block-scopes", PROGRAMS);
}

#[test]
fn redeclaring_in_the_same_scope_is_a_clear_error() {
    support::check_c_errors(
        "same-scope redeclaration",
        &[
            ("int main() { int x = 1; int x = 2; return x; }", "'x' is already declared in this block (on line 1)"),
            ("int main() { { int y = 1; char y = 2; } return 0; }", "'y' is already declared in this block"),
            ("int f(int a) { int a = 2; return a; } int main() { return f(1); }", "'a' is already declared in this block"),
            ("int f(int a, int a) { return a; } int main() { return f(1, 2); }", "parameter 'a' appears twice"),
            ("int main() { int a[2]; int a = 1; return a; }", "already declared in this block"),
            ("int main() { for (int i = 0; i < 2; i++) { } return i; }", "'i' is not visible here"),
            ("int main() { { int t = 1; } t = 2; return 0; }", "declare it before that block"),
        ],
    );
}

#[test]
fn redeclaration_errors_say_what_to_do() {
    let err = sim_engine::c_to_asm("int main() {\n  int x = 1;\n  int x = 2;\n  return x;\n}").unwrap_err();
    assert_eq!(err.line, 3);
    assert!(err.message.contains("on line 2"), "{}", err.message);
    assert!(err.message.contains("use a different name"), "{}", err.message);
}

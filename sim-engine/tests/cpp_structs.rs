//! S8: enums, structs and unions flow to the C++ front end (valid C gives
//! the same result), and translating them to Rust or between C and C++
//! source fails with a clear, line-numbered error.

mod support;

use support::{run_asm32, run_asm64, run_c32, run_c64};

/// Valid C that is also valid C++ in the subset (no pointers or globals,
/// which the C++ subset does not have): (program, RV32 result, RV64 result).
const SHARED: &[(&str, i64, i64)] = &[
    ("enum Color { RED, GREEN = 5, BLUE }; int main() { return BLUE; }", 6, 6),
    ("typedef enum { OFF, ON } Switch; int main() { Switch s = ON; return s; }", 1, 1),
    ("enum { N = 3 }; int main() { int a[N] = {1, 2, 3}; return a[N - 1]; }", 3, 3),
    ("enum Op { ADD, MUL }; int run(int op, int a, int b) { switch (op) { case ADD: return a + b; case MUL: return a * b; } return 0; } int main() { return run(MUL, 6, 7); }", 42, 42),
    ("struct P { int x; int y; }; int main() { struct P p; p.x = 3; p.y = 4; return p.x * 10 + p.y; }", 34, 34),
    ("struct S { char c; long l; }; int main() { return sizeof(struct S); }", 8, 16),
    ("struct P { int x; int y; }; int main() { struct P p = {5, 6}; struct P q = p; q.x = 1; return p.x * 10 + q.x; }", 51, 51),
    ("struct In { int a; }; struct Out { struct In in; int b[3]; }; int main() { struct Out o = {{2}, {3, 4}}; return o.in.a * 100 + o.b[0] * 10 + o.b[1] + o.b[2]; }", 234, 234),
    ("struct P { int x; int y; }; int main() { struct P pts[3] = {{1, 2}, {3, 4}, {5, 6}}; int s = 0; for (int i = 0; i < 3; i++) s += pts[i].x * pts[i].y; return s; }", 44, 44),
    ("struct P { int x; int y; }; struct P make(int x, int y) { struct P p = {x, y}; return p; } int main() { struct P p = make(2, 9); return p.x + p.y; }", 11, 11),
    ("struct P { int x; int y; }; int dist2(struct P a, struct P b) { int dx = a.x - b.x; int dy = a.y - b.y; return dx * dx + dy * dy; } int main() { struct P a = {1, 2}; struct P b = {4, 6}; return dist2(a, b); }", 25, 25),
    ("struct R { int key; int val; }; int main() { struct R rs[4] = {{3, 30}, {1, 10}, {4, 40}, {2, 20}}; for (int i = 0; i < 4; i++) for (int j = 0; j + 1 < 4 - i; j++) if (rs[j].key > rs[j + 1].key) { struct R t = rs[j]; rs[j] = rs[j + 1]; rs[j + 1] = t; } return rs[0].val + rs[3].val * 10; }", 410, 410),
    ("struct Stack { int top; int data[8]; }; struct Stack push(struct Stack s, int v) { s.data[s.top] = v; s.top++; return s; } int main() { struct Stack s = {0}; s = push(s, 4); s = push(s, 5); return s.data[s.top - 1] * 10 + s.top; }", 52, 52),
    ("struct M { int rows; int cols; int cells[6]; }; int main() { struct M m = {2, 3, {1, 2, 3, 4, 5, 6}}; return m.cells[1 * m.cols + 2]; }", 6, 6),
    ("struct Str { char text[8]; int len; }; int main() { struct Str s = {{104, 101, 108, 108, 111}, 5}; int i = 0; int j = s.len - 1; while (i < j) { char t = s.text[i]; s.text[i] = s.text[j]; s.text[j] = t; i++; j--; } return s.text[0]; }", 111, 111),
    ("union U { int i; unsigned char b[4]; }; int main() { union U u; u.i = 258; return u.b[0] + u.b[1] * 10; }", 12, 12),
    ("union U { char c; long l; }; int main() { return sizeof(union U); }", 4, 8),
    ("enum Kind { NUM, PAIR }; struct V { enum Kind k; union { int n; short p[2]; } as; }; int eval(struct V v) { if (v.k == NUM) return v.as.n; return v.as.p[0] * v.as.p[1]; } int main() { struct V a; a.k = NUM; a.as.n = 5; struct V b; b.k = PAIR; b.as.p[0] = 6; b.as.p[1] = 7; return eval(a) + eval(b); }", 47, 47),
    ("typedef struct { int w; int h; } Size; int area(Size s) { return s.w * s.h; } int main() { Size s = {.h = 7, .w = 6}; return area(s); }", 42, 42),
    ("struct Acc { int sum; int n; }; struct Acc add(struct Acc a, int v) { a.sum += v; a.n++; return a; } int main() { struct Acc a = {0, 0}; for (int i = 1; i <= 4; i++) a = add(a, i); return a.sum * 10 + a.n; }", 104, 104),
];

fn run_cpp32(src: &str) -> Result<i64, String> {
    run_asm32(&sim_engine::cpp_to_asm(src).map_err(|e| format!("line {}: {}", e.line, e.message))?)
}

fn run_cpp64(src: &str) -> Result<i64, String> {
    run_asm64(&sim_engine::cpp_to_asm64(src).map_err(|e| format!("line {}: {}", e.line, e.message))?)
}

#[test]
fn valid_c_gives_the_same_result_as_cpp() {
    let mut failures = Vec::new();
    for (src, want32, want64) in SHARED {
        for (what, got, want) in [
            ("C RV32", run_c32(src), *want32),
            ("C RV64", run_c64(src), *want64),
            ("C++ RV32", run_cpp32(src), *want32),
            ("C++ RV64", run_cpp64(src), *want64),
        ] {
            if got.as_ref() != Ok(&want) {
                failures.push(format!("{what}: {src}\n    expected {want}, got {got:?}"));
            }
        }
    }
    assert!(failures.is_empty(), "{} failures\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn cpp_tags_are_type_names() {
    let src = "struct Point { int x; int y; };\nenum Mode { A, B };\nunion Cell { int i; char c; };\nint main() { Point p = {1, 2}; Mode m = B; Cell c; c.i = 3; return p.y * 100 + m * 10 + c.i; }";
    assert_eq!(run_cpp32(src), Ok(213));
    assert_eq!(run_cpp64(src), Ok(213));
}

#[test]
fn cpp_keeps_its_limits_on_structs() {
    for (src, line, needle) in [
        ("struct P { int x; };\nint main() { P p; P *q = &p; return 0; }", 2, "unsupported"),
        ("struct P { int x; };\nint main() { P p;\n return p->x; }", 3, "'->' needs pointers"),
        ("struct P { int x; };\nP g;\nint main() { return 0; }", 2, "global variables"),
        ("struct P { bool b; };\nint main() { return 0; }", 1, "bool members like 'b'"),
    ] {
        let e = sim_engine::cpp_to_asm(src).expect_err(src);
        assert_eq!(e.line, line, "{src}: {e:?}");
        assert!(e.message.contains(needle), "{src}: {}", e.message);
    }
}

/// Translating to Rust (or between C and C++ source) stops at the first
/// enum, struct, union or typedef with its line and a pointer to the
/// supported list.
#[test]
fn translating_user_types_to_rust_fails_with_a_line() {
    let src = "int main() {\n  int x = 1;\n  struct P { int x; };\n  struct P p;\n  p.x = x;\n  return p.x;\n}\n";
    for (direction, result, to) in [
        ("c to rust", sim_engine::c_to_rust(src), "Rust"),
        ("cpp to rust", sim_engine::cpp_to_rust(src), "Rust"),
        ("c to cpp", sim_engine::c_to_cpp(src), "C++"),
        ("cpp to c", sim_engine::cpp_to_c(src), "C"),
    ] {
        let e = result.expect_err(direction);
        assert_eq!(e.line, 3, "{direction}: {e:?}");
        assert!(e.message.contains("'struct'"), "{direction}: the keyword is quoted for the caret: {}", e.message);
        assert!(e.message.contains("subset list"), "{direction}: {}", e.message);
        assert!(e.message.contains(&format!("to {to} is not supported yet")), "{direction}: {}", e.message);
    }
    let enums = "enum Color { RED, GREEN };\nint main() { return GREEN; }\n";
    let e = sim_engine::c_to_rust(enums).unwrap_err();
    assert_eq!(e.line, 1);
    assert!(e.message.contains("'enum'"), "{}", e.message);
    let e = sim_engine::cpp_to_rust("typedef int Number;\nint main() { Number n = 2; return n; }\n").unwrap_err();
    assert_eq!(e.line, 1);
    assert!(e.message.contains("'typedef'"), "{}", e.message);
}

//! C void functions: `void f(...)`, `f(void)` parameter lists, bare
//! `return;`, calls as statements, prototypes, and clear errors for using
//! a void call as a value.

mod support;

/// (source, RV32 result, RV64 result)
const PROGRAMS: &[(&str, i64, i64)] = &[
    ("void inc(int *p) { *p = *p + 1; } int main() { int x = 4; inc(&x); inc(&x); return x; }", 6, 6),
    // bubble sort with a void swap(int *, int *)
    ("void swap(int *a, int *b) { int t = *a; *a = *b; *b = t; }\n\
void sort(int *v, int n) { for (int i = 0; i < n; i++) { for (int j = 0; j + 1 < n - i; j++) { if (v[j] > v[j + 1]) swap(&v[j], &v[j + 1]); } } }\n\
int main() { int a[6] = {5, 2, 9, 1, 7, 3}; sort(a, 6); return a[0] * 100000 + a[1] * 10000 + a[2] * 1000 + a[3] * 100 + a[4] * 10 + a[5]; }", 123579, 123579),
    // an early bare return
    ("int g = 0; void setg(int v) { if (v < 0) return; g = v; } int main() { setg(5); setg(-1); return g; }", 5, 5),
    // a (void) prototype, defined after main
    ("void bump(void); int c = 0; int main() { bump(); bump(); bump(); return c; } void bump(void) { c += 2; }", 6, 6),
    // string length and in-place reverse over a char array
    ("int len(char *s) { int n = 0; while (s[n] != 0) n++; return n; }\n\
void reverse(char *s) { int i = 0; int j = len(s) - 1; while (i < j) { char t = s[i]; s[i] = s[j]; s[j] = t; i++; j--; } }\n\
int main() { char s[6] = \"hello\"; reverse(s); return s[0] * 1000 + s[4] + len(s); }", 111109, 111109),
    ("int total = 0; void add(int v) { total += v; } int main() { for (int i = 1; i <= 10; i++) add(i); return total; }", 55, 55),
    ("int depth = 0; void down(int n) { if (n == 0) return; depth++; down(n - 1); } int main() { down(7); return depth; }", 7, 7),
    ("int a = 0; void one(void) { a += 1; } void three(void) { one(); one(); one(); } int main() { three(); three(); return a; }", 6, 6),
    ("void fill(int *a, int n, int v) { for (int i = 0; i < n; i++) a[i] = v + i; } int main() { int a[4]; fill(a, 4, 10); return a[0] + a[3]; }", 23, 23),
    ("int r = 0; void f7(int a, int b, int c, int d, int e, int f, int g) { r = a + b * 2 + c * 3 + d * 4 + e * 5 + f * 6 + g * 7; } int main() { f7(1, 1, 1, 1, 1, 1, 1); return r; }", 28, 28),
    ("int m = 0; void maxset(int a, int b) { if (a > b) { m = a; return; } m = b; } int main() { maxset(3, 9); int x = m; maxset(8, 2); return x * 10 + m; }", 98, 98),
    ("void upper(char *s) { for (int i = 0; s[i]; i++) { if (s[i] >= 'a' && s[i] <= 'z') s[i] = s[i] - 32; } } int main() { char s[4] = \"abc\"; upper(s); return s[0] + s[2]; }", 132, 132),
    ("void step(long *acc, long by) { *acc = *acc + by; } int main() { long a = 0; for (int i = 0; i < 5; i++) step(&a, i); return (int)a; }", 10, 10),
    // an old-style empty prototype, then the definition
    ("int z = 0; void f(); void f() { z = 9; } int main() { f(); return z; }", 9, 9),
    // an int function called as a statement discards its result
    ("int c = 0; int tick(void) { c++; return c; } int main() { tick(); tick(); return c; }", 2, 2),
    // matrix transpose in place on a flat array
    ("void transpose(int *m, int n) { for (int i = 0; i < n; i++) { for (int j = i + 1; j < n; j++) { int t = m[i * n + j]; m[i * n + j] = m[j * n + i]; m[j * n + i] = t; } } }\n\
int main() { int m[9] = {1, 2, 3, 4, 5, 6, 7, 8, 9}; transpose(m, 3); return m[1] * 10 + m[5]; }", 48, 48),
    ("int s = 0; void add(int v) { s += v; } int main() { for (int i = 0; i < 4; i++) { switch (i) { case 0: add(1); break; case 2: add(10); break; default: add(100); } } return s; }", 211, 211),
    ("void zero(char *b, int n) { int i = 0; while (i < n) { b[i] = 0; i++; } } int main() { char b[5] = \"wxyz\"; zero(b, 2); return b[0] + b[1] + b[2]; }", 121, 121),
    ("void gcd(int a, int b, int *out) { while (b != 0) { int t = a % b; a = b; b = t; } *out = a; } int main() { int g = 0; gcd(84, 36, &g); return g; }", 12, 12),
    // linked list on a global array pool
    ("int next[8]; int val[8]; int head = -1; int used = 0;\n\
void push(int v) { val[used] = v; next[used] = head; head = used; used++; }\n\
int sum(void) { int s = 0; for (int n = head; n != -1; n = next[n]) s += val[n]; return s; }\n\
int main() { push(3); push(4); push(5); return sum() * 10 + used; }", 123, 123),
    ("void minmax(int *a, int n, int *lo, int *hi) { *lo = a[0]; *hi = a[0]; for (int i = 1; i < n; i++) { if (a[i] < *lo) *lo = a[i]; if (a[i] > *hi) *hi = a[i]; } }\n\
int main() { int a[5] = {4, -2, 9, 0, 3}; int lo = 0; int hi = 0; minmax(a, 5, &lo, &hi); return hi * 100 + lo; }", 898, 898),
    // a void function returning from inside a loop
    ("int found = -1; void find(int *a, int n, int key) { for (int i = 0; i < n; i++) { if (a[i] == key) { found = i; return; } } } int main() { int a[5] = {8, 6, 7, 5, 3}; find(a, 5, 5); return found; }", 3, 3),
];

#[test]
fn void_functions_execute_on_rv32_and_rv64() {
    support::check_c_programs("void functions", PROGRAMS);
}

#[test]
fn void_functions_match_the_host_compiler() {
    support::host_cc_differential("c-void-functions", PROGRAMS);
}

#[test]
fn misusing_void_is_a_clear_error() {
    support::check_c_errors(
        "void misuse",
        &[
            ("void f(void) { } int main() { int x = f(); return x; }", "void function 'f' can only be called as a statement"),
            ("void f(void) { } int main() { return f() + 1; }", "it returns no value"),
            ("void ext(int x); int main() { return ext(1); }", "void function 'ext' can only be called as a statement"),
            ("void f(void) { return 1; } int main() { f(); return 0; }", "'f' is declared void, so write 'return;'"),
            ("int f(void) { return; } int main() { return f(); }", "'f' must return a value"),
            ("int main() { void x; return 0; }", "a variable cannot have type void"),
            ("void main() { }", "main() must return int"),
            ("void f(void) { } int main() { int a[2] = {f(), 1}; return a[0]; }", "can only be called as a statement"),
            ("void f(void) { } int main() { if (f()) return 1; return 0; }", "can only be called as a statement"),
        ],
    );
}

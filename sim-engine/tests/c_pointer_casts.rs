//! Pointer casts between object pointer types, casts between pointers and
//! pointer-width integers, `void *` as an opaque pointer, and comparison
//! with 0. Function pointers stay a clear error.

mod support;

/// (source, RV32 result, RV64 result)
const PROGRAMS: &[(&str, i64, i64)] = &[
    // little-endian byte view of an int
    ("int main() { int x = 0x01020304; char *c = (char *)&x; return c[0]; }", 4, 4),
    ("int main() { int x = 42; void *v = &x; int *p = (int *)v; return *p; }", 42, 42),
    // void * converts to and from other object pointers without a cast
    ("int main() { int x = 7; void *v = &x; int *p = v; *p = 9; return x; }", 9, 9),
    // a byte-wise swap through void * parameters
    ("void swap_bytes(void *a, void *b, int n) { char *x = (char *)a; char *y = (char *)b; for (int i = 0; i < n; i++) { char t = x[i]; x[i] = y[i]; y[i] = t; } }\n\
int main() { int a = 5; int b = 11; swap_bytes(&a, &b, 4); return a * 100 + b; }", 1105, 1105),
    // pointer -> long -> pointer
    ("int main() { int a[4] = {1, 2, 3, 4}; long addr = (long)&a[1]; int *p = (int *)addr; return *p + p[1]; }", 5, 5),
    ("int main() { int a[3] = {10, 20, 30}; unsigned long u = (unsigned long)a; u += 8; return *(int *)u; }", 30, 30),
    ("int main() { int *p = 0; int r = 0; if (p == 0) r += 1; int x = 0; p = &x; if (p != 0) r += 10; if (0 == p) r += 100; return r; }", 11, 11),
    ("void *pick(int *a, int i) { if (i < 0) return 0; return &a[i]; }\n\
int main() { int a[3] = {4, 5, 6}; int *p = pick(a, 2); void *q = pick(a, -1); int r = *p; if (q == 0) r += 100; return r; }", 106, 106),
    ("int main() { int a[2] = {0x01010101, 0x02020202}; unsigned char *b = (unsigned char *)a; int s = 0; for (int i = 0; i < 8; i++) s += b[i]; return s; }", 12, 12),
    ("int main() { int x = 0x00050003; short *h = (short *)&x; return h[0] * 10 + h[1]; }", 35, 35),
    // long is pointer-sized: 4 bytes on RV32, 8 on RV64
    ("int main() { long a[2]; long p = (long)&a[0]; long q = (long)&a[1]; return (int)(q - p); }", 4, 8),
    ("int main() { int x = 3; int *p = &x; void *vp = &p; int **pp = (int **)vp; **pp = 8; return x; }", 8, 8),
    ("int vals[4] = {7, 8, 9, 10};\n\
int sum(void *base, int n) { int *p = (int *)base; int s = 0; for (int i = 0; i < n; i++) s += p[i]; return s; }\n\
int main() { return sum(vals, 4); }", 34, 34),
    ("int g = 5; int main() { int *p = (int *)0; if (p == 0) return g; return 0; }", 5, 5),
    ("int main() { char *s = \"\\xff\\x01\"; unsigned char *u = (unsigned char *)s; return u[0] + u[1]; }", 256, 256),
    ("int main() { int a[5]; char *b = (char *)&a[0]; char *e = (char *)&a[4]; return (int)(e - b); }", 16, 16),
    // memcpy-style copy through void *
    ("void copy(void *dst, void *src, int n) { char *d = (char *)dst; char *s = (char *)src; for (int i = 0; i < n; i++) d[i] = s[i]; }\n\
int main() { int a[3] = {1, 2, 3}; int b[3] = {0, 0, 0}; copy(b, a, 12); return b[0] + b[1] * 10 + b[2] * 100; }", 321, 321),
    ("int main() { int x = 0; unsigned long a = (unsigned long)&x; return (int)(a % 4); }", 0, 0),
    ("int main() { int x = 0; void *v = &x; int *p = &x; return v == p; }", 1, 1),
    ("int main() { int a[2] = {11, 22}; char *c = (char *)a; c += 4; int *p = (int *)c; return *p; }", 22, 22),
    ("int main() { int x = 6; void *v = &x; return *(int *)v * 7; }", 42, 42),
    // linked list on a global pool, walked through void * links
    ("int val[4] = {3, 1, 4, 1}; int nxt[4] = {1, 2, 3, -1};\n\
void *node(int i) { if (i < 0) return 0; return &val[i]; }\n\
int main() { int s = 0; int i = 0; void *n = node(i); while (n != 0) { s = s * 10 + *(int *)n; i = nxt[i]; n = node(i); } return s; }", 3141, 3141),
];

#[test]
fn pointer_casts_execute_on_rv32_and_rv64() {
    support::check_c_programs("pointer casts", PROGRAMS);
}

#[test]
fn pointer_casts_match_the_host_compiler() {
    support::host_cc_differential("c-pointer-casts", PROGRAMS);
}

#[test]
fn misusing_void_pointers_and_casts_is_a_clear_error() {
    support::check_c_errors(
        "pointer cast misuse",
        &[
            ("int main() { int x = 1; void *p = &x; return *p; }", "cannot dereference a 'void *'"),
            ("int main() { int x = 1; void *p = &x; return p[0]; }", "cannot index a 'void *'"),
            ("int main() { int x = 1; void *p = &x; void *q = p + 1; return 0; }", "cannot do arithmetic on a 'void *'"),
            ("int main() { int x = 1; void *p = &x; p++; return 0; }", "cannot do arithmetic on a 'void *'"),
            ("int main() { int x = 1; void *p = &x; *p = 2; return 0; }", "cast it to a typed pointer first"),
            ("int main() { int x = 1; char c = (char)&x; return c; }", "use long or unsigned long"),
            ("int main() { short s = 1; int *p = (int *)s; return 0; }", "pointers are"),
            ("int main() { int x = 1; int *p = &x; char *c = p; return 0; }", "write a cast such as (char *)"),
            ("int main() { int x = 1; int *p = x; return 0; }", "only the constant 0 converts to a pointer"),
            ("int main() { int (*f)(int); return 0; }", "function pointers"),
            ("int main() { int x = 0; return (int)(int (*)(int))x; }", "function pointer types are not supported"),
        ],
    );
}

/// `int` is pointer-sized on RV32 only.
#[test]
fn int_pointer_casts_depend_on_the_target_width() {
    let src = "int main() { int x = 5; int a = (int)&x; int *p = (int *)a; return *p; }";
    assert_eq!(support::run_c32(src), Ok(5));
    let err = sim_engine::c_to_asm64(src).unwrap_err();
    assert!(err.message.contains("on RV64: pointers are 64 bits but 'int' is 32"), "{}", err.message);
    assert!(err.message.contains("use long or unsigned long"), "{}", err.message);
}

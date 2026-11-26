//! S2-S6: C structs. Layout with natural alignment and padding (ILP32 on
//! RV32, LP64 on RV64), member access with `.` and `->`, pointers to
//! structs, nesting, arrays, copies, initializers, and structs passed and
//! returned by value.

mod support;

use support::{check_c_errors, check_c_programs, host_cc_differential};

/// S2: declarations, typedef, tags, layout and sizeof, `.` and `->`,
/// pointers to structs, locals and globals, incomplete types behind
/// pointers. (program, RV32 result, RV64 result)
const LAYOUT: &[(&str, i64, i64)] = &[
    ("struct P { int x; int y; }; int main() { struct P p; p.x = 3; p.y = 4; return p.x * 10 + p.y; }", 34, 34),
    ("struct P { int x; int y; }; int main() { return sizeof(struct P); }", 8, 8),
    ("struct S { char c; int i; }; int main() { return sizeof(struct S); }", 8, 8),
    ("struct S { char c; short s; char d; }; int main() { return sizeof(struct S); }", 6, 6),
    ("struct S { char c; long l; }; int main() { return sizeof(struct S); }", 8, 16),
    ("struct S { int *p; char c; }; int main() { return sizeof(struct S); }", 8, 16),
    ("struct S { char a; char b; char c; }; int main() { return sizeof(struct S); }", 3, 3),
    ("struct S { short a; char b; }; int main() { struct S s; return sizeof(s); }", 4, 4),
    ("struct S { char c; long long x; }; int main() { return sizeof(struct S); }", -1, 16),
    // padding: the bytes between members stay out of the way
    ("struct S { char c; int i; }; int main() { struct S s; s.c = 255; s.i = -2; return s.c + s.i; }", 253, 253),
    ("struct S { unsigned char a; short b; unsigned char c; long d; }; int main() { struct S s; s.a = 1; s.b = -300; s.c = 200; s.d = 100000; return s.a + s.b + s.c + s.d / 1000; }", 1, 1),
    // typedef struct and tags
    ("typedef struct { int w; int h; } Size; int area(Size *s) { return s->w * s->h; } int main() { Size s; s.w = 6; s.h = 7; return area(&s); }", 42, 42),
    ("typedef struct Point Point; struct Point { int x; int y; }; int main() { Point p; p.x = 2; p.y = 5; struct Point *q = &p; return q->x + q->y; }", 7, 7),
    ("typedef struct Node { int v; struct Node *next; } Node; int main() { Node a; Node b; a.v = 1; b.v = 2; a.next = &b; b.next = 0; return a.next->v + (a.next->next == 0); }", 3, 3),
    // pointers to structs, -> on scalar and pointer members
    ("struct P { int x; int y; }; void move(struct P *p, int dx) { p->x += dx; p->y -= dx; } int main() { struct P p; p.x = 10; p.y = 10; move(&p, 3); return p.x * 100 + p.y; }", 1307, 1307),
    ("struct C { int n; }; int main() { struct C c; struct C *p = &c; p->n = 0; p->n++; ++p->n; p->n *= 5; return (*p).n; }", 10, 10),
    ("struct B { char *name; int len; }; int main() { struct B b; b.name = \"hello\"; b.len = 5; return b.name[b.len - 1]; }", 111, 111),
    ("struct R { int *target; }; int main() { int x = 1; struct R r; r.target = &x; *r.target = 9; return x; }", 9, 9),
    // globals
    ("struct P { int x; int y; }; struct P g; int main() { g.x = 4; g.y = 5; return g.x * g.y; }", 20, 20),
    ("struct P { int x; int y; }; struct P g; struct P *gp = &g; int main() { gp->y = 12; return g.y; }", 12, 12),
    ("struct C { long count; char tag; }; struct C counters[3]; int main() { for (int i = 0; i < 3; i++) { counters[i].count = i * 10; counters[i].tag = 'a' + i; } return counters[2].count + counters[1].tag; }", 118, 118),
    // incomplete types behind pointers: a linked list on a global pool
    ("struct node; struct node *head; struct node { int value; struct node *next; }; struct node pool[4]; int main() { head = 0; for (int i = 0; i < 4; i++) { pool[i].value = i + 1; pool[i].next = head; head = &pool[i]; } int s = 0; for (struct node *n = head; n; n = n->next) s = s * 10 + n->value; return s; }", 4321, 4321),
    // a struct of points with distance squared
    ("struct Point { int x; int y; }; int dist2(struct Point *a, struct Point *b) { int dx = a->x - b->x; int dy = a->y - b->y; return dx * dx + dy * dy; } int main() { struct Point a; struct Point b; a.x = 1; a.y = 2; b.x = 4; b.y = 6; return dist2(&a, &b); }", 25, 25),
    // a void * round trip
    ("struct P { int x; }; int main() { struct P p; p.x = 77; void *v = &p; struct P *q = v; return q->x; }", 77, 77),
    ("struct P { int x; }; int main() { struct P p; p.x = 5; struct P *q = (struct P *)(void *)&p; return q->x; }", 5, 5),
];

#[test]
fn layout_and_member_access_execute_on_rv32_and_rv64() {
    // `long long` is RV64-only: check that one separately
    let (rv64_only, both): (Vec<_>, Vec<_>) = LAYOUT.iter().partition(|(_, want32, _)| *want32 == -1);
    check_c_programs("struct layout", &both.into_iter().copied().collect::<Vec<_>>());
    for (src, _, want64) in rv64_only {
        assert_eq!(support::run_c64(src), Ok(*want64), "{src}");
        let e = sim_engine::c_to_asm(src).unwrap_err();
        assert!(e.message.contains("RV32"), "{}", e.message);
    }
}

#[test]
fn layout_matches_the_host_cc() {
    host_cc_differential("struct layout", LAYOUT);
}

#[test]
fn layout_mistakes_fail_clearly() {
    check_c_errors(
        "struct layout errors",
        &[
            ("struct P { int x; }; int main() { struct P p; return p.z; }", "'z' is not a member of struct P"),
            ("struct P { int xx; }; int main() { struct P p; return p.xy; }", "did you mean 'xx'?"),
            ("struct P { int x; }; int main() { struct P p; struct P *q = &p; return q.x; }", "so use '->'"),
            ("struct P { int x; }; int main() { struct P p; return p->x; }", "not a pointer, so use '.'"),
            ("int main() { int x = 1; return x.y; }", "'.' needs a struct or union on its left"),
            ("struct node; int main() { struct node n; return 0; }", "'struct node', which is not complete here"),
            ("struct node; int f(struct node *n) { return n->v; } int main() { return 0; }", "is not complete here"),
            ("struct node { int v; struct node inner; }; int main() { return 0; }", "inside itself"),
            ("struct P { int x; int x; }; int main() { return 0; }", "'x' is already a member"),
            ("struct E { }; int main() { return 0; }", "this 'struct' has no members"),
            ("struct P { int x; }; struct P { int y; }; int main() { return 0; }", "is defined twice"),
            ("struct P { int x; }; int main() { struct P p; p.x = 1; return p; }", "'p' is a struct P"),
            ("struct P { int x; }; int main() { struct P p; p.x = 1; return p + 1; }", "'p' is a struct P"),
            ("struct P { int x; }; struct Q { int y; }; int main() { struct P p; struct Q *q = &p; return 0; }", "'q' is a struct Q *, but this value is a struct P *"),
            ("struct P { int x; }; int main() { struct P p; int *ip = &p; return 0; }", "'p' is a struct P *, but 'ip' is a int *"),
            ("struct P { int x; }; union P u; int main() { return 0; }", "'P' was declared as a struct"),
        ],
    );
}

/// Everything the subset leaves out of structs fails with its documented
/// message (see `C_SUBSET_UNSUPPORTED`).
#[test]
fn unsupported_struct_features_fail_clearly() {
    check_c_errors(
        "unsupported struct features",
        &[
            ("struct F { int x : 3; }; int main() { return 0; }", "unsupported: bit-fields ('x' has a : width)"),
            ("struct F { int n; int data[]; }; int main() { return 0; }", "unsupported: flexible array members like 'data[]'"),
            ("struct F { struct { int a; }; }; int main() { return 0; }", "unsupported: anonymous struct and union members"),
            ("struct F { union { int a; char b; }; int n; }; int main() { return 0; }", "unsupported: anonymous struct and union members"),
            ("struct F { int (*op)(int); }; int main() { return 0; }", "unsupported: function pointers inside structs"),
            ("int main() { int n = 4; int a[n]; return 0; }", "unsupported: variable-length arrays"),
            ("struct F { int m[2][2]; }; int main() { return 0; }", "unsupported: arrays of arrays"),
            ("struct F { _Bool b; }; int main() { return 0; }", "expected a type"),
        ],
    );
}

/// S3: nested structs, arrays inside structs, arrays of structs,
/// member-access chains, address-of members, pointer arithmetic over
/// arrays of structs.
const NESTED: &[(&str, i64, i64)] = &[
    ("struct In { int a; int b; }; struct Out { char tag; struct In in; int z; }; int main() { struct Out o; o.in.a = 2; o.in.b = 3; o.z = 4; return o.in.a * 100 + o.in.b * 10 + o.z; }", 234, 234),
    ("struct In { char c; long l; }; struct Out { char t; struct In in; }; int main() { return sizeof(struct Out) * 100 + sizeof(struct In); }", 1208, 2416),
    ("struct A { int v; }; struct B { struct A a; }; struct C { struct B b; }; struct D { struct C c; }; int main() { struct D d; d.c.b.a.v = 41; d.c.b.a.v++; return d.c.b.a.v; }", 42, 42),
    ("struct V { int n; int items[5]; }; int main() { struct V v; v.n = 5; for (int i = 0; i < v.n; i++) v.items[i] = i * 3; return v.items[4] + sizeof(v.items); }", 32, 32),
    ("struct S { char name[8]; int len; }; int main() { struct S s; s.name[0] = 'h'; s.name[1] = 'i'; s.name[2] = 0; s.len = 0; while (s.name[s.len]) s.len++; return s.len; }", 2, 2),
    ("struct P { int x; int y; }; int main() { struct P pts[4]; for (int i = 0; i < 4; i++) { pts[i].x = i; pts[i].y = i * i; } int s = 0; for (int i = 0; i < 4; i++) s += pts[i].x + pts[i].y; return s + sizeof(pts); }", 52, 52),
    ("struct P { int x; int y; }; int main() { struct P pts[3]; struct P *p = pts; p->x = 1; (p + 1)->x = 2; p[2].x = 3; return pts[0].x * 100 + pts[1].x * 10 + pts[2].x; }", 123, 123),
    ("struct P { int x; char c; }; int main() { struct P pts[5]; struct P *a = &pts[1]; struct P *b = &pts[4]; return (b - a) * 10 + (b > a); }", 31, 31),
    ("struct P { short x; }; int main() { struct P ps[4]; int i = 0; for (struct P *p = ps; p < ps + 4; p++) p->x = 10 * ++i; struct P *q = ps + 3; q -= 2; q += 1; return q->x; }", 30, 30),
    ("struct P { int x; int y; }; int main() { struct P p; int *py = &p.y; *py = 8; int *px = &p.x; *px = py - px; return p.x * 10 + p.y; }", 18, 18),
    ("struct L { struct L *next; int v; }; int main() { struct L a; struct L b; struct L c; a.next = &b; b.next = &c; c.next = 0; c.v = 7; return a.next->next->v; }", 7, 7),
    ("struct Box { int w; }; struct Shelf { struct Box boxes[3]; int count; }; int main() { struct Shelf s; s.count = 3; for (int i = 0; i < 3; i++) s.boxes[i].w = i + 5; struct Shelf *p = &s; return p->boxes[2].w + p->count; }", 10, 10),
    ("struct Box { int w; }; struct Shelf { struct Box boxes[3]; }; int main() { struct Shelf rows[2]; rows[1].boxes[2].w = 9; struct Box *b = &rows[1].boxes[2]; b->w *= 3; return rows[1].boxes[2].w; }", 27, 27),
    ("struct N { int v; struct N *kids[2]; }; int main() { struct N r; struct N a; struct N b; r.kids[0] = &a; r.kids[1] = &b; a.v = 4; b.v = 6; return r.kids[0]->v * r.kids[1]->v; }", 24, 24),
    ("struct T { int v; }; int main() { struct T ts[3]; struct T *ptrs[3]; for (int i = 0; i < 3; i++) { ts[i].v = i + 1; ptrs[2 - i] = &ts[i]; } return ptrs[0]->v * 100 + ptrs[2]->v; }", 301, 301),
    ("struct T { int v; }; int main() { struct T t; t.v = 3; struct T *p = &t; struct T **pp = &p; (*pp)->v = 11; return (**pp).v; }", 11, 11),
    ("struct M { int rows; int cols; int cells[12]; }; int get(struct M *m, int r, int c) { return m->cells[r * m->cols + c]; } int main() { struct M m; m.rows = 3; m.cols = 4; for (int i = 0; i < 12; i++) m.cells[i] = i; return get(&m, 2, 3) + get(&m, 1, 1); }", 16, 16),
    ("struct Q { int head; int tail; int items[8]; }; void push(struct Q *q, int v) { q->items[q->tail] = v; q->tail = (q->tail + 1) % 8; } int pop(struct Q *q) { int v = q->items[q->head]; q->head = (q->head + 1) % 8; return v; } int main() { struct Q q; q.head = 0; q.tail = 0; push(&q, 5); push(&q, 6); push(&q, 7); int a = pop(&q); int b = pop(&q); return a * 10 + b; }", 56, 56),
    ("struct Stack { int top; long data[16]; }; void push(struct Stack *s, long v) { s->data[s->top++] = v; } long pop(struct Stack *s) { return s->data[--s->top]; } int main() { struct Stack s; s.top = 0; for (int i = 1; i <= 5; i++) push(&s, i * 100); long a = pop(&s); long b = pop(&s); return a - b + s.top; }", 103, 103),
    ("struct Str { char text[16]; int len; }; void reverse(struct Str *s) { int i = 0; int j = s->len - 1; while (i < j) { char t = s->text[i]; s->text[i] = s->text[j]; s->text[j] = t; i++; j--; } } int main() { struct Str s; char *src = \"abcde\"; s.len = 0; while (src[s.len]) { s.text[s.len] = src[s.len]; s.len++; } reverse(&s); return s.text[0] * 1000 + s.text[4]; }", 101097, 101097),
    ("struct P { int x; }; struct P g[3]; int main() { struct P *e = g + 3; int n = 0; for (struct P *p = g; p != e; p++) n++; return n + (e - g) * 10; }", 33, 33),
    ("struct P { int x; int y; }; int main() { struct P p; char *base = (char *)&p; char *y = (char *)&p.y; return y - base; }", 4, 4),
    ("struct A { char c; struct A *self; }; int main() { struct A a; a.self = &a; a.c = 'z'; return a.self->self->self->c; }", 122, 122),
];

#[test]
fn nesting_arrays_and_chains_execute_on_rv32_and_rv64() {
    check_c_programs("nested structs", NESTED);
}

#[test]
fn nesting_arrays_and_chains_match_the_host_cc() {
    host_cc_differential("nested structs", NESTED);
}

/// S4: struct assignment and copy, padding included.
const COPY: &[(&str, i64, i64)] = &[
    ("struct P { int x; int y; }; int main() { struct P a; struct P b; a.x = 1; a.y = 2; b = a; a.x = 9; return b.x * 10 + b.y; }", 12, 12),
    ("struct P { int x; int y; }; int main() { struct P a; a.x = 3; a.y = 4; struct P b = a; return b.x + b.y; }", 7, 7),
    ("struct P { char c; long l; }; int main() { struct P a; struct P b; a.c = 7; a.l = 1000; b = a; return b.c + b.l; }", 1007, 1007),
    ("struct P { int x; }; int main() { struct P a; struct P b; struct P *p = &a; struct P *q = &b; q->x = 5; *p = *q; return a.x; }", 5, 5),
    ("struct P { int v[4]; }; int main() { struct P a; struct P b; for (int i = 0; i < 4; i++) a.v[i] = i + 1; b = a; a.v[0] = 100; return b.v[0] + b.v[3] * 10; }", 41, 41),
    ("struct In { int a; }; struct Out { struct In in; int b; }; int main() { struct Out o; struct In i; i.a = 6; o.in = i; o.b = 1; return o.in.a + o.b; }", 7, 7),
    ("struct P { int x; }; int main() { struct P a; struct P b; struct P c; a.x = 4; c = b = a; return b.x + c.x; }", 8, 8),
    ("struct P { int x; int y; }; int main() { struct P arr[3]; arr[0].x = 1; arr[0].y = 2; arr[2] = arr[0]; arr[1] = arr[2]; return arr[1].x * 10 + arr[1].y; }", 12, 12),
    ("struct R { int key; int val; }; int main() { struct R rs[4]; int keys[4] = {3, 1, 4, 2}; for (int i = 0; i < 4; i++) { rs[i].key = keys[i]; rs[i].val = keys[i] * 10; } for (int i = 0; i < 4; i++) for (int j = 0; j + 1 < 4 - i; j++) if (rs[j].key > rs[j + 1].key) { struct R t = rs[j]; rs[j] = rs[j + 1]; rs[j + 1] = t; } return rs[0].val * 1000 + rs[1].val * 100 + rs[2].val + rs[3].key; }", 12034, 12034),
    ("struct P { int x; }; struct P g; int main() { struct P l; l.x = 9; g = l; l.x = 1; return g.x; }", 9, 9),
    ("struct P { short a; char b; }; int main() { struct P x; struct P y; x.a = -5; x.b = 3; y = x; return y.a * y.b + sizeof(y); }", -11, -11),
    ("struct Node { int v; struct Node *next; }; int main() { struct Node a; struct Node b; a.v = 1; a.next = &a; b = a; return b.next == &a; }", 1, 1),
    ("struct W { char c[3]; }; int main() { struct W a; struct W b; a.c[0] = 'x'; a.c[1] = 'y'; a.c[2] = 'z'; b = a; return b.c[2] - b.c[0]; }", 2, 2),
    ("struct P { int x; }; int main() { struct P a; struct P b; a.x = 2; b.x = 3; struct P t = a; a = b; b = t; return a.x * 10 + b.x; }", 32, 32),
    ("struct Big { long v[20]; }; int main() { struct Big a; struct Big b; for (int i = 0; i < 20; i++) a.v[i] = i; b = a; long s = 0; for (int i = 0; i < 20; i++) s += b.v[i]; return s; }", 190, 190),
    ("struct P { int x; int y; }; int main() { struct P a; a.x = 1; a.y = 2; struct P *p = &a; struct P b; b = *p; b.y = 5; return a.y * 10 + b.y; }", 25, 25),
    ("struct In { int a; int b; }; struct Out { struct In first; struct In second; }; int main() { struct Out o; o.first.a = 1; o.first.b = 2; o.second = o.first; o.second.b = 7; return o.first.b * 10 + o.second.b; }", 27, 27),
    ("struct P { int x; }; void set(struct P *dst, struct P *src) { *dst = *src; } int main() { struct P a; struct P b; a.x = 0; b.x = 42; set(&a, &b); return a.x; }", 42, 42),
    ("struct P { char tag; int n; }; int main() { struct P a; struct P b; a.tag = 'q'; a.n = 70000; b = a; return (b.tag == 'q') + b.n / 10000; }", 8, 8),
    ("struct P { int x; }; int main() { struct P ps[2]; struct P *p = ps; ps[1].x = 3; *p = *(p + 1); return ps[0].x; }", 3, 3),
];

#[test]
fn struct_copies_execute_on_rv32_and_rv64() {
    check_c_programs("struct copy", COPY);
}

#[test]
fn struct_copies_match_the_host_cc() {
    host_cc_differential("struct copy", COPY);
}

#[test]
fn struct_copy_mistakes_fail_clearly() {
    check_c_errors(
        "struct copy errors",
        &[
            ("struct P { int x; }; struct Q { int x; }; int main() { struct P p; struct Q q; p = q; return 0; }", "'p' is a struct P, so it can only be assigned another struct P"),
            ("struct P { int x; }; int main() { struct P p; p = 3; return 0; }", "can only be assigned another struct P"),
            ("struct P { int x; }; int main() { struct P p; struct P q; p += q; return 0; }", "only '=' copies a struct"),
            ("struct P { int x; }; int main() { struct P ps[2]; struct P qs[2]; ps = qs; return 0; }", "cannot assign to array 'ps' as a whole"),
            ("struct P { int x; }; int main() { struct P p; int x = 0; x = p; return x; }", "'p' is a struct P"),
        ],
    );
}

/// S5: `{...}` initializers for globals and locals: positional, nested,
/// partial (the rest is zero), designated, and strings for char arrays.
const INIT: &[(&str, i64, i64)] = &[
    ("struct P { int x; int y; }; int main() { struct P p = {3, 4}; return p.x * 10 + p.y; }", 34, 34),
    ("struct P { int x; int y; }; struct P g = {5, 6}; int main() { return g.x * 10 + g.y; }", 56, 56),
    ("struct P { int x; int y; int z; }; int main() { struct P p = {1}; return p.x + p.y + p.z; }", 1, 1),
    ("struct P { int x; int y; int z; }; struct P g = {7}; int main() { return g.x * 100 + g.y * 10 + g.z; }", 700, 700),
    ("struct P { int x; int y; }; int main() { struct P p = {0}; return p.x + p.y; }", 0, 0),
    ("struct In { char c; int n; }; struct Out { struct In a; struct In b; long l; }; int main() { struct Out o = {{'a', 1}, {'b', 2}, 300}; return o.a.c + o.b.n + o.l; }", 399, 399),
    ("struct In { int a; int b; }; struct Out { struct In x; struct In y; }; struct Out g = {1, 2, 3, 4}; int main() { return g.x.a * 1000 + g.x.b * 100 + g.y.a * 10 + g.y.b; }", 1234, 1234),
    ("struct P { int x; int y; }; struct P pts[3] = {{1, 2}, {3, 4}}; int main() { return pts[0].y + pts[1].x + pts[2].x + pts[2].y; }", 5, 5),
    ("struct P { int x; int y; }; int main() { struct P pts[] = {{1, 2}, {3, 4}, {5, 6}}; return sizeof(pts) / sizeof(pts[0]) * 100 + pts[2].y; }", 306, 306),
    ("struct P { int x; int y; }; int main() { struct P pts[3] = {1, 2, 3}; return pts[0].x * 100 + pts[0].y * 10 + pts[1].x + pts[2].y; }", 123, 123),
    ("struct S { char name[8]; int age; }; int main() { struct S s = {\"bob\", 30}; return s.name[0] + s.name[2] + s.name[3] + s.age; }", 226, 226),
    ("struct S { char name[8]; int age; }; struct S people[2] = {{\"ann\", 40}, {\"al\", 7}}; int main() { return people[1].name[1] + people[0].age; }", 148, 148),
    ("struct S { char *name; int n; }; struct S g = {\"hey\", 3}; int main() { return g.name[g.n - 1]; }", 121, 121),
    ("struct P { int x; int y; int z; }; int main() { struct P p = {.z = 3, .x = 1}; return p.x * 100 + p.y * 10 + p.z; }", 103, 103),
    ("struct P { int x; int y; int z; }; struct P g = {.y = 5, 6}; int main() { return g.x * 100 + g.y * 10 + g.z; }", 56, 56),
    ("int main() { int a = 4; struct { int x; int y; } p = {a, a * 2}; return p.x + p.y; }", 12, 12),
    ("struct V { int n; int v[4]; }; int main() { struct V v = {2, {7, 8}}; return v.n * 100 + v.v[0] * 10 + v.v[1] + v.v[3]; }", 278, 278),
    ("struct V { int n; int v[4]; }; struct V g = {4, {[2] = 9}}; int main() { return g.n + g.v[2] + g.v[0]; }", 13, 13),
    ("struct N { int v; struct N *next; }; struct N pool[3]; struct N *head = pool; int main() { head->v = 4; return pool[0].v + (head == &pool[0]); }", 5, 5),
    ("struct N { int v; struct N *next; }; struct N last = {3, 0}; struct N first = {1, &last}; int main() { return first.next->v * 10 + first.v; }", 31, 31),
    ("struct P { int x; int y; }; int main() { struct P a = {1, 2}; struct P b = a; struct P c = {b.y, b.x}; return c.x * 10 + c.y; }", 21, 21),
    ("struct P { signed char c; short s; long l; }; struct P g = {-1, -2, -3}; int main() { return g.c + g.s + g.l; }", -6, -6),
    ("typedef struct { unsigned char r; unsigned char g; unsigned char b; } Rgb; Rgb palette[2] = {{255, 128, 0}, {1, 2, 3}}; int main() { return palette[0].r + palette[0].g + palette[1].b + sizeof(Rgb); }", 389, 389),
];

#[test]
fn initializers_execute_on_rv32_and_rv64() {
    check_c_programs("struct initializers", INIT);
}

#[test]
fn initializers_match_the_host_cc() {
    host_cc_differential("struct initializers", INIT);
}

#[test]
fn initializer_mistakes_fail_clearly() {
    check_c_errors(
        "struct initializer errors",
        &[
            ("struct P { int x; }; int main() { struct P p = {1, 2}; return 0; }", "too many initializers for 'P' (struct P)"),
            ("struct P { int x; }; struct P g = {1, 2}; int main() { return 0; }", "too many initializers"),
            ("struct P { int x; }; int main() { struct P p = {.y = 1}; return 0; }", "'y' is not a member of struct P; its members are x"),
            ("struct P { int x; }; int g = 1; struct P h = {g}; int main() { return 0; }", "global initializers must be constants"),
            ("struct In { int a; }; struct Out { struct In i; }; int main() { struct Out o = {.i.a = 1}; return 0; }", "unsupported: nested designators"),
            ("struct S { char name[2]; }; int main() { struct S s = {\"long\"}; return 0; }", "'\"long\"' is longer than the array it initializes (2 bytes)"),
            ("struct P { int x; }; struct P a = {1}; struct P b = a; int main() { return 0; }", "cannot start as a copy"),
            ("struct P { int x; }; int main() { struct P pts[2] = {{1}, {2}, {3}}; return 0; }", "too many array initializers"),
        ],
    );
}

/// S6: structs passed and returned by value (a hidden pointer to a
/// caller-made copy for arguments, a hidden result pointer in a0 for
/// results); scalar arguments keep the RISC-V calling convention.
const BY_VALUE: &[(&str, i64, i64)] = &[
    ("struct P { int x; int y; }; int sum(struct P p) { return p.x + p.y; } int main() { struct P p = {3, 4}; return sum(p); }", 7, 7),
    ("struct P { int x; int y; }; struct P make(int x, int y) { struct P p; p.x = x; p.y = y; return p; } int main() { struct P p = make(5, 6); return p.x * 10 + p.y; }", 56, 56),
    ("struct P { int x; }; void bump(struct P p) { p.x = 99; } int main() { struct P p = {1}; bump(p); return p.x; }", 1, 1),
    ("struct P { int x; int y; }; struct P add(struct P a, struct P b) { struct P r = {a.x + b.x, a.y + b.y}; return r; } int main() { struct P a = {1, 2}; struct P b = {10, 20}; struct P c = add(a, b); return c.x + c.y; }", 33, 33),
    ("struct P { int x; int y; }; struct P make(int x, int y) { struct P p = {x, y}; return p; } int main() { return make(4, 9).y; }", 9, 9),
    ("struct P { int x; int y; }; struct P make(int x) { struct P p = {x, x * 2}; return p; } int main() { struct P q; q = make(7); return q.y; }", 14, 14),
    ("struct P { int x; }; struct P twice(struct P p) { p.x *= 2; return p; } int main() { struct P p = {3}; struct P q = twice(twice(p)); return q.x * 10 + p.x; }", 123, 123),
    ("struct P { int x; int y; }; struct P swap(struct P p) { struct P r = {p.y, p.x}; return r; } int main() { struct P p = {1, 2}; p = swap(p); return p.x * 10 + p.y; }", 21, 21),
    ("struct V { long v[6]; }; long total(struct V v) { long s = 0; for (int i = 0; i < 6; i++) s += v.v[i]; return s; } int main() { struct V v; for (int i = 0; i < 6; i++) v.v[i] = i + 1; return total(v); }", 21, 21),
    ("struct P { char c; long l; }; struct P mk(char c, long l) { struct P p; p.c = c; p.l = l; return p; } int main() { struct P p = mk('A', 1000); return p.c + p.l; }", 1065, 1065),
    ("struct P { int x; }; int f(int a, struct P p, int b) { return a * 100 + p.x * 10 + b; } int main() { struct P p = {5}; return f(1, p, 9); }", 159, 159),
    ("struct P { int x; }; struct P f(int a, int b, int c, int d, int e, int g) { struct P p = {a + b + c + d + e + g}; return p; } int main() { return f(1, 2, 3, 4, 5, 6).x; }", 21, 21),
    ("struct P { int x; }; struct P fib(int n) { struct P r; if (n < 2) { r.x = n; return r; } r.x = fib(n - 1).x + fib(n - 2).x; return r; } int main() { return fib(10).x; }", 55, 55),
    ("struct P { int x; int y; }; struct P mid(struct P a, struct P b); int main() { struct P a = {0, 0}; struct P b = {4, 8}; struct P m = mid(a, b); return m.x * 10 + m.y; } struct P mid(struct P a, struct P b) { struct P r = {(a.x + b.x) / 2, (a.y + b.y) / 2}; return r; }", 24, 24),
    ("struct P { int x; }; int get(struct P p) { return p.x; } int main() { struct P ps[3] = {{1}, {2}, {3}}; int s = 0; for (int i = 0; i < 3; i++) s += get(ps[i]); return s; }", 6, 6),
    ("struct P { int x; }; int get(struct P p) { return p.x; } int main() { struct P p = {8}; struct P *q = &p; return get(*q); }", 8, 8),
    ("struct In { int a; }; struct Out { struct In in; int b; }; struct In inner(struct Out o) { return o.in; } int main() { struct Out o = {{6}, 7}; return inner(o).a + o.b; }", 13, 13),
    ("struct P { int x; }; struct P g = {3}; struct P read(void) { return g; } int main() { struct P p = read(); g.x = 9; return p.x * 10 + read().x; }", 39, 39),
    ("struct P { int x; }; struct P *pick(struct P *a, struct P *b, int first) { if (first) return a; return b; } int main() { struct P a = {1}; struct P b = {2}; return pick(&a, &b, 0)->x * 10 + pick(&a, &b, 1)->x; }", 21, 21),
    ("struct Acc { long sum; int count; }; struct Acc add(struct Acc a, int v) { a.sum += v; a.count++; return a; } int main() { struct Acc a = {0, 0}; for (int i = 1; i <= 10; i++) a = add(a, i); return a.sum + a.count; }", 65, 65),
    ("struct P { int x; int y; }; int dist2(struct P a, struct P b) { int dx = a.x - b.x; int dy = a.y - b.y; return dx * dx + dy * dy; } int main() { struct P pts[3] = {{0, 0}, {3, 4}, {6, 8}}; return dist2(pts[0], pts[1]) + dist2(pts[0], pts[2]); }", 125, 125),
    ("struct P { int x; }; void show(struct P p) { } int main() { struct P p = {1}; show(p); return 5; }", 5, 5),
];

#[test]
fn by_value_arguments_and_results_execute_on_rv32_and_rv64() {
    check_c_programs("structs by value", BY_VALUE);
}

#[test]
fn by_value_arguments_and_results_match_the_host_cc() {
    host_cc_differential("structs by value", BY_VALUE);
}

#[test]
fn by_value_mistakes_fail_clearly() {
    check_c_errors(
        "structs by value errors",
        &[
            ("struct P { int x; }; int main() { struct P p = {1}; return f(p); } int f(struct P p) { return p.x; }", "'f' is called with a struct (argument 1), but it is not declared yet"),
            ("struct P { int x; }; int main() { return f(); } struct P g(void); struct P f(void) { struct P p = {1}; return p; }", "'f' takes or returns a struct, so it must be declared before its first use"),
            ("struct P { int x; }; struct Q { int y; }; int f(struct P p) { return p.x; } int main() { struct Q q = {1}; return f(q); }", "argument 1 of 'f' must be a struct P"),
            ("struct P { int x; }; struct P f(void) { return 1; } int main() { return 0; }", "'f' returns a struct P, but this value is not one"),
            ("struct P { int x; }; struct P f(void) { return; } int main() { return 0; }", "'f' must return a value"),
            ("struct P { int x; }; struct P main() { struct P p; return p; }", "main() must return int"),
            ("struct P { int x; }; struct P f(int a, int b, int c, int d, int e, int g, int h) { struct P p; return p; } int main() { return 0; }", "more than 6 parameters in a function that returns a struct"),
            ("struct P { int x; }; int f(struct P p); int f(struct P *p) { return 0; } int main() { return 0; }", "is declared with different types here"),
            ("struct P { int x; }; int ext(struct P p); int main() { struct P p = {1}; return ext(p); }", "'ext' has no body here, so hand-written assembly must define it"),
            ("struct P { int x; }; struct P ext(void); int main() { return ext().x; }", "assembly cannot take or return a struct by value"),
        ],
    );
}

/// The internal convention is visible in the assembly: the hidden result
/// pointer is the first argument (a0), and the result comes back in a0.
#[test]
fn by_value_convention_uses_a_hidden_result_pointer_in_a0() {
    let src = "struct P { int x; int y; }; struct P make(int x, int y) { struct P p = {x, y}; return p; } int main() { struct P p = make(1, 2); return p.y; }";
    for asm in [sim_engine::c_to_asm(src).unwrap(), sim_engine::c_to_asm64(src).unwrap()] {
        let make = &asm[asm.find("make:").unwrap()..];
        // the visible parameters arrive in a1 and a2
        assert!(make.contains(" a1, ") && make.contains(" a2, "), "{make}");
        assert!(asm.contains("call  __struct_copy") || asm.contains("call __struct_copy"), "{asm}");
    }
}

/// S7: unions: members share offset 0, sizeof is the largest member
/// rounded up to the largest alignment, same access rules as structs.
const UNIONS: &[(&str, i64, i64)] = &[
    ("union U { int i; char c; }; int main() { return sizeof(union U); }", 4, 4),
    ("union U { char c[5]; int i; }; int main() { return sizeof(union U); }", 8, 8),
    ("union U { char c; long l; }; int main() { return sizeof(union U); }", 4, 8),
    ("union U { short s[3]; char c; }; int main() { return sizeof(union U); }", 6, 6),
    ("union U { int i; unsigned char b[4]; }; int main() { union U u; u.i = 0x01020304; return u.b[0] * 10 + u.b[3]; }", 41, 41),
    ("union U { int i; short s; }; int main() { union U u; u.i = -1; u.s = 0; return u.i == 0xffff0000; }", 1, 1),
    ("union U { int i; char c; }; int main() { union U u; char *a = (char *)&u.i; char *b = &u.c; return a == b; }", 1, 1),
    ("union U { unsigned int bits; unsigned char bytes[4]; }; int main() { union U u; u.bits = 0; u.bytes[1] = 1; return u.bits; }", 256, 256),
    ("typedef union { int i; unsigned char c; } Cell; int main() { Cell c; c.i = 300; return c.c; }", 44, 44),
    ("union U { int i; char c; }; int main() { union U a; union U b; a.i = 77; b = a; return b.i; }", 77, 77),
    ("union U { int i; char c; }; union U g = {5}; int main() { return g.i; }", 5, 5),
    ("union U { int i; char c; }; int main() { union U u = {.c = 9}; return u.c; }", 9, 9),
    ("union U { int i; char c; }; union U g = {.c = 3}; int main() { return g.i; }", 3, 3),
    ("union U { int i; long l; }; union U set(long v) { union U u; u.l = v; return u; } int main() { union U u = set(12); return u.i; }", 12, 12),
    ("union U { int i; char c; }; int peek(union U *u) { return u->c; } int main() { union U u; u.i = 65; return peek(&u); }", 65, 65),
    ("union U { int i; char c; }; int main() { union U us[3]; for (int i = 0; i < 3; i++) us[i].i = i * 100; return us[2].c + sizeof(us); }", 212, 212),
    ("struct S { char tag; union { int i; char c; } u; }; int main() { struct S s; s.tag = 1; s.u.i = 70; return s.u.c + sizeof(s); }", 78, 78),
    // a tagged union
    ("enum Kind { INT, PAIR }; struct Pair { short a; short b; }; struct Value { enum Kind kind; union { int i; struct Pair p; } as; }; int value(struct Value *v) { switch (v->kind) { case INT: return v->as.i; case PAIR: return v->as.p.a * v->as.p.b; } return -1; } int main() { struct Value vs[2]; vs[0].kind = INT; vs[0].as.i = 5; vs[1].kind = PAIR; vs[1].as.p.a = 6; vs[1].as.p.b = 7; return value(&vs[0]) + value(&vs[1]); }", 47, 47),
    ("enum T { NUM, CH }; struct Tok { enum T t; union { long n; char c; } v; }; struct Tok num(long n) { struct Tok k; k.t = NUM; k.v.n = n; return k; } struct Tok ch(char c) { struct Tok k; k.t = CH; k.v.c = c; return k; } int score(struct Tok k) { if (k.t == NUM) return k.v.n; return k.v.c - 'a'; } int main() { return score(num(40)) + score(ch('c')); }", 42, 42),
    ("union U { int i; struct { short lo; short hi; } h; }; int main() { union U u; u.h.lo = 1; u.h.hi = 2; return u.i == 0x20001; }", 1, 1),
    ("union U { unsigned char raw[8]; long l; int i; }; int main() { union U u = {{1, 0, 0, 0, 0, 0, 0, 0}}; return u.i + sizeof(u); }", 9, 9),
];

#[test]
fn unions_execute_on_rv32_and_rv64() {
    check_c_programs("unions", UNIONS);
}

#[test]
fn unions_match_the_host_cc() {
    host_cc_differential("unions", UNIONS);
}

#[test]
fn union_mistakes_fail_clearly() {
    check_c_errors(
        "union errors",
        &[
            ("union U { int i; char c; }; int main() { union U u; return u.x; }", "'x' is not a member of union U; its members are i, c"),
            ("union U { int i; char c; }; union U g = {1, 2}; int main() { return 0; }", "too many initializers"),
            ("union U { int i; }; struct U s; int main() { return 0; }", "'U' was declared as a union"),
            ("union U { int i : 2; }; int main() { return 0; }", "unsupported: bit-fields"),
            ("union U { }; int main() { return 0; }", "this 'union' has no members"),
        ],
    );
}

/// A realistic struct program, cut and spliced with random tokens: the
/// front ends never panic, and their messages never show internal names.
#[test]
fn mutated_struct_programs_never_panic_or_leak() {
    const BASE: &str = "typedef enum { A, B = 4 } Kind;\nstruct node { int v; struct node *next; char tag[4]; };\nunion cell { int i; char c; };\nstruct node pool[3] = {{1, 0, \"ab\"}, {.v = 2}};\nstruct node make(int v) { struct node n = {v, 0}; return n; }\nint sum(struct node *n) { int s = 0; while (n) { s += n->v; n = n->next; } return s; }\nint main() { struct node a = make(B); union cell c = {.c = 3}; a.next = &pool[1]; pool[1].next = pool; return sum(&a) + c.c + sizeof(a) + pool[0].tag[1]; }\n";
    const VOCAB: &[&str] = &[
        "struct", "union", "enum", "typedef", "node", "cell", "Kind", ".", "->", "v", "next", "a", "pool",
        "{", "}", "[", "]", "(", ")", ";", ",", "=", "*", "&", "0", "1", "\"x\"", ".v =", "[1] =",
        "int", "char", "sizeof", "return", "make(1)", "p", "x : 2", "int (*f)(int);",
    ];
    assert!(support::run_c32(BASE).is_ok() && support::run_c64(BASE).is_ok(), "the base program compiles");
    let mut rng = support::Rng::new(0x5_7AC7);
    type Compile = fn(&str) -> Result<String, sim_engine::TranslateError>;
    let entries: [(&str, Compile); 3] =
        [("c_to_asm", sim_engine::c_to_asm), ("c_to_asm64", sim_engine::c_to_asm64), ("cpp_to_asm", sim_engine::cpp_to_asm)];
    for _ in 0..support::iterations(300, 5000) {
        let cut = rng.below(BASE.len() as u64) as usize;
        let resume = (cut + rng.below(24) as usize).min(BASE.len());
        let mut src = BASE[..cut].to_string();
        for _ in 0..rng.below(5) {
            src.push_str(rng.pick::<&str>(VOCAB));
            src.push(' ');
        }
        src.push_str(&BASE[resume..]);
        for (name, f) in entries {
            let result = std::panic::catch_unwind(|| f(&src));
            let Ok(result) = result else { panic!("{name} panicked on {src:?}") };
            if let Err(e) = result {
                assert!(!e.message.trim().is_empty(), "{name}: empty message for {src:?}");
                for leak in ["\u{1}", "Some(", "None", "Rec(", "Scalar(", "Tok::", "internal"] {
                    assert!(!e.message.contains(leak), "{name} leaks {leak:?}: {} for {src:?}", e.message);
                }
            }
        }
    }
}

/// `--annotate`: struct code maps to its source lines; the generated copy
/// helper belongs to no line; the text matches the plain translation.
#[test]
fn annotated_struct_code_maps_to_source_lines() {
    let src = "struct P { int x; int y; };\nint main() {\n  struct P a = {1, 2};\n  struct P b = a;\n  return b.y;\n}\n";
    for (xlen, plain) in [(32, sim_engine::c_to_asm(src).unwrap()), (64, sim_engine::c_to_asm64(src).unwrap())] {
        let lines = sim_engine::translate_annotated("c", xlen, src).unwrap();
        let text: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(text.join("\n"), plain.trim_end_matches('\n'), "RV{xlen}");
        let helper = lines.iter().position(|l| l.text.starts_with("__struct_copy:")).expect("helper emitted");
        assert!(lines[helper..].iter().take_while(|l| !l.text.is_empty()).all(|l| l.source_line.is_none()), "RV{xlen}");
        for line in [3, 4, 5] {
            assert!(lines.iter().any(|l| l.source_line == Some(line)), "RV{xlen}: no code for line {line}");
        }
    }
}

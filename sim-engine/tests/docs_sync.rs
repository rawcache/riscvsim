//! The docs page is generated from the same source of truth as the engine:
//! subset tables must match the constants word for word, and every limit
//! must be documented with its value.

use sim_engine::limits::*;
use sim_engine::*;

const DOCS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../frontend/docs/index.html");

/// The docs page lives in `frontend/`, which only the full repository has.
/// When the crates are checked out on their own the file is absent and the
/// docs checks are skipped with a note; when the file exists they are fully
/// strict (any read error other than "not found" still fails).
fn docs() -> Option<String> {
    match std::fs::read_to_string(DOCS_PATH) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("note: skipping docs check, frontend/docs/index.html not present (crates-only checkout)");
            None
        }
        Err(e) => panic!("frontend/docs/index.html: {e}"),
    }
}

fn decode(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&amp;", "&")
}

fn cell(html: &str, attr: &str) -> String {
    let start = html.find(attr).unwrap_or_else(|| panic!("missing {attr}")) + attr.len();
    let end = html[start..].find('<').unwrap() + start;
    decode(&html[start..end])
}

#[test]
fn subset_tables_match_the_constants() {
    let Some(html) = docs() else { return };
    for (lang, supported, unsupported) in [
        ("c", C_SUBSET_SUPPORTED, C_SUBSET_UNSUPPORTED),
        ("cpp", CPP_SUBSET_SUPPORTED, CPP_SUBSET_UNSUPPORTED),
        ("rust", RUST_SUBSET_SUPPORTED, RUST_SUBSET_UNSUPPORTED),
    ] {
        assert_eq!(cell(&html, &format!("data-subset-supported=\"{lang}\">")), supported, "{lang}");
        assert_eq!(cell(&html, &format!("data-subset-unsupported=\"{lang}\">")), unsupported, "{lang}");
    }
}

#[test]
fn every_limit_is_documented_with_its_value() {
    let Some(html) = docs() else { return };
    for (name, value) in [
        ("MAX_SOURCE_BYTES", MAX_SOURCE_BYTES as u64),
        ("MAX_LINE_LENGTH", MAX_LINE_LENGTH as u64),
        ("MAX_NESTING_DEPTH", MAX_NESTING_DEPTH as u64),
        ("MAX_LABELS", MAX_LABELS as u64),
        ("MAX_STRING_LITERAL_BYTES", MAX_STRING_LITERAL_BYTES as u64),
        ("MAX_INSTRUCTIONS", MAX_INSTRUCTIONS as u64),
        ("MAX_DATA_BYTES", MAX_DATA_BYTES as u64),
        ("DEFAULT_STEP_LIMIT", DEFAULT_STEP_LIMIT),
    ] {
        let text = cell(&html, &format!("data-limit=\"{name}\">"));
        assert!(text.starts_with(&value.to_string()), "{name}: docs say {text:?}, engine says {value}");
    }
}

fn c64(src: &str) -> Result<String, String> {
    c_to_asm64(src).map_err(|e| e.message)
}

/// One program per construct the C subset list names as supported.
#[test]
fn every_listed_c_construct_compiles() {
    let constructs = [
        ("char, short, int, long, long long", "int main() { char a = 1; short b = 2; long c = 3; long long d = 4; unsigned e = 5; return a + b + c + d + e; }"),
        ("casts & sizeof", "int main() { return (unsigned char)300 + sizeof(int); }"),
        ("character literals", "int main() { return 'a'; }"),
        ("local variables & fixed arrays", "int main() { int a[3] = {1, 2, 3}; int x = a[2]; return x; }"),
        ("pointers: & and *, arithmetic scaled by element size, arrays decay to pointers, pointer parameters & results", "int *at(int *a, int i) { return a + i; } int main() { int a[3] = {1, 2, 3}; int x = 0; int *p = &x; *p = *at(a, 2); return x; }"),
        ("globals with constant initializers", "int g = 4; int t[2] = {1, 2}; int main() { return g + t[1]; }"),
        ("string literals (read-only data)", "int main() { char *s = \"hi\"; return s[1]; }"),
        ("arithmetic, comparisons, bitwise & compound assignment, && || !", "int main() { int x = 5; x <<= 1; x ^= 3; return (x > 2 && !0) || x % 2; }"),
        ("if/else", "int main() { if (1) { return 1; } else { return 2; } }"),
        ("while/for/do-while", "int main() { int i = 0; while (i < 2) i++; for (; i < 4; i++) {} do { i++; } while (i < 6); return i; }"),
        ("switch with fallthrough", "int main() { int r = 0; switch (1) { case 1: r++; case 2: r++; break; default: r = 9; } return r; }"),
        ("break/continue (also continue inside switch)", "int main() { int s = 0; for (int i = 0; i < 9; i++) { if (i == 5) break; if (i % 2) continue; switch (i) { case 2: continue; } s += i; } return s; }"),
        ("block scopes & shadowing", "int i = 9; int main() { int s = 0; for (int i = 0; i < 2; i++) s += i; for (int i = 0; i < 3; i++) { int s2 = i; s += s2; } { int i = 4; s += i; } return s + i; }"),
        ("void functions & (void) parameter lists", "int g = 0; void set(int v) { if (v < 0) return; g = v; } int get(void) { return g; } int main() { set(3); return get(); }"),
        ("pointer casts, void * & pointer-width integer casts", "int main() { int x = 7; void *v = &x; long a = (long)v; char *c = (char *)a; return *(int *)c + *c; }"),
        ("functions (up to 7 integer args)", "int f(int a, int b, int c, int d, int e, int g, int h) { return a + h; } int main() { return f(1, 2, 3, 4, 5, 6, 7); }"),
        ("prototypes without a body call hand-written assembly (psABI)", "int ext(int x);\nint main() { return ext(1); }"),
        ("recursion", "int f(int n) { return n < 2 ? n : f(n - 1) + f(n - 2); } int main() { return 0; }"),
        ("#define/#undef/#if/#ifdef", "#define A 1\n#undef A\n#ifndef A\n#if 1\nint main() { return 0; }\n#endif\n#endif\n"),
    ];
    for (name, src) in constructs {
        if name == "recursion" {
            // the ternary operator is not part of the subset; use if instead
            let src = "int f(int n) { if (n < 2) { return n; } return f(n - 1) + f(n - 2); } int main() { return f(10); }";
            assert!(c64(src).is_ok(), "{name}");
            continue;
        }
        assert!(c64(src).is_ok(), "listed construct '{name}' does not compile: {:?}", c64(src).err());
        assert!(C_SUBSET_SUPPORTED.contains(name.split(',').next().unwrap()), "{name} not in the list");
    }
}

/// One program per construct the C subset list names as unsupported; each
/// must fail with a clear message (never a wrong program).
#[test]
fn every_listed_unsupported_c_construct_is_rejected_clearly() {
    let constructs = [
        ("function pointers & pointers to arrays", "int main() { int (*f)(int); return 0; }", "function pointers"),
        ("structs & unions", "struct P { int x; }; int main() { return 0; }", "struct"),
        ("floats", "int main() { float f = 1; return 0; }", "floating point"),
        ("goto", "int main() { goto end; end: return 0; }", "goto"),
        ("#include & standard library calls", "#include <stdio.h>\nint main() { return 0; }", "#include"),
    ];
    for (name, src, needle) in constructs {
        assert!(C_SUBSET_UNSUPPORTED.contains(name), "{name} not in the unsupported list");
        let err = c64(src).expect_err(name);
        assert!(err.to_lowercase().contains(needle), "{name}: {err}");
    }
    let err = c_to_asm("int main() { long long x = 1; return x; }").unwrap_err().message;
    assert!(C_SUBSET_UNSUPPORTED.contains("64-bit integers on RV32") && err.contains("RV32"), "{err}");
    let err = c64("int main() { return printf(1); }").unwrap_err();
    assert!(err.contains("no standard library"), "{err}");
}

//! PART E (priority 6): the C/C++ preprocessor.

mod support;

use support::{run_c32, run_c64};

const PROGRAMS: &[(&str, i64)] = &[
    ("#define N 10\nint main() { return N * 2; }", 20),
    ("#define SQ(x) ((x) * (x))\nint main() { return SQ(3 + 1); }", 16),
    ("#define ADD(a, b) ((a) + (b))\n#define TWICE(x) ADD(x, x)\nint main() { return TWICE(21); }", 42),
    ("#define A 1\n#undef A\n#ifdef A\nint main() { return 1; }\n#else\nint main() { return 2; }\n#endif\n", 2),
    ("#ifndef GUARD\n#define GUARD 5\n#endif\nint main() { return GUARD; }", 5),
    ("#define V 3\n#if V > 2 && defined(V)\nint main() { return 1; }\n#elif V == 2\nint main() { return 2; }\n#else\nint main() { return 3; }\n#endif\n", 1),
    ("#define V 2\n#if V > 2\nint main() { return 1; }\n#elif V == 2\nint main() { return 2; }\n#else\nint main() { return 3; }\n#endif\n", 2),
    ("#if 0\nthis is not code at all\n#endif\nint main() { return 7; }", 7),
    ("#if defined UNKNOWN || (1 << 3) == 8\nint main() { return 8; }\n#endif\n", 8),
    ("#define LONG_MACRO(a) \\\n    ((a) + \\\n     100)\nint main() {\n    return LONG_MACRO(1);\n}\n", 101),
    ("/* #define X 1 */\n#ifdef X\nint main() { return 1; }\n#else\nint main() { return 0; }\n#endif\n", 0),
    ("#define EMPTY\nint main() { EMPTY return 9 EMPTY; }", 9),
    ("#define F() 6\nint main() { return F(); }", 6),
    ("#define CH 'x'\nint main() { return CH; }", 120),
    ("#if 1\n#if 0\nint main() { return 1; }\n#else\nint main() { return 2; }\n#endif\n#endif\n", 2),
];

#[test]
fn preprocessor_programs() {
    for (src, expected) in PROGRAMS {
        if *expected < 0 {
            continue;
        }
        assert_eq!(run_c64(src), Ok(*expected), "RV64: {src}");
        assert_eq!(run_c32(src), Ok(*expected), "RV32: {src}");
        let cpp = sim_engine::cpp_to_asm64(src).map_err(|e| e.message).and_then(|a| support::run_asm64(&a));
        assert_eq!(cpp, Ok(*expected), "C++: {src}");
    }
}

#[test]
fn line_numbers_survive_preprocessing() {
    let src = "#define X 1\n/* a\n   b */\n#if 1\nint main() {\n  return y;\n}\n#endif\n";
    let err = sim_engine::c_to_asm(src).unwrap_err();
    assert_eq!(err.line, 6, "{}", err.message);
    let err = sim_engine::c_to_asm("#define M(a) \\\n  (a)\nint main() {\n  return q;\n}\n").unwrap_err();
    assert_eq!(err.line, 4, "{}", err.message);
}

#[test]
fn preprocessor_errors_are_clear() {
    let cases = [
        ("#include <stdio.h>\nint main() { return 0; }", 1, "no header files"),
        ("#pragma once\nint main() { return 0; }", 1, "supported are #define"),
        ("#if 1\nint main() { return 0; }\n", 1, "no matching #endif"),
        ("#endif\nint main() { return 0; }", 1, "without a matching #if"),
        ("#else\n", 1, "without a matching #if"),
        ("#if 1\n#else\n#else\n#endif\n", 3, "second #else"),
        ("#define F(a, b) a\nint main() { return F(1); }", 2, "expects 2 argument"),
        ("#define\n", 1, "needs a macro name"),
        ("#define S(x) #x\n", 1, "# and ## macro operators"),
        ("#if 1 +\n#endif\n", 1, "invalid #if expression"),
        ("#if 1 / 0\n#endif\n", 1, "division by zero"),
        ("#define F(a) a\nint main() { return F(1; }", 2, "same line"),
    ];
    for (src, line, needle) in cases {
        let err = sim_engine::c_to_asm(src).unwrap_err();
        assert!(err.message.contains(needle), "{src:?}: {}", err.message);
        assert_eq!(err.line, line, "{src:?}: {}", err.message);
    }
}

#[test]
fn recursive_and_exploding_macros_are_bounded() {
    // Self-reference stops (C's "painted blue" rule).
    assert!(sim_engine::c_to_asm("#define X X\nint main() { int X = 3; return X; }").is_ok());
    // Mutual recursion stops too.
    assert!(sim_engine::c_to_asm("#define A B\n#define B A\nint main() { int A = 1; return A; }").is_ok());
    // Exponential growth hits the documented size limit with a clear error.
    let mut src = String::from("#define M0 1+1\n");
    for i in 1..40 {
        src.push_str(&format!("#define M{i} M{0}+M{0}\n", i - 1));
    }
    src.push_str("int main() { return M39; }\n");
    let start = std::time::Instant::now();
    let err = sim_engine::c_to_asm(&src).unwrap_err();
    assert!(err.message.contains("macro expansion is too large"), "{}", err.message);
    assert!(start.elapsed().as_secs() < 5);
}

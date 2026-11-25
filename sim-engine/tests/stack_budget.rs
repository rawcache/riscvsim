//! Stack budget: the worst-case nesting input of every recursive path must
//! fit in half of a browser WASM stack (1 MiB, the wasm32 default; this
//! repository sets no custom link arguments), with a margin, even in an
//! unoptimized debug build.
//!
//! Peak usage is measured by painting a region of a fresh 1 MiB thread
//! stack with a known byte, running the entry point, and finding the
//! deepest byte that changed. Run with `--nocapture` to see the table.

mod support;

use std::panic::{catch_unwind, AssertUnwindSafe};
use support::{entry_points, Lang, TextFn};

/// Thread stack for each probe: 1 MiB, the browser WASM stack. Set
/// `STACK_PROBE_MIB` to measure inputs that do not fit yet.
fn thread_stack() -> usize {
    std::env::var("STACK_PROBE_MIB").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(1) << 20
}
const WORD: u64 = 0xA5A5_5A5A_A5A5_5A5A;
/// Half of the 1 MiB WASM stack...
const BUDGET: usize = 512 << 10;
/// ...minus a 25% margin for frames this test does not exercise.
const LIMIT: usize = BUDGET * 3 / 4;

/// Fill `len` bytes below the current frame with `MARK`; returns the
/// lowest painted address.
#[inline(never)]
fn paint(len: usize) -> usize {
    let here = std::hint::black_box(0u8);
    let top = (&here as *const u8 as usize - 4096) & !7;
    let low = top - (len & !7);
    let mut addr = low;
    while addr < top {
        // SAFETY: the range lies inside this thread's own stack, below every
        // live frame and above the guard page (len < stack size - 64 KiB).
        unsafe { std::ptr::write_volatile(addr as *mut u64, WORD) };
        addr += 8;
    }
    low
}

#[inline(never)]
fn untouched(low: usize, len: usize) -> usize {
    let mut i = 0;
    // SAFETY: same painted range as above.
    while i + 8 <= len && unsafe { std::ptr::read_volatile((low + i) as *const u64) } == WORD {
        i += 8;
    }
    i
}

/// Peak stack bytes `f(input)` used, measured on a fresh thread.
fn peak_stack(f: TextFn, input: String) -> (usize, bool) {
    let len = thread_stack() - (96 << 10);
    std::thread::Builder::new()
        .stack_size(thread_stack())
        .spawn(move || {
            let low = paint(len);
            let ok = catch_unwind(AssertUnwindSafe(|| f(&input))).is_ok();
            (len - untouched(low, len), ok)
        })
        .expect("spawn")
        .join()
        .expect("probe thread")
}

/// Worst-case nesting inputs for one source language: every shape the
/// recursive parsers, expanders, code generators and translators recurse on.
pub fn worst_cases(lang: Lang) -> Vec<(&'static str, String)> {
    let limit = sim_engine::limits::MAX_NESTING_DEPTH;
    let mut cases: Vec<(&'static str, String)> = Vec::new();
    for depth in [limit - 2, limit - 1, limit, limit + 1] {
        let parens = format!("{}1{}", "(".repeat(depth), ")".repeat(depth));
        let blocks = format!("{}{}", "{ ".repeat(depth), " }".repeat(depth));
        match lang {
            Lang::Rust => {
                cases.push(("parentheses", format!("fn main() -> i32 {{ {parens} }}\n")));
                cases.push(("blocks", format!("fn main() -> i32 {{ {blocks} 0 }}\n")));
                cases.push((
                    "if nesting",
                    format!(
                        "fn main() -> i32 {{ let mut x = 0; {} x = 1; {} x }}\n",
                        "if x == 0 { ".repeat(depth),
                        "}".repeat(depth)
                    ),
                ));
                cases.push((
                    "loop nesting",
                    format!(
                        "fn main() -> i32 {{ let mut x = 0; {} x += 1; {} x }}\n",
                        "while x < 1 { ".repeat(depth),
                        "}".repeat(depth)
                    ),
                ));
                cases.push((
                    "call nesting",
                    format!(
                        "fn f(x: i32) -> i32 {{ x }}\nfn main() -> i32 {{ {}1{} }}\n",
                        "f(".repeat(depth),
                        ")".repeat(depth)
                    ),
                ));
            }
            Lang::Asm32 | Lang::Asm64 => {
                cases.push(("parentheses", format!("addi a0, x0, {parens}\n")));
                // Nested forward branches: the decompiler recurses per level.
                let mut asm = String::new();
                for i in 0..depth * 4 {
                    asm.push_str(&format!("beq a0, x0, L{i}\naddi a0, a0, 1\n"));
                }
                for i in (0..depth * 4).rev() {
                    asm.push_str(&format!("L{i}:\naddi a1, a1, 1\n"));
                }
                cases.push(("branch nesting", asm));
                // Nested backward loops.
                let mut asm = String::new();
                for i in 0..depth * 4 {
                    asm.push_str(&format!("T{i}:\naddi a0, a0, 1\n"));
                }
                for i in (0..depth * 4).rev() {
                    asm.push_str(&format!("bne a0, x0, T{i}\n"));
                }
                cases.push(("loop nesting", asm));
            }
            Lang::C | Lang::Cpp => {
                let main = |body: String| format!("int main() {{ int x = 0; int a[4] = {{0}}; {body} }}\n");
                cases.push(("parentheses", main(format!("return {parens};"))));
                cases.push(("blocks", main(format!("{blocks} return 0;"))));
                cases.push((
                    "if nesting",
                    main(format!("{} x = 1; {} return x;", "if (x == 0) { ".repeat(depth), "}".repeat(depth))),
                ));
                cases.push((
                    "loop nesting",
                    main(format!(
                        "{} x = x + 1; {} return x;",
                        "while (x < 1) { for (;;) { do { switch (x) { default: ".repeat(depth / 4),
                        "} } while (0); break; } }".repeat(depth / 4)
                    )),
                ));
                cases.push((
                    "call nesting",
                    format!(
                        "int f(int x) {{ return x; }}\nint main() {{ return {}1{}; }}\n",
                        "f(".repeat(depth),
                        ")".repeat(depth)
                    ),
                ));
                cases.push((
                    "index nesting",
                    main(format!("return {}0{};", "a[".repeat(depth - 1), "]".repeat(depth - 1))),
                ));
            }
        }
    }
    // Chains that brackets do not show: the parser backstop bounds these.
    for depth in [100, 300, 383, 384, 385, 1_000, 5_000] {
        match lang {
            Lang::Rust => {
                cases.push(("unary chain", format!("fn main() -> i32 {{ {}1 }}\n", "- ".repeat(depth))));
                cases.push(("not chain", format!("fn main() -> i32 {{ {}1 }}\n", "!".repeat(depth))));
                cases.push((
                    "else-if ladder",
                    format!(
                        "fn main() -> i32 {{ let mut x = 0; {} {{ x = 2; }} x }}\n",
                        "if x == 1 { x = 1; } else ".repeat(depth)
                    ),
                ));
                cases.push(("assignment chain", format!("fn main() -> i32 {{ let mut x = 0; x = {}1; x }}\n", "1 + ".repeat(depth))));
            }
            Lang::Asm32 | Lang::Asm64 => {
                cases.push(("unary chain", format!("li a0, {}1\n", "-".repeat(depth))));
            }
            Lang::C | Lang::Cpp => {
                let main = |body: String| format!("int main() {{ int x = 0; {body} }}\n");
                cases.push(("unary chain", main(format!("return {}1;", "- ".repeat(depth)))));
                cases.push(("not chain", main(format!("return {}1;", "!".repeat(depth)))));
                cases.push(("complement chain", main(format!("return {}1;", "~".repeat(depth)))));
                cases.push(("cast chain", main(format!("return {}x;", "(int)".repeat(depth)))));
                cases.push(("increment chain", main(format!("return {}x;", "++".repeat(depth)))));
                cases.push((
                    "else-if ladder",
                    main(format!("{} x = 2; return x;", "if (x == 1) x = 1; else ".repeat(depth))),
                ));
                cases.push(("assignment chain", main(format!("int y; {}1; return x;", "x = y = ".repeat(depth)))));
                cases.push(("macro nesting", format!(
                    "#define F(a) (a)\nint main() {{ return {}1{}; }}\n",
                    "F(".repeat(depth.min(limit + 1)),
                    ")".repeat(depth.min(limit + 1))
                )));
                cases.push(("macro arg nesting", format!(
                    "#define G(a) a\nint main() {{ return {}1{}; }}\n",
                    "G(".repeat(depth),
                    ")".repeat(depth)
                )));
                cases.push(("#if unary chain", format!("#if {}1\n#endif\nint main() {{ return 0; }}\n", "- ".repeat(depth))));
                cases.push(("#if parentheses", format!(
                    "#if {}1{}\n#endif\nint main() {{ return 0; }}\n",
                    "(".repeat(depth),
                    ")".repeat(depth)
                )));
            }
        }
    }
    // Long left-associative chains build deep trees with no parser
    // recursion; the code generators and emitters walk them.
    for terms in [1_000, 5_000] {
        let chain = vec!["1"; terms].join(" +\n");
        match lang {
            Lang::Rust => cases.push(("long operator chain", format!("fn main() -> i32 {{ {chain} }}\n"))),
            Lang::Asm32 | Lang::Asm64 => {}
            Lang::C | Lang::Cpp => cases.push(("long operator chain", format!("int main() {{ return {chain}; }}\n"))),
        }
    }
    cases
}

#[test]
fn worst_case_nesting_fits_half_the_wasm_stack() {
    let mut rows: Vec<(usize, &str, &str)> = Vec::new();
    let mut failures = Vec::new();
    let only = std::env::var("STACK_PROBE_ONLY").ok();
    let verbose = std::env::var("STACK_PROBE_VERBOSE").is_ok();
    for (name, lang, f) in entry_points() {
        if only.as_deref().is_some_and(|o| o != name) {
            continue;
        }
        let mut worst = (0usize, "");
        for (shape, input) in worst_cases(lang) {
            let (used, ok) = peak_stack(f, input);
            if verbose {
                println!("    {name:<14} {:>6} KiB  {shape}", used >> 10);
            }
            if !ok {
                failures.push(format!("{name} panicked on {shape}"));
            }
            if used > worst.0 {
                worst = (used, shape);
            }
        }
        if worst.0 > LIMIT {
            failures.push(format!(
                "{name}: {} KiB on {} (limit {} KiB)",
                worst.0 >> 10,
                worst.1,
                LIMIT >> 10
            ));
        }
        rows.push((worst.0, name, worst.1));
    }
    println!("peak stack per entry point ({}):", if cfg!(debug_assertions) { "debug" } else { "release" });
    for (used, name, shape) in &rows {
        println!("  {name:<14} {:>5} KiB  {shape}", used >> 10);
    }
    assert!(failures.is_empty(), "stack budget exceeded:\n{}", failures.join("\n"));
}

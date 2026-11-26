//! Documented resource limits for every public entry point.
//!
//! Each limit produces a plain-English error that names the limit, so a
//! browser tab or terminal can never freeze, run out of stack, or allocate
//! without bound, whatever text it is given.

/// Largest source text accepted by the assemblers and every translator.
pub const MAX_SOURCE_BYTES: usize = 1024 * 1024;
/// Longest single source line.
pub const MAX_LINE_LENGTH: usize = 16 * 1024;
/// Deepest nesting the front ends accept: parentheses, brackets, blocks,
/// statements and operators (`a + b + c` is three levels; each `else if`
/// is one more), structs and unions defined or contained inside each
/// other, and chains of `.`, `->`, `[ ]` and calls (`p->next` counts up to
/// three levels, so about 20 hops fit in one expression). The worst case
/// at this depth fits in half of a 1 MiB browser WASM stack even in a
/// debug build (`tests/stack_budget.rs`).
pub const MAX_NESTING_DEPTH: usize = 64;
/// Largest struct, union, or array of them (one variable), in bytes.
pub const MAX_STRUCT_BYTES: usize = 1024 * 1024;
/// Most labels one assembly program may define.
pub const MAX_LABELS: usize = 65_536;
/// Longest string literal (assembler `.string`/`.ascii`, or source language).
pub const MAX_STRING_LITERAL_BYTES: usize = 8 * 1024;
/// Most machine instructions one program (or one translation) may contain.
pub const MAX_INSTRUCTIONS: usize = 128 * 1024;
/// Largest static data image (the whole data segment).
pub const MAX_DATA_BYTES: usize = crate::DATA_SIZE as usize;
/// Largest single `read_memory` request; longer requests are truncated
/// to this many bytes instead of allocating whatever the caller asked for.
pub const MAX_MEMORY_READ_BYTES: usize = 16 * 1024 * 1024;
/// Default per-run step (cycle) limit; callers may pass their own.
pub const DEFAULT_STEP_LIMIT: u64 = crate::DEFAULT_MAX_CYCLES;

/// Check the size limits shared by every text entry point.
/// Returns `(line, message)` for the first violated limit.
pub fn check_source(source: &str) -> Result<(), (usize, String)> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err((
            0,
            format!(
                "source is too large: found {} bytes, but the limit is {MAX_SOURCE_BYTES} bytes",
                source.len()
            ),
        ));
    }
    for (index, line) in source.lines().enumerate() {
        if line.len() > MAX_LINE_LENGTH {
            return Err((
                index + 1,
                format!(
                    "line {} is too long: found {} bytes, but the limit is {MAX_LINE_LENGTH} bytes per line",
                    index + 1,
                    line.len()
                ),
            ));
        }
    }
    Ok(())
}

/// Error text for exceeding the nesting limit.
pub fn nesting_message(what: &str) -> String {
    format!(
        "{what} is nested too deeply: the limit is {MAX_NESTING_DEPTH} levels; \
         split it into smaller pieces"
    )
}

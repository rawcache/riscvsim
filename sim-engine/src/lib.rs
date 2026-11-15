//! sim-engine: shared RV32IM assembler + classic 5-stage pipeline simulator.
//!
//! This crate is intentionally free of wasm-bindgen and any platform
//! dependencies so the exact same execution engine backs both the browser
//! simulator (via `rust-core`'s WASM bindings) and the `riscvsim` CLI.

pub mod assembler;
pub mod assembler64;
pub mod pipeline;
pub mod pipeline64;
pub mod translate;
pub mod xlen_convert;

/// Memory map (matches the rest of StudyRISC-V — do not change).
pub const TEXT_BASE: u32 = 0x0000_0000;
pub const DATA_BASE: u32 = 0x1000_0000;
/// Data segment size: 4 MiB is plenty for MVP-scale programs.
pub const DATA_SIZE: u32 = 4 * 1024 * 1024;
/// Stack: 4 MiB ending just below 0x8000_0000; sp (x2) starts at 0x7FFF_FFFC.
pub const STACK_TOP: u32 = 0x7fff_fffc;
pub const STACK_LIMIT: u32 = 0x7fc0_0000;

/// Safety cap so `run` can never hang a browser tab or terminal.
pub const DEFAULT_MAX_CYCLES: u64 = 1_000_000;

pub use assembler::{assemble, AsmError, AsmInstr, Program};
pub use assembler64::{assemble64, AsmError64, AsmInstr64, Op64, Program64};
pub use pipeline::{Pipeline, Snapshot};
pub use pipeline64::{Pipeline64, Snapshot as Snapshot64};
pub use translate::{
    asm64_to_c, asm_to_c, c_to_asm, c_to_asm64, c_to_cpp, c_to_rust, cpp_to_asm, cpp_to_asm64,
    cpp_to_c, cpp_to_rust, rust_to_asm, rust_to_asm64, rust_to_c, rust_to_cpp, TranslateError,
    CPP_SUBSET_SUPPORTED, CPP_SUBSET_UNSUPPORTED, C_SUBSET_SUPPORTED, C_SUBSET_UNSUPPORTED,
    RUST_SUBSET_SUPPORTED, RUST_SUBSET_UNSUPPORTED,
};
pub use xlen_convert::{rv32_to_rv64, rv64_to_rv32, XlenConvertError};

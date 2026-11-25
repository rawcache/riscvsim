//! One-call run reports shared by the browser (`run_rv64` in rust-core) and
//! the CLI (`riscvsim run --xlen=64 --json`), so both give identical results.

use crate::{assemble64, Pipeline64};
use serde::Serialize;

/// `{ ok, output, line, message, registers, pc, cycles }`: every 64-bit
/// value is a `0x`-prefixed 16-digit hex string so it never passes through
/// a JS Number.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RunReport {
    pub ok: bool,
    /// Changed registers, one `xN (abi) = 0x... (signed)` line each, when ok.
    pub output: Option<String>,
    /// 1-based source line of the error (0 = no anchor).
    pub line: usize,
    /// Halt message ("program complete (ecall)") or the error.
    pub message: String,
    pub registers: Vec<String>,
    pub pc: String,
    pub cycles: u64,
}

pub fn hex64(value: u64) -> String {
    format!("0x{value:016x}")
}

/// Engine trap messages are written as `line N: ...`; lift N into `line`.
pub fn split_line_prefix(message: &str) -> (usize, String) {
    if let Some(rest) = message.strip_prefix("line ") {
        if let Some((num, tail)) = rest.split_once(": ") {
            if let Ok(line) = num.parse::<usize>() {
                return (line, tail.to_string());
            }
        }
    }
    (0, message.to_string())
}

/// Assemble and run an RV64IM program with a step (cycle) limit.
pub fn run64(source: &str, max_cycles: u64) -> RunReport {
    let program = match assemble64(source) {
        Ok(program) => program,
        Err(errors) => {
            let (line, message) = errors
                .first()
                .map(|e| (e.line, e.message.clone()))
                .unwrap_or((0, "assembly failed".to_string()));
            return RunReport {
                ok: false,
                output: None,
                line,
                message,
                registers: Vec::new(),
                pc: hex64(0),
                cycles: 0,
            };
        }
    };
    let mut pipeline = Pipeline64::new(program);
    let initial = pipeline.registers();
    pipeline.run(max_cycles);
    let snap = pipeline.snapshot();
    let registers = pipeline.registers();
    let regs_hex: Vec<String> = registers.iter().copied().map(hex64).collect();
    let (ok, line, message) = match &snap.halt {
        Some(h) if h.kind == "complete" => (true, 0, h.message.clone()),
        Some(h) => {
            let (line, message) = split_line_prefix(&h.message);
            (false, line, message)
        }
        None => (
            false,
            snap.stages.get(2).and_then(|s| s.line).unwrap_or(0),
            format!("step limit reached: execution stopped after {max_cycles} cycles (possible infinite loop)"),
        ),
    };
    let output = ok.then(|| {
        (0..32)
            .filter(|&i| initial[i] != registers[i])
            .map(|i| {
                format!(
                    "x{i} ({}) = {} ({})",
                    crate::assembler64::abi_name(i as u8),
                    hex64(registers[i]),
                    registers[i] as i64
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    });
    RunReport {
        ok,
        output,
        line,
        message,
        registers: regs_hex,
        pc: hex64(snap.pc),
        cycles: snap.stats.cycles,
    }
}

/// Assemble and run an RV32IM program; same shape as [`run64`], with
/// registers as 8-digit hex strings.
pub fn run32(source: &str, max_cycles: u64) -> RunReport {
    let hex32 = |v: u32| format!("0x{v:08x}");
    let program = match crate::assemble(source) {
        Ok(program) => program,
        Err(errors) => {
            let (line, message) = errors
                .first()
                .map(|e| (e.line, e.message.clone()))
                .unwrap_or((0, "assembly failed".to_string()));
            return RunReport { ok: false, output: None, line, message, registers: Vec::new(), pc: hex32(0), cycles: 0 };
        }
    };
    let mut pipeline = crate::Pipeline::new(program);
    let initial = pipeline.registers();
    pipeline.run(max_cycles);
    let snap = pipeline.snapshot();
    let registers = pipeline.registers();
    let (ok, line, message) = match &snap.halt {
        Some(h) if h.kind == "complete" => (true, 0, h.message.clone()),
        Some(h) => {
            let (line, message) = split_line_prefix(&h.message);
            (false, line, message)
        }
        None => (false, 0, format!("step limit reached: execution stopped after {max_cycles} cycles (possible infinite loop)")),
    };
    let output = ok.then(|| {
        (0..32)
            .filter(|&i| initial[i] != registers[i])
            .map(|i| {
                format!(
                    "x{i} ({}) = {} ({})",
                    crate::assembler::abi_name(i as u8),
                    hex32(registers[i]),
                    registers[i] as i32
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    });
    RunReport {
        ok,
        output,
        line,
        message,
        registers: registers.iter().copied().map(hex32).collect(),
        pc: hex32(snap.pc),
        cycles: snap.stats.cycles,
    }
}

/// Source and target languages accepted by [`translate`].
pub const TRANSLATE_LANGUAGES: &[&str] = &["rv32", "rv64", "c", "cpp", "rust"];

/// Translate between any two supported languages by name (`rv32`/`asm`,
/// `rv64`, `c`, `cpp`/`c++`, `rust`). Returns `(line, message)` on error;
/// directions without a translator say so plainly.
pub fn translate(from: &str, to: &str, source: &str) -> Result<String, (usize, String)> {
    let canon = |l: &str| -> Option<&'static str> {
        Some(match l.to_ascii_lowercase().as_str() {
            "rv32" | "asm" | "asm32" | "riscv" | "rv32im" => "rv32",
            "rv64" | "asm64" | "rv64im" => "rv64",
            "c" => "c",
            "cpp" | "c++" | "cxx" => "cpp",
            "rust" | "rs" => "rust",
            _ => return None,
        })
    };
    let (Some(f), Some(t)) = (canon(from), canon(to)) else {
        let bad = if canon(from).is_none() { from } else { to };
        return Err((0, format!("unknown language '{bad}': use one of rv32, rv64, c, cpp, rust")));
    };
    use crate::translate as tr;
    let mapped: Result<String, crate::TranslateError> = match (f, t) {
        ("rv32", "c") => tr::asm_to_c(source),
        ("rv64", "c") => tr::asm64_to_c(source),
        ("c", "rv32") => tr::c_to_asm(source),
        ("c", "rv64") => tr::c_to_asm64(source),
        ("cpp", "rv32") => tr::cpp_to_asm(source),
        ("cpp", "rv64") => tr::cpp_to_asm64(source),
        ("rust", "rv32") => tr::rust_to_asm(source),
        ("rust", "rv64") => tr::rust_to_asm64(source),
        ("c", "cpp") => tr::c_to_cpp(source),
        ("cpp", "c") => tr::cpp_to_c(source),
        ("c", "rust") => tr::c_to_rust(source),
        ("cpp", "rust") => tr::cpp_to_rust(source),
        ("rust", "c") => tr::rust_to_c(source),
        ("rust", "cpp") => tr::rust_to_cpp(source),
        ("rv32", "rv64") => return crate::rv32_to_rv64(source).map_err(|e| (e.line, e.message)),
        ("rv64", "rv32") => return crate::rv64_to_rv32(source).map_err(|e| (e.line, e.message)),
        (a, b) if a == b => return Err((0, format!("source and target are both '{a}': nothing to translate"))),
        (a, b) => {
            return Err((
                0,
                format!(
                    "there is no translator from {a} to {b}: assembly can be lifted to C pseudocode \
                     (rv32 or rv64 to c) or converted between rv32 and rv64"
                ),
            ))
        }
    };
    mapped.map_err(|e| (e.line, e.message))
}

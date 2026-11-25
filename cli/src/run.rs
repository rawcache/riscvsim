//! `riscvsim run`: assemble, execute, and print an aligned register table
//! plus a one-glance summary. Shared by RV32 and RV64 through `Machine`.

use crate::diag::Diagnostic;
use crate::progress::{self, Status};
use crate::term::{self, group_thousands, Paint};
use sim_engine::{assemble, assemble64, Pipeline, Pipeline64};
use std::process::ExitCode;

pub const ABI_NAMES: [&str; 32] = [
    "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2", "s0", "s1", "a0", "a1", "a2", "a3", "a4",
    "a5", "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "t3", "t4",
    "t5", "t6",
];

pub struct Totals {
    pub cycles: u64,
    pub instructions: u64,
    pub stalls: u64,
    pub mispredictions: u64,
}

/// The parts of a pipeline `run` needs, for either width.
pub trait Machine {
    const XLEN: u32;
    fn halted(&self) -> bool;
    fn cycles(&self) -> u64;
    fn step_cycle(&mut self);
    fn regs(&self) -> [u64; 32];
    fn totals(&self) -> Totals;
    /// (kind, message) once halted.
    fn halt(&self) -> Option<(&'static str, String)>;
    fn log_seq(&self) -> u64;
    /// (seq, kind, text) since `seq`.
    fn log_since(&self, seq: u64) -> Vec<(u64, &'static str, String)>;
    fn text_width(&self) -> usize;
}

macro_rules! impl_machine {
    ($ty:ty, $xlen:expr) => {
        impl Machine for $ty {
            const XLEN: u32 = $xlen;
            fn halted(&self) -> bool {
                <$ty>::halted(self)
            }
            fn cycles(&self) -> u64 {
                self.stats().cycles
            }
            fn step_cycle(&mut self) {
                <$ty>::step_cycle(self)
            }
            fn regs(&self) -> [u64; 32] {
                self.registers().map(|r| r as u64)
            }
            fn totals(&self) -> Totals {
                let s = self.stats();
                Totals {
                    cycles: s.cycles,
                    instructions: s.instructions,
                    stalls: s.stalls,
                    mispredictions: s.mispredictions,
                }
            }
            fn halt(&self) -> Option<(&'static str, String)> {
                self.snapshot().halt.map(|h| (h.kind, h.message))
            }
            fn log_seq(&self) -> u64 {
                <$ty>::log_seq(self)
            }
            fn log_since(&self, seq: u64) -> Vec<(u64, &'static str, String)> {
                <$ty>::log_since(self, seq)
                    .into_iter()
                    .map(|l| (l.seq, l.kind, l.text))
                    .collect()
            }
            fn text_width(&self) -> usize {
                self.program().instrs.iter().map(|i| i.text.len()).max().unwrap_or(0)
            }
        }
    };
}
impl_machine!(Pipeline, 32);
impl_machine!(Pipeline64, 64);

pub struct RunOpts {
    pub path: String,
    pub xlen: u32,
    pub verbose: bool,
    pub limit: u64,
    /// `--watch REG`: register number to show live on the status line.
    pub watch: Option<u8>,
}

/// Parse a register for `--watch`: `x5`, `t0`, `a0`, `fp` or a number.
pub fn parse_register(name: &str) -> Option<u8> {
    let n = name.trim().to_ascii_lowercase();
    if let Some(num) = n.strip_prefix('x') {
        return num.parse::<u8>().ok().filter(|r| *r < 32);
    }
    if n == "fp" {
        return Some(8);
    }
    (0u8..32).find(|r| sim_engine::assembler::abi_name(*r) == n)
}

fn display_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// Read a source file, printing a friendly error (with a file-name
/// suggestion when the file does not exist).
pub fn read_source(path: &str) -> Result<String, ExitCode> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(error) => {
            let p = Paint::stderr();
            let reason = match error.kind() {
                std::io::ErrorKind::NotFound => "no such file".to_string(),
                std::io::ErrorKind::PermissionDenied => "permission denied".to_string(),
                std::io::ErrorKind::InvalidData => "the file is not UTF-8 text".to_string(),
                _ => error.to_string(),
            };
            eprintln!("{}{} could not read {path}: {reason}", p.error_bold("error"), p.bold(":"));
            if error.kind() == std::io::ErrorKind::NotFound {
                if let Some(s) = suggest_file(path) {
                    eprintln!("  {} did you mean '{}'?", p.info_bold(p.sym("→", "->")), s);
                }
            }
            Err(ExitCode::from(crate::EXIT_RUNTIME))
        }
    }
}

/// The closest existing file next to `path` (same directory).
fn suggest_file(path: &str) -> Option<String> {
    let p = std::path::Path::new(path);
    let dir = p.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(std::path::Path::new("."));
    let want = p.file_name()?.to_string_lossy().to_string();
    let names: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .take(500)
        .collect();
    let best = crate::diag::closest(&want, names.iter().map(String::as_str))?;
    Some(if dir == std::path::Path::new(".") && p.parent().is_none_or(|d| d.as_os_str().is_empty()) {
        best.to_string()
    } else {
        dir.join(best).display().to_string()
    })
}

/// Print engine errors as compiler-style diagnostics on stderr.
pub fn print_diagnostics(file: &str, source: &str, errors: &[(usize, String)]) {
    let p = Paint::stderr();
    let width = term::width();
    for (line, message) in errors {
        let d = Diagnostic::from_engine(file, source, *line, message);
        eprint!("{}", d.render(&p, width));
        eprintln!();
    }
    let n = errors.len();
    eprintln!(
        "{}{} {n} error{} in {file}; nothing was run",
        p.error_bold("error"),
        p.bold(":"),
        if n == 1 { "" } else { "s" }
    );
}

pub fn cmd(opts: RunOpts) -> ExitCode {
    let source = match read_source(&opts.path) {
        Ok(s) => s,
        Err(code) => return code,
    };
    let name = display_name(&opts.path);
    cmd_source(&name, &source, &opts)
}

/// Run in-memory source (`riscvsim demo`, or a file already read).
pub fn cmd_source(name: &str, source: &str, opts: &RunOpts) -> ExitCode {
    let (source, name) = (source.to_string(), name.to_string());
    if opts.xlen == 64 {
        match assemble64(&source) {
            Ok(program) => {
                let n = program.instrs.len();
                execute(Pipeline64::new(program), n, &name, opts)
            }
            Err(errors) => {
                let errs: Vec<_> = errors.into_iter().map(|e| (e.line, e.message)).collect();
                print_diagnostics(&opts.path, &source, &errs);
                ExitCode::from(crate::EXIT_ASSEMBLY)
            }
        }
    } else {
        match assemble(&source) {
            Ok(program) => {
                let n = program.instrs.len();
                execute(Pipeline::new(program), n, &name, opts)
            }
            Err(errors) => {
                let errs: Vec<_> = errors.into_iter().map(|e| (e.line, e.message)).collect();
                print_diagnostics(&opts.path, &source, &errs);
                ExitCode::from(crate::EXIT_ASSEMBLY)
            }
        }
    }
}

enum Outcome {
    Complete,
    Fault(String),
    Limit,
    Interrupted,
}

fn execute<M: Machine>(mut m: M, n_instrs: usize, name: &str, opts: &RunOpts) -> ExitCode {
    let p = Paint::new();
    let dot = p.dot();
    let isa = if M::XLEN == 64 { "RV64IM" } else { "RV32IM" };
    println!(
        "{} {} {dot} {} {dot} {}",
        p.ok_mark(),
        p.bold(name),
        plural(n_instrs as u64, "instruction"),
        p.gray(&format!("{isa} 5-stage pipeline")),
    );
    println!();

    progress::catch_interrupt();
    let initial = m.regs();
    let mut status = Status::new();
    let outcome = if opts.verbose {
        let width = m.text_width();
        let mut seen = m.log_seq();
        loop {
            if m.halted() {
                break None;
            }
            if progress::interrupted() {
                break Some(Outcome::Interrupted);
            }
            if m.cycles() >= opts.limit {
                break Some(Outcome::Limit);
            }
            m.step_cycle();
            for (seq, kind, text) in m.log_since(seen) {
                if kind == "instr" {
                    println!("{}", format_instr_line(&text, width, &p));
                }
                seen = seq + 1;
            }
        }
    } else {
        const CHUNK: u64 = 8192;
        loop {
            let stop = (m.cycles() + CHUNK).min(opts.limit);
            while !m.halted() && m.cycles() < stop {
                m.step_cycle();
            }
            if m.halted() {
                break None;
            }
            if progress::interrupted() {
                break Some(Outcome::Interrupted);
            }
            if m.cycles() >= opts.limit {
                break Some(Outcome::Limit);
            }
            if let Some(r) = opts.watch {
                let v = m.regs()[r as usize];
                let shown = if M::XLEN == 64 { v as i64 } else { v as u32 as i32 as i64 };
                status.watch(format!("x{r} = {shown}"));
            }
            status.update(m.cycles());
        }
    };
    status.clear();
    if opts.verbose {
        println!();
    }
    let outcome = outcome.unwrap_or_else(|| match m.halt() {
        Some(("complete", _)) => Outcome::Complete,
        Some((_, message)) => Outcome::Fault(message),
        None => Outcome::Complete,
    });

    let final_regs = m.regs();
    for line in register_table(&initial, &final_regs, M::XLEN, &p) {
        println!("{line}");
    }
    println!();

    let t = m.totals();
    let (headline, code) = match &outcome {
        Outcome::Complete => (
            format!("{} {}", p.ok_mark(), p.bold(if M::XLEN == 64 { "RV64 program complete" } else { "program complete" })),
            ExitCode::SUCCESS,
        ),
        Outcome::Fault(message) => (
            format!("{} {}", p.err_mark(), p.error(message)),
            ExitCode::from(crate::EXIT_RUNTIME),
        ),
        Outcome::Limit => (
            format!(
                "{} {}",
                p.err_mark(),
                p.error(&format!(
                    "step limit reached after {} cycles; the program may loop forever",
                    group_thousands(opts.limit)
                ))
            ),
            ExitCode::from(crate::EXIT_RUNTIME),
        ),
        Outcome::Interrupted => (
            format!(
                "{} {}",
                p.warn_mark(),
                p.warn(&format!("stopped by Ctrl-C at cycle {}", group_thousands(t.cycles)))
            ),
            ExitCode::from(130),
        ),
    };
    println!("{headline}");
    for line in summary_lines(&t, &p, term::width().saturating_sub(2)) {
        println!("  {line}");
    }
    if matches!(outcome, Outcome::Limit) {
        println!(
            "  {}",
            p.gray(&format!("raise the limit with --limit N (now {})", group_thousands(opts.limit)))
        );
    }
    code
}

pub fn plural(n: u64, word: &str) -> String {
    format!("{} {word}{}", group_thousands(n), if n == 1 { "" } else { "s" })
}

/// "14 cycles · 6 instructions · CPI 2.33 · 2 stalls · 0 mispredictions"
#[cfg(test)]
pub fn summary_line(t: &Totals, p: &Paint) -> String {
    summary_lines(t, p, usize::MAX).join(" ")
}

/// The summary, broken at the separators to fit `width` columns.
pub fn summary_lines(t: &Totals, p: &Paint, width: usize) -> Vec<String> {
    let dot = p.gray(p.dot());
    let cpi = if t.instructions == 0 {
        "CPI n/a".to_string()
    } else {
        format!("CPI {:.2}", t.cycles as f64 / t.instructions as f64)
    };
    [
        plural(t.cycles, "cycle"),
        plural(t.instructions, "instruction"),
        cpi,
        plural(t.stalls, "stall"),
        plural(t.mispredictions, "misprediction"),
    ]
    .into_iter()
    .fold(Vec::<(String, usize)>::new(), |mut lines, part| {
        let w = part.chars().count();
        match lines.last_mut() {
            Some((text, len)) if *len + 3 + w <= width => {
                text.push_str(&format!(" {dot} {part}"));
                *len += 3 + w;
            }
            _ => lines.push((part, w)),
        }
        lines
    })
    .into_iter()
    .map(|(text, _)| text)
    .collect()
}

/// Hex with 4-digit groups for 64-bit values: 0x0000_0001_0000_0007.
pub fn hex(v: u64, xlen: u32) -> String {
    if xlen == 64 {
        let h = format!("{v:016x}");
        format!("0x{}_{}_{}_{}", &h[0..4], &h[4..8], &h[8..12], &h[12..16])
    } else {
        format!("0x{:08x}", v as u32)
    }
}

fn signed(v: u64, xlen: u32) -> i64 {
    if xlen == 64 {
        v as i64
    } else {
        v as u32 as i32 as i64
    }
}

/// Registers that changed (highlighted) plus any other non-zero register
/// (dim, for context), aligned in columns: reg · abi · hex · decimal.
pub fn register_table(before: &[u64; 32], after: &[u64; 32], xlen: u32, p: &Paint) -> Vec<String> {
    let rows: Vec<usize> = (1..32).filter(|&i| after[i] != before[i] || after[i] != 0).collect();
    if rows.is_empty() {
        return vec![p.gray("no registers changed")];
    }
    let hex_w = hex(0, xlen).len();
    let dec_w = rows
        .iter()
        .map(|&i| signed(after[i], xlen).to_string().len())
        .max()
        .unwrap_or(1)
        .max("decimal".len());
    let mut out = vec![p.gray(&format!(
        "  {:<5}{:<6}{:<hex_w$}  {:>dec_w$}",
        "reg", "abi", "hex", "decimal"
    ))];
    let mark = p.sym("●", "*");
    for i in rows {
        let changed = after[i] != before[i];
        let reg = format!("x{i}");
        let body = format!(
            "{:<5}{:<6}{:<hex_w$}  {:>dec_w$}",
            reg,
            ABI_NAMES[i],
            hex(after[i], xlen),
            signed(after[i], xlen)
        );
        out.push(if changed {
            format!("{} {}", p.success(mark), p.bold(&body))
        } else {
            format!("  {}", p.gray(&body))
        });
    }
    let n_changed = (1..32).filter(|&i| after[i] != before[i]).count();
    if out.len() - 1 > n_changed {
        out.push(p.gray(&format!("  {mark} changed by the program; other rows kept their starting value")));
    }
    out
}

pub fn format_instr_line(text: &str, text_width: usize, paint: &Paint) -> String {
    // "add x5, x3, x4  x5: 0 -> 7" — pad the instruction, dim the old value,
    // leave the new value bright. The engine appends the delta after two
    // spaces; split on the LAST double-space, since the instruction text
    // itself may contain aligned double-spaces (e.g. "mul  x7, x5, x6").
    if let Some(pos) = text.rfind("  ") {
        let (instr, delta) = text.split_at(pos);
        let delta = delta.trim_start();
        if let Some((label, change)) = delta.split_once(": ") {
            if let Some((old, new)) = change.split_once(" -> ") {
                return format!(
                    "{instr:<text_width$}  {label}: {} {}",
                    paint.gray(&format!("{old} {}", paint.sym("→", "->"))),
                    paint.bold(new),
                );
            }
        }
    }
    text.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watch_accepts_x_and_abi_names() {
        assert_eq!(super::parse_register("x5"), Some(5));
        assert_eq!(super::parse_register("T0"), Some(5));
        assert_eq!(super::parse_register("a0"), Some(10));
        assert_eq!(super::parse_register("fp"), Some(8));
        assert_eq!(super::parse_register("x32"), None);
        assert_eq!(super::parse_register("pc"), None);
    }

    #[test]
    fn hex_groups_64_bit_values() {
        assert_eq!(hex(0x1_0000_0007, 64), "0x0000_0001_0000_0007");
        assert_eq!(hex(5, 32), "0x00000005");
    }

    #[test]
    fn register_table_snapshot() {
        let before = [0u64; 32];
        let mut after = [0u64; 32];
        after[1] = 5;
        after[2] = (-8i32) as u32 as u64;
        let lines = register_table(&before, &after, 32, &Paint::fixed(false, true));
        assert_eq!(
            lines.join("\n"),
            "  reg  abi   hex         decimal\n\
             ● x1   ra    0x00000005        5\n\
             ● x2   sp    0xfffffff8       -8"
        );
    }

    #[test]
    fn register_table_fits_80_columns_for_rv64() {
        let before = [0u64; 32];
        let mut after = [0u64; 32];
        after[31] = i64::MIN as u64;
        for line in register_table(&before, &after, 64, &Paint::fixed(false, true)) {
            assert!(line.chars().count() <= 80, "{line}");
        }
    }

    #[test]
    fn summary_wraps_at_separators() {
        let t = Totals { cycles: 1_000_000, instructions: 999_994, stalls: 0, mispredictions: 1 };
        let lines = summary_lines(&t, &Paint::fixed(false, true), 78);
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|l| l.chars().count() <= 78));
        assert_eq!(lines[1], "1 misprediction");
    }

    #[test]
    fn summary_has_cpi() {
        let t = Totals { cycles: 14, instructions: 6, stalls: 1, mispredictions: 0 };
        assert_eq!(
            summary_line(&t, &Paint::fixed(false, true)),
            "14 cycles · 6 instructions · CPI 2.33 · 1 stall · 0 mispredictions"
        );
    }
}

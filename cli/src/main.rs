//! riscvsim — StudyRISC-V's terminal simulator.
//!
//!   riscvsim run <file.s> [--verbose] [--max-cycles N]
//!   riscvsim tui [file.s] [--tour]
//!   riscvsim serve <file.s> [--port N]
//!
//! All commands run the exact same sim-engine pipeline the browser
//! simulator uses. `tui` is the full interactive simulator inside the
//! terminal; `serve` holds the session in memory and serves the embedded
//! simulator UI plus a small JSON API on localhost; when the process
//! exits, the session is gone.
//!
//! Exit codes: 0 success · 1 runtime error (trap, memory fault, cycle cap,
//! unreadable file) · 2 usage error · 3 assembly error.

use sim_engine::{assemble, assemble64, Pipeline, Pipeline64, DEFAULT_MAX_CYCLES};
use std::io::IsTerminal;
use std::process::ExitCode;

mod doctor;
mod server;
mod tui;
mod update;

const VERSION: &str = env!("CARGO_PKG_VERSION");

const EXIT_RUNTIME: u8 = 1;
const EXIT_USAGE: u8 = 2;
const EXIT_ASSEMBLY: u8 = 3;

// ---------------------------------------------------------------------------
// Terminal colors (informational, never decorative):
//   green = success · red = error · cyan = in-progress status · gray = detail
// Disabled when stdout is not a TTY, NO_COLOR is set, or TERM=dumb — piped
// output must stay clean for tee/grep/CI.
// ---------------------------------------------------------------------------

pub struct Paint {
    enabled: bool,
}

impl Paint {
    fn new() -> Self {
        let no_color = std::env::var_os("NO_COLOR").is_some();
        let dumb = std::env::var("TERM").map(|t| t == "dumb").unwrap_or(false);
        Self {
            enabled: std::io::stdout().is_terminal() && !no_color && !dumb,
        }
    }
    fn wrap(&self, code: &str, text: &str) -> String {
        if self.enabled {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }
    pub fn status(&self, t: &str) -> String {
        self.wrap("36", t)
    }
    pub fn success(&self, t: &str) -> String {
        self.wrap("32", t)
    }
    pub fn error(&self, t: &str) -> String {
        self.wrap("31", t)
    }
    pub fn gray(&self, t: &str) -> String {
        self.wrap("90", t)
    }
    pub fn bold(&self, t: &str) -> String {
        self.wrap("1", t)
    }
}

// ---------------------------------------------------------------------------
// Help / version
// ---------------------------------------------------------------------------

fn print_version() {
    println!("riscvsim {VERSION}");
}

fn print_help() {
    println!(
        "riscvsim {VERSION} — RISC-V (RV32IM/RV64IM) 5-stage pipeline simulator

usage:
  riscvsim                         start the interactive session
  riscvsim run <file.s> [--xlen=32|64] [--verbose|-v] [--limit N] [--json]
  riscvsim tui [file.s] [--tour]
  riscvsim serve <file.s> [--port N]
  riscvsim doctor

commands:
  run     assemble and run to completion, print final registers and stats
  tui     interactive simulator in the terminal: step, rewind, watch the
          pipeline, registers, and memory — keyboard and mouse
  serve   start a local in-memory session and open it in the browser UI
  doctor  inspect the active executable, PATH copies, and release version

interactive session (riscvsim with no arguments):
  Slash commands inside the session — /help lists them all:
    /run <file>        load and run an assembly file
    /demo [n]          load a built-in sample program and run it
    /serve [--port N]  open the loaded program in the browser UI
    /doctor            versions, PATH copies, update instructions
    /exit              leave the session
  Anything not starting with / is assembled and run as RISC-V source.

flags:
  -v, --verbose      print every retired instruction and register change
      --xlen=32|64   execution width for run (default 32; RV64 is run-only)
  -i, --interactive  with run: open the interactive simulator instead
      --max-cycles   cycle safety cap (default 1000000)
      --port         port for serve (default 4200)
      --tour         with tui: replay the first-run walkthrough
  -V, --version      print version
  -h, --help         this help (also: riscvsim run --help)

examples:
  riscvsim                       start the session, then try /demo or /help
  riscvsim run add.s             final RV32 register state + pipeline stats
  riscvsim translate --from c --to rv64 prog.c   compile C to RV64 assembly
  riscvsim run add.s --json      machine-readable result (same as the browser)
  riscvsim run wide.s --xlen=64  execute RV64IM with 64-bit registers/memory
  riscvsim run add.s -v          watch each instruction retire
  riscvsim tui add.s             step through it without leaving the terminal
  riscvsim serve add.s           inspect the pipeline cycle by cycle

exit codes:
  0 success · 1 runtime error · 2 usage error · 3 assembly error"
    );
}

fn print_run_help() {
    println!(
        "riscvsim run — assemble and execute a RISC-V program

usage:
  riscvsim run <file.s> [--xlen=32|64] [--verbose|-v] [--limit N] [--json]

Runs the program on a 5-stage pipeline (forwarding, load-use stalls,
2-bit branch prediction) and prints every register that changed, then a
stats line: instructions, cycles, stalls, mispredictions.

flags:
  -v, --verbose      also print each instruction as it retires
      --xlen=32|64   execution width (default 32)
      --limit N      stop after N cycles with \"step limit reached\"
                     (default 1000000; --max-cycles N is the same)
      --json         print one JSON result {{ok, output, line, message,
                     registers, pc, cycles}}, as the browser engine does

examples:
  riscvsim run add.s
  riscvsim run loop.s --verbose
  riscvsim run wide.s --xlen=64
  riscvsim run big.s --max-cycles 5000000"
    );
}

fn print_serve_help() {
    println!(
        "riscvsim serve — step through a program in the browser

usage:
  riscvsim serve <file.s> [--port N]

Assembles the program and serves the StudyRISC-V simulator UI on
localhost, pointed at this live session. Step, rewind, and inspect
registers/memory from the browser. The session lives in memory only —
closing this process ends it.

flags:
  --port   local port (default 4200; the next free port is tried
           automatically if 4200 is taken)

example:
  riscvsim serve add.s        then open the printed URL"
    );
}

fn usage_error(message: &str) -> ExitCode {
    eprintln!("✗ {message}");
    eprintln!("  riscvsim --help for usage");
    ExitCode::from(EXIT_USAGE)
}

/// Parses CLI arguments, validates `--xlen`, dispatches to the subcommand (TUI by default), and reports available updates.
fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first() else {
        return cmd_tui(&[]);
    };
    let wants_help = args.iter().any(|a| a == "--help" || a == "-h");
    let xlen = args.iter().find_map(|arg| arg.strip_prefix("--xlen="));
    if xlen.is_some_and(|value| !matches!(value, "32" | "64")) {
        return usage_error("--xlen must be 32 or 64");
    }
    if xlen == Some("64")
        && (command != "run" || args.iter().any(|a| a == "--interactive" || a == "-i"))
    {
        return usage_error("RV64 is available through `riscvsim run <file> --xlen=64`");
    }
    let owns_update_check = command == "doctor"
        || command == "tui"
        || (command == "run" && args.iter().any(|a| a == "--interactive" || a == "-i"));
    let update_check = if owns_update_check {
        None
    } else {
        let _install_method = doctor::active_install_method();
        Some(update::spawn_check(VERSION))
    };
    let exit = match command.as_str() {
        "run" if wants_help => {
            print_run_help();
            ExitCode::SUCCESS
        }
        "serve" if wants_help => {
            print_serve_help();
            ExitCode::SUCCESS
        }
        "run" if args.iter().any(|a| a == "--interactive" || a == "-i") => cmd_tui(&args[1..]),
        "run" if args.iter().any(|a| a == "--json") => cmd_run_json(&args[1..]),
        "run" => cmd_run(&args[1..]),
        "translate" if wants_help => {
            print_translate_help();
            ExitCode::SUCCESS
        }
        "translate" => cmd_translate(&args[1..]),
        "tui" => cmd_tui(&args[1..]),
        "serve" => cmd_serve(&args[1..]),
        "doctor" => doctor::run(VERSION),
        "--help" | "-h" | "help" => {
            print_help();
            ExitCode::SUCCESS
        }
        "--version" | "-V" | "version" => {
            print_version();
            ExitCode::SUCCESS
        }
        other => usage_error(&format!("unknown command '{other}'")),
    };
    if let Some(status) = update_check.and_then(update::UpdateCheck::finish) {
        if status.update_available {
            eprintln!(
                "(a newer version of riscvsim is available: {} -> {} — run `riscvsim doctor` for update instructions)",
                VERSION.trim_start_matches('v'),
                status.latest.trim_start_matches('v')
            );
        }
    }
    exit
}

/// `--limit N` / `--limit=N` / `--max-cycles N`: the per-run step limit.
fn step_limit(args: &[String]) -> Result<u64, ExitCode> {
    let raw = parse_flag_value(args, "--limit")
        .or_else(|| args.iter().find_map(|a| a.strip_prefix("--limit=").map(str::to_string)))
        .or_else(|| parse_flag_value(args, "--max-cycles"));
    match raw {
        None => Ok(DEFAULT_MAX_CYCLES),
        Some(v) => match v.parse::<u64>() {
            Ok(n) if n > 0 => Ok(n),
            _ => Err(usage_error(&format!(
                "the step limit must be a positive whole number, but found '{v}'"
            ))),
        },
    }
}

/// The input file: the first argument that is neither a flag nor a flag's value.
fn positional(args: &[String], flags_with_values: &[&str]) -> Option<String> {
    let mut skip = false;
    for a in args {
        if skip {
            skip = false;
            continue;
        }
        if flags_with_values.contains(&a.as_str()) {
            skip = true;
            continue;
        }
        if !a.starts_with('-') {
            return Some(a.clone());
        }
    }
    None
}

/// `riscvsim run <file> [--xlen=64] [--limit N] --json`: one JSON object with
/// the same shape the browser engine's `run_rv64` returns.
fn cmd_run_json(args: &[String]) -> ExitCode {
    let Some(path) = positional(args, &["--limit", "--max-cycles"]) else {
        return usage_error("run needs a file: riscvsim run <file.s> --json");
    };
    let limit = match step_limit(args) {
        Ok(limit) => limit,
        Err(code) => return code,
    };
    let source = match std::fs::read_to_string(&path) {
        Ok(source) => source,
        Err(error) => {
            eprintln!("✗ could not read {path}: {error}");
            return ExitCode::from(EXIT_RUNTIME);
        }
    };
    let report = if args.iter().any(|a| a == "--xlen=64") {
        sim_engine::report::run64(&source, limit)
    } else {
        sim_engine::report::run32(&source, limit)
    };
    match serde_json::to_string_pretty(&report) {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("✗ could not format the result: {error}");
            return ExitCode::from(EXIT_RUNTIME);
        }
    }
    if report.ok {
        ExitCode::SUCCESS
    } else if report.cycles == 0 && report.registers.is_empty() {
        ExitCode::from(EXIT_ASSEMBLY)
    } else {
        ExitCode::from(EXIT_RUNTIME)
    }
}

fn print_translate_help() {
    println!(
        "riscvsim translate — translate between assembly, C, C++ and Rust

usage:
  riscvsim translate --from LANG --to LANG <file> [-o output]

languages: rv32 (or asm), rv64, c, cpp, rust
  c, cpp and rust compile to rv32 or rv64 assembly and translate to each
  other; rv32/rv64 lift to C pseudocode and convert between each other.

The result goes to stdout, or to the file given with -o. Errors name the
line and say what to change; the exit code is 3 for a translation error.

examples:
  riscvsim translate --from c --to rv64 prog.c
  riscvsim translate --from rust --to c lib.rs -o lib.c"
    );
}

fn cmd_translate(args: &[String]) -> ExitCode {
    let from = parse_flag_value(args, "--from");
    let to = parse_flag_value(args, "--to");
    let (Some(from), Some(to)) = (from, to) else {
        return usage_error("translate needs --from and --to: riscvsim translate --from c --to rv64 <file>");
    };
    let Some(path) = positional(args, &["--from", "--to", "-o", "--output"]) else {
        return usage_error("translate needs an input file: riscvsim translate --from c --to rv64 <file>");
    };
    let source = match std::fs::read_to_string(&path) {
        Ok(source) => source,
        Err(error) => {
            eprintln!("✗ could not read {path}: {error}");
            return ExitCode::from(EXIT_RUNTIME);
        }
    };
    match sim_engine::report::translate(&from, &to, &source) {
        Ok(output) => {
            match parse_flag_value(args, "-o").or_else(|| parse_flag_value(args, "--output")) {
                Some(out_path) => {
                    if let Err(error) = std::fs::write(&out_path, output) {
                        eprintln!("✗ could not write {out_path}: {error}");
                        return ExitCode::from(EXIT_RUNTIME);
                    }
                }
                None => print!("{output}"),
            }
            ExitCode::SUCCESS
        }
        Err((line, message)) => {
            if line > 0 {
                eprintln!("✗ {path}:{line}: {message}");
            } else {
                eprintln!("✗ {path}: {message}");
            }
            if message.starts_with("unknown language") {
                ExitCode::from(EXIT_USAGE)
            } else {
                ExitCode::from(EXIT_ASSEMBLY)
            }
        }
    }
}

fn parse_flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

enum LoadError {
    Io,
    Assembly,
}

fn load_and_assemble(path: &str, paint: &Paint) -> Result<(String, Pipeline), LoadError> {
    let file_name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    println!("{}", paint.status(&format!("Loading {file_name}...")));
    let source = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            println!("{}", paint.error(&format!("✗ could not read {path}: {e}")));
            return Err(LoadError::Io);
        }
    };
    println!("{}", paint.status("Assembling program..."));
    match assemble(&source) {
        Ok(program) => {
            println!(
                "{}",
                paint.success(&format!(
                    "✓ assembled {} instructions",
                    program.instrs.len()
                ))
            );
            Ok((source, Pipeline::new(program)))
        }
        Err(errors) => {
            for err in &errors {
                println!(
                    "{}",
                    paint.error(&format!("✗ line {}: {}", err.line, err.message))
                );
            }
            Err(LoadError::Assembly)
        }
    }
}

fn stats_line(pipeline: &Pipeline) -> String {
    let s = pipeline.stats();
    let plural =
        |n: u64, word: &str| -> String { format!("{n} {word}{}", if n == 1 { "" } else { "s" }) };
    format!(
        "{}, {}, {}, {}",
        plural(s.instructions, "instruction"),
        plural(s.cycles, "cycle"),
        plural(s.stalls, "stall"),
        plural(s.mispredictions, "misprediction")
    )
}

fn stats_line64(pipeline: &Pipeline64) -> String {
    let s = pipeline.stats();
    let plural =
        |n: u64, word: &str| -> String { format!("{n} {word}{}", if n == 1 { "" } else { "s" }) };
    format!(
        "{}, {}, {}, {}",
        plural(s.instructions, "instruction"),
        plural(s.cycles, "cycle"),
        plural(s.stalls, "stall"),
        plural(s.mispredictions, "misprediction")
    )
}

// ---------------------------------------------------------------------------
// riscvsim run
// ---------------------------------------------------------------------------

fn cmd_run(args: &[String]) -> ExitCode {
    if args.iter().any(|arg| arg == "--xlen=64") {
        return cmd_run64(args);
    }
    let paint = Paint::new();
    let Some(path) = args.iter().find(|a| !a.starts_with('-')) else {
        return usage_error("run needs a file: riscvsim run <file.s>");
    };
    let verbose = args.iter().any(|a| a == "--verbose" || a == "-v");
    let max_cycles = match step_limit(args) {
        Ok(limit) => limit,
        Err(code) => return code,
    };

    let (_, mut pipeline) = match load_and_assemble(path, &paint) {
        Ok(v) => v,
        Err(LoadError::Io) => return ExitCode::from(EXIT_RUNTIME),
        Err(LoadError::Assembly) => return ExitCode::from(EXIT_ASSEMBLY),
    };
    println!("{}", paint.status("Running simulator..."));
    println!();

    let initial_regs = pipeline.registers();

    if verbose {
        // Cycle by cycle, streaming retired instructions as they commit.
        // Instruction text is padded to a common width so the register
        // deltas align in a clean column.
        let text_width = pipeline
            .program()
            .instrs
            .iter()
            .map(|i| i.text.len())
            .max()
            .unwrap_or(0);
        let mut seen = pipeline.log_seq();
        loop {
            if pipeline.halted() {
                break;
            }
            if pipeline.stats().cycles >= max_cycles {
                println!(
                    "{}",
                    paint.error(&format!(
                        "✗ step limit reached: execution stopped after {max_cycles} cycles (possible infinite loop)"
                    ))
                );
                return ExitCode::from(EXIT_RUNTIME);
            }
            pipeline.step_cycle();
            for line in pipeline.log_since(seen) {
                if line.kind == "instr" {
                    println!("{}", format_instr_line(&line.text, text_width, &paint));
                }
                seen = line.seq + 1;
            }
        }
    } else {
        pipeline.run(max_cycles);
    }

    // Final register state: everything that changed from its initial value,
    // labels and old values padded so the columns line up.
    let final_regs = pipeline.registers();
    let changed: Vec<(usize, u32, u32)> = initial_regs
        .iter()
        .zip(final_regs.iter())
        .enumerate()
        .filter(|(_, (b, a))| b != a)
        .map(|(i, (&b, &a))| (i, b, a))
        .collect();
    if !changed.is_empty() {
        let label_w = changed
            .iter()
            .map(|(i, _, _)| format!("x{i}").len())
            .max()
            .unwrap_or(2);
        let old_w = changed
            .iter()
            .map(|(_, b, _)| (*b as i32).to_string().len())
            .max()
            .unwrap_or(1);
        for (i, before, after) in &changed {
            let label = format!("x{i}:");
            println!(
                "{:<lw$} {} {}",
                label,
                paint.gray(&format!("{:>ow$} ->", *before as i32, ow = old_w)),
                *after as i32,
                lw = label_w + 1,
            );
        }
        println!();
    }

    match pipeline.snapshot().halt {
        Some(halt) if halt.kind == "complete" => {
            println!("{}", paint.gray(&stats_line(&pipeline)));
            println!("{}", paint.success("✓ program complete"));
            ExitCode::SUCCESS
        }
        Some(halt) => {
            println!("{}", paint.gray(&stats_line(&pipeline)));
            println!("{}", paint.error(&format!("✗ {}", halt.message)));
            ExitCode::from(EXIT_RUNTIME)
        }
        None => {
            println!(
                "{}",
                paint.error(&format!(
                    "✗ step limit reached: execution stopped after {max_cycles} cycles (possible infinite loop)"
                ))
            );
            ExitCode::from(EXIT_RUNTIME)
        }
    }
}

fn cmd_run64(args: &[String]) -> ExitCode {
    let paint = Paint::new();
    let Some(path) = args.iter().find(|a| !a.starts_with('-')) else {
        return usage_error("run needs a file: riscvsim run <file.s> --xlen=64");
    };
    let verbose = args.iter().any(|a| a == "--verbose" || a == "-v");
    let max_cycles = match step_limit(args) {
        Ok(limit) => limit,
        Err(code) => return code,
    };
    let file_name = std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    println!("{}", paint.status(&format!("Loading {file_name}...")));
    let source = match std::fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) => {
            println!(
                "{}",
                paint.error(&format!("✗ could not read {path}: {error}"))
            );
            return ExitCode::from(EXIT_RUNTIME);
        }
    };
    println!("{}", paint.status("Assembling RV64IM program..."));
    let program = match assemble64(&source) {
        Ok(program) => program,
        Err(errors) => {
            for error in &errors {
                println!(
                    "{}",
                    paint.error(&format!("✗ line {}: {}", error.line, error.message))
                );
            }
            return ExitCode::from(EXIT_ASSEMBLY);
        }
    };
    println!(
        "{}",
        paint.success(&format!(
            "✓ assembled {} RV64 instructions",
            program.instrs.len()
        ))
    );
    let mut pipeline = Pipeline64::new(program);
    println!("{}", paint.status("Running RV64 simulator..."));
    println!();

    let initial_regs = pipeline.registers();
    if verbose {
        let text_width = pipeline
            .program()
            .instrs
            .iter()
            .map(|instruction| instruction.text.len())
            .max()
            .unwrap_or(0);
        let mut seen = pipeline.log_seq();
        loop {
            if pipeline.halted() {
                break;
            }
            if pipeline.stats().cycles >= max_cycles {
                println!(
                    "{}",
                    paint.error(&format!(
                        "✗ step limit reached: execution stopped after {max_cycles} cycles (possible infinite loop)"
                    ))
                );
                return ExitCode::from(EXIT_RUNTIME);
            }
            pipeline.step_cycle();
            for line in pipeline.log_since(seen) {
                if line.kind == "instr" {
                    println!("{}", format_instr_line(&line.text, text_width, &paint));
                }
                seen = line.seq + 1;
            }
        }
    } else {
        pipeline.run(max_cycles);
    }

    let final_regs = pipeline.registers();
    let changed: Vec<(usize, u64, u64)> = initial_regs
        .iter()
        .zip(final_regs.iter())
        .enumerate()
        .filter(|(_, (before, after))| before != after)
        .map(|(index, (&before, &after))| (index, before, after))
        .collect();
    if !changed.is_empty() {
        let label_width = changed
            .iter()
            .map(|(index, _, _)| format!("x{index}").len())
            .max()
            .unwrap_or(2);
        let old_width = changed
            .iter()
            .map(|(_, before, _)| (*before as i64).to_string().len())
            .max()
            .unwrap_or(1);
        for (index, before, after) in &changed {
            println!(
                "{:<label_width$} {} {}",
                format!("x{index}:"),
                paint.gray(&format!("{:>old_width$} ->", *before as i64)),
                *after as i64,
                label_width = label_width + 1,
            );
        }
        println!();
    }

    match pipeline.snapshot().halt {
        Some(halt) if halt.kind == "complete" => {
            println!("{}", paint.gray(&stats_line64(&pipeline)));
            println!("{}", paint.success("✓ RV64 program complete"));
            ExitCode::SUCCESS
        }
        Some(halt) => {
            println!("{}", paint.gray(&stats_line64(&pipeline)));
            println!("{}", paint.error(&format!("✗ {}", halt.message)));
            ExitCode::from(EXIT_RUNTIME)
        }
        None => {
            println!(
                "{}",
                paint.error(&format!(
                    "✗ step limit reached: execution stopped after {max_cycles} cycles (possible infinite loop)"
                ))
            );
            ExitCode::from(EXIT_RUNTIME)
        }
    }
}

fn format_instr_line(text: &str, text_width: usize, paint: &Paint) -> String {
    // "add x5, x3, x4  x5: 0 -> 7" — pad the instruction, dim the old value,
    // leave the new value bright (matches the marketing terminal treatment).
    // The engine appends the delta after two spaces; split on the LAST
    // double-space, since the instruction text itself may contain aligned
    // double-spaces (e.g. "mul  x7, x5, x6").
    if let Some(pos) = text.rfind("  ") {
        let (instr, delta) = text.split_at(pos);
        let delta = delta.trim_start();
        if let Some((label, change)) = delta.split_once(": ") {
            if let Some((old, new)) = change.split_once(" -> ") {
                return format!(
                    "{instr:<text_width$}  {label}: {} {}",
                    paint.gray(&format!("{old} ->")),
                    paint.bold(new),
                );
            }
        }
        return format!("{instr:<text_width$}  {}", paint.gray(delta));
    }
    text.to_string()
}

// ---------------------------------------------------------------------------
// riscvsim tui
// ---------------------------------------------------------------------------

fn cmd_tui(args: &[String]) -> ExitCode {
    let file = args
        .iter()
        .find(|a| !a.starts_with('-'))
        .map(std::path::PathBuf::from);
    let force_tour = args.iter().any(|a| a == "--tour");
    match tui::run(tui::Opts { file, force_tour }) {
        // The session ended with /serve: the terminal is back to normal, so
        // hand the loaded program to the same server `riscvsim serve` uses.
        Ok(Some(request)) => serve_program(request.source, &request.file_name, request.port),
        Ok(None) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("✗ {e}");
            ExitCode::from(EXIT_RUNTIME)
        }
    }
}

/// Assemble in-memory source and serve it. Shared by `riscvsim serve <file>`
/// and the interactive session's `/serve`.
fn serve_program(source: String, label: &str, port: Option<u16>) -> ExitCode {
    let paint = Paint::new();
    println!("{}", paint.status(&format!("Assembling {label}...")));
    let program = match assemble(&source) {
        Ok(program) => program,
        Err(errors) => {
            for err in &errors {
                println!(
                    "{}",
                    paint.error(&format!("✗ line {}: {}", err.line, err.message))
                );
            }
            return ExitCode::from(EXIT_ASSEMBLY);
        }
    };
    println!(
        "{}",
        paint.success(&format!("✓ assembled {} instructions", program.instrs.len()))
    );
    match server::serve(source, Pipeline::new(program), port, paint) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("✗ {e}");
            ExitCode::from(EXIT_RUNTIME)
        }
    }
}

// ---------------------------------------------------------------------------
// riscvsim serve
// ---------------------------------------------------------------------------

fn cmd_serve(args: &[String]) -> ExitCode {
    let paint = Paint::new();
    let Some(path) = args.iter().find(|a| !a.starts_with('-')) else {
        return usage_error("serve needs a file: riscvsim serve <file.s>");
    };
    let port = parse_flag_value(args, "--port").and_then(|v| v.parse::<u16>().ok());

    let (source, pipeline) = match load_and_assemble(path, &paint) {
        Ok(v) => v,
        Err(LoadError::Io) => return ExitCode::from(EXIT_RUNTIME),
        Err(LoadError::Assembly) => return ExitCode::from(EXIT_ASSEMBLY),
    };

    match server::serve(source, pipeline, port, paint) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("✗ {e}");
            ExitCode::from(EXIT_RUNTIME)
        }
    }
}

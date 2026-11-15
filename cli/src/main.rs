//! riscvsim — StudyRISC-V's terminal simulator.
//!
//!   riscvsim run <file.s> [--verbose] [--max-cycles N]
//!   riscvsim serve <file.s> [--port N]
//!
//! Both commands run the exact same sim-engine pipeline the browser
//! simulator uses. `serve` holds the session in memory and serves the
//! embedded simulator UI plus a small JSON API on localhost; when the
//! process exits, the session is gone.
//!
//! Exit codes: 0 success · 1 runtime error (trap, memory fault, cycle cap,
//! unreadable file) · 2 usage error · 3 assembly error.

use sim_engine::{assemble, Pipeline, DEFAULT_MAX_CYCLES};
use std::io::IsTerminal;
use std::process::ExitCode;

mod server;

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
// Help / version / first-run
// ---------------------------------------------------------------------------

fn print_version() {
    println!("riscvsim {VERSION}");
}

fn print_welcome() {
    println!("riscvsim {VERSION} — RISC-V (RV32IM) 5-stage pipeline simulator");
    println!();
    println!("  riscvsim run <file.s>      assemble and run a program");
    println!("  riscvsim serve <file.s>    step through it in the browser");
    println!("  riscvsim --help            full usage and examples");
}

fn print_help() {
    println!(
        "riscvsim {VERSION} — RISC-V (RV32IM) 5-stage pipeline simulator

usage:
  riscvsim run <file.s> [--verbose|-v] [--max-cycles N]
  riscvsim serve <file.s> [--port N]

commands:
  run     assemble and run to completion, print final registers and stats
  serve   start a local in-memory session and open it in the browser UI

flags:
  -v, --verbose      print every retired instruction and register change
      --max-cycles   cycle safety cap (default 1000000)
      --port         port for serve (default 4200)
  -V, --version      print version
  -h, --help         this help (also: riscvsim run --help)

examples:
  riscvsim run add.s             final register state + pipeline stats
  riscvsim run add.s -v          watch each instruction retire
  riscvsim serve add.s           inspect the pipeline cycle by cycle

exit codes:
  0 success · 1 runtime error · 2 usage error · 3 assembly error"
    );
}

fn print_run_help() {
    println!(
        "riscvsim run — assemble and execute a RISC-V program

usage:
  riscvsim run <file.s> [--verbose|-v] [--max-cycles N]

Runs the program on a 5-stage pipeline (forwarding, load-use stalls,
2-bit branch prediction) and prints every register that changed, then a
stats line: instructions, cycles, stalls, mispredictions.

flags:
  -v, --verbose      also print each instruction as it retires
      --max-cycles   halt after N cycles (default 1000000) — protects
                     against infinite loops

examples:
  riscvsim run add.s
  riscvsim run loop.s --verbose
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

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first() else {
        print_welcome();
        return ExitCode::SUCCESS;
    };
    let wants_help = args.iter().any(|a| a == "--help" || a == "-h");
    match command.as_str() {
        "run" if wants_help => {
            print_run_help();
            ExitCode::SUCCESS
        }
        "serve" if wants_help => {
            print_serve_help();
            ExitCode::SUCCESS
        }
        "run" => cmd_run(&args[1..]),
        "serve" => cmd_serve(&args[1..]),
        "--help" | "-h" | "help" => {
            print_help();
            ExitCode::SUCCESS
        }
        "--version" | "-V" | "version" => {
            print_version();
            ExitCode::SUCCESS
        }
        other => usage_error(&format!("unknown command '{other}'")),
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
                paint.success(&format!("✓ assembled {} instructions", program.instrs.len()))
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
    let plural = |n: u64, word: &str| -> String {
        format!("{n} {word}{}", if n == 1 { "" } else { "s" })
    };
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
    let paint = Paint::new();
    let Some(path) = args.iter().find(|a| !a.starts_with('-')) else {
        return usage_error("run needs a file: riscvsim run <file.s>");
    };
    let verbose = args.iter().any(|a| a == "--verbose" || a == "-v");
    let max_cycles = parse_flag_value(args, "--max-cycles")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_MAX_CYCLES);

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
                        "✗ execution halted: exceeded {max_cycles} cycles (possible infinite loop)"
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
        let label_w = changed.iter().map(|(i, _, _)| format!("x{i}").len()).max().unwrap_or(2);
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
                    "✗ execution halted: exceeded {max_cycles} cycles (possible infinite loop)"
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

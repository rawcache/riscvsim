//! riscvsim — StudyRISC-V's terminal simulator.
//!
//!   riscvsim run <file.s> [--verbose] [--limit N] [--xlen=32|64] [--json]
//!   riscvsim demo [n|name]
//!   riscvsim tui [file.s] [--xlen=32|64] [--tour]
//!   riscvsim translate --from LANG --to LANG <file> [-o out]
//!   riscvsim serve [file.s] [--port N] [--no-open] [-v]
//!   riscvsim doctor
//!
//! All commands run the exact same sim-engine pipeline the browser
//! simulator uses. `tui` is the full interactive simulator inside the
//! terminal; `serve` holds the session in memory and serves the embedded
//! simulator UI plus a small JSON API on localhost.
//!
//! Exit codes: 0 ok · 1 a problem with the program or input (assembly or
//! translation error, trap, memory fault, step limit, unreadable file, busy
//! port) · 2 usage error (unknown command or option, missing argument) ·
//! 130 stopped with Ctrl-C.
//!
//! Startup does no work beyond parsing arguments: no tables are built, no
//! network is touched (the update notice comes from a cache that a detached
//! background process refreshes at most hourly).

use sim_engine::{assemble, Pipeline, DEFAULT_MAX_CYCLES};
use std::process::ExitCode;

mod completions;
mod diag;
mod explain;
mod lessons;
mod machine;
mod demo;
mod doctor;
mod progress;
mod run;
mod server;
#[cfg(test)]
mod snapshots;
mod term;
mod tui;
mod update;

pub use term::Paint;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DOCS_URL: &str = "https://studyriscv.com/docs/";

pub const EXIT_RUNTIME: u8 = 1;
pub const EXIT_USAGE: u8 = 2;
/// Assembly and translation errors are problems with the input: exit 1,
/// like every other problem with the program (see the exit codes above).
pub const EXIT_ASSEMBLY: u8 = 1;

// ---------------------------------------------------------------------------
// Help, home screen, version
// ---------------------------------------------------------------------------

/// Shown for `riscvsim` with no arguments when there is no interactive
/// terminal (on a terminal, the interactive session opens instead).
fn home_text(p: &Paint) -> String {
    let dot = p.dot();
    format!(
        "{name} {ver} {dot} a RISC-V simulator with a real 5-stage pipeline

Runs RV32IM and RV64IM programs cycle by cycle: forwarding, load-use
stalls and branch prediction, the same engine as studyriscv.com.

{try_}
  {c1}            six short lessons on the pipeline, no files needed
  {c2}      run your program, print registers and stats
  {c3}             step through the pipeline interactively

{help} riscvsim --help {dot} riscvsim <command> --help {dot} {DOCS_URL}",
        name = p.bold("riscvsim"),
        ver = p.gray(&format!("v{VERSION}")),
        try_ = p.bold("Try"),
        c1 = p.status("riscvsim demo"),
        c2 = p.status("riscvsim run prog.s"),
        c3 = p.status("riscvsim tui"),
        help = p.bold("Help:"),
    )
}

/// `riscvsim --version`: one short line. It always starts with
/// `riscvsim X.Y.Z` so scripts (and doctor) can read the first two words.
fn version_line(p: &Paint) -> String {
    let dot = p.dot();
    format!(
        "riscvsim {VERSION} {dot} {} {dot} {}",
        p.gray("RV32IM and RV64IM"),
        p.gray("translates a subset of C, C++ and Rust")
    )
}

fn help_text(p: &Paint) -> String {
    let h = |s: &str| p.bold(s);
    format!(
        "{title} {ver} {dot} RISC-V (RV32IM / RV64IM) 5-stage pipeline simulator

{usage}
  riscvsim                      interactive session (on a terminal)
  riscvsim <command> [options]

{commands}
  run          assemble and run a program, print registers and stats
  demo         six short lessons on the pipeline, cycle by cycle
  tui          interactive simulator: step, rewind, watch the pipeline
  translate    a documented subset of C, C++ and Rust to assembly, and back
  serve        the browser simulator on this computer, no account needed
  doctor       check the install, PATH copies and updates
  completions  tab completion for bash, zsh or fish

{examples}
  riscvsim demo                 lesson 1 of the course, cycle by cycle
  riscvsim run add.s            final registers + cycles, CPI, stalls
  riscvsim run add.s -v         watch every instruction retire
  riscvsim run wide.s --xlen=64 run with 64-bit registers
  riscvsim tui add.s            step through it in the terminal
  riscvsim translate --from c --to rv64 prog.c
  riscvsim translate --from c --to rv32 prog.c --annotate

{options}
  --no-color      never use color (NO_COLOR=1 works too)
  -h, --help      help for riscvsim or for one command
  -V, --version   print the version

Run 'riscvsim <command> --help' for a command's options.
{exit}
  0 ok {dot} 1 a problem with the program or input {dot} 2 usage error
  130 stopped with Ctrl-C
Docs: {DOCS_URL}",
        title = h("riscvsim"),
        ver = p.gray(&format!("v{VERSION}")),
        dot = p.dot(),
        usage = h("Usage"),
        commands = h("Commands"),
        examples = h("Examples"),
        options = h("Options"),
        exit = h("Exit codes"),
    )
}

fn run_help(p: &Paint) -> String {
    format!(
        "{title} {dot} assemble and run a RISC-V program

{usage}
  riscvsim run <file.s> [options]

Runs the program on a 5-stage pipeline (forwarding, load-use stalls,
2-bit branch prediction), then prints the registers it changed in hex and
decimal and a summary: cycles, instructions, CPI, stalls, mispredictions.
Long runs show a live status line; Ctrl-C stops with a summary.

{options}
  -v, --verbose      print each instruction as it retires
      --xlen=32|64   register width (default 32)
      --limit N      stop after N cycles (default {limit});
                     --max-cycles N is the same
      --watch REG    show one register live while it runs (t0, x5)
      --expect R=V   after the run, check that register R holds V (42,
                     -1 or 0x2a; x3 or a0); repeatable; exit 0 if all
                     match, 1 if any does not
      --json         one JSON result, the same shape the browser uses
  -i, --interactive  open the program in the interactive simulator

{examples}
  riscvsim run add.s
  riscvsim run loop.s --verbose
  riscvsim run wide.s --xlen=64
  riscvsim run big.s --limit 5000000 --watch a0
  riscvsim run add.s --json | jq .registers

  Grade a submission: exit 0 only if both registers are right
  riscvsim run hw1.s --expect a0=55 --expect x6=0x2a && echo pass",
        dot = p.dot(),
        title = p.bold("riscvsim run"),
        usage = p.bold("Usage"),
        options = p.bold("Options"),
        examples = p.bold("Examples"),
        limit = term::group_thousands(DEFAULT_MAX_CYCLES),
    )
}

fn demo_help(p: &Paint) -> String {
    let mut s = format!(
        "{title} {dot} a short course on the pipeline, one cycle at a time

{usage}
  riscvsim demo [number|name] [options]
  riscvsim demo --list

Six lessons, each a tiny program. On a terminal a lesson is interactive:
Enter next cycle, a autoplay, +/- speed, b back, r restart, q quit; when
a lesson ends, Enter starts the next one. Piped, it prints the same lesson
as text. Each cycle gets one plain sentence saying what happened and why.

{options}
  --list      the lessons, with what each one shows
  --summary   just run the lesson and print registers and stats
  -v          run it and show every instruction as it retires
  --json      the run result as JSON

{lessons}\n",
        dot = p.dot(),
        title = p.bold("riscvsim demo"),
        usage = p.bold("Usage"),
        options = p.bold("Options"),
        lessons = p.bold("Lessons"),
    );
    for (i, lesson) in lessons::LESSONS.iter().enumerate() {
        s.push_str(&format!("  {}  {:<12} {}\n", i + 1, lesson.slug, p.gray(lesson.title())));
    }
    s.push_str(&format!(
        "\n{examples}
  riscvsim demo                 start the course at lesson 1
  riscvsim demo 4               why a wrong branch guess costs cycles
  riscvsim demo loops -v        the loop, instruction by instruction
  riscvsim demo --list",
        examples = p.bold("Examples")
    ));
    s
}

fn tui_help(p: &Paint) -> String {
    format!(
        "{title} {dot} the interactive simulator in your terminal

{usage}
  riscvsim tui [file.s] [--xlen=32|64] [--tour]

Shows the source, the five pipeline stages, registers, memory and output.
Keys: {right}/n step {dot} {left} back {dot} space run/pause {dot} r reset {dot} ? help {dot} q quit
Needs a terminal of at least 60x20.

{options}
  --xlen=32|64   register width (default 32), as in riscvsim run
  --tour         replay the first-run walkthrough

{examples}
  riscvsim tui                  start with a built-in sample
  riscvsim tui add.s            open your program
  riscvsim tui wide.s --xlen=64 step through a 64-bit program",
        right = p.sym("\u{2192}", "right"),
        left = p.sym("\u{2190}", "left"),
        title = p.bold("riscvsim tui"),
        usage = p.bold("Usage"),
        options = p.bold("Options"),
        examples = p.bold("Examples"),
        dot = p.dot(),
    )
}

fn serve_help(p: &Paint) -> String {
    format!(
        "{title} {dot} step through a program in the browser

{usage}
  riscvsim serve [file.s] [options]

Assembles the program (or a built-in sample when no file is given) and
serves the browser simulator on this computer only, pointed at this live
session. Nothing is uploaded and no account is needed. The session lives
in memory; press Ctrl-C to stop.

{options}
  --xlen=32|64 register width (default 32), as in riscvsim run; a file
               whose first line is # xlen=64 is RV64 too
  --port N     local port (default 4200; if it is busy, the next free
               port is used and the panel says so)
  --no-open    do not open a browser, just print the address
  -v           log each request from the browser

{examples}
  riscvsim serve                a sample, opened in your browser
  riscvsim serve add.s          your program
  riscvsim serve wide.s --xlen=64
  riscvsim serve add.s --port 8080 --no-open",
        dot = p.dot(),
        title = p.bold("riscvsim serve"),
        usage = p.bold("Usage"),
        options = p.bold("Options"),
        examples = p.bold("Examples"),
    )
}

fn translate_help(p: &Paint) -> String {
    format!(
        "{title} {dot} translate between assembly, C, C++ and Rust

{usage}
  riscvsim translate --from LANG --to LANG <file> [-o output]
  riscvsim translate --subset LANG

Languages: rv32 (or asm), rv64, c, cpp, rust. A documented subset of C,
C++ and Rust compiles to rv32 or rv64 assembly and translates between the
three; --subset LANG lists exactly what it accepts. rv32 and rv64 lift to
C pseudocode and convert between each other.

The result goes to stdout, or to the file given with -o. Errors point at
the line and say what to change; the exit code is 1 for a translation error.

{options}
  --from LANG       input language
  --to LANG         output language
  -o, --output F    write to a file instead of stdout
  --subset LANG     list what the c, cpp or rust translator supports
  --annotate        C or C++ to assembly with each source line shown as a
                    comment above the instructions it became

{examples}
  riscvsim translate --from c --to rv64 prog.c
  riscvsim translate --from c --to rv32 prog.c -o prog.s && riscvsim run prog.s
  riscvsim translate --from rust --to c lib.rs -o lib.c
  riscvsim translate --subset c",
        dot = p.dot(),
        title = p.bold("riscvsim translate"),
        usage = p.bold("Usage"),
        options = p.bold("Options"),
        examples = p.bold("Examples"),
    )
}

fn completions_help(p: &Paint) -> String {
    format!(
        "{title} {dot} tab completion for your shell

{usage}
  riscvsim completions bash|zsh|fish

Prints a completion script for riscvsim's commands, options and values.

{examples}
  source <(riscvsim completions bash)      bash, this session
  riscvsim completions zsh > ~/.zfunc/_riscvsim
  riscvsim completions fish > ~/.config/fish/completions/riscvsim.fish",
        dot = p.dot(),
        title = p.bold("riscvsim completions"),
        usage = p.bold("Usage"),
        examples = p.bold("Examples"),
    )
}

fn doctor_help(p: &Paint) -> String {
    format!(
        "{title} {dot} check this riscvsim install

{usage}
  riscvsim doctor

Checks the running executable, copies on PATH, the latest release and the
terminal, and says how to fix anything that needs attention.

{examples}
  riscvsim doctor",
        dot = p.dot(),
        title = p.bold("riscvsim doctor"),
        usage = p.bold("Usage"),
        examples = p.bold("Examples"),
    )
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/// A command's flags: (name, takes a value). Aliases are listed separately.
type Spec = &'static [(&'static str, bool)];

const RUN_FLAGS: Spec = &[
    ("--watch", true),
    ("--expect", true),
    ("--verbose", false),
    ("-v", false),
    ("--xlen", true),
    ("--limit", true),
    ("--max-cycles", true),
    ("--json", false),
    ("--interactive", false),
    ("-i", false),
];
const DEMO_FLAGS: Spec = &[
    ("--verbose", false),
    ("-v", false),
    ("--xlen", true),
    ("--limit", true),
    ("--max-cycles", true),
    ("--json", false),
    ("--summary", false),
    ("--list", false),
    ("--interactive", false),
    ("-i", false),
];
const TUI_FLAGS: Spec = &[("--tour", false), ("--xlen", true)];
const SERVE_FLAGS: Spec = &[("--port", true), ("--xlen", true), ("--no-open", false), ("--verbose", false), ("-v", false)];
const TRANSLATE_FLAGS: Spec = &[
    ("--from", true),
    ("--to", true),
    ("-o", true),
    ("--output", true),
    ("--subset", true),
    ("--annotate", false),
];
const NO_FLAGS: Spec = &[];

/// What a command's free arguments are, for shell completion.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Operand {
    None,
    File,
    Sample,
    Shell,
}

/// One command: its name, a one-line summary, its flags, what it takes,
/// its help screen and the function that runs it. The dispatcher, argument
/// parsing, the completion scripts and the unknown-command error all read
/// this table, so they cannot drift apart.
struct CommandDef {
    name: &'static str,
    about: &'static str,
    flags: Spec,
    operand: Operand,
    help: fn(&Paint) -> String,
    run: fn(&Args) -> ExitCode,
}

const CLI: &[CommandDef] = &[
    CommandDef { name: "run", about: "assemble and run a program", flags: RUN_FLAGS, operand: Operand::File, help: run_help, run: cmd_run },
    CommandDef { name: "demo", about: "a six-lesson course on the pipeline", flags: DEMO_FLAGS, operand: Operand::Sample, help: demo_help, run: cmd_demo },
    CommandDef { name: "tui", about: "the interactive simulator", flags: TUI_FLAGS, operand: Operand::File, help: tui_help, run: cmd_tui },
    CommandDef { name: "translate", about: "a subset of C, C++ and Rust to assembly, and back", flags: TRANSLATE_FLAGS, operand: Operand::File, help: translate_help, run: cmd_translate },
    CommandDef { name: "serve", about: "the browser simulator on this computer", flags: SERVE_FLAGS, operand: Operand::File, help: serve_help, run: cmd_serve },
    CommandDef { name: "doctor", about: "check the install and updates", flags: NO_FLAGS, operand: Operand::None, help: doctor_help, run: cmd_doctor },
    CommandDef { name: "completions", about: "shell completion script", flags: NO_FLAGS, operand: Operand::Shell, help: completions_help, run: cmd_completions },
];

fn find_command(name: &str) -> Option<&'static CommandDef> {
    CLI.iter().find(|c| c.name == name)
}

/// Every word accepted as a command, for did-you-mean: the table, plus
/// `help` and `version`.
fn command_words() -> impl Iterator<Item = &'static str> {
    CLI.iter().map(|c| c.name).chain(["help", "version"])
}

/// "run, demo, tui, ...": the commands, in table order.
fn command_list() -> String {
    CLI.iter().map(|c| c.name).collect::<Vec<_>>().join(", ")
}

fn cmd_doctor(_: &Args) -> ExitCode {
    doctor::run(VERSION)
}

/// Values a flag accepts, for completion.
fn flag_values(flag: &str) -> &'static [&'static str] {
    match flag {
        "--xlen" => &["32", "64"],
        "--from" | "--to" => &["rv32", "rv64", "c", "cpp", "rust"],
        "--subset" => &["c", "cpp", "rust"],
        _ => &[],
    }
}

#[derive(Default)]
struct Args {
    flags: Vec<(&'static str, Option<String>)>,
    positionals: Vec<String>,
}

impl Args {
    fn has(&self, names: &[&str]) -> bool {
        self.flags.iter().any(|(f, _)| names.contains(f))
    }
    /// Every value given for a repeatable flag, in order.
    fn values(&self, names: &[&str]) -> Vec<&str> {
        self.flags.iter().filter(|(f, _)| names.contains(f)).filter_map(|(_, v)| v.as_deref()).collect()
    }
    fn value(&self, names: &[&str]) -> Option<&str> {
        self.flags
            .iter()
            .rev()
            .find(|(f, _)| names.contains(f))
            .and_then(|(_, v)| v.as_deref())
    }
}

fn parse_args(command: &str, args: &[String], spec: Spec) -> Result<Args, ExitCode> {
    let mut out = Args::default();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        if a == "--" {
            out.positionals.extend(args[i..].iter().cloned());
            break;
        }
        if !a.starts_with('-') || a == "-" {
            out.positionals.push(a.clone());
            continue;
        }
        let (name, inline) = match a.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n, Some(v.to_string())),
            _ => (a.as_str(), None),
        };
        let Some(&(flag, takes_value)) = spec.iter().find(|(f, _)| *f == name) else {
            let long: Vec<&str> = spec.iter().map(|(f, _)| *f).filter(|f| f.starts_with("--")).collect();
            let hint = diag::closest(name.trim_start_matches('-'), long.iter().map(|f| f.trim_start_matches('-')))
                .map(|f| format!("did you mean '--{f}'?"));
            return Err(usage_error_with(
                &format!("'{a}' is not an option of riscvsim {command}"),
                hint.as_deref(),
                Some(&format!("riscvsim {command} --help lists the options")),
            ));
        };
        let value = if takes_value {
            match inline {
                Some(v) => Some(v),
                None => match args.get(i) {
                    Some(v) if !v.starts_with("--") => {
                        i += 1;
                        Some(v.clone())
                    }
                    _ => {
                        return Err(usage_error(&format!("{flag} needs a value, for example: riscvsim {command} {flag} {}", example_value(flag))));
                    }
                },
            }
        } else if inline.is_some() {
            return Err(usage_error(&format!("{flag} does not take a value")));
        } else {
            None
        };
        out.flags.push((flag, value));
    }
    Ok(out)
}

fn example_value(flag: &str) -> &'static str {
    match flag {
        "--xlen" => "64",
        "--limit" | "--max-cycles" => "5000000",
        "--port" => "4200",
        "--watch" => "t0",
        "--expect" => "x3=42",
        "--from" => "c",
        "--to" => "rv64",
        "--subset" => "c",
        _ => "out.s",
    }
}

fn usage_error(message: &str) -> ExitCode {
    usage_error_with(message, None, None)
}

fn usage_error_with(message: &str, suggestion: Option<&str>, help: Option<&str>) -> ExitCode {
    eprint!("{}", usage_text(&Paint::stderr(), message, suggestion, help));
    ExitCode::from(EXIT_USAGE)
}

/// A usage error: what went wrong, an optional suggestion, then what to do.
fn usage_text(p: &Paint, message: &str, suggestion: Option<&str>, help: Option<&str>) -> String {
    let mut out = format!("{}{} {message}\n", p.error_bold("error"), p.bold(":"));
    if let Some(s) = suggestion {
        out.push_str(&format!("  {} {}\n", p.info_bold(p.sym("→", "->")), p.info_bold(s)));
    }
    let help = help.unwrap_or("riscvsim --help for usage");
    // Keep within 78 columns: a long hint wraps under itself.
    let lines = help.lines().flat_map(|l| if l.chars().count() > 76 { term::wrap(l, 76) } else { vec![l.to_string()] });
    for line in lines {
        out.push_str(&format!("  {}\n", p.gray(&line)));
    }
    out
}

fn print_text(text: String) -> ExitCode {
    println!("{text}");
    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // Global flags, accepted anywhere.
    args.retain(|a| {
        if a == "--no-color" || a == "--color=never" {
            term::disable_color();
            false
        } else {
            true
        }
    });

    let Some(command) = args.first().cloned() else {
        if term::Stream::Stdout.is_tty() && !std::env::var("TERM").is_ok_and(|t| t == "dumb") {
            return cmd_tui(&Args::default());
        }
        return print_text(home_text(&Paint::new()));
    };
    let rest = &args[1..];
    let wants_help = rest.iter().any(|a| a == "--help" || a == "-h");
    let p = Paint::new();

    if command == update::REFRESH_COMMAND {
        update::refresh_now();
        return ExitCode::SUCCESS;
    }

    let shows_update_notice = matches!(command.as_str(), "run" | "demo" | "translate" | "serve")
        && !rest.iter().any(|a| a == "--json" || a == "-i" || a == "--interactive");

    let exit = match command.as_str() {
        "--help" | "-h" | "help" => match rest.first().and_then(|name| find_command(name)) {
            Some(def) => print_text((def.help)(&p)),
            None => print_text(help_text(&p)),
        },
        "--version" | "-V" | "version" => print_text(version_line(&p)),
        name => match find_command(name) {
            Some(def) if wants_help => print_text((def.help)(&p)),
            Some(def) => match parse_args(def.name, rest, def.flags) {
                Ok(a) => (def.run)(&a),
                Err(code) => code,
            },
            None => unknown_command(name),
        },
    };

    if shows_update_notice && term::Stream::Stderr.is_tty() {
        if let Some(status) = update::cached_status(VERSION).filter(|s| s.update_available) {
            let e = Paint::stderr();
            eprintln!(
                "{}",
                e.gray(&format!(
                    "riscvsim {} is available (you have {}); riscvsim doctor shows how to update",
                    status.latest.trim_start_matches('v'),
                    VERSION
                ))
            );
        }
    }
    exit
}

fn unknown_command(other: &str) -> ExitCode {
    if other.starts_with('-') {
        return usage_error_with(
            &format!("'{other}' is not an option of riscvsim"),
            None,
            Some("options go after a command, e.g. riscvsim run prog.s --verbose; riscvsim --help lists them"),
        );
    }
    let looks_like_file = other.contains('.') || other.contains('/') || std::path::Path::new(other).is_file();
    if looks_like_file {
        return usage_error_with(
            &format!("'{other}' is not a command"),
            Some(&format!("to run a file: riscvsim run {other}")),
            None,
        );
    }
    let (message, hint, help) = unknown_command_parts(other);
    usage_error_with(&message, hint.as_deref(), Some(&help))
}

/// The unknown-command error: message, did-you-mean, and every command.
fn unknown_command_parts(other: &str) -> (String, Option<String>, String) {
    let hint = diag::closest(other, command_words()).map(|c| format!("did you mean 'riscvsim {c}'?"));
    (
        format!("unknown command '{other}'"),
        hint,
        format!("commands: {}\nriscvsim --help for more", command_list()),
    )
}

// ---------------------------------------------------------------------------
// run / demo
// ---------------------------------------------------------------------------

/// `--limit N` / `--max-cycles N`: the per-run step limit.
fn step_limit(args: &Args) -> Result<u64, ExitCode> {
    match args.value(&["--limit", "--max-cycles"]) {
        None => Ok(DEFAULT_MAX_CYCLES),
        Some(v) => match v.replace(['_', ','], "").parse::<u64>() {
            Ok(n) if n > 0 => Ok(n),
            _ => Err(usage_error(&format!(
                "the step limit must be a positive whole number, but found '{v}'"
            ))),
        },
    }
}

fn xlen(args: &Args) -> Result<u32, ExitCode> {
    match args.value(&["--xlen"]) {
        None | Some("32") => Ok(32),
        Some("64") => Ok(64),
        Some(v) => Err(usage_error(&format!("--xlen must be 32 or 64, but found '{v}'"))),
    }
}

/// `--expect REG=VALUE` (repeatable), checked against the register width.
fn expect_checks(args: &Args, xlen: u32) -> Result<Vec<run::Check>, ExitCode> {
    let mut checks = Vec::new();
    for spec in args.values(&["--expect"]) {
        match run::parse_check(spec) {
            Ok(check) if check.fits(xlen) => checks.push(check),
            Ok(check) => {
                let hint = (xlen == 32).then_some("for a 64-bit value run with --xlen=64");
                return Err(usage_error_with(
                    &format!("--expect {spec}: {} does not fit in a {xlen}-bit register", check.text),
                    hint,
                    Some("riscvsim run --help shows --expect"),
                ));
            }
            Err((message, hint)) => {
                return Err(usage_error_with(&message, hint.as_deref(), Some("riscvsim run --help shows --expect")));
            }
        }
    }
    Ok(checks)
}

fn run_opts(args: &Args, path: String) -> Result<run::RunOpts, ExitCode> {
    let width = xlen(args)?;
    Ok(run::RunOpts {
        path,
        xlen: width,
        expect: expect_checks(args, width)?,
        verbose: args.has(&["--verbose", "-v"]),
        limit: step_limit(args)?,
        watch: match args.value(&["--watch"]) {
            None => None,
            Some(r) => match run::parse_register(r) {
                Some(n) => Some(n),
                None => {
                    return Err(usage_error_with(
                        &format!("--watch needs a register, but found '{r}'"),
                        Some("for example: riscvsim run prog.s --watch t0"),
                        Some("registers: x0 to x31, or names like t0, a0, sp"),
                    ))
                }
            },
        },
    })
}

fn cmd_run(args: &Args) -> ExitCode {
    let Some(path) = args.positionals.first().cloned() else {
        return usage_error_with(
            "run needs a file",
            Some("riscvsim run prog.s"),
            Some("no program yet? riscvsim demo runs a built-in sample"),
        );
    };
    if args.positionals.len() > 1 {
        return usage_error(&format!("run takes one file, but got {}", args.positionals.len()));
    }
    let opts = match run_opts(args, path) {
        Ok(o) => o,
        Err(code) => return code,
    };
    if args.has(&["--interactive", "-i"]) {
        return cmd_tui(args);
    }
    if args.has(&["--json"]) {
        return cmd_run_json(&opts);
    }
    run::cmd(opts)
}

fn cmd_demo(args: &Args) -> ExitCode {
    use lessons::{Pick, LESSONS};
    if args.has(&["--list"]) {
        for line in demo::menu(&Paint::new(), term::width()) {
            println!("{line}");
        }
        return ExitCode::SUCCESS;
    }
    if args.positionals.len() > 1 {
        return usage_error_with(
            &format!("demo takes one lesson, but got {}", args.positionals.len()),
            Some("for example: riscvsim demo 2"),
            Some("riscvsim demo --list shows the lessons"),
        );
    }
    let pick = args.positionals.first().map(String::as_str);
    let found = match pick {
        None => Some(Pick::Lesson(1)),
        Some(s) => lessons::find(s),
    };
    let Some(found) = found else {
        let pick = pick.unwrap_or("");
        let (message, hint) = match pick.trim().parse::<i64>() {
            Ok(_) => (format!("there is no lesson {pick}"), Some(format!("lessons are 1 to {}", LESSONS.len()))),
            Err(_) => (
                format!("there is no lesson called '{pick}'"),
                diag::closest(&pick.to_ascii_lowercase(), lessons::names()).map(|n| format!("did you mean '{n}'?")),
            ),
        };
        return usage_error_with(&message, hint.as_deref(), Some("riscvsim demo --list shows all six lessons"));
    };
    let (tour, sample) = match found {
        Pick::Lesson(n) => (demo::Tour::lesson(n), &LESSONS[n - 1].sample),
        Pick::Sample(i) => {
            let sample = &tui::samples::SAMPLES[i];
            (demo::Tour::new(i + 1, sample), sample)
        }
    };
    let mut opts = match run_opts(args, sample.file.to_string()) {
        Ok(o) => o,
        Err(code) => return code,
    };
    if sample.xlen == 64 {
        // An RV64 lesson always runs at 64 bits.
        opts.xlen = 64;
    }
    if args.has(&["--json"]) {
        return json_report(sample.source, &opts);
    }
    // The lesson, unless a run-style flag asks for the plain summary.
    let plain_run = args.flags.iter().any(|(f, _)| matches!(*f, "--verbose" | "-v" | "--xlen" | "--limit" | "--max-cycles" | "--summary"));
    if !plain_run {
        return demo::run(tour);
    }
    let code = run::cmd_source(sample.file, sample.source, &opts);
    if code == ExitCode::SUCCESS {
        let p = Paint::new();
        println!();
        let next = match found {
            Pick::Lesson(n) if n < LESSONS.len() => format!("Next: {}, or riscvsim tui to step through it", lessons::next_line(n)),
            Pick::Lesson(_) => "Next: riscvsim tui to step through your own program".to_string(),
            Pick::Sample(_) => "Next: riscvsim demo --list for the six lessons".to_string(),
        };
        println!("{}", p.gray(&next));
    }
    code
}

/// `riscvsim run <file> [--xlen=64] [--limit N] --json`: one JSON object with
/// the same shape the browser engine's `run_rv64` returns. Never colored.
fn cmd_run_json(opts: &run::RunOpts) -> ExitCode {
    let source = match run::read_source(&opts.path) {
        Ok(source) => source,
        Err(code) => return code,
    };
    json_report(&source, opts)
}

fn json_report(source: &str, opts: &run::RunOpts) -> ExitCode {
    let report = if opts.xlen == 64 {
        sim_engine::report::run64(source, opts.limit)
    } else {
        sim_engine::report::run32(source, opts.limit)
    };
    let assembled = !report.registers.is_empty();
    let mut checks_pass = None;
    match serde_json::to_string_pretty(&report) {
        Ok(json) if opts.expect.is_empty() || !assembled => println!("{json}"),
        Ok(json) => {
            let (expect, all) = expect_json(&opts.expect, &report.registers, opts.xlen);
            checks_pass = Some(all);
            println!("{}", with_expect(&json, &expect));
        }
        Err(error) => {
            let _ = error;
            eprintln!("error: could not format the result as JSON; please report this");
            return ExitCode::from(EXIT_RUNTIME);
        }
    }
    if let Some(all) = checks_pass {
        // Like the text output: the checks decide, a step limit still
        // compares, any other stop is a failure.
        let limited = report.message.starts_with("step limit reached");
        return if all && (report.ok || limited) { ExitCode::SUCCESS } else { ExitCode::from(EXIT_RUNTIME) };
    }
    if report.ok {
        ExitCode::SUCCESS
    } else if report.cycles == 0 && report.registers.is_empty() {
        ExitCode::from(EXIT_ASSEMBLY)
    } else {
        ExitCode::from(EXIT_RUNTIME)
    }
}

/// The `expect` array: one object per check with its result.
fn expect_json(checks: &[run::Check], registers: &[String], xlen: u32) -> (serde_json::Value, bool) {
    let mut all = true;
    let items = checks
        .iter()
        .map(|c| {
            let actual = registers
                .get(c.reg as usize)
                .and_then(|h| u64::from_str_radix(h.trim_start_matches("0x"), 16).ok())
                .unwrap_or(0);
            let pass = c.matches(actual, xlen);
            all &= pass;
            serde_json::json!({
                "register": c.name,
                "expected": c.text,
                "actual": c.show_actual(actual, xlen),
                "pass": pass,
            })
        })
        .collect();
    (serde_json::Value::Array(items), all)
}

/// The run result with `"expect": [...]` as its last field; every other
/// byte is exactly what `--json` prints without `--expect`.
fn with_expect(json: &str, expect: &serde_json::Value) -> String {
    let body = json.strip_suffix("\n}").unwrap_or(json);
    let list = serde_json::to_string_pretty(expect).unwrap_or_else(|_| "[]".into()).replace('\n', "\n  ");
    format!("{body},\n  \"expect\": {list}\n}}")
}

// ---------------------------------------------------------------------------
// translate
// ---------------------------------------------------------------------------

fn lang_label(lang: &str) -> &'static str {
    match lang.to_ascii_lowercase().as_str() {
        "rv32" | "asm" | "asm32" | "riscv" | "rv32im" => "RV32",
        "rv64" | "asm64" | "rv64im" => "RV64",
        "c" => "C",
        "cpp" | "c++" | "cxx" => "C++",
        "rust" | "rs" => "Rust",
        _ => "?",
    }
}

/// Count real instructions in generated assembly (no labels, directives,
/// comments or blank lines).
fn count_instructions(asm: &str) -> usize {
    let mut in_text = true;
    asm.lines()
        .map(|l| l.split('#').next().unwrap_or("").trim())
        .filter(|l| {
            if l.starts_with(".data") || l.starts_with(".rodata") || l.starts_with(".section") {
                in_text = false;
            } else if l.starts_with(".text") {
                in_text = true;
            }
            in_text && !l.is_empty() && !l.starts_with('.') && !l.ends_with(':')
        })
        .count()
}

fn subset_lists(lang: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match lang_label(lang) {
        "C" => ("C", sim_engine::C_SUBSET_SUPPORTED, sim_engine::C_SUBSET_UNSUPPORTED),
        "C++" => ("C++", sim_engine::CPP_SUBSET_SUPPORTED, sim_engine::CPP_SUBSET_UNSUPPORTED),
        "Rust" => ("Rust", sim_engine::RUST_SUBSET_SUPPORTED, sim_engine::RUST_SUBSET_UNSUPPORTED),
        _ => return None,
    })
}

fn print_subset(lang: &str) -> ExitCode {
    let Some((label, supported, unsupported)) = subset_lists(lang) else {
        return usage_error(&format!("--subset takes c, cpp or rust, but found '{lang}'"));
    };
    let p = Paint::new();
    let width = term::width().min(100);
    let bullet = p.sym("•", "-");
    let list = |title: String, items: &str| {
        println!("{title}");
        for item in items.split(" · ").map(str::trim).filter(|s| !s.is_empty()) {
            for (i, line) in term::wrap(item, width.saturating_sub(4)).iter().enumerate() {
                if i == 0 {
                    println!("  {bullet} {line}");
                } else {
                    println!("    {line}");
                }
            }
        }
    };
    list(p.bold(&format!("Supported {label}")), supported);
    println!();
    list(p.bold("Not supported yet"), unsupported);
    println!();
    println!("{}", p.gray(&format!("More: {DOCS_URL}#translation")));
    ExitCode::SUCCESS
}

fn cmd_translate(args: &Args) -> ExitCode {
    if let Some(lang) = args.value(&["--subset"]) {
        return print_subset(lang);
    }
    let (Some(from), Some(to)) = (args.value(&["--from"]), args.value(&["--to"])) else {
        return usage_error_with(
            "translate needs --from and --to",
            Some("riscvsim translate --from c --to rv64 prog.c"),
            Some("languages: rv32, rv64, c, cpp, rust"),
        );
    };
    let Some(path) = args.positionals.first() else {
        return usage_error_with(
            "translate needs an input file",
            Some(&format!("riscvsim translate --from {from} --to {to} <file>")),
            None,
        );
    };
    let source = match run::read_source(path) {
        Ok(source) => source,
        Err(code) => return code,
    };
    let e = Paint::stderr();
    if args.has(&["--annotate"]) {
        return translate_annotated(from, to, path, &source, args.value(&["-o", "--output"]));
    }
    match sim_engine::report::translate(from, to, &source) {
        Ok(output) => {
            let target = lang_label(to);
            let what = if matches!(target, "RV32" | "RV64") {
                run::plural(count_instructions(&output) as u64, "instruction")
            } else {
                run::plural(output.lines().count() as u64, "line")
            };
            let header = format!(
                "{} {} to {}, {what}",
                e.ok_mark(),
                lang_label(from),
                target
            );
            match args.value(&["-o", "--output"]) {
                Some(out_path) => {
                    if let Err(error) = std::fs::write(out_path, &output) {
                        eprintln!("{}{} could not write {out_path}: {}", e.error_bold("error"), e.bold(":"), io_reason(&error));
                        eprintln!("  {}", e.gray("check that the folder exists and you can write to it"));
                        return ExitCode::from(EXIT_RUNTIME);
                    }
                    eprintln!("{header} {} {out_path}", e.gray(e.sym("→", "->")));
                }
                None => {
                    if term::Stream::Stderr.is_tty() {
                        eprintln!("{header}");
                    }
                    print!("{output}");
                }
            }
            ExitCode::SUCCESS
        }
        Err((line, message)) => {
            if message.starts_with("unknown language") || message.starts_with("no translator") {
                let help = "languages: rv32, rv64, c, cpp, rust (riscvsim translate --help)";
                let code = if message.starts_with("unknown language") { EXIT_USAGE } else { EXIT_ASSEMBLY };
                eprintln!("{}{} {message}", e.error_bold("error"), e.bold(":"));
                eprintln!("  {}", e.gray(help));
                return ExitCode::from(code);
            }
            let mut d = diag::Diagnostic::from_engine(path, &source, line, &message);
            let lower = message.to_lowercase();
            let rejected = lower.contains("unsupported") || lower.contains("not supported") || lower.contains("not yet");
            if rejected && d.help.is_none() {
                if subset_lists(from).is_some() {
                    d.help = Some(format!(
                        "see what is supported: riscvsim translate --subset {} or {DOCS_URL}#translation",
                        from.to_ascii_lowercase()
                    ));
                }
            }
            eprint!("{}", d.render(&e, term::width()));
            ExitCode::from(EXIT_ASSEMBLY)
        }
    }
}

/// Lay out annotated assembly: each source line as a comment, then the
/// instructions it became. Still valid assembly (the comments start with #).
fn render_annotated(lines: &[sim_engine::AsmLine], source: &str, p: &Paint) -> String {
    let src: Vec<&str> = source.lines().collect();
    let width = src.len().max(1).to_string().len();
    let mut out = String::new();
    let mut shown: Option<usize> = None;
    for line in lines {
        if let Some(n) = line.source_line {
            if shown != Some(n) {
                let text = src.get(n - 1).map(|t| t.trim()).unwrap_or("");
                let last_blank = out.trim_end_matches('\n').rsplit('\n').next().is_some_and(|l| l.trim().is_empty());
                if !out.is_empty() && !out.ends_with("\n\n") && !last_blank {
                    out.push('\n');
                }
                out.push_str(&p.gray(&format!("# {n:>width$} | {text}")));
                out.push('\n');
                shown = Some(n);
            }
        } else if shown.is_some() {
            shown = None;
            out.push('\n');
        }
        out.push_str(&line.text);
        out.push('\n');
    }
    out
}

fn translate_annotated(from: &str, to: &str, path: &str, source: &str, out_path: Option<&str>) -> ExitCode {
    let from_key = match lang_label(from) {
        "C" => "c",
        "C++" => "cpp",
        _ => {
            return usage_error_with(
                &format!("--annotate works when translating C or C++ to assembly, not {}", lang_label(from)),
                Some(&format!("riscvsim translate --from c --to {to} {path} --annotate")),
                None,
            )
        }
    };
    let xlen = match lang_label(to) {
        "RV32" => 32,
        "RV64" => 64,
        _ => {
            return usage_error_with(
                "--annotate needs an assembly target: --to rv32 or --to rv64",
                Some(&format!("riscvsim translate --from {from} --to rv32 {path} --annotate")),
                None,
            )
        }
    };
    let e = Paint::stderr();
    match sim_engine::translate_annotated(from_key, xlen, source) {
        Ok(lines) => {
            let count = lines
                .iter()
                .map(|l| l.text.split('#').next().unwrap_or("").trim())
                .filter(|t| !t.is_empty() && !t.starts_with('.') && !t.ends_with(':'))
                .count();
            let header = format!(
                "{} {} to {}, {}, annotated",
                e.ok_mark(),
                lang_label(from),
                lang_label(to),
                run::plural(count as u64, "instruction")
            );
            match out_path {
                Some(out_path) => {
                    let text = render_annotated(&lines, source, &Paint::fixed(false, true));
                    if let Err(error) = std::fs::write(out_path, text) {
                        eprintln!("{}{} could not write {out_path}: {}", e.error_bold("error"), e.bold(":"), io_reason(&error));
                        return ExitCode::from(EXIT_RUNTIME);
                    }
                    eprintln!("{header} {} {out_path}", e.gray(e.sym("→", "->")));
                }
                None => {
                    if term::Stream::Stderr.is_tty() {
                        eprintln!("{header}");
                    }
                    print!("{}", render_annotated(&lines, source, &Paint::new()));
                }
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            let d = diag::Diagnostic::from_engine(path, source, error.line, &error.message);
            eprint!("{}", d.render(&e, term::width()));
            ExitCode::from(EXIT_ASSEMBLY)
        }
    }
}

/// A file error in plain words, without Rust's "(os error N)" suffix.
pub fn io_reason(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "the folder does not exist".into(),
        std::io::ErrorKind::PermissionDenied => "permission denied".into(),
        _ => {
            let text = error.to_string();
            text.split(" (os error").next().unwrap_or(&text).to_string()
        }
    }
}

// ---------------------------------------------------------------------------
// tui / serve
// ---------------------------------------------------------------------------

fn cmd_tui(args: &Args) -> ExitCode {
    let file = args.positionals.first().map(std::path::PathBuf::from);
    let force_tour = args.has(&["--tour"]);
    let xlen = match xlen(args) {
        Ok(x) => x,
        Err(code) => return code,
    };
    match tui::run(tui::Opts { file, force_tour, xlen }) {
        // The session ended with /serve: the terminal is back to normal, so
        // hand the loaded program to the same server `riscvsim serve` uses.
        Ok(Some(request)) => serve_program(request.source, &request.file_name, request.port, request.xlen),
        Ok(None) => ExitCode::SUCCESS,
        Err(message) => {
            let p = Paint::stderr();
            eprintln!("{}{} {message}", p.error_bold("error"), p.bold(":"));
            ExitCode::from(EXIT_RUNTIME)
        }
    }
}

/// Assemble in-memory source and serve it. Shared by `riscvsim serve <file>`
/// and the interactive session's `/serve`.
fn serve_program(source: String, label: &str, port: Option<u16>, xlen: u32) -> ExitCode {
    let opts = server::ServeOpts { port, open: browser_allowed(false), verbose: false };
    serve_with(source, label, &opts, xlen)
}

/// Open a browser only for a person at a real terminal.
fn browser_allowed(no_open: bool) -> bool {
    !no_open
        && term::Stream::Stdout.is_tty()
        && std::env::var_os("RISCVSIM_NO_OPEN").is_none()
        && !std::env::var("TERM").is_ok_and(|t| t == "dumb")
}

/// Assemble and serve. `xlen` is 64 for `--xlen=64`; a program whose first
/// line is `# xlen=64` is RV64 too, the browser simulator's own rule. An
/// RV64 program reaches the page with that marker line on top (the file on
/// disk is not changed), so the page shows it as RV64.
fn serve_with(source: String, label: &str, opts: &server::ServeOpts, xlen: u32) -> ExitCode {
    let paint = Paint::new();
    let xlen = if server::has_xlen_marker(&source) { 64 } else { xlen };
    // Assemble what the page will show, so listing lines match its editor.
    let shown = server::page_source(&source, xlen);
    let sim = if xlen == 64 {
        match sim_engine::assemble64(&shown) {
            Ok(program) => server::Sim::Rv64(Box::new(sim_engine::Pipeline64::new(program))),
            Err(errors) => {
                let errs: Vec<_> = errors.into_iter().map(|e| (e.line, e.message)).collect();
                run::print_diagnostics(label, &shown, &errs);
                return ExitCode::from(EXIT_ASSEMBLY);
            }
        }
    } else {
        match assemble(&shown) {
            Ok(program) => server::Sim::Rv32(Box::new(Pipeline::new(program))),
            Err(errors) => {
                let errs: Vec<_> = errors.into_iter().map(|e| (e.line, e.message)).collect();
                run::print_diagnostics(label, &shown, &errs);
                return ExitCode::from(EXIT_ASSEMBLY);
            }
        }
    };
    match server::serve(shown, sim, label, opts, paint) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let (what, next) = error.explain();
            let p = Paint::stderr();
            eprintln!("{}{} {what}", p.error_bold("error"), p.bold(":"));
            eprintln!("  {} {}", p.info_bold(p.sym("→", "->")), p.info_bold(&next));
            ExitCode::from(EXIT_RUNTIME)
        }
    }
}

fn cmd_completions(args: &Args) -> ExitCode {
    let Some(shell) = args.positionals.first().map(String::as_str) else {
        return usage_error_with(
            "completions needs a shell: bash, zsh or fish",
            Some("riscvsim completions zsh > ~/.zfunc/_riscvsim"),
            None,
        );
    };
    let cmds: Vec<completions::Cmd> = CLI
        .iter()
        .map(|c| completions::Cmd {
            name: c.name,
            about: c.about,
            flags: c.flags.iter().map(|(f, takes)| (*f, *takes, flag_values(f))).collect(),
            operand: match c.operand {
                Operand::None => "",
                Operand::File => "file",
                Operand::Sample => "sample",
                Operand::Shell => "shell",
            },
        })
        .collect();
    // `riscvsim demo <TAB>`: lesson numbers, then lesson and sample names.
    const NUMBERS: [&str; 9] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
    let mut samples: Vec<&str> = NUMBERS[..lessons::LESSONS.len().min(NUMBERS.len())].to_vec();
    samples.extend(lessons::names());
    let script = match shell {
        "bash" => completions::bash(&cmds, &samples),
        "zsh" => completions::zsh(&cmds, &samples),
        "fish" => completions::fish(&cmds, &samples),
        other => {
            let hint = diag::closest(other, completions::SHELLS.iter().copied()).map(|s| format!("did you mean '{s}'?"));
            return usage_error_with(
                &format!("riscvsim has completions for bash, zsh and fish, not '{other}'"),
                hint.as_deref(),
                None,
            );
        }
    };
    print!("{script}");
    ExitCode::SUCCESS
}

fn cmd_serve(args: &Args) -> ExitCode {
    if args.positionals.len() > 1 {
        return usage_error(&format!("serve takes one file, but got {}", args.positionals.len()));
    }
    let port = match args.value(&["--port"]) {
        None => None,
        Some(v) => match v.parse::<u16>() {
            Ok(n) if n > 0 => Some(n),
            _ => return usage_error(&format!("--port must be a number from 1 to 65535, but found '{v}'")),
        },
    };
    let xlen = match xlen(args) {
        Ok(x) => x,
        Err(code) => return code,
    };
    let opts = server::ServeOpts {
        port,
        open: browser_allowed(args.has(&["--no-open"])),
        verbose: args.has(&["--verbose", "-v"]),
    };
    // No file: serve a built-in sample so `riscvsim serve` just works (the
    // 64-bit one for --xlen=64, as in riscvsim tui).
    let Some(path) = args.positionals.first() else {
        let sample = if xlen == 64 { &tui::samples::RV64_SAMPLE } else { &tui::samples::SAMPLES[0] };
        return serve_with(sample.source.to_string(), sample.file, &opts, xlen);
    };
    let source = match run::read_source(path) {
        Ok(s) => s,
        Err(code) => return code,
    };
    let label = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    serve_with(source, &label, &opts, xlen)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_and_home_fit_80_columns_and_have_examples() {
        let p = Paint::fixed(false, true);
        for (name, text) in [
            ("home", home_text(&p)),
            ("help", help_text(&p)),
            ("run", run_help(&p)),
            ("demo", demo_help(&p)),
            ("tui", tui_help(&p)),
            ("serve", serve_help(&p)),
            ("translate", translate_help(&p)),
            ("doctor", doctor_help(&p)),
            ("completions", completions_help(&p)),
        ] {
            for line in text.lines() {
                assert!(line.chars().count() <= 80, "{name}: {line}");
            }
            assert!(text.contains("riscvsim "), "{name}");
            if name != "home" {
                assert!(text.contains("Examples"), "{name} help needs examples");
            }
        }
        // the home screen is short: what it is, three commands, where to get help
        assert!(home_text(&p).lines().count() <= 12);
    }

    #[test]
    fn completions_cover_every_command_and_flag() {
        let cmds: Vec<completions::Cmd> = CLI
            .iter()
            .map(|c| completions::Cmd {
                name: c.name,
                about: c.about,
                flags: c.flags.iter().map(|(f, t)| (*f, *t, flag_values(f))).collect(),
                operand: "file",
            })
            .collect();
        for script in [completions::bash(&cmds, &[]), completions::zsh(&cmds, &[]), completions::fish(&cmds, &[])] {
            for c in CLI {
                assert!(script.contains(c.name), "{}", c.name);
                for (flag, _) in c.flags {
                    let fish_form = flag.trim_start_matches('-');
                    assert!(script.contains(flag) || script.contains(fish_form), "{flag}");
                }
            }
        }
        // Every table command is a word the did-you-mean knows.
        for c in CLI {
            assert!(command_words().any(|w| w == c.name));
        }
    }

    #[test]
    fn version_line_starts_with_name_and_number() {
        let line = version_line(&Paint::fixed(false, true));
        assert_eq!(line, format!("riscvsim {VERSION} · RV32IM and RV64IM · translates a subset of C, C++ and Rust"));
        assert!(line.chars().count() <= 78);
        assert!(version_line(&Paint::fixed(false, false)).is_ascii());
    }

    #[test]
    fn help_and_version_snapshots_say_subset() {
        for (name, color) in [("nocolor", false), ("color", true)] {
            let p = Paint::fixed(color, true);
            let mark = |t: String| if color { crate::snapshots::mark_ansi(&t) } else { t };
            crate::snapshots::check(&format!("help.{name}"), &mark(help_text(&p)));
            crate::snapshots::check(&format!("version.{name}"), &mark(version_line(&p)));
            crate::snapshots::check(&format!("help.translate.{name}"), &mark(translate_help(&p)));
        }
        let plain = Paint::fixed(false, true);
        assert!(help_text(&plain).contains("a documented subset of C, C++ and Rust"));
        assert!(translate_help(&plain).contains("--subset LANG lists exactly what it accepts"));
    }

    #[test]
    fn unknown_command_lists_every_dispatchable_command() {
        let (message, hint, help) = unknown_command_parts("completion");
        assert_eq!(message, "unknown command 'completion'");
        assert_eq!(hint.as_deref(), Some("did you mean 'riscvsim completions'?"));
        let cmds: Vec<completions::Cmd> = CLI
            .iter()
            .map(|c| completions::Cmd { name: c.name, about: c.about, flags: vec![], operand: "" })
            .collect();
        let scripts = [completions::bash(&cmds, &[]), completions::zsh(&cmds, &[]), completions::fish(&cmds, &[])];
        for c in CLI {
            // the dispatcher finds it, the error lists it, completion offers it
            assert!(find_command(c.name).is_some());
            assert!(help.contains(c.name), "{} missing from: {help}", c.name);
            for script in &scripts {
                assert!(script.contains(c.name), "{} missing from completions", c.name);
            }
        }
        assert_eq!(help, "commands: run, demo, tui, translate, serve, doctor, completions\nriscvsim --help for more");
        for (name, color) in [("nocolor", false), ("color", true)] {
            let p = Paint::fixed(color, true);
            let text = usage_text(&p, &message, hint.as_deref(), Some(&help));
            for line in text.lines() {
                assert!(term::visible_width(line) <= 78, "{line}");
            }
            let text = if color { crate::snapshots::mark_ansi(&text) } else { text };
            crate::snapshots::check(&format!("error.unknown-command.{name}"), &text);
        }
    }

    #[test]
    fn counts_only_instructions() {
        let asm = "# c\n    call main\n    ecall\n\nmain:\n    li a0, 1\n    ret\n.data\nx: .word 1\n";
        assert_eq!(count_instructions(asm), 4);
    }

    #[test]
    fn unknown_flag_parse_fails() {
        let args: Vec<String> = vec!["a.s".into(), "--verbos".into()];
        assert!(parse_args("run", &args, RUN_FLAGS).is_err());
        let args: Vec<String> = vec!["a.s".into(), "--xlen=64".into(), "--limit".into(), "9".into()];
        let a = parse_args("run", &args, RUN_FLAGS).ok().unwrap();
        assert_eq!(a.value(&["--xlen"]), Some("64"));
        assert_eq!(a.value(&["--limit"]), Some("9"));
        assert_eq!(a.positionals, vec!["a.s".to_string()]);
    }
}

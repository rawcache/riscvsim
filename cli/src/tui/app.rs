//! TUI application state and update logic (no rendering here).

use super::samples::SAMPLES;
use ratatui::crossterm::event::{
    KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::{Position, Rect};
use crate::machine::{Machine, Snap as Snapshot, StageState};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const DATA_BASE: u64 = sim_engine::DATA_BASE as u64;

/// Cycles per second, matching the browser simulator's speed slider.
pub const SPEEDS: &[Speed] = &[
    Speed::Cps(1),
    Speed::Cps(2),
    Speed::Cps(5),
    Speed::Cps(10),
    Speed::Cps(30),
    Speed::Cps(60),
    Speed::Max,
];
pub const DEFAULT_SPEED_IDX: usize = 3; // 10 cyc/s

/// Cycles stepped per frame when the speed slider is at MAX.
const MAX_CHUNK: u32 = 2000;

pub const REG_FLASH_MS: u64 = 500;
pub const STAGE_PULSE_MS: u64 = 180;
pub const FWD_TRAVEL_MS: u64 = 380;
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Speed {
    Cps(u32),
    Max,
}

impl Speed {
    pub fn label(self) -> String {
        match self {
            Speed::Cps(n) => format!("{n} cyc/s"),
            Speed::Max => "MAX".to_string(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Pipeline,
    State,
}

/// Every clickable thing on screen. Rebuilt as hit regions each frame.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Act {
    Assemble,
    Step,
    Back,
    RunPause,
    Reset,
    TabPipeline,
    TabState,
    SpeedTrack,
    SampleToggle,
    Sample(usize),
    MemData,
    MemStack,
    MemPrev,
    MemNext,
    RegFmt,
    TourNext,
    TourSkip,
    TrustYes,
    TrustNo,
    Help,
    Quit,
}

pub struct Hit {
    pub rect: Rect,
    pub act: Act,
}

/// Terminal capabilities, detected once at startup.
#[derive(Clone, Copy)]
pub struct Caps {
    pub color: bool,
    pub unicode: bool,
}

impl Caps {
    pub fn detect() -> Self {
        let no_color = std::env::var_os("NO_COLOR").is_some();
        let unicode = if cfg!(windows) {
            true
        } else {
            ["LC_ALL", "LC_CTYPE", "LANG"]
                .iter()
                .filter_map(|k| std::env::var(k).ok())
                .find(|v| !v.is_empty())
                .map(|v| {
                    let v = v.to_ascii_lowercase();
                    v.contains("utf-8") || v.contains("utf8")
                })
                .unwrap_or(false)
        };
        Self {
            color: !no_color,
            unicode,
        }
    }
}

pub struct LogEntry {
    /// "cmd" | "status" | "success" | "error" | "instr"
    pub kind: &'static str,
    pub text: String,
}

/// A forwarded value traveling between pipeline stages.
pub struct FwdAnim {
    /// "exmem" or "memwb"
    pub from: &'static str,
    pub reg: String,
    pub value: u64,
    pub started: Instant,
}

#[derive(Default)]
pub struct Anims {
    /// reg index -> when it was written (green flash, fades out).
    pub reg_flash: Vec<(u8, Instant)>,
    /// Border pulse when a new instruction enters a stage.
    pub stage_pulse: [Option<Instant>; 5],
    stage_prev: [Option<u64>; 5],
    pub forwards: Vec<FwdAnim>,
}

impl Anims {
    fn note_snapshot(&mut self, snap: &Snapshot, animate: bool) {
        let now = Instant::now();
        for (i, st) in snap.stages.iter().enumerate().take(5) {
            let pc = if st.state == StageState::Normal {
                st.pc
            } else {
                None
            };
            if animate && pc.is_some() && pc != self.stage_prev[i] {
                self.stage_pulse[i] = Some(now);
            }
            self.stage_prev[i] = pc;
        }
        if animate {
            self.forwards = snap
                .view
                .forwards
                .iter()
                .map(|f| FwdAnim {
                    from: if f.from == "exmem" { "exmem" } else { "memwb" },
                    reg: f.reg.clone(),
                    value: f.value,
                    started: now,
                })
                .collect();
            self.reg_flash = snap.view.reg_writes.iter().map(|w| (w.reg, now)).collect();
        } else {
            self.forwards.clear();
            self.reg_flash.clear();
        }
    }

    fn clear(&mut self) {
        *self = Anims::default();
    }

    pub fn active(&self) -> bool {
        let now = Instant::now();
        let within = |t: Instant, ms: u64| now.duration_since(t).as_millis() < ms as u128;
        self.reg_flash.iter().any(|(_, t)| within(*t, REG_FLASH_MS))
            || self
                .stage_pulse
                .iter()
                .flatten()
                .any(|t| within(*t, STAGE_PULSE_MS))
            || self
                .forwards
                .iter()
                .any(|f| within(f.started, FWD_TRAVEL_MS + 150))
    }
}

/// Startup phases, in order: the trust check (only when loading a file from
/// a directory the user hasn't confirmed before), the welcome screen, then
/// the simulator itself.
pub enum Gate {
    Trust { selected: usize }, // 0 = yes, 1 = no/exit
    Welcome,
    Done,
}

pub struct Tour {
    pub step: usize,
}

/// `/serve` hands the loaded program back to `main`, which starts the real
/// server once the alternate screen is torn down — the same `server::serve`
/// path `riscvsim serve <file>` takes, not a second copy of it.
pub struct ServeRequest {
    pub source: String,
    pub file_name: String,
    pub port: Option<u16>,
}

pub const TOUR_STEPS: &[(&str, &str)] = &[
    (
        "Your program",
        "The source panel shows your assembly with the executing line \
highlighted. Edit the file in your editor, then press [a] Assemble to \
reload it — or pick a built-in sample from the bar below.",
    ),
    (
        "Run it",
        "Run plays the whole program at the speed on the slider. Step \
advances one clock cycle at a time (arrow keys work too), and Back \
rewinds a cycle.",
    ),
    (
        "Watch the pipeline",
        "Instructions move left to right through five stages. Green chips \
are values being forwarded between instructions, yellow is a stall, red \
is a flushed wrong-path instruction. The tabs switch to registers and \
memory.",
    ),
];

pub struct App {
    pub caps: Caps,
    pub file_path: Option<PathBuf>,
    pub file_name: String,
    pub source: String,
    pub pipeline: Option<Machine>,
    pub snap: Option<Snapshot>,
    /// Register width: 32, or 64 for `--xlen=64` and RV64 samples.
    pub xlen: u32,
    /// (addr, text) rows of the assembled program.
    pub listing: Vec<(u64, String)>,
    pub log: Vec<LogEntry>,
    log_seen: u64,
    pub tab: Tab,
    pub running: bool,
    next_step_due: Option<Instant>,
    pub speed_idx: usize,
    /// Speed to return to when fast mode (f) is switched off.
    pub speed_before_fast: Option<usize>,
    /// Source line numbers (1-based) where a run pauses before fetching.
    pub breakpoints: std::collections::BTreeSet<usize>,
    /// The selected source line (moved with up/down or j/k), 1-based.
    pub src_sel: Option<usize>,
    pub status: (String, &'static str), // text, "plain" | "ok" | "err"
    pub reg_hex: bool,
    pub mem_addr: u64,
    /// Manual scroll offset for the source panel; None = follow execution.
    pub src_scroll: Option<u16>,
    pub anims: Anims,
    pub gate: Gate,
    /// Shared background release state used by the welcome, footer, and commands.
    pub update_status: crate::update::StatusSlot,
    pub install_method: crate::doctor::InstallMethod,
    pub working_dir: String,
    last_update_check: Instant,
    pub command_input: String,
    pub prompt_active: bool,
    /// Earlier prompt entries, oldest first, and the one being recalled.
    pub history: Vec<String>,
    pub history_pos: Option<usize>,
    /// Directory to remember as trusted once confirmed.
    pub trust_key: Option<String>,
    pub tour: Option<Tour>,
    /// Set by the renderer after at least one walkthrough frame reaches the terminal.
    pub tour_shown: bool,
    pub menu_open: bool,
    pub menu_sel: usize,
    pub help_open: bool,
    pub hits: Vec<Hit>,
    pub pressed: Option<Act>,
    pub hover: Option<Act>,
    /// Track rect of the speed slider, for click/drag position mapping.
    pub speed_track: Rect,
    /// Panel rects the walkthrough spotlights (recorded during draw).
    pub rect_source: Rect,
    pub rect_pipeline: Rect,
    pub rect_run_btn: Rect,
    pub rect_terminal: Rect,
    pub quit: bool,
    /// Set by /serve: quit the TUI, then serve this program from main.
    pub serve_request: Option<ServeRequest>,
}

impl App {
    pub fn new(
        file_path: Option<PathBuf>,
        source: String,
        file_name: String,
        show_tour: bool,
        trust_key: Option<String>,
        update_status: crate::update::StatusSlot,
        install_method: crate::doctor::InstallMethod,
    ) -> Self {
        Self {
            caps: Caps::detect(),
            file_path,
            file_name,
            source,
            pipeline: None,
            snap: None,
            xlen: 32,
            listing: Vec::new(),
            log: Vec::new(),
            log_seen: 0,
            tab: Tab::Pipeline,
            running: false,
            next_step_due: None,
            speed_idx: DEFAULT_SPEED_IDX,
            speed_before_fast: None,
            breakpoints: std::collections::BTreeSet::new(),
            src_sel: None,
            status: (String::new(), "plain"),
            reg_hex: true,
            mem_addr: DATA_BASE,
            src_scroll: None,
            anims: Anims::default(),
            gate: if trust_key.is_some() {
                Gate::Trust { selected: 0 }
            } else if show_tour {
                Gate::Done
            } else {
                Gate::Welcome
            },
            update_status,
            install_method,
            working_dir: std::env::current_dir()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|_| "working directory unavailable".into()),
            last_update_check: Instant::now(),
            command_input: String::new(),
            history: Vec::new(),
            history_pos: None,
            prompt_active: !show_tour,
            trust_key,
            tour: if show_tour {
                Some(Tour { step: 0 })
            } else {
                None
            },
            tour_shown: false,
            menu_open: false,
            menu_sel: 0,
            help_open: false,
            hits: Vec::new(),
            pressed: None,
            hover: None,
            speed_track: Rect::default(),
            rect_source: Rect::default(),
            rect_pipeline: Rect::default(),
            rect_run_btn: Rect::default(),
            rect_terminal: Rect::default(),
            quit: false,
            serve_request: None,
        }
    }

    pub fn speed(&self) -> Speed {
        SPEEDS[self.speed_idx]
    }

    fn push_log(&mut self, kind: &'static str, text: String, _instant: bool) {
        self.log.push(LogEntry { kind, text });
        if self.log.len() > 500 {
            self.log.drain(..self.log.len() - 500);
        }
    }

    fn set_status(&mut self, text: impl Into<String>, tone: &'static str) {
        self.status = (text.into(), tone);
    }

    /// First assemble at launch: logs the invocation like a shell session.
    pub fn boot(&mut self) {
        let cmd = self.command_line(&self.file_name);
        self.push_log("cmd", cmd, true);
        self.assemble(false);
    }

    /// (Re)assemble. `reload` re-reads the file from disk first so the
    /// edit-in-your-editor / assemble-in-the-TUI loop works.
    pub fn assemble(&mut self, reload: bool) {
        self.stop_running();
        if reload {
            if let Some(path) = &self.file_path {
                match std::fs::read_to_string(path) {
                    Ok(s) => self.source = s,
                    Err(e) => {
                        let msg = format!("✗ could not re-read {}: {}", self.file_name, crate::io_reason(&e));
                        self.push_log("error", msg.clone(), false);
                        self.set_status(msg, "err");
                        return;
                    }
                }
            }
        }
        self.push_log("status", format!("Loading {}...", self.file_name), false);
        self.push_log("status", "Assembling program...".into(), false);
        match crate::machine::build(&self.source, self.xlen) {
            Ok(built) => {
                self.listing = built.listing;
                let n = self.listing.len();
                let pipeline = built.machine;
                self.log_seen = 0;
                self.snap = Some(pipeline.snapshot());
                self.pipeline = Some(pipeline);
                self.anims.clear();
                self.src_scroll = None;
                self.push_log("success", format!("✓ assembled {n} instructions"), false);
                self.set_status(
                    format!("✓ assembled {n} instructions (press Run or Step)"),
                    "ok",
                );
            }
            Err(errors) => {
                self.pipeline = None;
                self.snap = None;
                self.listing.clear();
                for err in errors.iter().take(8) {
                    self.push_log(
                        "error",
                        format!("✗ line {}: {}", err.0, err.1),
                        false,
                    );
                }
                self.push_log(
                    "status",
                    "fix the line above and press Assemble again".into(),
                    false,
                );
                let first = &errors[0];
                self.set_status(format!("✗ line {}: {}", first.0, first.1), "err");
            }
        }
    }

    fn refresh_snapshot(&mut self, animate: bool) {
        let Some(p) = &self.pipeline else { return };
        let snap = p.snapshot();
        let lines: Vec<(&'static str, String, u64)> = p
            .log_since(self.log_seen)
            .into_iter()
            .map(|l| (l.kind, l.text, l.seq))
            .collect();
        for (kind, text, seq) in lines {
            // Retired-instruction lines stream in while the simulator runs.
            self.push_log(kind, text, kind == "instr");
            self.log_seen = seq + 1;
        }
        self.anims.note_snapshot(&snap, animate);
        if snap.halted {
            self.stop_running();
            if let Some(halt) = &snap.halt {
                if halt.kind == "complete" {
                    self.set_status(format!("✓ {}", halt.message), "ok");
                } else {
                    self.set_status(format!("✗ {}", halt.message), "err");
                }
            }
        } else if snap.cycle > 0 {
            self.set_status(
                format!("cycle {}, pc {}", snap.cycle, crate::machine::addr(snap.pc)),
                "plain",
            );
        }
        self.src_scroll = None; // re-follow execution after every step
        self.snap = Some(snap);
    }

    pub fn assembled(&self) -> bool {
        self.pipeline.is_some()
    }

    pub fn halted(&self) -> bool {
        self.snap.as_ref().map(|s| s.halted).unwrap_or(false)
    }

    pub fn can_step_back(&self) -> bool {
        self.snap.as_ref().map(|s| s.can_step_back).unwrap_or(false)
    }

    pub fn step(&mut self, cycles: u32, animate: bool) {
        let Some(p) = &mut self.pipeline else { return };
        if p.halted() {
            return;
        }
        let mut hit: Option<usize> = None;
        for _ in 0..cycles {
            if p.halted() {
                break;
            }
            let before = p.fetch_pc();
            p.step_cycle();
            if self.running && !self.breakpoints.is_empty() {
                let pc = p.fetch_pc();
                if pc != before {
                    if let Some(line) = p.line_at(pc) {
                        if self.breakpoints.contains(&line) {
                            hit = Some(line);
                            break;
                        }
                    }
                }
            }
        }
        self.refresh_snapshot(animate);
        if let Some(line) = hit {
            self.stop_running();
            self.set_status(format!("paused at the breakpoint on line {line}; space continues"), "plain");
        }
    }

    /// Toggle a breakpoint on the selected line (or the executing line).
    pub fn toggle_breakpoint(&mut self) {
        let line = self.src_sel.or_else(|| self.exec_line()).unwrap_or(1);
        let text = self.source.lines().nth(line.saturating_sub(1)).unwrap_or("").trim().to_string();
        if self.breakpoints.remove(&line) {
            self.set_status(format!("breakpoint removed from line {line}"), "plain");
        } else if text.is_empty() || text.starts_with('#') || text.starts_with('.') || text.ends_with(':') {
            self.set_status(format!("line {line} has no instruction; pick a line with one"), "err");
        } else {
            self.breakpoints.insert(line);
            self.set_status(format!("breakpoint on line {line}: a run pauses before it"), "ok");
        }
    }

    /// The source line of the instruction in EX, if any.
    pub fn exec_line(&self) -> Option<usize> {
        self.snap.as_ref().and_then(|s| {
            s.stages
                .iter()
                .find(|st| st.name == "EX" && st.state == StageState::Normal)
                .and_then(|st| st.line)
        })
    }

    /// Move the source selection by `delta` lines.
    pub fn move_selection(&mut self, delta: isize) {
        let total = self.source.lines().count().max(1);
        let from = self.src_sel.or_else(|| self.exec_line()).unwrap_or(1) as isize;
        self.src_sel = Some((from + delta).clamp(1, total as isize) as usize);
    }

    pub fn faster(&mut self) {
        self.speed_before_fast = None;
        self.speed_idx = (self.speed_idx + 1).min(SPEEDS.len() - 1);
    }

    pub fn slower(&mut self) {
        self.speed_before_fast = None;
        self.speed_idx = self.speed_idx.saturating_sub(1);
    }

    /// Fast mode: run at full speed with no animation, or go back.
    pub fn toggle_fast(&mut self) {
        match self.speed_before_fast.take() {
            Some(prev) => {
                self.speed_idx = prev;
                self.set_status(format!("fast mode off, {}", SPEEDS[prev].label()), "plain");
            }
            None => {
                self.speed_before_fast = Some(self.speed_idx);
                self.speed_idx = SPEEDS.len() - 1;
                self.set_status("fast mode: full speed, no animation (f again to slow down)", "plain");
            }
        }
    }

    pub fn step_back(&mut self) {
        self.stop_running();
        let Some(p) = &mut self.pipeline else { return };
        if p.step_back() {
            // Rewinding removes log lines; clamp our cursor.
            self.log_seen = self.log_seen.min(p.log_seq());
            self.refresh_snapshot(false);
            let snap = self.snap.as_ref().unwrap();
            self.set_status(
                format!("rewound to cycle {}, pc {}", snap.cycle, crate::machine::addr(snap.pc)),
                "plain",
            );
        }
    }

    pub fn reset(&mut self) {
        self.stop_running();
        let Some(p) = &mut self.pipeline else { return };
        p.reset();
        self.log_seen = 0;
        self.anims.clear();
        self.refresh_snapshot(false);
        self.set_status("reset, ready", "plain");
    }

    pub fn toggle_run(&mut self) {
        if !self.assembled() || self.halted() {
            return;
        }
        if self.running {
            self.stop_running();
        } else {
            self.running = true;
            self.next_step_due = Some(Instant::now());
        }
    }

    fn stop_running(&mut self) {
        self.running = false;
        self.next_step_due = None;
    }

    /// How this session would be started from a shell, for the log.
    fn command_line(&self, file: &str) -> String {
        if self.xlen == 64 {
            format!("riscvsim tui --xlen=64 {file}")
        } else {
            format!("riscvsim tui {file}")
        }
    }

    pub fn load_sample(&mut self, idx: usize) {
        let Some(sample) = SAMPLES.get(idx) else {
            return;
        };
        self.stop_running();
        self.file_path = None;
        self.file_name = sample.file.to_string();
        self.source = sample.source.to_string();
        self.xlen = sample.xlen;
        let cmd = self.command_line(sample.file);
        self.push_log("cmd", cmd, true);
        self.assemble(false);
    }

    fn load_path(&mut self, path: &str, run: bool) {
        let path = PathBuf::from(path);
        match std::fs::read_to_string(&path) {
            Ok(source) => {
                self.stop_running();
                self.file_name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.display().to_string());
                self.file_path = Some(path);
                self.source = source;
                self.assemble(false);
                if run && self.assembled() && !self.halted() {
                    self.toggle_run();
                }
            }
            Err(error) => {
                let message = format!("could not read {path}: {error}", path = path.display());
                self.push_log("error", message.clone(), true);
                self.set_status(message, "err");
            }
        }
    }

    fn execute_command(&mut self, input: String) {
        let input = input.trim();
        if input.is_empty() {
            return;
        }
        self.push_log("cmd", input.to_string(), true);
        if !input.starts_with('/') {
            // Plain input is treated as assembly source. It replaces the
            // editor buffer, assembles, and starts animated execution.
            self.stop_running();
            self.file_path = None;
            self.file_name = "repl.s".into();
            self.source = format!("{input}\n");
            self.assemble(false);
            if self.assembled() && !self.halted() {
                self.toggle_run();
            }
            return;
        }

        let mut parts = input[1..].split_whitespace();
        let command = parts.next().unwrap_or_default();
        let arguments = parts.collect::<Vec<_>>().join(" ");
        match command {
            "help" => {
                for line in [
                    "/help          list slash commands",
                    "/doctor        inspect versions, PATH copies, and update instructions",
                    "/run <file>    load and run an assembly file",
                    "/demo [n]      load a built-in sample program and run it",
                    "/serve [--port N]  open the loaded program in the browser UI",
                    "/reset         reset the loaded program",
                    "/version       show installed and latest versions",
                    "/examples      show the sample-program walkthrough",
                    "/exit          leave the session (also /quit)",
                    "",
                    "Examples:",
                    "  /demo 2              the load-use stall sample",
                    "  /run add.s           load and run your file",
                    "  addi x1, x0, 5       type an instruction to run it",
                    "  /serve --port 8080   continue in the browser",
                    "Up and Down recall earlier commands.",
                    "plain input    assemble and run it as RISC-V source",
                ] {
                    self.push_log("status", line.into(), true);
                }
            }
            "doctor" => {
                let latest = crate::update::latest_release_tag_cached();
                for line in crate::doctor::report_lines(env!("CARGO_PKG_VERSION"), latest) {
                    self.push_log("status", line, true);
                }
            }
            "run" if arguments.is_empty() => {
                self.push_log("error", "usage: /run <file>".into(), true);
            }
            "run" => self.load_path(&arguments, true),
            "demo" => {
                // No argument runs the first sample; /demo <n> picks one. The
                // samples are the same four the browser simulator ships.
                let idx = if arguments.is_empty() {
                    Some(0)
                } else {
                    arguments
                        .parse::<usize>()
                        .ok()
                        .and_then(|n| n.checked_sub(1))
                        .filter(|n| *n < SAMPLES.len())
                };
                match idx {
                    Some(idx) => {
                        self.load_sample(idx);
                        if self.assembled() && !self.halted() {
                            self.toggle_run();
                        }
                    }
                    None => {
                        self.push_log("error", format!("usage: /demo [1-{}]", SAMPLES.len()), true);
                        for (i, sample) in SAMPLES.iter().enumerate() {
                            self.push_log(
                                "status",
                                format!("  {}  {}", i + 1, sample.name),
                                true,
                            );
                        }
                    }
                }
            }
            "serve" => {
                if !self.assembled() {
                    self.push_log(
                        "error",
                        "nothing to serve: load a program first (/run <file> or /demo)".into(),
                        true,
                    );
                } else if self.xlen == 64 {
                    self.push_log(
                        "error",
                        "the browser simulator runs RV32 programs; this one is RV64, so it stays here".into(),
                        true,
                    );
                } else {
                    // --port N, or a bare port number.
                    let port = arguments
                        .split_whitespace()
                        .find(|token| !token.starts_with('-'))
                        .and_then(|token| token.parse::<u16>().ok());
                    self.serve_request = Some(ServeRequest {
                        source: self.source.clone(),
                        file_name: self.file_name.clone(),
                        port,
                    });
                    self.quit = true;
                }
            }
            "reset" => self.reset(),
            "version" => {
                let local = env!("CARGO_PKG_VERSION");
                let status = self
                    .update_status
                    .lock()
                    .ok()
                    .and_then(|guard| guard.clone());
                match status {
                    Some(status) if status.update_available => self.push_log(
                        "status",
                        format!("riscvsim {local}; latest published {}", status.latest),
                        true,
                    ),
                    _ => self.push_log("status", format!("riscvsim {local}"), true),
                }
            }
            "examples" => {
                for line in [
                    "Create a sample: printf 'addi x1, x0, 5\\naddi x2, x1, 3\\n' > add.s",
                    "Run it here: /run add.s",
                    "Or paste one instruction directly at this prompt.",
                ] {
                    self.push_log("status", line.into(), true);
                }
            }
            "exit" | "quit" => self.quit = true,
            "" => {}
            unknown => {
                const KNOWN: &[&str] = &["help", "doctor", "run", "demo", "serve", "reset", "version", "examples", "exit", "quit"];
                let message = match crate::diag::closest(unknown, KNOWN.iter().copied()) {
                    Some(guess) => format!("there is no /{unknown}. Did you mean /{guess}? (/help lists them all)"),
                    None => format!("there is no /{unknown}. Type /help to see the commands."),
                };
                self.push_log("error", message, true);
            }
        }
    }

    fn on_prompt_key(&mut self, key: KeyEvent) -> bool {
        if !self.prompt_active {
            return false;
        }
        match key.code {
            KeyCode::Up => {
                if !self.history.is_empty() {
                    let pos = match self.history_pos {
                        Some(p) => p.saturating_sub(1),
                        None => self.history.len() - 1,
                    };
                    self.history_pos = Some(pos);
                    self.command_input = self.history[pos].clone();
                }
            }
            KeyCode::Down => {
                if let Some(p) = self.history_pos {
                    if p + 1 < self.history.len() {
                        self.history_pos = Some(p + 1);
                        self.command_input = self.history[p + 1].clone();
                    } else {
                        self.history_pos = None;
                        self.command_input.clear();
                    }
                }
            }
            KeyCode::Enter => {
                let input = std::mem::take(&mut self.command_input);
                self.history_pos = None;
                if !input.trim().is_empty() && self.history.last() != Some(&input) {
                    self.history.push(input.clone());
                }
                self.prompt_active = false;
                self.dismiss_welcome();
                self.execute_command(input);
            }
            KeyCode::Esc => {
                self.command_input.clear();
                self.prompt_active = false;
            }
            KeyCode::Backspace => {
                self.command_input.pop();
            }
            KeyCode::Char(character)
                if !key.modifiers.contains(KeyModifiers::CONTROL)
                    && !key.modifiers.contains(KeyModifiers::ALT) =>
            {
                self.command_input.push(character);
            }
            _ => {}
        }
        true
    }

    /// Confirm the trust prompt: remember the directory and move on.
    pub fn trust_confirm(&mut self) {
        if let Some(key) = &self.trust_key {
            super::tour::mark_trusted(key);
        }
        self.gate = if self.tour.is_some() {
            Gate::Done
        } else {
            Gate::Welcome
        };
    }

    pub fn dismiss_welcome(&mut self) {
        if matches!(self.gate, Gate::Welcome) {
            self.gate = Gate::Done;
        }
    }

    /// Advance time-driven work and refresh the cached release check hourly.
    pub fn tick(&mut self) {
        if self.last_update_check.elapsed() >= Duration::from_secs(60 * 60) {
            crate::update::spawn_status_check(
                env!("CARGO_PKG_VERSION"),
                self.update_status.clone(),
            );
            self.last_update_check = Instant::now();
        }
        if self.running {
            if let Some(due) = self.next_step_due {
                let now = Instant::now();
                if now >= due {
                    let (cycles, period, animate) = match self.speed() {
                        Speed::Max => (MAX_CHUNK, Duration::from_millis(0), false),
                        Speed::Cps(n) => (
                            1,
                            Duration::from_millis((1000 / n.max(1)).max(8) as u64),
                            n <= 30,
                        ),
                    };
                    self.step(cycles, animate);
                    if self.running {
                        self.next_step_due = Some(now + period);
                    }
                }
            }
        }
    }

    /// How long the event loop may sleep before the next frame is needed.
    pub fn tick_timeout(&self) -> Duration {
        if !matches!(self.gate, Gate::Done) || self.running || self.anims.active() {
            Duration::from_millis(33)
        } else {
            Duration::from_millis(250)
        }
    }

    // -- input ---------------------------------------------------------

    pub fn on_key(&mut self, key: KeyEvent) {
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.quit = true;
            return;
        }
        if let Gate::Trust { selected } = &mut self.gate {
            match key.code {
                KeyCode::Up | KeyCode::Char('k') => *selected = 0,
                KeyCode::Down | KeyCode::Char('j') => *selected = 1,
                KeyCode::Char('1') => *selected = 0,
                KeyCode::Char('2') => *selected = 1,
                KeyCode::Enter => {
                    if *selected == 0 {
                        self.trust_confirm();
                    } else {
                        self.quit = true;
                    }
                }
                KeyCode::Esc | KeyCode::Char('q') => self.quit = true,
                _ => {}
            }
            return;
        }
        if matches!(self.gate, Gate::Welcome) {
            self.prompt_active = true;
            let _ = self.on_prompt_key(key);
            return;
        }
        if self.help_open {
            self.help_open = false;
            return;
        }
        if self.tour.is_some() {
            match key.code {
                KeyCode::Char('q') => self.quit = true,
                KeyCode::Esc | KeyCode::Char('s') => self.tour_skip(),
                KeyCode::Enter | KeyCode::Char(' ') | KeyCode::Right => self.tour_next(),
                _ => {}
            }
            return;
        }
        if self.on_prompt_key(key) {
            return;
        }
        if self.menu_open {
            match key.code {
                KeyCode::Esc | KeyCode::Char('s') => self.menu_open = false,
                KeyCode::Up => self.menu_sel = self.menu_sel.saturating_sub(1),
                KeyCode::Down => self.menu_sel = (self.menu_sel + 1).min(SAMPLES.len() - 1),
                KeyCode::Enter => {
                    self.menu_open = false;
                    self.load_sample(self.menu_sel);
                }
                KeyCode::Char('q') => self.quit = true,
                _ => {}
            }
            return;
        }
        match key.code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Char('?') => self.help_open = true,
            KeyCode::Right | KeyCode::Char('n') => {
                if self.assembled() && !self.halted() && !self.running {
                    self.step(1, true);
                }
            }
            KeyCode::Left => {
                if self.can_step_back() {
                    self.step_back();
                }
            }
            KeyCode::Char(' ') => self.toggle_run(),
            KeyCode::Enter => self.prompt_active = true,
            KeyCode::Char('/') => {
                self.prompt_active = true;
                self.command_input.clear();
                self.command_input.push('/');
            }
            KeyCode::Char('a') => self.assemble(true),
            KeyCode::Char('r') => self.reset(),
            KeyCode::Tab | KeyCode::Char('t') => {
                self.tab = match self.tab {
                    Tab::Pipeline => Tab::State,
                    Tab::State => Tab::Pipeline,
                };
            }
            KeyCode::Char('[') | KeyCode::Char('-') | KeyCode::Char('_') => self.slower(),
            KeyCode::Char(']') | KeyCode::Char('+') | KeyCode::Char('=') => self.faster(),
            KeyCode::Char('f') => self.toggle_fast(),
            KeyCode::Char('b') => self.toggle_breakpoint(),
            KeyCode::Up | KeyCode::Char('k') => self.move_selection(-1),
            KeyCode::Down | KeyCode::Char('j') => self.move_selection(1),
            KeyCode::Char('s') => {
                self.menu_open = true;
                self.menu_sel = 0;
            }
            KeyCode::Char('h') => self.reg_hex = !self.reg_hex,
            KeyCode::Char('g') => {
                self.tab = Tab::State;
                self.mem_addr = DATA_BASE;
            }
            KeyCode::Char('G') => {
                self.tab = Tab::State;
                self.mem_addr = 0x7fff_ff80;
            }
            KeyCode::PageUp => self.mem_addr = self.mem_addr.saturating_sub(128),
            KeyCode::PageDown => self.mem_addr = self.mem_addr.saturating_add(128),
            KeyCode::Esc => self.src_sel = None, // overlays above handle Esc first
            _ => {}
        }
    }

    fn hit_at(&self, x: u16, y: u16) -> Option<Act> {
        let pos = Position { x, y };
        self.hits
            .iter()
            .rev() // overlays are pushed last and win
            .find(|h| h.rect.contains(pos))
            .map(|h| h.act)
    }

    pub fn on_mouse(&mut self, me: MouseEvent) {
        match me.kind {
            MouseEventKind::Moved => {
                self.hover = self.hit_at(me.column, me.row);
            }
            MouseEventKind::Down(MouseButton::Left) => {
                if let Gate::Trust { .. } = self.gate {
                    match self.hit_at(me.column, me.row) {
                        Some(Act::TrustYes) => self.trust_confirm(),
                        Some(Act::TrustNo) => self.quit = true,
                        _ => {}
                    }
                    return;
                }
                if matches!(self.gate, Gate::Welcome) {
                    self.dismiss_welcome();
                    return;
                }
                let hit = self.hit_at(me.column, me.row);
                if self.tour.is_some()
                    && !matches!(
                        hit,
                        Some(Act::TourNext) | Some(Act::TourSkip) | Some(Act::Quit)
                    )
                {
                    return;
                }
                if hit == Some(Act::SpeedTrack) {
                    self.set_speed_from_col(me.column);
                }
                self.pressed = hit;
                // Click anywhere outside an open menu closes it.
                if self.menu_open && !matches!(hit, Some(Act::Sample(_)) | Some(Act::SampleToggle))
                {
                    self.menu_open = false;
                    self.pressed = None;
                }
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if self.pressed == Some(Act::SpeedTrack) {
                    self.set_speed_from_col(me.column);
                }
            }
            MouseEventKind::Up(MouseButton::Left) => {
                let hit = self.hit_at(me.column, me.row);
                let pressed = self.pressed.take();
                if pressed.is_some() && hit == pressed {
                    self.trigger(pressed.unwrap());
                }
            }
            MouseEventKind::ScrollUp => self.scroll_source(-3, me.column, me.row),
            MouseEventKind::ScrollDown => self.scroll_source(3, me.column, me.row),
            _ => {}
        }
    }

    fn scroll_source(&mut self, delta: i32, x: u16, y: u16) {
        if !self.rect_source.contains(Position { x, y }) {
            return;
        }
        let cur = self.src_scroll.unwrap_or(0) as i32;
        self.src_scroll = Some((cur + delta).max(0) as u16);
    }

    fn set_speed_from_col(&mut self, col: u16) {
        let t = self.speed_track;
        if t.width <= 1 {
            return;
        }
        let rel = col.saturating_sub(t.x).min(t.width - 1) as f32 / (t.width - 1) as f32;
        self.speed_idx = (rel * (SPEEDS.len() - 1) as f32).round() as usize;
    }

    fn trigger(&mut self, act: Act) {
        match act {
            Act::Assemble => self.assemble(true),
            Act::Step => {
                if self.assembled() && !self.halted() && !self.running {
                    self.step(1, true);
                }
            }
            Act::Back => {
                if self.can_step_back() {
                    self.step_back();
                }
            }
            Act::RunPause => self.toggle_run(),
            Act::Reset => self.reset(),
            Act::TabPipeline => self.tab = Tab::Pipeline,
            Act::TabState => self.tab = Tab::State,
            Act::SpeedTrack => {} // handled on Down/Drag
            Act::SampleToggle => {
                self.menu_open = !self.menu_open;
                self.menu_sel = 0;
            }
            Act::Sample(i) => {
                self.menu_open = false;
                self.load_sample(i);
            }
            Act::MemData => self.mem_addr = DATA_BASE,
            Act::MemStack => self.mem_addr = 0x7fff_ff80,
            Act::MemPrev => self.mem_addr = self.mem_addr.saturating_sub(128),
            Act::MemNext => self.mem_addr = self.mem_addr.saturating_add(128),
            Act::RegFmt => self.reg_hex = !self.reg_hex,
            Act::TourNext => self.tour_next(),
            Act::TourSkip => self.tour_skip(),
            Act::TrustYes => self.trust_confirm(),
            Act::TrustNo => self.quit = true,
            Act::Help => self.help_open = !self.help_open,
            Act::Quit => self.quit = true,
        }
    }

    fn tour_next(&mut self) {
        if let Some(tour) = &mut self.tour {
            if tour.step + 1 >= TOUR_STEPS.len() {
                self.tour_skip();
            } else {
                tour.step += 1;
            }
        }
    }

    fn tour_skip(&mut self) {
        self.tour = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn app(show_tour: bool, trust_key: Option<String>) -> App {
        App::new(
            None,
            "addi x1, x0, 1\n".into(),
            "sample.s".into(),
            show_tour,
            trust_key,
            Arc::new(Mutex::new(None)),
            crate::doctor::InstallMethod::Manual,
        )
    }

    #[test]
    fn first_run_tour_bypasses_welcome_gate() {
        let app = app(true, None);
        assert!(matches!(app.gate, Gate::Done));
        assert!(app.tour.is_some());
        assert!(!app.prompt_active);
        assert!(!app.tour_shown);
    }

    #[test]
    fn returning_user_still_gets_welcome_gate() {
        let app = app(false, None);
        assert!(matches!(app.gate, Gate::Welcome));
        assert!(app.tour.is_none());
        assert!(app.prompt_active);
    }

    #[test]
    fn trust_confirmation_leads_to_tour_before_welcome() {
        let mut app = app(true, Some("already-tested".into()));
        assert!(matches!(app.gate, Gate::Trust { .. }));
        app.trust_key = None;
        app.trust_confirm();
        assert!(matches!(app.gate, Gate::Done));
        assert!(app.tour.is_some());
    }
}

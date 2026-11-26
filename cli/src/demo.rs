//! `riscvsim demo`: a six-lesson course on the pipeline, one cycle at a time.
//!
//! On a terminal it is interactive (Enter for the next cycle, a for
//! autoplay, b back, r restart, q quit). Piped or on a dumb terminal it
//! prints the same walkthrough as static text, one block per cycle.
//!
//! Every cycle is computed up front (the samples are tiny), so moving
//! forward, back or restarting is just an index change and always instant.

use crate::explain::{self, Kind};
use crate::term::{self, visible_width, Paint};
use crate::lessons::{self, LESSONS};
use crate::tui::samples::Sample;
use crate::machine::{Snap as Snapshot, StageState};
use std::process::ExitCode;
use std::time::{Duration, Instant};

/// The most cycles a tour will show (the samples need far fewer).
const MAX_CYCLES: usize = 400;

/// Autoplay speeds in cycles per second; the default is index 2.
pub const SPEEDS: [f64; 6] = [0.5, 1.0, 2.0, 3.0, 5.0, 8.0];
const DEFAULT_SPEED: usize = 2;

pub struct Tour {
    pub number: usize,
    pub sample: &'static Sample,
    pub snaps: Vec<Snapshot>,
    /// Set for the six lessons; extra samples (array-sum) are plain tours.
    pub lesson: Option<&'static lessons::Lesson>,
    /// Per cycle: definitions of the terms its sentence is first to use.
    pub glosses: Vec<Vec<&'static str>>,
}

impl Tour {
    /// Lesson `n` (1-based) of the course.
    pub fn lesson(n: usize) -> Result<Self, String> {
        let lesson = LESSONS.get(n.wrapping_sub(1)).ok_or_else(|| format!("there is no lesson {n}"))?;
        let mut tour = Self::new(n, &lesson.sample)?;
        tour.lesson = Some(lesson);
        Ok(tour)
    }

    /// A built-in sample that is not one of the lessons.
    pub fn new(number: usize, sample: &'static Sample) -> Result<Self, String> {
        let mut pipeline = crate::machine::build(sample.source, sample.xlen)
            .map_err(|e| format!("the sample did not assemble: {}", e[0].1))?
            .machine;
        let mut snaps = vec![pipeline.snapshot()];
        while !pipeline.halted() && snaps.len() <= MAX_CYCLES {
            pipeline.step_cycle();
            snaps.push(pipeline.snapshot());
        }
        let sentences: Vec<String> = snaps.iter().map(|s| explain::cycle(s).1).collect();
        let glosses = explain::first_use_glosses(&sentences);
        Ok(Self { number, sample, snaps, lesson: None, glosses })
    }

    /// The lesson after this one, when this is a lesson and not the last.
    pub fn next_lesson(&self) -> Option<usize> {
        self.lesson.map(|_| self.number + 1).filter(|n| *n <= LESSONS.len())
    }

    pub fn last(&self) -> usize {
        self.snaps.len() - 1
    }
}

// ---------------------------------------------------------------------------
// Keys: a pure state machine, so it is testable without a terminal.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Next,
    Back,
    Autoplay,
    Faster,
    Slower,
    Restart,
    Quit,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct State {
    pub at: usize,
    pub last: usize,
    pub autoplay: bool,
    pub speed: usize,
    pub quit: bool,
}

impl State {
    pub fn new(last: usize) -> Self {
        Self { at: 0, last, autoplay: false, speed: DEFAULT_SPEED, quit: false }
    }

    pub fn press(mut self, key: Key) -> Self {
        match key {
            Key::Next => {
                if self.at < self.last {
                    self.at += 1;
                }
                self.autoplay = false;
            }
            Key::Back => {
                self.at = self.at.saturating_sub(1);
                self.autoplay = false;
            }
            Key::Autoplay => {
                if self.at == self.last {
                    self.at = 0;
                }
                self.autoplay = !self.autoplay;
            }
            Key::Faster => self.speed = (self.speed + 1).min(SPEEDS.len() - 1),
            Key::Slower => self.speed = self.speed.saturating_sub(1),
            Key::Restart => {
                self.at = 0;
                self.autoplay = false;
            }
            Key::Quit => self.quit = true,
            Key::Other => {}
        }
        self
    }

    /// One autoplay tick: advance, and stop at the end.
    pub fn tick(mut self) -> Self {
        if self.autoplay {
            if self.at < self.last {
                self.at += 1;
            }
            if self.at == self.last {
                self.autoplay = false;
            }
        }
        self
    }

    pub fn interval(&self) -> Duration {
        Duration::from_secs_f64(1.0 / SPEEDS[self.speed])
    }
}

pub fn speed_label(speed: usize) -> String {
    let s = SPEEDS[speed];
    if s.fract() == 0.0 {
        format!("{s:.0}/s")
    } else {
        format!("{s}/s")
    }
}

// ---------------------------------------------------------------------------
// Rendering pieces shared by both modes
// ---------------------------------------------------------------------------

/// Instruction text for a narrow box, shortened on whole tokens (the same
/// rule the tui uses): `addi x1, x0, 5` -> `addi x1,x0,5` -> `addi x1,x0…`.
fn squeeze(text: &str, room: usize) -> String {
    explain::fit_instr(text, room, true)
}

fn stage_text(snap: &Snapshot, i: usize, room: usize, p: &Paint) -> (String, StageState) {
    let s = &snap.stages[i];
    let text = match (&s.state, &s.text) {
        (StageState::Normal, Some(t)) => squeeze(t, room),
        (StageState::Stall, _) => "bubble".to_string(),
        (StageState::Flush, Some(t)) => squeeze(&format!("✗ {t}"), room),
        (StageState::Flush, None) => "flushed".to_string(),
        _ => p.sym("·", ".").to_string(),
    };
    let text = if p.unicode { text } else { text.replace('…', "~").replace('✗', "x") };
    (text, s.state.clone())
}

fn paint_stage(p: &Paint, text: &str, state: &StageState) -> String {
    match state {
        StageState::Normal => p.bold(text),
        StageState::Stall => p.warn(text),
        StageState::Flush => p.error(text),
        StageState::Empty => p.gray(text),
    }
}

/// The five stages as boxes, filling the width (at most 78 columns).
pub fn stage_boxes(p: &Paint, snap: &Snapshot, width: usize) -> Vec<String> {
    let inner = ((width.min(110).saturating_sub(2)) / 5).saturating_sub(2).max(8);
    let (tl, tr, bl, br, h, v) = if p.unicode { ("┌", "┐", "└", "┘", "─", "│") } else { ("+", "+", "+", "+", "-", "|") };
    let mut top = String::from("  ");
    let mut mid = String::from("  ");
    let mut bot = String::from("  ");
    for (i, s) in snap.stages.iter().enumerate() {
        let label = format!(" {} ", s.name);
        let rest = inner.saturating_sub(label.chars().count() + 1);
        top.push_str(&p.gray(&format!("{tl}{h}")));
        top.push_str(&p.status(&label));
        top.push_str(&p.gray(&format!("{}{tr}", h.repeat(rest))));
        let (text, state) = stage_text(snap, i, inner - 2, p);
        let pad = inner.saturating_sub(text.chars().count() + 1);
        mid.push_str(&format!("{} {}{}{}", p.gray(v), paint_stage(p, &text, &state), " ".repeat(pad), p.gray(v)));
        bot.push_str(&p.gray(&format!("{bl}{}{br}", h.repeat(inner))));
    }
    vec![top, mid, bot]
}

/// Compact one-line stages for static output: `IF add x3,x2,x1  ID ...`.
/// Each stage starts with its full text; while the line is too wide, the
/// longest one is shortened, so short instructions are never cut.
pub fn stage_line(p: &Paint, snap: &Snapshot, width: usize) -> String {
    let max = width.min(78);
    let build = |rooms: &[usize]| -> String {
        let parts: Vec<String> = snap
            .stages
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let (text, state) = stage_text(snap, i, rooms[i], p);
                format!("{} {}", p.status(s.name), paint_stage(p, &text, &state))
            })
            .collect();
        format!("    {}", parts.join("  "))
    };
    let mut rooms: Vec<usize> = (0..snap.stages.len()).map(|i| stage_text(snap, i, 40, p).0.chars().count()).collect();
    loop {
        let line = build(&rooms);
        if visible_width(&line) <= max {
            return line;
        }
        let (i, &longest) = rooms.iter().enumerate().max_by_key(|(_, r)| **r).unwrap();
        if longest <= 5 {
            return line;
        }
        rooms[i] = longest - 1;
    }
}

/// Registers that changed between two snapshots: `x1 = 5`.
pub fn changed_registers(prev: Option<&Snapshot>, snap: &Snapshot) -> Vec<(usize, u64)> {
    let Some(prev) = prev else { return Vec::new() };
    (1..32).filter(|&r| prev.registers[r] != snap.registers[r]).map(|r| (r, snap.registers[r])).collect()
}

fn changed_line(p: &Paint, prev: Option<&Snapshot>, snap: &Snapshot) -> Option<String> {
    let changed = changed_registers(prev, snap);
    if changed.is_empty() {
        return None;
    }
    let parts: Vec<String> = changed
        .iter()
        .map(|(r, v)| format!("{} = {}", p.changed(&format!("x{r}")), p.changed(&snap.value(*v))))
        .collect();
    Some(format!("    {} {}", p.success(p.sym("✓", "+")), parts.join("  ")))
}

fn explain_line(p: &Paint, snap: &Snapshot, width: usize, indent: usize) -> Vec<String> {
    let (kind, text) = explain::cycle(snap);
    let mark = match kind {
        Kind::Stall => p.warn(p.sym("!", "!")),
        Kind::Flush | Kind::Error => p.error(p.sym("✗", "x")),
        Kind::Done => p.success(p.sym("✓", "+")),
        _ => p.status(p.chevron()),
    };
    let room = width.min(78).saturating_sub(indent + 2).max(30);
    term::wrap(&text, room)
        .into_iter()
        .enumerate()
        .map(|(i, l)| {
            if i == 0 {
                format!("{}{mark} {l}", " ".repeat(indent))
            } else {
                format!("{}  {l}", " ".repeat(indent))
            }
        })
        .collect()
}

/// The first time a cycle's sentence uses a term, its short definition,
/// dim, under the sentence.
fn gloss_lines(p: &Paint, tour: &Tour, at: usize, width: usize, indent: usize) -> Vec<String> {
    let room = width.min(78).saturating_sub(indent + 2).max(30);
    let mut out = Vec::new();
    for gloss in tour.glosses.get(at).into_iter().flatten() {
        for line in term::wrap(gloss, room) {
            out.push(format!("{}  {}", " ".repeat(indent), p.gray(&line)));
        }
    }
    out
}

fn title(p: &Paint, tour: &Tour) -> String {
    let width = if tour.sample.xlen == 64 { format!(" {} RV64", p.dot()) } else { String::new() };
    match tour.lesson {
        Some(_) => format!("{} {} {}{width}", p.heading(&format!("demo {}", tour.number)), p.dot(), tour.sample.name),
        None => format!("{} {} {}{width}", p.heading(&format!("demo {}", tour.sample.file.trim_end_matches(".s"))), p.dot(), tour.sample.name),
    }
}

/// The registers a lesson watches, every cycle: `counter x1 = 7 · sum x2 = 27`.
fn watch_line(p: &Paint, tour: &Tour, snap: &Snapshot) -> Option<String> {
    let watch = tour.lesson?.watch;
    if watch.is_empty() {
        return None;
    }
    let parts: Vec<String> = watch
        .iter()
        .map(|(r, what)| format!("{what} x{r} = {}", snap.value(snap.registers[*r as usize])))
        .collect();
    Some(format!("    {}", p.gray(&parts.join(&format!(" {} ", p.dot())))))
}

/// Where to go after this tour.
fn next_lines(p: &Paint, tour: &Tour) -> Vec<String> {
    match tour.lesson {
        Some(_) if tour.number < LESSONS.len() => {
            vec![format!("  {} {}", p.bold("Next:"), p.status(&lessons::next_line(tour.number)))]
        }
        Some(_) => vec![
            format!("  {} {}", p.ok_mark(), p.success("You finished all six lessons.")),
            format!("  {} {} {}", p.bold("Next:"), p.status("riscvsim tui"), p.gray("to step through your own program")),
        ],
        None => vec![format!("  {} {} {}", p.bold("Next:"), p.status("riscvsim demo --list"), p.gray("for the six lessons"))],
    }
}

/// The program with line numbers, a marker on the instruction in EX and
/// the stage each instruction is in.
fn listing(p: &Paint, snap: &Snapshot, source: &str) -> Vec<String> {
    let mut at_line: Vec<(usize, &str)> = Vec::new();
    for s in &snap.stages {
        if s.state == StageState::Normal {
            if let Some(l) = s.line {
                at_line.push((l, s.name));
            }
        }
    }
    let ex_line = snap.stages.iter().find(|s| s.name == "EX" && s.state == StageState::Normal).and_then(|s| s.line);
    // Stage tags line up in one column after the longest line (lesson
    // sources stay within 60 columns, so tags still fit in 78).
    let col = source.lines().map(|l| l.chars().count()).max().unwrap_or(0).clamp(30, 60);
    source
        .lines()
        .enumerate()
        .map(|(i, text)| {
            let n = i + 1;
            let marker = if ex_line == Some(n) { p.status(p.chevron()) } else { " ".into() };
            let tags: Vec<&str> = at_line.iter().filter(|(l, _)| *l == n).map(|(_, s)| *s).collect();
            let body = format!("{text:<col$}");
            let body = if text.trim_start().starts_with('#') { p.gray(&body) } else { body };
            let tag = if tags.is_empty() { String::new() } else { p.status(&tags.join(" ")) };
            format!("  {marker} {} {body} {tag}", p.gray(&format!("{n:>2}"))).trim_end().to_string()
        })
        .collect()
}

pub fn summary(p: &Paint, tour: &Tour) -> Vec<String> {
    let last = &tour.snaps[tour.last()];
    let st = last.stats;
    let cpi = if st.instructions > 0 { st.cycles as f64 / st.instructions as f64 } else { 0.0 };
    let mut lines = vec![format!(
        "  {} {} {} {} {} CPI {:.2} {} {} {} {}",
        p.ok_mark(),
        crate::run::plural(st.cycles, "cycle"),
        p.dot(),
        crate::run::plural(st.instructions, "instruction"),
        p.dot(),
        cpi,
        p.dot(),
        crate::run::plural(st.stalls, "stall"),
        p.dot(),
        crate::run::plural(st.mispredictions, "misprediction"),
    )];
    let mut seen: Vec<String> = Vec::new();
    for snap in &tour.snaps {
        let (kind, text) = explain::cycle(snap);
        if matches!(kind, Kind::Stall | Kind::Flush) && !seen.contains(&text) {
            seen.push(text);
        }
    }
    if let Some(lesson) = tour.lesson {
        // The registers the lesson is about, read from the final state.
        // Negative values also show their bits: -1 (0xffff_ffff_ffff_ffff).
        let parts: Vec<String> = lesson
            .expect
            .iter()
            .map(|(r, _)| {
                let v = last.registers[*r as usize];
                let shown = last.value(v);
                if crate::machine::signed(v, last.xlen) < 0 && !shown.starts_with("0x") {
                    format!("x{r} = {shown} ({})", crate::run::hex(v, last.xlen))
                } else {
                    format!("x{r} = {shown}")
                }
            })
            .collect();
        // Break between values, never inside one.
        let sep = format!(" {} ", p.dot());
        let mut rows: Vec<String> = Vec::new();
        for part in parts {
            match rows.last_mut() {
                Some(row) if row.chars().count() + sep.chars().count() + part.chars().count() <= 60 => {
                    row.push_str(&sep);
                    row.push_str(&part);
                }
                _ => rows.push(part),
            }
        }
        for (j, l) in rows.into_iter().enumerate() {
            let lead = if j == 0 { "Ends with" } else { "         " };
            lines.push(format!("    {} {}", p.gray(lead), p.changed(&l)));
        }
    }
    if seen.is_empty() {
        let forwarded = tour.snaps.iter().any(|s| !s.view.forwards.is_empty());
        let why = if forwarded {
            "No stalls: forwarding kept every instruction moving."
        } else {
            "No stalls: every instruction moved one stage each cycle."
        };
        lines.push(format!("    {}", p.gray(why)));
    }
    for (i, text) in seen.iter().enumerate() {
        let lead = if i == 0 { "Why it slowed down:" } else { "" };
        if !lead.is_empty() {
            lines.push(format!("    {}", p.gray(lead)));
        }
        for (j, l) in term::wrap(text, 70).into_iter().enumerate() {
            lines.push(format!("    {} {l}", if j == 0 { p.sym("•", "-") } else { " " }));
        }
    }
    lines.push(String::new());
    lines.extend(next_lines(p, tour));
    lines
}

// ---------------------------------------------------------------------------
// The course menu: `riscvsim demo --list`
// ---------------------------------------------------------------------------

/// The numbered lessons: title and name on one line, the promise below.
pub fn menu(p: &Paint, width: usize) -> Vec<String> {
    let width = width.clamp(40, 78);
    let mut out = vec![
        String::new(),
        format!("{} {} {}", p.heading("demo"), p.dot(), "a short course on the pipeline, in six lessons"),
        String::new(),
    ];
    for (i, lesson) in LESSONS.iter().enumerate() {
        let title = if lesson.sample.xlen == 64 { format!("{} (RV64)", lesson.title()) } else { lesson.title().to_string() };
        let used = 7 + title.chars().count() + lesson.slug.len();
        let gap = width.saturating_sub(used).max(2);
        out.push(format!("  {}  {}{}{}", p.status(&format!("{:>2}", i + 1)), p.bold(&title), " ".repeat(gap), p.gray(lesson.slug)));
        for line in term::wrap(lesson.promise, width.saturating_sub(6)) {
            out.push(format!("      {}", p.gray(&line)));
        }
    }
    out.push(String::new());
    out.push(format!(
        "  {} {} {}",
        p.bold("Start:"),
        p.status("riscvsim demo 1"),
        p.gray("(or by name: riscvsim demo loops)")
    ));
    out
}

// ---------------------------------------------------------------------------
// Static walkthrough (piped, dumb terminal)
// ---------------------------------------------------------------------------

pub fn walkthrough(p: &Paint, tour: &Tour, width: usize) -> Vec<String> {
    let mut out = vec![String::new(), title(p, tour)];
    if let Some(lesson) = tour.lesson {
        out.push(format!("  {}", p.gray(lesson.promise)));
    }
    out.push(String::new());
    for (i, line) in tour.sample.source.lines().enumerate() {
        let body = format!("{:>2}  {line}", i + 1);
        out.push(format!("  {}", if line.trim_start().starts_with('#') { p.gray(&body) } else { body }).trim_end().to_string());
    }
    for (i, snap) in tour.snaps.iter().enumerate().skip(1) {
        out.push(String::new());
        out.push(format!("  {}", p.bold(&format!("cycle {i}"))));
        out.push(stage_line(p, snap, width));
        if let Some(l) = changed_line(p, tour.snaps.get(i - 1), snap) {
            out.push(l);
        }
        out.extend(watch_line(p, tour, snap));
        out.extend(explain_line(p, snap, width, 4));
        out.extend(gloss_lines(p, tour, i, width, 4));
    }
    out.push(String::new());
    out.extend(summary(p, tour));
    out
}

// ---------------------------------------------------------------------------
// Interactive tour
// ---------------------------------------------------------------------------

pub fn frame(p: &Paint, tour: &Tour, state: &State, width: usize, rows: usize) -> Vec<String> {
    let snap = &tour.snaps[state.at];
    let mut lines = vec![String::new()];
    let head = title(p, tour);
    let progress = p.gray(&format!("cycle {} of {}", state.at, state.last));
    let gap = width.min(78).saturating_sub(visible_width(&head) + visible_width(&progress)).max(2);
    lines.push(format!("{head}{}{progress}", " ".repeat(gap)));
    lines.push(String::new());

    // Build the bottom first so the listing gets exactly the rows left.
    let mut bottom = vec![String::new()];
    bottom.extend(stage_boxes(p, snap, width));
    bottom.push(changed_line(p, state.at.checked_sub(1).and_then(|i| tour.snaps.get(i)), snap).unwrap_or_default());
    bottom.extend(watch_line(p, tour, snap));
    bottom.push(String::new());
    bottom.extend(explain_line(p, snap, width, 2));
    bottom.extend(gloss_lines(p, tour, state.at, width, 2));
    bottom.push(String::new());
    if state.at == state.last {
        let summary = summary(p, tour);
        // On a short terminal keep the first summary line and the Next line.
        if rows >= 30 {
            bottom.extend(summary);
        } else {
            bottom.push(summary[0].clone());
            bottom.extend(next_lines(p, tour));
        }
        bottom.push(String::new());
        match tour.next_lesson() {
            Some(_) => bottom.push(format!(
                "  {}   {}   {}   {}",
                p.key("Enter", "next lesson"),
                p.key("r", "restart"),
                p.key("b", "back"),
                p.key("q", "quit")
            )),
            None => bottom.push(format!("  {}   {}   {}", p.key("r", "restart"), p.key("b", "back"), p.key("q", "quit"))),
        }
    } else {
        let play = if state.autoplay { "pause" } else { "autoplay" };
        bottom.push(format!(
            "  {}   {}   {}   {}   {}   {}",
            p.key("Enter", "next"),
            p.key("a", play),
            p.key("+/-", &format!("speed {}", speed_label(state.speed))),
            p.key("b", "back"),
            p.key("r", "restart"),
            p.key("q", "quit")
        ));
    }

    let room = rows.saturating_sub(lines.len() + bottom.len()).max(2);
    let mut list = listing(p, snap, tour.sample.source);
    if list.len() > room {
        let focus = snap
            .stages
            .iter()
            .filter(|s| s.state == StageState::Normal)
            .find_map(|s| s.line)
            .unwrap_or(1)
            .saturating_sub(1);
        let start = focus.saturating_sub(room / 2).min(list.len() - room);
        list = list[start..start + room].to_vec();
    }
    lines.extend(list);
    lines.extend(bottom);
    lines
}

fn read_key(timeout: Duration) -> std::io::Result<Option<Key>> {
    use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
    if !event::poll(timeout)? {
        return Ok(None);
    }
    Ok(match event::read()? {
        Event::Key(k) if k.kind != KeyEventKind::Release => Some(match k.code {
            KeyCode::Char('c') if k.modifiers.contains(KeyModifiers::CONTROL) => Key::Quit,
            KeyCode::Enter | KeyCode::Char(' ') | KeyCode::Right | KeyCode::Char('n') | KeyCode::Char('l') => Key::Next,
            KeyCode::Left | KeyCode::Char('b') | KeyCode::Char('h') => Key::Back,
            KeyCode::Char('a') | KeyCode::Char('p') => Key::Autoplay,
            KeyCode::Char('+') | KeyCode::Char('=') => Key::Faster,
            KeyCode::Char('-') | KeyCode::Char('_') => Key::Slower,
            KeyCode::Char('r') => Key::Restart,
            KeyCode::Char('q') | KeyCode::Esc => Key::Quit,
            _ => Key::Other,
        }),
        // A resize just redraws.
        Event::Resize(..) => Some(Key::Other),
        _ => None,
    })
}

/// Enter at the end of a lesson moves on to the next one.
pub fn advances_lesson(tour: &Tour, state: &State, key: Key) -> Option<usize> {
    (key == Key::Next && state.at == state.last).then(|| tour.next_lesson()).flatten()
}

/// The interactive tour. At the end of a lesson, Enter opens the next
/// one in the same screen; the tour that was showing last is returned.
fn interactive(first: Tour) -> std::io::Result<(State, Tour)> {
    let p = Paint::fixed(term::color_allowed(), term::unicode());
    let mut tour = first;
    let mut state = State::new(tour.last());
    term::screen::enter()?;
    let result = (|| -> std::io::Result<State> {
        let mut dirty = true;
        let mut next_tick = Instant::now() + state.interval();
        loop {
            if dirty {
                let (w, h) = term::screen::size();
                term::screen::draw(&frame(&p, &tour, &state, w, h), h)?;
                dirty = false;
            }
            let wait = if state.autoplay { next_tick.saturating_duration_since(Instant::now()) } else { Duration::from_secs(3600) };
            match read_key(wait)? {
                Some(key) => {
                    if let Some(next) = advances_lesson(&tour, &state, key) {
                        if let Ok(t) = Tour::lesson(next) {
                            tour = t;
                            state = State::new(tour.last());
                            dirty = true;
                            continue;
                        }
                    }
                    let before = state;
                    state = state.press(key);
                    if state.quit {
                        return Ok(state);
                    }
                    if state.autoplay && !before.autoplay {
                        next_tick = Instant::now() + state.interval();
                    }
                    dirty = true;
                }
                None if state.autoplay => {
                    state = state.tick();
                    next_tick = Instant::now() + state.interval();
                    dirty = true;
                }
                None => {}
            }
        }
    })();
    let _ = term::screen::leave();
    result.map(|state| (state, tour))
}

/// Should the demo be interactive? Only for a person at a real terminal.
pub fn interactive_terminal() -> bool {
    term::Stream::Stdout.is_tty()
        && std::io::IsTerminal::is_terminal(&std::io::stdin())
        && !std::env::var("TERM").is_ok_and(|t| t == "dumb")
}

pub fn run(tour: Result<Tour, String>) -> ExitCode {
    let tour = match tour {
        Ok(t) => t,
        Err(message) => {
            let e = Paint::stderr();
            eprintln!("{}{} {message}", e.error_bold("error"), e.bold(":"));
            return ExitCode::from(crate::EXIT_RUNTIME);
        }
    };
    let p = Paint::new();
    if !interactive_terminal() {
        for line in walkthrough(&p, &tour, term::width()) {
            println!("{line}");
        }
        return ExitCode::SUCCESS;
    }
    match interactive(tour) {
        Ok((state, tour)) => {
            // Leave a short record on the normal screen.
            println!();
            println!("{}", title(&p, &tour));
            println!();
            if state.at == state.last {
                for line in summary(&p, &tour) {
                    println!("{line}");
                }
            } else {
                println!("  {} stopped at cycle {} of {}", p.gray(p.chevron()), state.at, state.last);
                println!();
                let again = match tour.lesson {
                    Some(_) => format!("riscvsim demo {}", tour.number),
                    None => format!("riscvsim demo {}", tour.sample.file.trim_end_matches(".s")),
                };
                println!("  {} {}", p.bold("Again:"), p.status(&again));
                for line in next_lines(&p, &tour) {
                    println!("{line}");
                }
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            let e = Paint::stderr();
            eprintln!("{}{} this terminal could not run the interactive tour ({})", e.error_bold("error"), e.bold(":"), crate::io_reason(&error));
            eprintln!("  {}", e.gray("try: riscvsim demo | less   (prints the same tour as text)"));
            ExitCode::from(crate::EXIT_RUNTIME)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tour(n: usize) -> Tour {
        Tour::lesson(n).unwrap()
    }

    #[test]
    fn keys_move_through_the_tour() {
        let s = State::new(3);
        assert_eq!(s.press(Key::Next).at, 1);
        assert_eq!(s.press(Key::Back).at, 0);
        let end = s.press(Key::Next).press(Key::Next).press(Key::Next).press(Key::Next);
        assert_eq!(end.at, 3, "never runs past the end");
        assert_eq!(end.press(Key::Restart).at, 0);
        assert!(s.press(Key::Quit).quit);
        assert_eq!(s.press(Key::Other), s);
    }

    #[test]
    fn autoplay_runs_at_an_adjustable_speed_and_stops_at_the_end() {
        let s = State::new(2).press(Key::Autoplay);
        assert!(s.autoplay);
        assert_eq!(s.interval(), Duration::from_millis(500), "about two cycles a second");
        assert_eq!(speed_label(s.speed), "2/s");
        assert_eq!(s.press(Key::Faster).speed, 3);
        assert_eq!(s.press(Key::Slower).press(Key::Slower).press(Key::Slower).speed, 0);
        assert_eq!(speed_label(0), "0.5/s");
        let s = s.tick().tick();
        assert_eq!(s.at, 2);
        assert!(!s.autoplay, "autoplay stops at the end");
        // a at the end replays from the start
        let again = s.press(Key::Autoplay);
        assert_eq!((again.at, again.autoplay), (0, true));
        // stepping by hand pauses autoplay
        assert!(!State::new(5).press(Key::Autoplay).press(Key::Next).autoplay);
    }

    /// Every lesson's static (piped) output, plain and in color.
    #[test]
    fn lesson_walkthrough_snapshots() {
        for n in 1..=LESSONS.len() {
            let t = tour(n);
            let plain = walkthrough(&Paint::fixed(false, true), &t, 80).join("\n");
            for line in plain.lines() {
                assert!(line.chars().count() <= 78, "lesson {n}: {line}");
            }
            assert!(plain.contains(LESSONS[n - 1].promise), "lesson {n} shows its promise");
            if n < LESSONS.len() {
                let next = format!("Next: riscvsim demo {} ({})", n + 1, LESSONS[n].title());
                assert!(plain.trim_end().ends_with(&next), "lesson {n} ends with {next}:\n{plain}");
            } else {
                assert!(plain.contains("You finished all six lessons."), "{plain}");
            }
            crate::snapshots::check(&format!("demo.lesson{n}.nocolor.80"), &plain);
            let color = walkthrough(&Paint::fixed(true, true), &t, 80).join("\n");
            crate::snapshots::check(&format!("demo.lesson{n}.color.80"), &crate::snapshots::mark_ansi(&color));
        }
    }

    #[test]
    fn loops_lesson_keeps_the_counter_in_view() {
        let plain = walkthrough(&Paint::fixed(false, true), &tour(5), 80).join("\n");
        let watched = plain.lines().filter(|l| l.trim_start().starts_with("counter x5 = ")).count();
        assert_eq!(watched, tour(5).last(), "every cycle shows the counter");
        assert!(plain.contains("counter x5 = 7 · sum x6 = 27"), "{plain}");
        assert!(plain.contains("Ends with x5 = 0 · x6 = 55"), "{plain}");
    }

    #[test]
    fn menu_snapshots() {
        let plain = menu(&Paint::fixed(false, true), 80).join("\n");
        for (i, l) in LESSONS.iter().enumerate() {
            assert!(plain.contains(&format!("{:>2}  {}", i + 1, l.title())), "{plain}");
            assert!(plain.contains(l.promise) && plain.contains(l.slug));
        }
        for line in plain.lines() {
            assert!(line.chars().count() <= 78, "{line}");
        }
        crate::snapshots::check("demo.menu.nocolor.80", &plain);
        crate::snapshots::check("demo.menu.nocolor.120", &menu(&Paint::fixed(false, true), 120).join("\n"));
        crate::snapshots::check("demo.menu.nocolor.60", &menu(&Paint::fixed(false, true), 60).join("\n"));
        let ascii = menu(&Paint::fixed(false, false), 80).join("\n");
        assert!(ascii.is_ascii(), "{ascii}");
        crate::snapshots::check("demo.menu.ascii.80", &ascii);
        let color = menu(&Paint::fixed(true, true), 80).join("\n");
        crate::snapshots::check("demo.menu.color.80", &crate::snapshots::mark_ansi(&color));
    }

    #[test]
    fn static_walkthrough_ascii_and_color() {
        let ascii = walkthrough(&Paint::fixed(false, false), &tour(2), 80).join("\n");
        assert!(ascii.is_ascii(), "{ascii}");
        assert!(ascii.contains("    ! lw is reading memory. add must wait one cycle because it needs x7 from"), "{ascii}");
        assert!(ascii.contains("bubble"));
        let color = walkthrough(&Paint::fixed(true, true), &tour(2), 80).join("\n");
        assert!(color.contains("\x1b[33mbubble\x1b[0m"), "stalls are yellow");
        for line in color.lines() {
            assert!(visible_width(line) <= 78, "{line}");
        }
        let flush = walkthrough(&Paint::fixed(false, true), &tour(4), 80).join("\n");
        assert!(flush.contains("✗ The branch was wrong"), "{flush}");
        assert!(flush.contains("Why it slowed down:"));
    }

    #[test]
    fn interactive_frames_fit_80x24_and_120x40() {
        let p = Paint::fixed(false, true);
        for (w, h) in [(80, 24), (120, 40)] {
            for n in 1..=LESSONS.len() + 1 {
                // the six lessons, then array-sum (a sample that is not one)
                let t = if n <= LESSONS.len() { tour(n) } else { Tour::new(4, &crate::tui::samples::SAMPLES[3]).unwrap() };
                let mut s = State::new(t.last());
                loop {
                    let lines = frame(&p, &t, &s, w, h);
                    assert!(lines.len() <= h, "demo {n} cycle {} has {} lines at {w}x{h}", s.at, lines.len());
                    for l in &lines {
                        assert!(visible_width(l) <= 78.max(w.min(110)), "{l}");
                    }
                    if s.at == s.last {
                        break;
                    }
                    s = s.press(Key::Next);
                }
            }
        }
    }

    #[test]
    fn interactive_frame_snapshot() {
        let p = Paint::fixed(false, true);
        let t = tour(2);
        let stall = t.snaps.iter().position(|s| s.view.stall.is_some()).expect("lesson 2 stalls");
        let s = State::new(t.last());
        let s = (0..stall).fold(s, |s, _| s.press(Key::Next));
        let text = frame(&p, &t, &s, 80, 24).join("\n");
        crate::snapshots::check("demo.frame.lesson2.stall.80x24", &text);
        assert!(text.contains("! lw is reading memory. add must wait one cycle because it needs x7 from lw."), "{text}");
        assert!(text.lines().count() <= 24);
    }

    #[test]
    fn color_frame_uses_only_basic_ansi() {
        let p = Paint::fixed(true, true);
        let t = tour(3);
        let s = (0..7).fold(State::new(t.last()), |s, _| s.press(Key::Next));
        let text = frame(&p, &t, &s, 80, 24).join("\n");
        for code in text.split("\x1b[").skip(1) {
            let sgr = code.split('m').next().unwrap();
            assert!(
                matches!(sgr, "0" | "1" | "31" | "32" | "33" | "36" | "90" | "1;32" | "1;31" | "1;36"),
                "unexpected SGR {sgr}"
            );
        }
    }

    #[test]
    fn rv64_walkthrough_snapshots() {
        let t = tour(6);
        let plain = walkthrough(&Paint::fixed(false, true), &t, 80).join("\n");
        assert!(plain.contains("x6 = 0x0000_0100_0000_0005"), "{plain}");
        assert!(plain.contains("x10 = -1"), "{plain}");
        assert!(plain.contains("addw"), "{plain}");
        // (the full text is the demo.lesson6 snapshot)
        assert!(plain.contains("x10 = -1 (0xffff_ffff_ffff_ffff)"), "{plain}");
    }

    #[test]
    fn enter_at_the_end_of_a_lesson_opens_the_next_one() {
        let one = tour(1);
        let end = (0..one.last()).fold(State::new(one.last()), |s, _| s.press(Key::Next));
        assert_eq!(advances_lesson(&one, &end, Key::Next), Some(2));
        assert_eq!(advances_lesson(&one, &end, Key::Quit), None);
        assert_eq!(advances_lesson(&one, &State::new(one.last()), Key::Next), None, "only at the end");
        let six = tour(6);
        let end6 = (0..six.last()).fold(State::new(six.last()), |s, _| s.press(Key::Next));
        assert_eq!(advances_lesson(&six, &end6, Key::Next), None, "the course is over");
        let extra = Tour::new(4, &crate::tui::samples::SAMPLES[3]).unwrap();
        let end_x = (0..extra.last()).fold(State::new(extra.last()), |s, _| s.press(Key::Next));
        assert_eq!(advances_lesson(&extra, &end_x, Key::Next), None, "not a lesson");

        for (name, color) in [("nocolor", false), ("color", true)] {
            let p = Paint::fixed(color, true);
            let text = frame(&p, &one, &end, 80, 24).join("\n");
            assert!(text.lines().count() <= 24);
            let shown = if color { crate::snapshots::mark_ansi(&text) } else { text.clone() };
            crate::snapshots::check(&format!("demo.frame.lesson1.end.{name}.80x24"), &shown);
            if !color {
                assert!(text.contains("Enter next lesson   r restart   b back   q quit"), "{text}");
            }
        }
        let last = frame(&Paint::fixed(false, true), &six, &end6, 80, 24).join("\n");
        assert!(!last.contains("next lesson"), "{last}");
    }

    #[test]
    fn glosses_appear_once_on_first_use() {
        let t = tour(2);
        let plain = walkthrough(&Paint::fixed(false, true), &t, 80).join("\n");
        for (_, gloss) in [crate::explain::GLOSSARY[0], crate::explain::GLOSSARY[2]] {
            let first = gloss.split_whitespace().take(4).collect::<Vec<_>>().join(" ");
            assert_eq!(plain.matches(&first).count(), 1, "{first}:\n{plain}");
        }
        assert!(!plain.contains("latch"), "no unexplained jargon");
    }
}

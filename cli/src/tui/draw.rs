//! All TUI rendering. State lives in `App`; this module turns it into a
//! frame and records the clickable hit regions for the mouse handler.

use super::app::{
    Act, App, Gate, Hit, Tab, FWD_TRAVEL_MS, REG_FLASH_MS, SPEEDS, STAGE_PULSE_MS, TOUR_STEPS,
};
use super::logo;
use super::samples::SAMPLES;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::symbols::border;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Clear, Paragraph, Wrap};
use ratatui::Frame;
use crate::machine::{self, StageState};
use std::time::Instant;

// Registers are labelled x0 to x31, the names every lesson and "why"
// line uses (ABI names such as sp appear only in run's register table).
const STAGE_LABELS: [(&str, &str); 5] = [
    ("IF", "Fetch"),
    ("ID", "Decode"),
    ("EX", "Execute"),
    ("MEM", "Memory"),
    ("WB", "Writeback"),
];

const ASCII_BORDER: border::Set = border::Set {
    top_left: "+",
    top_right: "+",
    bottom_left: "+",
    bottom_right: "+",
    vertical_left: "|",
    vertical_right: "|",
    horizontal_top: "-",
    horizontal_bottom: "-",
};

struct Th {
    color: bool,
    unicode: bool,
}

impl Th {
    fn fg(&self, c: Color) -> Style {
        if self.color {
            Style::new().fg(c)
        } else {
            Style::new()
        }
    }
    fn accent(&self) -> Style {
        self.fg(Color::Green)
    }
    fn warn(&self) -> Style {
        self.fg(Color::Yellow)
    }
    fn err(&self) -> Style {
        self.fg(Color::Red)
    }
    fn info(&self) -> Style {
        self.fg(Color::Cyan)
    }
    fn ok(&self) -> Style {
        self.fg(Color::Green)
    }
    fn dim(&self) -> Style {
        if self.color {
            Style::new().fg(Color::DarkGray)
        } else {
            Style::new().add_modifier(Modifier::DIM)
        }
    }
    fn border_set(&self) -> border::Set {
        if self.unicode {
            border::ROUNDED
        } else {
            ASCII_BORDER
        }
    }
    fn sym(&self, uni: &'static str, ascii: &'static str) -> &'static str {
        if self.unicode {
            uni
        } else {
            ascii
        }
    }
}

fn trunc(s: &str, w: usize) -> String {
    if s.chars().count() <= w {
        s.to_string()
    } else if w <= 1 {
        s.chars().take(w).collect()
    } else {
        let mut out: String = s.chars().take(w - 1).collect();
        out.push('…');
        out
    }
}

pub fn draw(f: &mut Frame, app: &mut App) {
    draw_frame(f, app);
    if !app.caps.unicode {
        ascii_fallback(f);
    }
}

/// Non-UTF-8 terminals: swap every non-ASCII cell for an ASCII stand-in,
/// cell for cell, so the layout is unchanged and nothing prints as mojibake.
fn ascii_fallback(f: &mut Frame) {
    let area = f.area();
    let buf = f.buffer_mut();
    for y in area.top()..area.bottom() {
        for x in area.left()..area.right() {
            let cell = &mut buf[(x, y)];
            let sym = cell.symbol();
            if sym.is_ascii() {
                continue;
            }
            let ascii = match sym.chars().next().unwrap_or(' ') {
                '·' | '•' | '●' => "*",
                '…' => ".",
                '‹' | '←' | '◀' | '⟵' => "<",
                '›' | '→' | '▶' | '⟶' => ">",
                '↑' | '▲' => "^",
                '↓' | '▼' | '▾' => "v",
                '—' | '–' | '─' | '━' | '═' | '╌' => "-",
                '│' | '┃' | '║' | '╎' => "|",
                '✕' | '✗' | '×' => "x",
                '✓' => "+",
                '┌' | '┐' | '└' | '┘' | '├' | '┤' | '┬' | '┴' | '┼' | '╭' | '╮' | '╰' | '╯' => "+",
                c if c.is_whitespace() => " ",
                _ => "?",
            };
            cell.set_symbol(ascii);
        }
    }
}

fn draw_frame(f: &mut Frame, app: &mut App) {
    app.hits.clear();
    let th = Th {
        color: app.caps.color,
        unicode: app.caps.unicode,
    };
    let area = f.area();

    if area.width < MIN_WIDTH || area.height < 20 {
        let msg = Paragraph::new(vec![
            Line::from(""),
            Line::from(Span::styled("riscvsim needs a bigger window", Style::new().add_modifier(Modifier::BOLD))),
            Line::from(format!("now {}x{}, needs at least {MIN_WIDTH}x20", area.width, area.height)),
            Line::from(""),
            Line::from(Span::styled("make the window larger, or press q to quit", th.dim())),
        ])
        .wrap(Wrap { trim: true })
        .centered();
        f.render_widget(msg, area);
        return;
    }

    match app.gate {
        Gate::Welcome => {
            draw_welcome(f, app, &th);
            return;
        }
        Gate::Done => {}
    }

    let [header, body, term, controls, prompt, status] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(12),
        Constraint::Length(7),
        Constraint::Length(2),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(area);

    // Below 80 columns the source pane folds away and the pipeline gets the
    // whole width (each stage row still names the instruction).
    draw_header(f, app, &th, header);
    if area.width >= SOURCE_PANE_MIN {
        let [src, right] =
            Layout::horizontal([Constraint::Percentage(38), Constraint::Percentage(62)]).areas(body);
        app.rect_source = src;
        draw_source(f, app, &th, src);
        draw_right(f, app, &th, right);
    } else {
        app.rect_source = body;
        draw_right(f, app, &th, body);
    }
    app.rect_terminal = term;
    draw_terminal(f, app, &th, term);
    draw_controls(f, app, &th, controls);
    draw_prompt(f, app, &th, prompt);
    draw_status(f, app, &th, status);

    if app.menu_open {
        draw_sample_menu(f, app, &th, controls);
    }
    if app.help_open {
        draw_help(f, app, &th, area);
    }
    if app.tour.is_some() {
        draw_tour(f, app, &th, area);
    }
}

// ---------------------------------------------------------------------------
// Startup gate: the welcome screen.
// ---------------------------------------------------------------------------

fn draw_welcome(f: &mut Frame, app: &App, th: &Th) {
    let area = f.area();
    let version = concat!("v", env!("CARGO_PKG_VERSION"));
    let release = app
        .update_status
        .lock()
        .ok()
        .and_then(|guard| guard.clone());

    let mut left: Vec<Line> = vec![
        Line::from(""),
        Line::styled(
            "Welcome to riscvsim!",
            Style::new().add_modifier(Modifier::BOLD),
        )
        .centered(),
        Line::from(""),
    ];
    let frame_style = th.accent();
    let glyph_style = Style::new().add_modifier(Modifier::BOLD);
    for row in logo::chip(th.unicode) {
        let spans: Vec<Span> = row
            .chars()
            .map(|c| {
                Span::styled(
                    c.to_string(),
                    if logo::is_glyph_char(c) {
                        glyph_style
                    } else {
                        frame_style
                    },
                )
            })
            .collect();
        left.push(Line::from(spans).centered());
    }
    left.push(Line::from(""));
    left.push(Line::styled(
        format!("{version} | {} 5-stage pipeline", if app.xlen == 64 { "RV64IM" } else { "RV32IM" }),
        th.dim(),
    ));
    left.push(Line::styled(format!("file: {}", app.file_name), th.dim()));
    left.push(Line::styled(
        format!("cwd: {}", trunc(&app.working_dir, 31)),
        th.dim(),
    ));

    let bullet = th.sym("·", "*");
    let key = |k: &str, what: &str| {
        Line::from(vec![
            Span::styled(format!(" {bullet} "), th.dim()),
            Span::styled(format!("{k:<12}"), Style::new().add_modifier(Modifier::BOLD)),
            Span::styled(what.to_string(), th.dim()),
        ])
    };
    let mut right: Vec<Line> = vec![
        Line::from(""),
        Line::styled("Watch RISC-V run, cycle by cycle", Style::new().add_modifier(Modifier::BOLD)),
        Line::styled(" through a real 5-stage pipeline.", th.dim()),
        Line::from(""),
        Line::styled("Try", Style::new().add_modifier(Modifier::BOLD)),
        key("/demo", "run a sample program"),
        key("/run prog.s", "run your own file"),
        key(th.sym("→", ">"), "then step one cycle"),
        Line::from(""),
        Line::styled("Help", Style::new().add_modifier(Modifier::BOLD)),
        key("/help", "every command"),
        key("?", "keyboard shortcuts"),
    ];
    if let Some(status) = &release {
        if status.update_available {
            right.push(Line::from(""));
            right.push(Line::styled(
                format!("{} {} available", th.sym("▲", "^"), status.latest),
                th.warn().add_modifier(Modifier::BOLD),
            ));
            right.push(Line::styled("  Run /doctor for update steps", th.warn()));
        }
    }

    // Narrow windows: one column, the words first and no logo.
    let narrow = area.width < 72;
    if narrow {
        let details: Vec<Line> = left.split_off(left.len() - 3);
        left.truncate(2);
        left.append(&mut right);
        left.push(Line::from(""));
        left.extend(details);
    }
    let left_w = if narrow { area.width.saturating_sub(4) } else { 36u16 };
    let right_w = 40u16;
    let box_w = if narrow { area.width.saturating_sub(2) } else { (left_w + right_w + 3).min(area.width.saturating_sub(2)) };
    let rows = left.len().max(right.len()) as u16;
    let box_h = rows + 2;
    let bx = (area.width.saturating_sub(box_w)) / 2;
    let by = (area.height.saturating_sub(box_h + 4)) / 2;
    let rect = Rect::new(bx, by, box_w, box_h.min(area.height.saturating_sub(3)));

    let block = Block::bordered()
        .border_set(th.border_set())
        .border_style(th.accent())
        .title(Line::from(vec![
            Span::styled(" riscvsim ", th.accent().add_modifier(Modifier::BOLD)),
            Span::styled(format!("{version} "), th.dim()),
        ]));
    let inner = block.inner(rect);
    f.render_widget(block, rect);

    let [left_area, divider, right_area] = Layout::horizontal([
        Constraint::Length(left_w),
        Constraint::Length(1),
        Constraint::Min(10),
    ])
    .areas(inner);
    if narrow {
        f.render_widget(Paragraph::new(left), inner);
    } else {
        draw_welcome_columns(f, th, area, left, divider, left_area, right, right_area);
    }
    draw_welcome_prompt(f, app, th, area, rect, release);
}

#[allow(clippy::too_many_arguments)]
fn draw_welcome_columns(
    f: &mut Frame,
    th: &Th,
    area: Rect,
    left: Vec<Line<'static>>,
    divider: Rect,
    left_area: Rect,
    right: Vec<Line<'static>>,
    right_area: Rect,
) {
    f.render_widget(Paragraph::new(left), left_area);
    let buf = f.buffer_mut();
    for y in divider.y..divider.bottom() {
        if divider.x < area.right() {
            buf[(divider.x, y)]
                .set_symbol(th.sym("│", "|"))
                .set_style(th.dim());
        }
    }
    f.render_widget(Paragraph::new(right), right_area);
}

fn draw_welcome_prompt(
    f: &mut Frame,
    app: &App,
    th: &Th,
    area: Rect,
    rect: Rect,
    release: Option<crate::update::ReleaseStatus>,
) {
    let prompt_y = rect.bottom().min(area.bottom().saturating_sub(2));
    let mut prompt = vec![Span::styled("> ", th.accent().add_modifier(Modifier::BOLD))];
    if app.command_input.is_empty() {
        prompt.push(Span::styled("Try \"/help\"", th.dim()));
    } else {
        prompt.push(Span::raw(app.command_input.clone()));
    }
    prompt.push(Span::styled(
        " ",
        Style::new().add_modifier(Modifier::REVERSED),
    ));
    f.render_widget(
        Paragraph::new(Line::from(prompt)),
        Rect::new(rect.x + 1, prompt_y + 1, rect.width.saturating_sub(2), 1),
    );

    let update = match release {
        Some(status) if status.update_available => "update available; /doctor",
        Some(_) => "current",
        None => "updates: /doctor",
    };
    let footer = format!("{} | {update}", app.install_method.label());
    f.render_widget(
        Paragraph::new(Span::styled(footer, th.dim())),
        Rect::new(rect.x + 1, prompt_y + 2, rect.width.saturating_sub(2), 1),
    );
}

// ---------------------------------------------------------------------------
// Header / status
// ---------------------------------------------------------------------------

fn draw_header(f: &mut Frame, app: &mut App, th: &Th, area: Rect) {
    let mut left = vec![
        Span::raw(" "),
        Span::styled(
            logo::mini_mark(th.unicode),
            th.accent().add_modifier(Modifier::BOLD),
        ),
        Span::styled(" riscvsim ", Style::new().add_modifier(Modifier::BOLD)),
        Span::styled(concat!("v", env!("CARGO_PKG_VERSION")), th.dim()),
    ];
    // file · [RV64 ·] cycle · pc, keeping whole items that fit before the ✕.
    let mut items = vec![app.file_name.clone()];
    if app.xlen == 64 {
        items.push("RV64".into());
    }
    if let Some(snap) = &app.snap {
        items.push(format!("cycle {}", snap.cycle));
        items.push(format!("pc {}", machine::addr(snap.pc)));
    }
    let used: usize = left.iter().map(|s| s.content.chars().count()).sum();
    let room = (area.width as usize).saturating_sub(used + 4);
    let mut tail = String::new();
    for item in items {
        let next = format!("{tail}  ·  {item}");
        if next.chars().count() > room {
            break;
        }
        tail = next;
    }
    left.push(Span::styled(tail, th.dim()));
    f.render_widget(Paragraph::new(Line::from(left)), area);

    // clickable ✕ in the corner
    let quit = th.sym(" ✕ ", " x ");
    let qrect = Rect::new(area.right().saturating_sub(4), area.y, 3, 1);
    let qstyle = if app.hover == Some(Act::Quit) {
        th.err().add_modifier(Modifier::BOLD)
    } else {
        th.dim()
    };
    f.render_widget(Paragraph::new(Span::styled(quit, qstyle)), qrect);
    app.hits.push(Hit {
        rect: qrect,
        act: Act::Quit,
    });
}

fn draw_status(f: &mut Frame, app: &mut App, th: &Th, area: Rect) {
    let (text, tone) = &app.status;
    let style = match *tone {
        "ok" => th.accent(),
        "err" => th.err(),
        _ => th.dim(),
    };
    f.render_widget(
        Paragraph::new(Line::from(Span::styled(format!(" {text}"), style))),
        area,
    );

    let update_available = app
        .update_status
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .is_some_and(|status| status.update_available);
    let used = text.chars().count() as u16 + 3;
    let room = area.width.saturating_sub(used);
    let hints = footer_hints(th, room as usize, update_available, &app.speed().label());
    let width = hints.iter().map(|s| s.content.chars().count()).sum::<usize>() as u16;
    if width > 0 && width < room {
        let x0 = area.right() - width - 1;
        // "? help" and "q quit" stay clickable.
        let mut x = x0;
        for (i, span) in hints.iter().enumerate() {
            let w = span.content.chars().count() as u16;
            let act = match span.content.as_ref() {
                "?" => Some(Act::Help),
                "q" => Some(Act::Quit),
                _ => None,
            };
            if let Some(act) = act {
                let label_w = hints.get(i + 1).map_or(0, |s| s.content.chars().count() as u16);
                app.hits.push(Hit { rect: Rect::new(x, area.y, w + label_w, 1), act });
            }
            x += w;
        }
        f.render_widget(Paragraph::new(Line::from(hints)), Rect::new(x0, area.y, width, 1));
    }
}

/// The footer's shortcut list, as long as fits in `room` columns.
fn footer_hints(th: &Th, room: usize, update_available: bool, speed: &str) -> Vec<Span<'static>> {
    let keys: [(&str, String); 7] = [
        (th.sym("→", ">"), "step".into()),
        (th.sym("←", "<"), "back".into()),
        ("space", "run".into()),
        ("r", "reset".into()),
        ("?", "help".into()),
        ("q", "quit".into()),
        ("+/-", format!("speed {speed}")),
    ];
    let sep = th.sym(" · ", " | ");
    let mut best = Vec::new();
    // Drop optional hints from the middle until the rest fits.
    for keep in [&[0, 1, 2, 6, 3, 4, 5][..], &[0, 1, 2, 6, 4, 5], &[0, 1, 2, 3, 4, 5], &[0, 2, 6, 4, 5], &[0, 2, 4, 5], &[0, 2, 5], &[5]] {
        let mut spans: Vec<Span<'static>> = Vec::new();
        if update_available {
            spans.push(Span::styled("update: /doctor", th.warn()));
            spans.push(Span::styled(sep, th.dim()));
        }
        for (n, &i) in keep.iter().enumerate() {
            if n > 0 {
                spans.push(Span::styled(sep, th.dim()));
            }
            spans.push(Span::styled(keys[i].0, Style::new().add_modifier(Modifier::BOLD)));
            spans.push(Span::styled(format!(" {}", keys[i].1), th.dim()));
        }
        let w: usize = spans.iter().map(|s| s.content.chars().count()).sum();
        if w + 1 < room {
            best = spans;
            break;
        }
    }
    best
}

fn draw_prompt(f: &mut Frame, app: &App, th: &Th, area: Rect) {
    let mut spans = vec![Span::styled("> ", th.accent().add_modifier(Modifier::BOLD))];
    if app.command_input.is_empty() {
        spans.push(Span::styled(
            if app.prompt_active {
                "Try /help or paste one RISC-V instruction"
            } else {
                "Press Enter for commands"
            },
            th.dim(),
        ));
    } else {
        spans.push(Span::raw(app.command_input.clone()));
    }
    if app.prompt_active {
        spans.push(Span::styled(
            " ",
            Style::new().add_modifier(Modifier::REVERSED),
        ));
    }
    f.render_widget(Paragraph::new(Line::from(spans)), area);
}

// ---------------------------------------------------------------------------
// Source panel
// ---------------------------------------------------------------------------

fn draw_source(f: &mut Frame, app: &mut App, th: &Th, area: Rect) {
    let block = Block::bordered()
        .border_set(th.border_set())
        .border_style(th.dim())
        .title(Line::from(vec![
            Span::styled(" source ", Style::new().add_modifier(Modifier::BOLD)),
            Span::styled(format!("· {} ", app.file_name), th.dim()),
        ]));
    let inner = block.inner(area);
    f.render_widget(block, area);

    // Map source lines to in-flight pipeline stages.
    let mut stage_of_line: Vec<(usize, &str)> = Vec::new();
    let mut exec_line: Option<usize> = None;
    if let Some(snap) = &app.snap {
        for st in &snap.stages {
            if st.state == StageState::Normal {
                if let Some(line) = st.line {
                    stage_of_line.push((line, st.name));
                    if st.name == "EX" {
                        exec_line = Some(line);
                    }
                }
            }
        }
    }

    let src_lines: Vec<&str> = app.source.lines().collect();
    let total = src_lines.len();
    let h = inner.height as usize;
    let scroll = match app.src_scroll {
        Some(s) => (s as usize).min(total.saturating_sub(h)),
        None => {
            // follow the selection, else execution: keep it roughly centered
            let center = app.src_sel.or(exec_line).unwrap_or(1);
            center
                .saturating_sub(h / 2 + 1)
                .min(total.saturating_sub(h))
        }
    };

    let gutter_w = total.to_string().len().max(2);
    let mut lines: Vec<Line> = Vec::new();
    for (idx, text) in src_lines.iter().enumerate().skip(scroll).take(h) {
        let lineno = idx + 1;
        let is_exec = exec_line == Some(lineno);
        let marker = if app.breakpoints.contains(&lineno) {
            Span::styled(th.sym("●", "*"), th.err().add_modifier(Modifier::BOLD))
        } else if is_exec {
            Span::styled(th.sym("▶", ">"), th.accent().add_modifier(Modifier::BOLD))
        } else {
            Span::raw(" ")
        };
        let num = if app.src_sel == Some(lineno) {
            Span::styled(format!("{lineno:>gutter_w$}"), Style::new().add_modifier(Modifier::REVERSED)).patch_style(Style::new())
        } else {
            Span::styled(format!("{lineno:>gutter_w$}"), th.dim())
        };
        let num = Span::styled(format!("{} ", num.content), num.style);
        let body_style = if is_exec {
            Style::new().add_modifier(Modifier::BOLD)
        } else if text.trim_start().starts_with('#') {
            th.dim()
        } else {
            Style::new()
        };
        let badges: Vec<&str> = stage_of_line
            .iter()
            .filter(|(l, _)| *l == lineno)
            .map(|(_, s)| *s)
            .collect();
        let avail = (inner.width as usize)
            .saturating_sub(gutter_w + 2)
            .saturating_sub(if badges.is_empty() {
                0
            } else {
                badges.len() * 4 + 1
            });
        let mut spans = vec![marker, num, Span::styled(trunc(text, avail), body_style)];
        if !badges.is_empty() {
            spans.push(Span::styled(
                format!(
                    " {}",
                    badges
                        .iter()
                        .map(|b| format!("‹{b}›"))
                        .collect::<Vec<_>>()
                        .join(" ")
                ),
                th.info(),
            ));
        }
        lines.push(Line::from(spans));
    }
    f.render_widget(Paragraph::new(lines), inner);
}

// ---------------------------------------------------------------------------
// Right pane: tab card
// ---------------------------------------------------------------------------

fn draw_right(f: &mut Frame, app: &mut App, th: &Th, area: Rect) {
    let block = Block::bordered()
        .border_set(th.border_set())
        .border_style(th.dim());
    let inner = block.inner(area);
    f.render_widget(block, area);
    app.rect_pipeline = area;

    let [tabs_row, content] =
        Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).areas(inner);

    // Tab headers, both clickable.
    let mut x = tabs_row.x + 1;
    for (label, act, tab) in [
        ("Pipeline", Act::TabPipeline, Tab::Pipeline),
        ("Registers · Memory", Act::TabState, Tab::State),
    ] {
        let label = if th.unicode {
            label.to_string()
        } else {
            label.replace('·', "+")
        };
        let w = label.chars().count() as u16 + 2;
        let rect = Rect::new(x, tabs_row.y, w.min(tabs_row.right().saturating_sub(x)), 1);
        let active = app.tab == tab;
        let mut style = if active {
            th.accent()
                .add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
        } else {
            th.dim()
        };
        if app.hover == Some(act) && !active {
            style = Style::new().add_modifier(Modifier::BOLD);
        }
        if app.pressed == Some(act) {
            style = style.add_modifier(Modifier::REVERSED);
        }
        f.render_widget(
            Paragraph::new(Span::styled(format!(" {label} "), style)),
            rect,
        );
        app.hits.push(Hit { rect, act });
        x += w + 2;
    }

    match app.tab {
        Tab::Pipeline => draw_pipeline_tab(f, app, th, content),
        Tab::State => draw_state_tab(f, app, th, content),
    }
}

// ---------------------------------------------------------------------------
// Pipeline tab
// ---------------------------------------------------------------------------

/// The narrowest terminal the simulator draws in.
pub const MIN_WIDTH: u16 = 60;
/// From this width the source pane sits beside the pipeline.
const SOURCE_PANE_MIN: u16 = 80;
/// From this width the stages are five boxes side by side; below it, one
/// row per stage so every instruction stays readable.
const STAGE_BOXES_MIN: u16 = 120;
/// From this width the stage rows also spell out the stage name.
const STAGE_WORDS_MIN: u16 = 100;

/// One stage's instruction text, shortened on whole tokens.
fn stage_fit(th: &Th, text: &str, room: usize) -> String {
    crate::explain::fit_instr(text, room, th.unicode)
}

fn draw_pipeline_tab(f: &mut Frame, app: &mut App, th: &Th, area: Rect) {
    if f.area().width < STAGE_BOXES_MIN {
        draw_pipeline_rows(f, app, th, area);
        return;
    }
    let [boxes_row, lanes, chips, stats_row] = Layout::vertical([
        Constraint::Length(5),
        Constraint::Length(3),
        Constraint::Min(2),
        Constraint::Length(1),
    ])
    .areas(area);

    let cols = Layout::horizontal([Constraint::Ratio(1, 5); 5])
        .spacing(1)
        .split(boxes_row);

    let now = Instant::now();
    let snap = app.snap.as_ref();
    let mut centers = [0u16; 5];

    for i in 0..5 {
        let rect = cols[i];
        centers[i] = rect.x + rect.width / 2;
        let (code, word) = STAGE_LABELS[i];
        let stage = snap.and_then(|s| s.stages.get(i));
        let state = stage.map(|s| &s.state).unwrap_or(&StageState::Empty);

        let pulsing = app.anims.stage_pulse[i]
            .map(|t| now.duration_since(t).as_millis() < STAGE_PULSE_MS as u128)
            .unwrap_or(false);
        let border_style = if pulsing {
            th.accent().add_modifier(Modifier::BOLD)
        } else {
            match state {
                StageState::Stall => th.warn(),
                StageState::Flush => th.err(),
                StageState::Empty => th.dim(),
                StageState::Normal => Style::new(),
            }
        };
        let block = Block::bordered()
            .border_set(th.border_set())
            .border_style(border_style)
            .title(Line::from(
                // "EX·Execute" when it fits the box, otherwise just "EX".
                if (code.len() + 1 + word.len() + 2) as u16 <= rect.width {
                    vec![
                        Span::styled(code, Style::new().add_modifier(Modifier::BOLD)),
                        Span::styled(format!("·{word}"), th.dim()),
                    ]
                } else {
                    vec![Span::styled(code, Style::new().add_modifier(Modifier::BOLD))]
                },
            ));
        let inner = block.inner(rect);
        f.render_widget(block, rect);

        let w = inner.width as usize;
        let mut lines: Vec<Line> = Vec::new();
        match state {
            StageState::Empty => lines.push(Line::styled("—", th.dim())),
            StageState::Stall => {
                lines.push(Line::styled(trunc(&bubble(th), w), th.dim()));
                lines.push(Line::styled(
                    "stall",
                    th.warn().add_modifier(Modifier::BOLD),
                ));
            }
            StageState::Flush => {
                let text = stage
                    .and_then(|s| s.text.clone())
                    .unwrap_or_else(|| "bubble".into());
                lines.push(Line::styled(stage_fit(th, &text, w), th.err()));
                lines.push(Line::styled(
                    format!("{} flushed", th.sym("✗", "x")),
                    th.err().add_modifier(Modifier::BOLD),
                ));
            }
            StageState::Normal => {
                let text = stage.and_then(|s| s.text.clone()).unwrap_or_default();
                lines.push(Line::styled(stage_fit(th, &text, w), Style::new()));
                if let Some(detail) = stage.and_then(|s| s.detail.clone()) {
                    let detail = match waits_for(&detail) {
                        Some(d) if d.chars().count() + 2 <= w => format!("! {d}"),
                        Some(d) => format!("! wait {}", d.trim_start_matches("waits for ")),
                        None => detail,
                    };
                    lines.push(Line::styled(trunc(&detail, w), th.warn()));
                } else {
                    lines.push(Line::from(""));
                }
                // The address only when it fits whole.
                if let Some(pc) = stage.and_then(|s| s.pc).map(machine::addr).filter(|a| a.chars().count() <= w) {
                    lines.push(Line::styled(pc, th.dim()));
                }
            }
        }
        f.render_widget(Paragraph::new(lines), inner);
    }

    draw_forward_lanes(f, app, th, lanes, centers, now);
    draw_hazard_chips(f, app, th, chips);
    draw_stats(f, app, th, stats_row);
}

fn bubble(th: &Th) -> String {
    format!("{} bubble", th.sym("◌", "o"))
}

/// What a load-use stall is waiting for, from the engine's reason:
/// "load-use hazard: waiting for x1 from 'lw ...'" -> "waits for x1".
fn waits_for(reason: &str) -> Option<String> {
    let reg = reason.split("waiting for ").nth(1)?.split_whitespace().next()?;
    Some(format!("waits for {reg}"))
}

/// Compact layout (below 100 columns): one row per stage.
///
/// ```text
///  IF   add x3, x2, x1
///  ID   ◌ bubble
///  EX   addi x2, x1, 3          ◂ x1=5 from EX/MEM
/// ```
fn draw_pipeline_rows(f: &mut Frame, app: &mut App, th: &Th, area: Rect) {
    let [rows, _gap, chips, stats_row] = Layout::vertical([
        Constraint::Length(5),
        Constraint::Length(1),
        Constraint::Min(2),
        Constraint::Length(1),
    ])
    .areas(area);
    let now = Instant::now();
    let snap = app.snap.as_ref();
    let width = rows.width as usize;
    let words = f.area().width >= STAGE_WORDS_MIN;
    let label_w = if words { 15 } else { 5 }; // " MEM Memory     " or " MEM "
    let mut lines: Vec<Line> = Vec::new();
    for (i, &(code, word)) in STAGE_LABELS.iter().enumerate() {
        let stage = snap.and_then(|s| s.stages.get(i));
        let state = stage.map(|s| s.state.clone()).unwrap_or(StageState::Empty);
        let pulsing = app.anims.stage_pulse[i]
            .map(|t| now.duration_since(t).as_millis() < STAGE_PULSE_MS as u128)
            .unwrap_or(false);
        let label_style = if pulsing {
            th.accent().add_modifier(Modifier::BOLD)
        } else {
            match state {
                StageState::Stall => th.warn().add_modifier(Modifier::BOLD),
                StageState::Flush => th.err().add_modifier(Modifier::BOLD),
                StageState::Empty => th.dim(),
                StageState::Normal => Style::new().add_modifier(Modifier::BOLD),
            }
        };
        let room = width.saturating_sub(label_w + 1);
        // (text, style) and right-hand notes, most useful first. A note
        // that explains the cycle shows while the text keeps at least 10
        // columns; the address only when the text still reads in full.
        let (text, style, notes): (String, Style, Vec<(String, Style)>) = match state {
            StageState::Empty => ("—".into(), th.dim(), vec![]),
            StageState::Stall => (bubble(th), th.dim(), vec![("stall".into(), th.warn())]),
            StageState::Flush => {
                let t = stage.and_then(|s| s.text.clone()).unwrap_or_else(|| "bubble".into());
                (t, th.err(), vec![(format!("{} flushed", th.sym("✗", "x")), th.err())])
            }
            StageState::Normal => {
                let t = stage.and_then(|s| s.text.clone()).unwrap_or_default();
                let mut notes = Vec::new();
                if let Some(fw) = (code == "EX").then(|| snap.and_then(|s| s.view.forwards.first())).flatten() {
                    let from = if fw.from == "exmem" { "EX/MEM" } else { "MEM/WB" };
                    let arrow = th.sym("◂", "<");
                    let v = machine::short_value(fw.value, app.xlen);
                    notes.push((format!("{arrow} {}={v} from {from}", fw.reg), th.accent()));
                    notes.push((format!("{arrow} {} from {from}", fw.reg), th.accent()));
                }
                if let Some(w) = stage.and_then(|s| s.detail.as_deref()).and_then(waits_for) {
                    notes.push((format!("! {w}"), th.warn()));
                }
                if let Some(pc) = stage.and_then(|s| s.pc) {
                    notes.push((machine::addr(pc), th.dim()));
                }
                (t, Style::new(), notes)
            }
        };
        let full = stage_fit(th, &text, usize::MAX);
        let mut spans = vec![Span::styled(format!(" {code:<4}"), label_style)];
        if words {
            spans.push(Span::styled(format!("{word:<10}"), th.dim()));
        }
        // First choice: a note beside the full text; second: an explaining
        // note beside text that keeps at least 10 columns.
        let pick = notes
            .iter()
            .find(|(n, _)| stage_fit(th, &text, room.saturating_sub(n.chars().count() + 2)) == full)
            .or_else(|| notes.iter().find(|(n, ns)| *ns != th.dim() && room.saturating_sub(n.chars().count() + 2) >= 10));
        let mut shown = false;
        if let Some((n, ns)) = pick {
            let avail = room.saturating_sub(n.chars().count() + 2);
            let fitted = stage_fit(th, &text, avail);
            {
                let pad = avail.saturating_sub(fitted.chars().count());
                spans.push(Span::styled(fitted, style));
                spans.push(Span::raw(" ".repeat(pad + 2)));
                spans.push(Span::styled(n.clone(), *ns));
                shown = true;
            }
        }
        if !shown {
            spans.push(Span::styled(stage_fit(th, &text, room), style));
        }
        lines.push(Line::from(spans));
    }
    f.render_widget(Paragraph::new(lines), rows);
    draw_hazard_chips(f, app, th, chips);
    draw_stats(f, app, th, stats_row);
}

/// The "value travels" animation: a chip carrying the forwarded value slides
/// along a box-drawing connector from EX/MEM or MEM/WB back into EX —
/// the terminal cousin of the browser's green SVG forwarding arc.
fn draw_forward_lanes(
    f: &mut Frame,
    app: &App,
    th: &Th,
    area: Rect,
    centers: [u16; 5],
    now: Instant,
) {
    if area.height < 3 || app.anims.forwards.is_empty() {
        return;
    }
    let buf = f.buffer_mut();
    let dst = centers[2]; // EX
    let arrow_row = area.y;

    let mut put = |x: u16, y: u16, sym: &str, style: Style| {
        if x >= area.x && x < area.right() && y >= area.y && y < area.bottom() {
            buf[(x, y)].set_symbol(sym).set_style(style);
        }
    };

    put(
        dst,
        arrow_row,
        th.sym("▲", "^"),
        th.accent().add_modifier(Modifier::BOLD),
    );

    for (lane, fwd) in app.anims.forwards.iter().take(2).enumerate() {
        let src = if fwd.from == "exmem" {
            centers[3]
        } else {
            centers[4]
        };
        let row = area.y + 1 + lane as u16;
        if row >= area.bottom() || src <= dst {
            continue;
        }
        put(src, arrow_row, th.sym("│", "|"), th.accent());
        put(dst, row, th.sym("╰", "\\"), th.accent());
        put(src, row, th.sym("╯", "/"), th.accent());
        for x in (dst + 1)..src {
            put(x, row, th.sym("─", "-"), th.accent());
        }

        let elapsed = now.duration_since(fwd.started).as_millis() as u64;
        let label_style = th.accent().add_modifier(Modifier::BOLD);
        if elapsed < FWD_TRAVEL_MS {
            // chip slides right → left along the lane
            let p = elapsed as f32 / FWD_TRAVEL_MS as f32;
            let chip = format!("[{}={}]", fwd.reg, machine::signed(fwd.value, app.xlen));
            let span = src as f32 - dst as f32;
            let cx = src as f32 - p * span;
            let start = (cx as i32 - chip.chars().count() as i32 / 2).max(dst as i32 + 1) as u16;
            for (k, ch) in chip.chars().enumerate() {
                put(start + k as u16, row, &ch.to_string(), label_style);
            }
        } else {
            // settled: static label centered on the lane
            let from = if fwd.from == "exmem" {
                "EX/MEM"
            } else {
                "MEM/WB"
            };
            let label = format!(" {} ({from}) ", fwd.reg);
            let mid = (dst + src) / 2;
            let start = mid.saturating_sub(label.chars().count() as u16 / 2);
            for (k, ch) in label.chars().enumerate() {
                put(start + k as u16, row, &ch.to_string(), th.accent());
            }
        }
    }
}

fn draw_hazard_chips(f: &mut Frame, app: &App, th: &Th, area: Rect) {
    let Some(snap) = &app.snap else { return };
    let mut lines: Vec<Line> = Vec::new();

    // The one-line "why" for this cycle, shared with riscvsim demo.
    let (kind, why) = crate::explain::cycle(snap);
    let (mark, style) = match kind {
        crate::explain::Kind::Stall => (th.sym("!", "!"), th.warn()),
        crate::explain::Kind::Flush | crate::explain::Kind::Error => (th.sym("✗", "x"), th.err()),
        crate::explain::Kind::Done => (th.sym("✓", "+"), th.ok()),
        _ => (th.sym("›", ">"), th.info()),
    };
    // At most two lines, ending on a whole word.
    let room = (area.width as usize).saturating_sub(2).max(20);
    for (i, part) in crate::term::wrap_at_most(&why, room, 2, th.unicode).into_iter().enumerate() {
        let lead = if i == 0 { format!("{mark} ") } else { "  ".to_string() };
        lines.push(Line::from(vec![Span::styled(lead, style.add_modifier(Modifier::BOLD)), Span::raw(part)]));
    }

    for fwd in &snap.view.forwards {
        let from = if fwd.from == "exmem" {
            "EX/MEM"
        } else {
            "MEM/WB"
        };
        lines.push(Line::from(vec![
            Span::styled(
                format!("forward {}: ", fwd.reg),
                th.accent().add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("{from} {} EX ({})", th.sym("→", "->"), fwd.operand),
                th.accent(),
            ),
        ]));
    }
    if let Some(stall) = &snap.view.stall {
        lines.push(Line::styled(format!("stall: {stall}"), th.warn()));
    }
    for fl in &snap.view.flushed {
        lines.push(Line::styled(
            format!("{} flushed ({}): {}", th.sym("✗", "x"), fl.stage, fl.text),
            th.err(),
        ));
    }
    if let Some(pred) = &snap.view.predictor {
        let guess = if pred.predicted_taken {
            "taken"
        } else {
            "not-taken"
        };
        let meter: String = (0..4)
            .map(|i| {
                if (i as u8) < pred.counter {
                    th.sym("▮", "#")
                } else {
                    th.sym("▯", ".")
                }
            })
            .collect();
        match pred.actual_taken {
            None => lines.push(Line::from(vec![
                Span::styled(format!("predictor: {guess} ({}) ", pred.text), th.info()),
                Span::styled(meter, th.info()),
            ])),
            Some(actual) => {
                let hit = pred.mispredicted != Some(true);
                let style = if hit { th.accent() } else { th.err() };
                lines.push(Line::from(vec![
                    Span::styled(
                        format!(
                            "predicted {guess}, was {} ({}) ",
                            if actual { "taken" } else { "not-taken" },
                            if hit {
                                format!("{} correct", th.sym("✓", "ok:"))
                            } else {
                                format!("{} mispredicted", th.sym("✗", "x"))
                            }
                        ),
                        style.add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(meter, style),
                ]));
            }
        }
    }
    if lines.is_empty() && snap.cycle == 0 && !snap.halted {
        lines.push(Line::styled(
            "press Step: instructions enter at IF (fetch) and move one stage right each cycle",
            th.dim(),
        ));
    }
    let h = area.height as usize;
    if lines.len() > h {
        lines.truncate(h);
    }
    f.render_widget(Paragraph::new(lines), area);
}

fn draw_stats(f: &mut Frame, app: &App, th: &Th, area: Rect) {
    let Some(snap) = &app.snap else { return };
    let s = &snap.stats;
    let cpi = if s.instructions > 0 {
        format!("{:.2}", s.cycles as f64 / s.instructions as f64)
    } else {
        "-".into()
    };
    let sep = th.sym(" · ", " | ");
    let parts = [
        format!("cycles {}", s.cycles),
        format!("instr {}", s.instructions),
        format!("CPI {cpi}"),
        format!("stalls {}", s.stalls),
        format!("flushed {}", s.flushes),
        format!("mispredict {}", s.mispredictions),
    ];
    // Whole items only: drop from the right until the row fits.
    let mut keep = parts.len();
    while keep > 1 && parts[..keep].join(sep).chars().count() > area.width as usize {
        keep -= 1;
    }
    f.render_widget(
        Paragraph::new(Line::styled(parts[..keep].join(sep), th.dim())),
        area,
    );
}

// ---------------------------------------------------------------------------
// Registers + memory tab
// ---------------------------------------------------------------------------

/// How the RV64 register grid fits a width: (columns, value width).
/// A cell is `name value` plus a two-space gap.
fn wide_reg_grid(inner_width: usize, values: &[String]) -> (usize, usize) {
    let vw = values.iter().map(|v| v.chars().count()).max().unwrap_or(1);
    let cell = 5 + vw + 2;
    (((inner_width + 2) / cell).clamp(1, 4), vw)
}

fn draw_state_tab(f: &mut Frame, app: &mut App, th: &Th, area: Rect) {
    let regs: Vec<u64> = app
        .snap
        .as_ref()
        .map(|s| s.registers.clone())
        .unwrap_or_else(|| vec![0; 32]);
    let xlen = app.xlen;
    let reg_text = |v: u64| -> String {
        if app.reg_hex {
            crate::run::hex(v, xlen)
        } else {
            machine::signed(v, xlen).to_string()
        }
    };
    let wide_values: Vec<String> = regs.iter().map(|&v| reg_text(v)).collect();
    // RV32: the classic 4 x 8 grid. RV64: as many columns as fit, and as
    // many rows as needed, leaving the memory view at least 4 rows.
    let (wide_cols, wide_vw) = wide_reg_grid(area.width.saturating_sub(2) as usize, &wide_values);
    // When all 32 do not fit, RV64 shows the non-zero registers (and any
    // just written) and says so in the title; they get priority over the
    // memory view's height.
    let nonzero: Vec<usize> = (0..32)
        .filter(|&i| regs[i] != 0 || app.anims.reg_flash.iter().any(|(r, _)| *r as usize == i))
        .collect();
    let all_rows = 32usize.div_ceil(wide_cols) as u16;
    let wide_fits = xlen == 64 && all_rows + 2 <= area.height.saturating_sub(4);
    let regs_height = if xlen != 64 {
        10
    } else if wide_fits {
        all_rows + 2
    } else {
        let need = nonzero.len().div_ceil(wide_cols).max(1) as u16 + 2;
        need.max(area.height.saturating_sub(4)).min(area.height.saturating_sub(3)).max(3)
    };
    let [regs_area, mem_area] =
        Layout::vertical([Constraint::Length(regs_height), Constraint::Min(if xlen == 64 { 3 } else { 4 })]).areas(area);

    // -- registers ------------------------------------------------------
    let fmt_label = if app.reg_hex { "[hex]" } else { "[dec]" };
    let fmt_style = if app.pressed == Some(Act::RegFmt) {
        th.accent().add_modifier(Modifier::REVERSED)
    } else if app.hover == Some(Act::RegFmt) {
        th.accent().add_modifier(Modifier::BOLD)
    } else {
        th.dim()
    };
    let block = Block::bordered()
        .border_set(th.border_set())
        .border_style(th.dim())
        .title(Line::from(vec![
            Span::styled(" registers ", Style::new().add_modifier(Modifier::BOLD)),
            Span::styled(fmt_label, fmt_style),
            Span::raw(" "),
            Span::styled(if xlen == 64 && !wide_fits { "· non-zero " } else { "" }, th.dim()),
        ]));
    let inner = block.inner(regs_area);
    f.render_widget(block, regs_area);
    // the [hex]/[dec] toggle in the title is clickable
    app.hits.push(Hit {
        rect: Rect::new(regs_area.x + 12, regs_area.y, 5, 1),
        act: Act::RegFmt,
    });

    let now = Instant::now();
    let flash_style = |reg: u8| -> Option<Style> {
        app.anims
            .reg_flash
            .iter()
            .find(|(r, _)| *r == reg)
            .and_then(|(_, t)| {
                let ms = now.duration_since(*t).as_millis() as u64;
                if ms < REG_FLASH_MS / 2 {
                    Some(
                        th.accent()
                            .add_modifier(Modifier::BOLD | Modifier::REVERSED),
                    )
                } else if ms < REG_FLASH_MS {
                    Some(th.accent().add_modifier(Modifier::BOLD))
                } else {
                    None
                }
            })
    };
    let cell_w = (inner.width as usize / 4).max(16);
    let mut lines: Vec<Line> = Vec::new();
    if xlen == 64 {
        let shown: Vec<usize> = if wide_fits { (0..32).collect() } else { nonzero.clone() };
        let rows_avail = inner.height as usize;
        let mut shown_rows = shown.len().div_ceil(wide_cols);
        // Too many even so: keep the last row for a "+N more" note.
        let more = if shown_rows > rows_avail {
            shown_rows = rows_avail.saturating_sub(1);
            shown.len() - shown_rows * wide_cols
        } else {
            0
        };
        for row in 0..shown_rows {
            let mut spans: Vec<Span> = Vec::new();
            for col in 0..wide_cols {
                let Some(&i) = shown.get(row * wide_cols + col) else { break };
                let text = &wide_values[i];
                let vstyle = flash_style(i as u8).unwrap_or_default();
                spans.push(Span::styled(format!("{:>4} ", format!("x{i}")), th.dim()));
                spans.push(Span::styled(format!("{text:>wide_vw$}"), vstyle));
                spans.push(Span::raw("  "));
            }
            lines.push(Line::from(spans));
        }
        if shown.is_empty() {
            lines.push(Line::styled("every register is 0", th.dim()));
        } else if more > 0 {
            lines.push(Line::styled(trunc(&format!("+{more} more; a taller window shows them"), inner.width as usize), th.dim()));
        }
        f.render_widget(Paragraph::new(lines), inner);
        draw_memory(f, app, th, mem_area);
        return;
    }
    for row in 0..8 {
        let mut spans: Vec<Span> = Vec::new();
        for col in 0..4 {
            let i = row * 4 + col;
            let text = wide_values[i].clone();
            let vstyle = flash_style(i as u8).unwrap_or_default();
            spans.push(Span::styled(format!("{:>4} ", format!("x{i}")), th.dim()));
            let pad = cell_w.saturating_sub(5 + text.chars().count());
            spans.push(Span::styled(text, vstyle));
            spans.push(Span::raw(" ".repeat(pad)));
        }
        lines.push(Line::from(spans));
    }
    f.render_widget(Paragraph::new(lines), inner);
    draw_memory(f, app, th, mem_area);
}

fn draw_memory(f: &mut Frame, app: &mut App, th: &Th, mem_area: Rect) {
    let block = Block::bordered()
        .border_set(th.border_set())
        .border_style(th.dim())
        .title(Line::from(vec![Span::styled(
            format!(" memory · {} ", machine::addr(app.mem_addr)),
            Style::new().add_modifier(Modifier::BOLD),
        )]));
    let inner = block.inner(mem_area);
    f.render_widget(block, mem_area);

    // nav buttons on the first inner row
    let mut x = inner.x;
    for (label, act) in [
        (" data ", Act::MemData),
        (" stack ", Act::MemStack),
        (th.sym(" ◀ ", " < "), Act::MemPrev),
        (th.sym(" ▶ ", " > "), Act::MemNext),
    ] {
        let w = label.chars().count() as u16;
        let rect = Rect::new(x, inner.y, w.min(inner.right().saturating_sub(x)), 1);
        let style = if app.pressed == Some(act) {
            Style::new().add_modifier(Modifier::REVERSED)
        } else if app.hover == Some(act) {
            th.accent().add_modifier(Modifier::BOLD)
        } else {
            th.info()
        };
        f.render_widget(Paragraph::new(Span::styled(label, style)), rect);
        app.hits.push(Hit { rect, act });
        x += w + 1;
    }

    let rows = (inner.height.saturating_sub(1)) as usize;
    let mut lines: Vec<Line> = Vec::new();
    if let Some(p) = &app.pipeline {
        let bytes = p.read_memory(app.mem_addr, rows * 16);
        for r in 0..rows {
            let addr = app.mem_addr.wrapping_add((r * 16) as u64);
            let mut words: Vec<String> = Vec::new();
            for wi in 0..4 {
                let o = r * 16 + wi * 4;
                let w = u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
                words.push(format!("{w:08x}"));
            }
            lines.push(Line::from(vec![
                Span::styled(format!("{}  ", machine::addr(addr)), th.dim()),
                Span::raw(words.join("  ")),
            ]));
        }
    } else {
        lines.push(Line::styled("assemble to inspect memory", th.dim()));
    }
    let body = Rect::new(
        inner.x,
        inner.y + 1,
        inner.width,
        inner.height.saturating_sub(1),
    );
    f.render_widget(Paragraph::new(lines), body);
}

// ---------------------------------------------------------------------------
// Terminal panel
// ---------------------------------------------------------------------------

fn draw_terminal(f: &mut Frame, app: &App, th: &Th, area: Rect) {
    let block = Block::bordered()
        .border_set(th.border_set())
        .border_style(th.dim())
        .title(Span::styled(
            " terminal ",
            Style::new().add_modifier(Modifier::BOLD),
        ));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let h = inner.height as usize;
    let visible = app.log.iter().rev().take(h).rev();
    let mut lines: Vec<Line> = Vec::new();
    for entry in visible {
        let text = entry.text.clone();
        lines.push(match entry.kind {
            "cmd" => Line::from(vec![Span::styled("> ", th.accent()), Span::raw(text)]),
            "status" => Line::styled(text, th.info()),
            "success" => Line::styled(text, th.accent()),
            "error" => Line::styled(text, th.err()),
            _ => format_instr_log(&text, th),
        });
    }
    f.render_widget(Paragraph::new(lines), inner);
}

/// "add x5, x3, x4  x5: 0 -> 7" — dim the old value, bold the new one
/// (same treatment as `riscvsim run`'s streaming output).
fn format_instr_log(text: &str, th: &Th) -> Line<'static> {
    if let Some(pos) = text.rfind("  ") {
        let (instr, delta) = text.split_at(pos);
        let delta = delta.trim_start();
        if let Some((label, change)) = delta.split_once(": ") {
            if let Some((old, new)) = change.split_once(" -> ") {
                return Line::from(vec![
                    Span::raw(format!("{instr}  {label}: ")),
                    Span::styled(format!("{old} -> "), th.dim()),
                    Span::styled(new.to_string(), Style::new().add_modifier(Modifier::BOLD)),
                ]);
            }
        }
        return Line::from(vec![
            Span::raw(instr.to_string()),
            Span::styled(format!("  {delta}"), th.dim()),
        ]);
    }
    Line::from(text.to_string())
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

fn button_style(app: &App, th: &Th, act: Act, enabled: bool, primary: bool) -> Style {
    if !enabled {
        return th.dim();
    }
    let mut style = if primary {
        th.accent().add_modifier(Modifier::BOLD)
    } else {
        Style::new().add_modifier(Modifier::BOLD)
    };
    if app.hover == Some(act) {
        style = style.add_modifier(Modifier::UNDERLINED);
    }
    if app.pressed == Some(act) {
        // "compressed" press feel: invert while the button is held
        style = style.add_modifier(Modifier::REVERSED);
    }
    style
}

fn draw_controls(f: &mut Frame, app: &mut App, th: &Th, area: Rect) {
    let row1 = Rect::new(area.x, area.y, area.width, 1);
    let row2 = Rect::new(area.x, area.y + 1, area.width, 1);

    // -- row 1: transport buttons ----------------------------------------
    let assembled = app.assembled();
    let halted = app.halted();
    let run_label = if app.running {
        format!("[ {} Pause ]", th.sym("⏸", "||"))
    } else {
        format!("[ {} Run ]", th.sym("▶", ">"))
    };
    let buttons: Vec<(String, Act, bool, bool)> = vec![
        ("[ Assemble ]".into(), Act::Assemble, true, false),
        (
            format!("[ {} Back ]", th.sym("◀", "<")),
            Act::Back,
            app.can_step_back() && !app.running,
            false,
        ),
        (
            format!("[ Step {} ]", th.sym("▶", ">")),
            Act::Step,
            assembled && !halted && !app.running,
            false,
        ),
        (run_label, Act::RunPause, assembled && !halted, true),
        (
            format!("[ {} Reset ]", th.sym("⟲", "@")),
            Act::Reset,
            assembled,
            false,
        ),
    ];
    let mut x = row1.x + 1;
    for (label, act, enabled, primary) in buttons {
        let w = label.chars().count() as u16;
        if x + w >= row1.right() {
            break;
        }
        let rect = Rect::new(x, row1.y, w, 1);
        let style = button_style(app, th, act, enabled, primary);
        f.render_widget(Paragraph::new(Span::styled(label, style)), rect);
        if enabled {
            app.hits.push(Hit { rect, act });
        }
        if act == Act::RunPause {
            app.rect_run_btn = rect;
        }
        x += w + 2;
    }

    // -- row 2: speed slider · samples · hints ----------------------------
    let mut x = row2.x + 1;
    let put = |f: &mut Frame, x: u16, text: &str, style: Style| -> u16 {
        let w = text.chars().count() as u16;
        f.render_widget(
            Paragraph::new(Span::styled(text.to_string(), style)),
            Rect::new(x, row2.y, w, 1),
        );
        w
    };

    x += put(f, x, "speed ", th.dim());
    // the slider: a clickable/draggable track with 7 stops
    let track_w: u16 = 15;
    let knob_pos =
        ((app.speed_idx as f32 / (SPEEDS.len() - 1) as f32) * (track_w - 1) as f32).round() as u16;
    x += put(f, x, th.sym("├", "["), th.dim());
    let track_rect = Rect::new(x, row2.y, track_w, 1);
    for i in 0..track_w {
        let (sym, style) = if i == knob_pos {
            (th.sym("●", "O"), th.accent().add_modifier(Modifier::BOLD))
        } else if i < knob_pos {
            (th.sym("━", "="), th.accent())
        } else {
            (th.sym("─", "-"), th.dim())
        };
        put(f, x + i, sym, style);
    }
    app.speed_track = track_rect;
    app.hits.push(Hit {
        rect: track_rect,
        act: Act::SpeedTrack,
    });
    x += track_w;
    x += put(f, x, th.sym("┤", "]"), th.dim());
    x += put(f, x, &format!(" {:<9}", app.speed().label()), Style::new());

    // sample selector
    let sample_label = format!("sample {} {}", th.sym("▾", "v"), trunc(&app.file_name, 24));
    let style = if app.pressed == Some(Act::SampleToggle) {
        Style::new().add_modifier(Modifier::REVERSED)
    } else if app.hover == Some(Act::SampleToggle) || app.menu_open {
        th.accent().add_modifier(Modifier::BOLD)
    } else {
        th.info()
    };
    let w = sample_label.chars().count() as u16;
    if x + w < row2.right() {
        let rect = Rect::new(x, row2.y, w, 1);
        f.render_widget(Paragraph::new(Span::styled(sample_label, style)), rect);
        app.hits.push(Hit {
            rect,
            act: Act::SampleToggle,
        });
        x += w + 3;
    }
    let _ = x;
}

// ---------------------------------------------------------------------------
// Overlays: samples menu, help, tour
// ---------------------------------------------------------------------------

fn draw_sample_menu(f: &mut Frame, app: &mut App, th: &Th, controls: Rect) {
    let w = (SAMPLES
        .iter()
        .map(|s| s.name.chars().count())
        .max()
        .unwrap_or(10)
        + 6) as u16;
    let h = SAMPLES.len() as u16 + 2;
    let x = (controls.x + 24).min(f.area().width.saturating_sub(w + 1));
    let y = controls.y.saturating_sub(h);
    let rect = Rect::new(x, y, w, h);
    f.render_widget(Clear, rect);
    let block = Block::bordered()
        .border_set(th.border_set())
        .border_style(th.accent())
        .title(Span::styled(
            " samples ",
            Style::new().add_modifier(Modifier::BOLD),
        ));
    let inner = block.inner(rect);
    f.render_widget(block, rect);
    for (i, sample) in SAMPLES.iter().enumerate() {
        let row = Rect::new(inner.x, inner.y + i as u16, inner.width, 1);
        let act = Act::Sample(i);
        let selected = app.menu_sel == i || app.hover == Some(act);
        let style = if app.pressed == Some(act) || selected {
            Style::new().add_modifier(Modifier::REVERSED)
        } else {
            Style::new()
        };
        f.render_widget(
            Paragraph::new(Span::styled(format!(" {} ", sample.name), style)),
            row,
        );
        app.hits.push(Hit { rect: row, act });
    }
}

/// Every key, with a short example of when to use it. Also used by tests.
pub(crate) fn help_lines(unicode: bool) -> Vec<(String, &'static str)> {
    let s = |u: &'static str, a: &'static str| if unicode { u } else { a };
    vec![
        (format!("{} / n", s("→", "right")), "step one cycle"),
        (s("←", "left").to_string(), "step back one cycle"),
        ("space".into(), "run / pause"),
        ("+ / -".into(), "faster / slower (also ] and [)"),
        ("f".into(), "fast mode: full speed, no animation"),
        (format!("{} / j k", s("↑ ↓", "up down")), "select a source line"),
        ("b".into(), "breakpoint on the selected line"),
        ("r".into(), "reset to cycle 0"),
        ("a".into(), "assemble again (reloads the file)"),
        ("tab / t".into(), "Pipeline or Registers + memory"),
        ("h".into(), "registers in hex or decimal"),
        ("g / G".into(), "memory: data or stack"),
        ("PgUp / PgDn".into(), "memory: scroll a page"),
        ("s".into(), "pick a sample program"),
        ("/".into(), "type a command, e.g. /open, /serve"),
        ("?".into(), "this help (any key closes it)"),
        ("q".into(), "quit"),
    ]
}

fn draw_help(f: &mut Frame, app: &mut App, th: &Th, area: Rect) {
    let entries = help_lines(th.unicode);
    let example = [
        "Example: press j until the line after a loop,",
        "b to set a breakpoint, then space to run to it.",
    ];
    let want_h = entries.len() as u16 + example.len() as u16 + 3;
    let w = 58u16.min(area.width.saturating_sub(4));
    let h = want_h.min(area.height.saturating_sub(2));
    let rect = Rect::new(area.x + (area.width - w) / 2, area.y + (area.height - h) / 2, w, h);
    f.render_widget(Clear, rect);
    let block = Block::bordered()
        .border_set(th.border_set())
        .border_style(th.info())
        .title(Span::styled(
            " keys ",
            Style::new().add_modifier(Modifier::BOLD),
        ));
    let inner = block.inner(rect);
    f.render_widget(block, rect);
    let mut lines: Vec<Line> = entries
        .iter()
        .map(|(k, what)| {
            Line::from(vec![
                Span::styled(format!(" {k:<13}"), th.info().add_modifier(Modifier::BOLD)),
                Span::raw(what.to_string()),
            ])
        })
        .collect();
    lines.push(Line::from(""));
    for e in example {
        lines.push(Line::styled(format!(" {e}"), th.dim()));
    }
    f.render_widget(Paragraph::new(lines), inner);
    app.hits.push(Hit {
        rect,
        act: Act::Help,
    });
}

fn draw_tour(f: &mut Frame, app: &mut App, th: &Th, area: Rect) {
    let Some(tour) = &app.tour else { return };
    app.tour_shown = true;
    let step = tour.step.min(TOUR_STEPS.len() - 1);
    let (title, mut body) = TOUR_STEPS[step];
    if step == 0 && area.width < SOURCE_PANE_MIN {
        body = "Your program runs through the five stages above; at 80 columns \
or wider its source sits beside them. Edit the file in your editor, then \
press [a] Assemble to reload it.";
    }
    let target = match step {
        0 => app.rect_source,
        1 => Rect::new(
            app.rect_run_btn.x.saturating_sub(1),
            app.rect_run_btn.y,
            app.rect_run_btn.width + 2,
            1,
        ),
        _ => app.rect_pipeline,
    };

    // Spotlight: dim every cell outside the target panel.
    let buf = f.buffer_mut();
    for y in area.y..area.bottom() {
        for x in area.x..area.right() {
            if !target.contains(Position { x, y }) {
                buf[(x, y)].modifier.insert(Modifier::DIM);
            }
        }
    }
    // Bright ring around the target.
    if target.height >= 2 {
        f.render_widget(
            Block::bordered()
                .border_set(th.border_set())
                .border_style(th.accent().add_modifier(Modifier::BOLD)),
            target,
        );
    }

    // Callout card near the target. Step 1 belongs in the terminal/log panel
    // below the source spotlight, so that panel is a hard boundary for it.
    let (rect, body_lines) = tour_callout_layout(step, body, target, app.rect_terminal, area);
    f.render_widget(Clear, rect);
    let block = Block::bordered()
        .border_set(th.border_set())
        .border_style(th.accent().add_modifier(Modifier::BOLD));
    let inner = block.inner(rect);
    f.render_widget(block, rect);

    let mut lines: Vec<Line> = vec![Line::from(vec![
        Span::styled(
            format!(" {} ", logo::mini_mark(th.unicode)),
            th.accent().add_modifier(Modifier::BOLD),
        ),
        Span::styled(title, Style::new().add_modifier(Modifier::BOLD)),
    ])];
    for l in body_lines {
        lines.push(Line::raw(format!(" {l}")));
    }
    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);

    // actions row: [ Next ] · Skip · dots
    let last = step == TOUR_STEPS.len() - 1;
    let next_label = if last { "[ Got it ]" } else { "[ Next ]" };
    let actions_y = rect.bottom() - 2;
    let mut x = inner.x + 1;
    let next_style = if app.pressed == Some(Act::TourNext) {
        th.accent().add_modifier(Modifier::REVERSED)
    } else if app.hover == Some(Act::TourNext) {
        th.accent()
            .add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
    } else {
        th.accent().add_modifier(Modifier::BOLD)
    };
    let nw = next_label.chars().count() as u16;
    let next_rect = Rect::new(x, actions_y, nw, 1);
    f.render_widget(
        Paragraph::new(Span::styled(next_label, next_style)),
        next_rect,
    );
    app.hits.push(Hit {
        rect: next_rect,
        act: Act::TourNext,
    });
    x += nw + 3;

    let skip_style = if app.hover == Some(Act::TourSkip) {
        Style::new().add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
    } else {
        th.dim().add_modifier(Modifier::UNDERLINED)
    };
    let skip_rect = Rect::new(x, actions_y, 4, 1);
    f.render_widget(Paragraph::new(Span::styled("Skip", skip_style)), skip_rect);
    app.hits.push(Hit {
        rect: skip_rect,
        act: Act::TourSkip,
    });

    let dots: String = (0..TOUR_STEPS.len())
        .map(|i| {
            if i == step {
                th.sym("●", "*")
            } else {
                th.sym("○", ".")
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let dw = dots.chars().count() as u16;
    f.render_widget(
        Paragraph::new(Span::styled(dots, th.dim())),
        Rect::new(inner.right().saturating_sub(dw + 1), actions_y, dw, 1),
    );
}

fn wrap_text(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut cur = String::new();
    for word in text.split_whitespace() {
        if !cur.is_empty() && cur.chars().count() + 1 + word.chars().count() > width {
            lines.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(word);
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    lines
}

fn tour_callout_layout(
    step: usize,
    body: &str,
    target: Rect,
    terminal: Rect,
    area: Rect,
) -> (Rect, Vec<String>) {
    let w = if step == 0 {
        76u16.min(terminal.width.saturating_sub(2))
    } else {
        46u16.min(area.width.saturating_sub(4))
    };
    let body_lines = wrap_text(body, w.saturating_sub(4) as usize);
    let desired_h = (body_lines.len() as u16) + 5;
    let rect = if step == 0 {
        // Inside the terminal panel; on a narrow window the text wraps to
        // more lines, so the card grows upward instead of cutting it.
        let need = body_lines.len() as u16 + 4; // borders, title, actions
        let x = terminal.x + terminal.width.saturating_sub(w) / 2;
        if need <= terminal.height {
            Rect::new(x, terminal.y, w, desired_h.min(terminal.height))
        } else {
            let h = need.min(area.height);
            Rect::new(x, terminal.bottom().saturating_sub(h), w, h)
        }
    } else {
        let below = target.bottom() + 1 + desired_h <= area.bottom();
        let y = if below {
            target.bottom().min(area.bottom() - desired_h)
        } else {
            target.y.saturating_sub(desired_h).max(area.y + 1)
        };
        let x = (target.x + 2).min(area.right().saturating_sub(w + 2));
        Rect::new(x, y, w, desired_h)
    };
    (rect, body_lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::app::Caps;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use std::sync::{Arc, Mutex};

    fn sample_app(unicode: bool) -> App {
        let s = &SAMPLES[0];
        let mut app = App::new(
            None,
            s.source.into(),
            s.file.into(),
            false,
            Arc::new(Mutex::new(None)),
            crate::doctor::InstallMethod::Manual,
        );
        app.caps = Caps { color: true, unicode };
        // Never the real directory: snapshots are committed.
        app.working_dir = "projects/riscv".into();
        app.boot();
        app
    }

    fn render(app: &mut App, w: u16, h: u16) -> String {
        let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
        t.draw(|f| draw(f, app)).unwrap();
        let buf = t.backend().buffer().clone();
        (0..h)
            .map(|y| (0..w).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>().trim_end().to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The tui decides color and symbols with the same rules as every other
    /// command, and the frame it draws follows that decision.
    #[test]
    fn capabilities_follow_the_shared_terminal_rules() {
        let utf8 = [("LANG", "en_US.UTF-8"), ("TERM", "xterm-256color")];
        // (case, environment, --no-color, want color, want Unicode)
        type Case<'a> = (&'a str, Vec<(&'a str, &'a str)>, bool, bool, bool);
        let cases: Vec<Case> = vec![
            ("utf-8 terminal", utf8.to_vec(), false, true, true),
            ("--no-color", utf8.to_vec(), true, false, true),
            ("NO_COLOR=1", [utf8.as_slice(), &[("NO_COLOR", "1")]].concat(), false, false, true),
            ("NO_COLOR empty", [utf8.as_slice(), &[("NO_COLOR", "")]].concat(), false, true, true),
            ("TERM=dumb", vec![("LANG", "en_US.UTF-8"), ("TERM", "dumb")], false, false, false),
            ("C locale", vec![("LANG", "C"), ("TERM", "xterm")], false, true, false),
        ];
        for (name, vars, flag, want_color, want_unicode) in cases {
            let env = |k: &str| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string());
            let caps = Caps::detect_in(&env, flag);
            assert_eq!((caps.color, caps.unicode), (want_color, want_unicode), "{name}");

            let mut app = sample_app(true);
            app.caps = caps;
            app.dismiss_welcome();
            app.step(4, true);
            let mut t = Terminal::new(TestBackend::new(80, 24)).unwrap();
            t.draw(|f| draw(f, &mut app)).unwrap();
            let buf = t.backend().buffer().clone();
            let colored = buf.content().iter().any(|c| c.fg != Color::Reset || c.bg != Color::Reset);
            assert_eq!(colored, want_color, "{name}: color in the frame");
            let ascii = buf.content().iter().all(|c| c.symbol().is_ascii());
            assert_eq!(ascii, !want_unicode, "{name}: ASCII symbols");
        }
    }

    /// Text renders of the main screens. With RISCVSIM_CAPTURE_DIR set they
    /// are also written out for review.
    #[test]
    fn screens_fit_and_show_the_footer() {
        let mut shots = Vec::new();
        for (w, h) in [(80u16, 24u16), (120, 36)] {
            let mut app = sample_app(true);
            shots.push((format!("welcome.{w}x{h}"), render(&mut app, w, h)));
            app.dismiss_welcome();
            for _ in 0..4 {
                app.step(1, true);
            }
            let main = render(&mut app, w, h);
            let last = main.lines().last().unwrap().to_string();
            assert!(last.contains("quit"), "footer at {w}: {last}");
            if w >= 120 {
                for hint in ["step", "back", "run", "reset", "help", "quit"] {
                    assert!(last.contains(hint), "{hint} missing at {w}: {last}");
                }
            }
            shots.push((format!("pipeline.{w}x{h}"), main));
        }
        let mut ascii = sample_app(false);
        ascii.dismiss_welcome();
        ascii.step(3, true);
        let text = render(&mut ascii, 80, 24);
        assert!(text.is_ascii(), "ASCII mode drew non-ASCII:\n{text}");
        shots.push(("pipeline.ascii.80x24".into(), text));

        let mut tiny = sample_app(true);
        tiny.dismiss_welcome();
        let small = render(&mut tiny, 50, 12);
        assert!(small.contains("needs a bigger window") && small.contains("50x12"), "{small}");
        shots.push(("too-small.50x12".into(), small));

        if let Some(dir) = std::env::var_os("RISCVSIM_CAPTURE_DIR") {
            let dir = std::path::PathBuf::from(dir);
            std::fs::create_dir_all(&dir).unwrap();
            for (name, text) in shots {
                std::fs::write(dir.join(format!("tui.{name}.txt")), text).unwrap();
            }
        }
    }

    fn first_callout_at(width: u16, height: u16) -> (Rect, Rect, usize) {
        let area = Rect::new(0, 0, width, height);
        let [_header, body, terminal, _controls, _prompt, _status] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(12),
            Constraint::Length(7),
            Constraint::Length(2),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .areas(area);
        let [source, _right] =
            Layout::horizontal([Constraint::Percentage(38), Constraint::Percentage(62)])
                .areas(body);
        let (callout, lines) = tour_callout_layout(0, TOUR_STEPS[0].1, source, terminal, area);
        (callout, terminal, lines.len())
    }

    #[test]
    fn first_tour_callout_stays_inside_log_panel_at_supported_sizes() {
        for (width, height) in [(80, 24), (150, 44)] {
            let (callout, terminal, body_lines) = first_callout_at(width, height);
            assert!(callout.x >= terminal.x);
            assert!(callout.y >= terminal.y);
            assert!(callout.right() <= terminal.right());
            assert!(callout.bottom() <= terminal.bottom());

            // Border interior has room for title + body before the actions row.
            assert!(1 + body_lines < callout.height.saturating_sub(2) as usize);
        }
    }

    /// A sample app in the normal stepping state: no welcome, tour or prompt.
    fn ready_app() -> App {
        let mut app = sample_app(true);
        app.dismiss_welcome();
        app.tour = None;
        app.prompt_active = false;
        app
    }

    fn key(app: &mut App, c: char) {
        use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        app.on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
    }

    fn save(name: &str, text: &str) {
        if let Some(dir) = std::env::var_os("RISCVSIM_CAPTURE_DIR") {
            let dir = std::path::PathBuf::from(dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(format!("tui.{name}.txt")), text).unwrap();
        }
    }

    #[test]
    fn pane_snapshots_at_80x24_and_120x40() {
        for (w, h) in [(80u16, 24u16), (120, 40)] {
            let mut app = ready_app();
            for _ in 0..4 {
                app.step(1, true);
            }
            let pipe = render(&mut app, w, h);
            // source pane: the executing line is marked
            assert!(pipe.contains("▶"), "{pipe}");
            // pipeline pane: the shared why line sits under the stages
            assert!(pipe.contains("› addi x2 needs x1 from addi x1"), "why line missing at {w}x{h}:\n{pipe}");
            // footer shows the speed
            assert!(pipe.lines().last().unwrap().contains("speed 10 cyc/s") || w < 100, "{pipe}");
            save(&format!("pane.pipeline.{w}x{h}"), &pipe);

            key(&mut app, 't');
            let regs = render(&mut app, w, h);
            assert!(regs.contains("x1") && regs.contains("ra"), "registers pane:\n{regs}");
            save(&format!("pane.registers.{w}x{h}"), &regs);
            key(&mut app, 'h');
            let dec = render(&mut app, w, h);
            assert_ne!(dec, regs, "h toggles hex and decimal");
            save(&format!("pane.registers-dec.{w}x{h}"), &dec);
            key(&mut app, 'g');
            let mem = render(&mut app, w, h);
            save(&format!("pane.memory.{w}x{h}"), &mem);
            for line in pipe.lines().chain(regs.lines()) {
                assert!(line.chars().count() <= w as usize);
            }
        }
    }

    #[test]
    fn breakpoints_toggle_and_pause_a_run() {
        let mut app = ready_app();
        // Select line 4 (add x3, x2, x1) and set a breakpoint.
        for _ in 0..3 {
            key(&mut app, 'j');
        }
        assert_eq!(app.src_sel, Some(4));
        key(&mut app, 'b');
        assert!(app.breakpoints.contains(&4));
        let shot = render(&mut app, 80, 24);
        assert!(shot.contains("●"), "breakpoint mark:\n{shot}");
        save("breakpoint.80x24", &shot);
        // Run at full speed: it must stop before fetching line 4.
        key(&mut app, 'f');
        app.toggle_run();
        for _ in 0..10 {
            app.tick();
        }
        assert!(!app.running, "the run paused at the breakpoint");
        assert!(!app.halted());
        assert!(app.status.0.contains("breakpoint on line 4"), "{}", app.status.0);
        // Toggle off again.
        key(&mut app, 'b');
        assert!(app.breakpoints.is_empty());
        // A comment line cannot hold a breakpoint.
        key(&mut app, 'k');
        key(&mut app, 'k');
        key(&mut app, 'k');
        key(&mut app, 'b');
        assert!(app.breakpoints.is_empty());
        assert_eq!(app.status.1, "err");
    }

    #[test]
    fn speed_keys_and_fast_mode() {
        let mut app = ready_app();
        let start = app.speed_idx;
        key(&mut app, '+');
        assert_eq!(app.speed_idx, start + 1);
        key(&mut app, '-');
        key(&mut app, '-');
        assert_eq!(app.speed_idx, start - 1);
        key(&mut app, 'f');
        assert!(matches!(app.speed(), crate::tui::app::Speed::Max));
        assert!(render(&mut app, 120, 40).contains("MAX"), "the speed control shows fast mode");
        key(&mut app, 'f');
        assert_eq!(app.speed_idx, start - 1, "f again returns to the previous speed");
    }

    #[test]
    fn help_overlay_lists_every_key() {
        for (w, h) in [(80u16, 24u16), (120, 40)] {
            let mut app = ready_app();
            key(&mut app, '?');
            let shot = render(&mut app, w, h);
            for needle in ["space", "run / pause", "breakpoint", "fast mode", "+ / -", "quit"] {
                assert!(shot.contains(needle), "{needle} missing at {w}x{h}:\n{shot}");
            }
            save(&format!("help.{w}x{h}"), &shot);
            key(&mut app, 'x');
            assert!(!app.help_open, "any key closes help");
        }
    }

    #[test]
    fn redraw_is_fast() {
        let mut app = ready_app();
        app.step(4, true);
        let mut t = Terminal::new(TestBackend::new(120, 40)).unwrap();
        let start = std::time::Instant::now();
        let frames = 200;
        for _ in 0..frames {
            t.draw(|f| draw(f, &mut app)).unwrap();
        }
        let per = start.elapsed() / frames;
        eprintln!("tui redraw 120x40: {per:?} per frame");
        assert!(per < std::time::Duration::from_millis(50), "{per:?}");
    }

    fn type_line(app: &mut App, text: &str) {
        use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        app.prompt_active = true;
        for c in text.chars() {
            app.on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
        }
        app.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    }

    #[test]
    fn session_suggests_commands_and_keeps_history() {
        use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = ready_app();
        type_line(&mut app, "/srve");
        let last = app.log.last().unwrap().text.clone();
        assert_eq!(last, "there is no /srve. Did you mean /serve? (/help lists them all)");
        type_line(&mut app, "/help");
        assert!(app.log.iter().any(|l| l.text.contains("/demo 2")), "help has examples");
        app.prompt_active = true;
        app.on_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(app.command_input, "/help");
        app.on_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(app.command_input, "/srve");
        app.on_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(app.command_input, "/help");
        app.on_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(app.command_input, "");
    }

    /// An app on the RV64 sample, as `riscvsim tui --xlen=64` starts it.
    fn rv64_app(color: bool) -> App {
        let s = &crate::tui::samples::RV64_SAMPLE;
        let mut app = App::new(
            None,
            s.source.into(),
            s.file.into(),
            false,
            Arc::new(Mutex::new(None)),
            crate::doctor::InstallMethod::Manual,
        );
        app.caps = Caps { color, unicode: true };
        app.xlen = 64;
        app.boot();
        app.dismiss_welcome();
        app.tour = None;
        app.prompt_active = false;
        app
    }

    #[test]
    fn rv64_screens_at_80x24_and_120x40() {
        for color in [true, false] {
            let tag = if color { "color" } else { "nocolor" };
            for (w, h) in [(80u16, 24u16), (120, 40)] {
                let mut app = rv64_app(color);
                assert!(app.log.iter().any(|l| l.text == "riscvsim tui --xlen=64 wide-values.s"));
                // cycle 6: addi x2 writes back, addw is in EX
                app.step(6, false);
                let pipe = render(&mut app, w, h);
                assert!(pipe.contains("addw"), "{pipe}");
                crate::snapshots::check(&format!("tui.rv64.pipeline.{tag}.{w}x{h}"), &pipe);
                // run to the end, then the registers tab in hex and decimal
                app.step(20, false);
                key(&mut app, 't');
                let regs = render(&mut app, w, h);
                assert!(regs.contains("0x0000_0100_0000_0005"), "{regs}");
                // Five registers are non-zero (sp keeps its start value);
                // a short window folds the rest behind a note.
                if h >= 40 {
                    assert!(regs.contains("0xffff_ffff_ffff_ffff"), "{regs}");
                } else {
                    assert!(regs.contains("+2 more; a taller window shows them"), "{regs}");
                }
                crate::snapshots::check(&format!("tui.rv64.registers.{tag}.{w}x{h}"), &regs);
                key(&mut app, 'h');
                let dec = render(&mut app, w, h);
                assert!(dec.contains("1099511627781") && dec.contains("-1"), "{dec}");
                crate::snapshots::check(&format!("tui.rv64.registers-dec.{tag}.{w}x{h}"), &dec);
                for line in pipe.lines().chain(regs.lines()).chain(dec.lines()) {
                    assert!(line.chars().count() <= w as usize, "{line}");
                }
            }
        }
    }

    /// RV32 screens are locked: the RV64 work must not change them.
    #[test]
    fn rv32_screens_unchanged() {
        for (w, h) in [(80u16, 24u16), (120, 40)] {
            let mut app = ready_app();
            app.step(4, false);
            crate::snapshots::check(&format!("tui.rv32.pipeline.{w}x{h}"), &render(&mut app, w, h));
            key(&mut app, 't');
            crate::snapshots::check(&format!("tui.rv32.registers.{w}x{h}"), &render(&mut app, w, h));
        }
    }

    /// An app on `sample`, stepped until `want` holds (or the program ends).
    fn app_at(sample: &crate::tui::samples::Sample, caps: Caps, want: impl Fn(&crate::machine::Snap) -> bool) -> App {
        let mut app = App::new(
            None,
            sample.source.into(),
            sample.file.into(),
            false,
            Arc::new(Mutex::new(None)),
            crate::doctor::InstallMethod::Manual,
        );
        app.caps = caps;
        app.xlen = sample.xlen;
        app.boot();
        app.dismiss_welcome();
        app.tour = None;
        app.prompt_active = false;
        while !app.halted() && !app.snap.as_ref().is_some_and(&want) {
            app.step(1, true);
        }
        assert!(app.snap.as_ref().is_some_and(&want), "{} never reached the wanted cycle", sample.file);
        app
    }

    #[test]
    fn adaptive_layout_snapshots() {
        use crate::tui::samples::{RV64_SAMPLE, SAMPLES};
        let busy = |s: &crate::machine::Snap| s.stages.iter().all(|st| st.state == StageState::Normal);
        let stall = |s: &crate::machine::Snap| s.view.stall.is_some();
        let flush = |s: &crate::machine::Snap| !s.view.flushed.is_empty();
        let rv64 = |s: &crate::machine::Snap| s.stages.iter().any(|st| st.state == StageState::Normal && st.name == "EX" && st.text.as_deref().is_some_and(|t| t.starts_with("addw")));
        let color = Caps { color: true, unicode: true };
        let plain = Caps { color: false, unicode: false };
        type Want<'a> = &'a dyn Fn(&crate::machine::Snap) -> bool;
        let cases: Vec<(&str, &crate::tui::samples::Sample, Want, Caps)> = vec![
            ("busy", &SAMPLES[3], &busy, color),
            ("busy.ascii-nocolor", &SAMPLES[3], &busy, plain),
            ("stall", &SAMPLES[1], &stall, color),
            ("flush", &SAMPLES[2], &flush, color),
            ("rv64", &RV64_SAMPLE, &rv64, color),
        ];
        for (name, sample, want, caps) in cases {
            for (w, h) in [(60u16, 24u16), (80, 24), (100, 30), (120, 40), (160, 40)] {
                let mut app = app_at(sample, caps, want);
                let text = render(&mut app, w, h);
                for line in text.lines() {
                    assert!(line.chars().count() <= w as usize, "{name} {w}: {line}");
                }
                assert!(!text.contains("needs a bigger window"), "{name} {w}x{h}:\n{text}");
                if !caps.unicode {
                    assert!(text.is_ascii(), "{name} {w}:\n{text}");
                }
                // every busy stage names its instruction's mnemonic in full
                let snap = app.snap.as_ref().unwrap();
                for st in snap.stages.iter().filter(|st| st.state == StageState::Normal) {
                    let m = crate::explain::mnemonic(st.text.as_deref().unwrap_or(""));
                    assert!(text.contains(m), "{name} {w}: {m} missing\n{text}");
                }
                crate::snapshots::check(&format!("tui.layout.{name}.{w}x{h}"), &text);
            }
        }
    }

    #[test]
    fn below_the_minimum_explains_itself() {
        let mut app = ready_app();
        let text = render(&mut app, 59, 24);
        assert!(text.contains("needs a bigger window") && text.contains("59x24") && text.contains("60x20"), "{text}");
        crate::snapshots::check("tui.too-small.59x24", &text);
    }

    /// Every screen still fits at the narrowest supported width.
    #[test]
    fn narrow_screens_at_60_columns() {
        let (w, h) = (60u16, 24u16);
        let mut shots: Vec<(String, String)> = Vec::new();
        let mut app = sample_app(true);
        shots.push(("welcome".into(), render(&mut app, w, h)));
        app.dismiss_welcome();
        app.tour = Some(crate::tui::app::Tour { step: 0 });
        shots.push(("tour-0".into(), render(&mut app, w, h)));
        app.tour = None;
        app.prompt_active = false;
        key(&mut app, '?');
        shots.push(("help".into(), render(&mut app, w, h)));
        key(&mut app, '?');
        app.step(4, false);
        key(&mut app, 't');
        shots.push(("registers".into(), render(&mut app, w, h)));
        let mut wide = rv64_app(true);
        wide.step(20, false);
        key(&mut wide, 't');
        shots.push(("registers.rv64".into(), render(&mut wide, w, h)));
        for (name, text) in shots {
            for line in text.lines() {
                assert!(line.chars().count() <= w as usize, "{name}: {line}");
            }
            crate::snapshots::check(&format!("tui.narrow.{name}.{w}x{h}"), &text);
        }
    }

    /// A full redraw stays far under the 50 ms "instant" bound at every
    /// layout width (run with --nocapture to see the numbers).
    #[test]
    fn redraw_is_instant_at_every_width() {
        let busy = |s: &crate::machine::Snap| s.stages.iter().all(|st| st.state == StageState::Normal);
        for (w, h) in [(60u16, 24u16), (80, 24), (100, 30), (120, 40), (160, 40)] {
            let mut app = app_at(&SAMPLES[3], Caps { color: true, unicode: true }, busy);
            // A fresh terminal each frame, so this is an upper bound.
            let start = std::time::Instant::now();
            let frames = 200;
            for _ in 0..frames {
                render(&mut app, w, h);
            }
            let per = start.elapsed().as_secs_f64() * 1000.0 / frames as f64;
            println!("redraw {w}x{h}: {per:.3} ms per frame");
            assert!(per < 50.0, "{w}x{h}: {per:.1} ms per frame");
        }
    }
}

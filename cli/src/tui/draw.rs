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
use sim_engine::pipeline::StageState;
use std::time::Instant;

const ABI_NAMES: [&str; 32] = [
    "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2", "s0", "s1", "a0", "a1", "a2", "a3", "a4",
    "a5", "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "t3", "t4",
    "t5", "t6",
];

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

    if area.width < 72 || area.height < 20 {
        let msg = Paragraph::new(vec![
            Line::from(""),
            Line::from(Span::styled("riscvsim needs a bigger window", Style::new().add_modifier(Modifier::BOLD))),
            Line::from(format!("now {}x{}, needs at least 72x20", area.width, area.height)),
            Line::from(""),
            Line::from(Span::styled("make the window larger, or press q to quit", th.dim())),
        ])
        .wrap(Wrap { trim: true })
        .centered();
        f.render_widget(msg, area);
        return;
    }

    match app.gate {
        Gate::Trust { .. } => {
            draw_trust(f, app, &th);
            return;
        }
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

    let [src, right] =
        Layout::horizontal([Constraint::Percentage(38), Constraint::Percentage(62)]).areas(body);
    app.rect_source = src;

    draw_header(f, app, &th, header);
    draw_source(f, app, &th, src);
    draw_right(f, app, &th, right);
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
// Startup gates: the trust confirmation and the welcome screen.
// Both mirror Claude Code's own terminal onboarding: a quiet safety check
// with selectable options, then a bordered identity/info box.
// ---------------------------------------------------------------------------

fn draw_trust(f: &mut Frame, app: &mut App, th: &Th) {
    let Gate::Trust { selected } = app.gate else {
        return;
    };
    let area = f.area();
    let file = app
        .file_path
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| app.file_name.clone());

    let w = 64u16.min(area.width.saturating_sub(4));
    let x = (area.width.saturating_sub(w)) / 2;

    let mut lines: Vec<Line> = vec![
        Line::styled(th.sym("─", "-").repeat(w as usize), th.dim()),
        Line::from(vec![Span::styled(
            " Loading program:",
            Style::new().add_modifier(Modifier::BOLD),
        )]),
        Line::from(""),
        Line::from(vec![
            Span::raw("   "),
            Span::styled(
                trunc(&file, w as usize - 4),
                th.accent().add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(""),
        Line::from(" Quick safety check: is this a file you wrote or one you trust?"),
        Line::styled(
            " It runs inside the simulated RV32IM pipeline only — it cannot",
            th.dim(),
        ),
        Line::styled(
            " touch your real system. Confirming remembers this folder.",
            th.dim(),
        ),
        Line::from(""),
    ];

    let options = ["1. Yes, I trust this folder", "2. No, exit"];
    let opts_start = lines.len() as u16;
    for (i, label) in options.iter().enumerate() {
        let is_sel = selected == i;
        let marker = if is_sel { th.sym("❯", ">") } else { " " };
        let style = if is_sel {
            th.accent().add_modifier(Modifier::BOLD)
        } else {
            th.dim()
        };
        lines.push(Line::from(vec![
            Span::styled(
                format!(" {marker} "),
                th.accent().add_modifier(Modifier::BOLD),
            ),
            Span::styled((*label).to_string(), style),
        ]));
    }
    lines.push(Line::from(""));
    lines.push(Line::styled(
        " Enter to confirm · Esc to cancel · ↑↓ or 1/2 to choose",
        th.dim(),
    ));
    lines.push(Line::styled(th.sym("─", "-").repeat(w as usize), th.dim()));

    let h = lines.len() as u16;
    let y = area.height.saturating_sub(h) / 2;
    let rect = Rect::new(x, y, w, h.min(area.height));
    f.render_widget(Paragraph::new(lines), rect);

    // both options are clickable
    for i in 0..2u16 {
        app.hits.push(Hit {
            rect: Rect::new(x, y + opts_start + i, w, 1),
            act: if i == 0 { Act::TrustYes } else { Act::TrustNo },
        });
    }
}

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
        format!("{version} | RV32IM 5-stage pipeline"),
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

    let left_w = 36u16;
    let right_w = 40u16;
    let box_w = (left_w + right_w + 3).min(area.width.saturating_sub(2));
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
    if let Some(snap) = &app.snap {
        left.push(Span::styled(
            format!(
                "  ·  {}  ·  cycle {}  ·  pc 0x{:08x}",
                app.file_name, snap.cycle, snap.pc
            ),
            th.dim(),
        ));
    } else {
        left.push(Span::styled(format!("  ·  {}", app.file_name), th.dim()));
    }
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

fn draw_pipeline_tab(f: &mut Frame, app: &mut App, th: &Th, area: Rect) {
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
                lines.push(Line::styled("bubble", th.warn()));
                lines.push(Line::styled(
                    "stall",
                    th.warn().add_modifier(Modifier::BOLD),
                ));
            }
            StageState::Flush => {
                let text = stage
                    .and_then(|s| s.text.clone())
                    .unwrap_or_else(|| "bubble".into());
                lines.push(Line::styled(trunc(&text, w), th.err()));
                lines.push(Line::styled(
                    format!("{} flushed", th.sym("✗", "x")),
                    th.err().add_modifier(Modifier::BOLD),
                ));
            }
            StageState::Normal => {
                let text = stage.and_then(|s| s.text.clone()).unwrap_or_default();
                lines.push(Line::styled(trunc(&text, w), Style::new()));
                if let Some(detail) = stage.and_then(|s| s.detail.clone()) {
                    lines.push(Line::styled(trunc(&detail, w), th.warn()));
                } else {
                    lines.push(Line::from(""));
                }
                if let Some(pc) = stage.and_then(|s| s.pc) {
                    lines.push(Line::styled(trunc(&format!("0x{pc:08x}"), w), th.dim()));
                }
            }
        }
        f.render_widget(Paragraph::new(lines), inner);
    }

    draw_forward_lanes(f, app, th, lanes, centers, now);
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
            let chip = format!("[{}={}]", fwd.reg, fwd.value as i32);
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
    let room = (area.width as usize).saturating_sub(2).max(20);
    for (i, part) in wrap_text(&why, room).into_iter().enumerate() {
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
    f.render_widget(
        Paragraph::new(Line::styled(parts.join(sep), th.dim())),
        area,
    );
}

// ---------------------------------------------------------------------------
// Registers + memory tab
// ---------------------------------------------------------------------------

fn draw_state_tab(f: &mut Frame, app: &mut App, th: &Th, area: Rect) {
    let [regs_area, mem_area] =
        Layout::vertical([Constraint::Length(10), Constraint::Min(4)]).areas(area);

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
        ]));
    let inner = block.inner(regs_area);
    f.render_widget(block, regs_area);
    // the [hex]/[dec] toggle in the title is clickable
    app.hits.push(Hit {
        rect: Rect::new(regs_area.x + 12, regs_area.y, 5, 1),
        act: Act::RegFmt,
    });

    let regs: Vec<u32> = app
        .snap
        .as_ref()
        .map(|s| s.registers.clone())
        .unwrap_or_else(|| vec![0; 32]);
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
    for row in 0..8 {
        let mut spans: Vec<Span> = Vec::new();
        for col in 0..4 {
            let i = row * 4 + col;
            let val = regs[i];
            let text = if app.reg_hex {
                format!("0x{val:08x}")
            } else {
                format!("{}", val as i32)
            };
            let vstyle = flash_style(i as u8).unwrap_or_default();
            spans.push(Span::styled(format!("{:>4} ", ABI_NAMES[i]), th.dim()));
            let pad = cell_w.saturating_sub(5 + text.chars().count());
            spans.push(Span::styled(text, vstyle));
            spans.push(Span::raw(" ".repeat(pad)));
        }
        lines.push(Line::from(spans));
    }
    f.render_widget(Paragraph::new(lines), inner);

    // -- memory ----------------------------------------------------------
    let block = Block::bordered()
        .border_set(th.border_set())
        .border_style(th.dim())
        .title(Line::from(vec![Span::styled(
            format!(" memory · 0x{:08x} ", app.mem_addr),
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
            let addr = app.mem_addr.wrapping_add((r * 16) as u32);
            let mut words: Vec<String> = Vec::new();
            for wi in 0..4 {
                let o = r * 16 + wi * 4;
                let w = u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
                words.push(format!("{w:08x}"));
            }
            lines.push(Line::from(vec![
                Span::styled(format!("0x{addr:08x}  "), th.dim()),
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
    let (title, body) = TOUR_STEPS[step];
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
        let h = desired_h.min(terminal.height);
        let x = terminal.x + terminal.width.saturating_sub(w) / 2;
        Rect::new(x, terminal.y, w, h)
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
            None,
            Arc::new(Mutex::new(None)),
            crate::doctor::InstallMethod::Manual,
        );
        app.caps = Caps { color: true, unicode };
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
            assert!(pipe.contains("› addi needs x1 from addi"), "why line missing at {w}x{h}:\n{pipe}");
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
}

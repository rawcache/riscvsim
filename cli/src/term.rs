//! Terminal capabilities and colour, decided once per process.
//!
//! Rules (shared by every command):
//! - colour only when the stream it is written to is a TTY (or
//!   `CLICOLOR_FORCE` is set), `NO_COLOR` is unset or empty, `TERM` is not
//!   `dumb`, and `--no-color` was not given;
//! - Unicode symbols only when the locale is UTF-8 and `TERM` is not `dumb`,
//!   otherwise plain ASCII stand-ins;
//! - width from `COLUMNS`, then the terminal, then 80.
//!
//! Nothing here runs at startup beyond reading a few environment variables
//! on first use.

use std::io::IsTerminal;
use std::sync::atomic::{AtomicBool, Ordering};

static NO_COLOR_FLAG: AtomicBool = AtomicBool::new(false);

/// `--no-color` on the command line.
pub fn disable_color() {
    NO_COLOR_FLAG.store(true, Ordering::Relaxed);
}

fn env_nonempty(key: &str) -> bool {
    std::env::var_os(key).is_some_and(|v| !v.is_empty())
}

fn term_is_dumb() -> bool {
    std::env::var("TERM").is_ok_and(|t| t == "dumb")
}

/// Colour is allowed at all (independent of which stream is a TTY).
pub fn color_allowed() -> bool {
    !NO_COLOR_FLAG.load(Ordering::Relaxed) && !env_nonempty("NO_COLOR") && !term_is_dumb()
}

/// `CLICOLOR_FORCE=1`: colour even when piped (for pagers like `less -R`
/// and for tests). `NO_COLOR`, `--no-color` and `TERM=dumb` still win.
pub fn color_forced() -> bool {
    std::env::var("CLICOLOR_FORCE").is_ok_and(|v| !v.is_empty() && v != "0")
}

/// The locale says UTF-8 and the terminal is not `dumb`.
pub fn unicode() -> bool {
    if term_is_dumb() {
        return false;
    }
    if cfg!(windows) {
        return true;
    }
    ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .find(|v| !v.is_empty())
        .map(|v| {
            let v = v.to_ascii_lowercase();
            v.contains("utf-8") || v.contains("utf8")
        })
        .unwrap_or(false)
}

/// Usable output width in columns (never below 40).
pub fn width() -> usize {
    let cols = std::env::var("COLUMNS")
        .ok()
        .and_then(|c| c.trim().parse::<usize>().ok())
        .filter(|c| *c > 0)
        .or_else(|| {
            if std::io::stdout().is_terminal() || std::io::stderr().is_terminal() {
                ratatui::crossterm::terminal::size()
                    .ok()
                    .map(|(w, _)| w as usize)
                    .filter(|w| *w > 0)
            } else {
                None
            }
        })
        .unwrap_or(80);
    cols.max(40)
}

#[derive(Clone, Copy)]
pub enum Stream {
    Stdout,
    Stderr,
}

impl Stream {
    pub fn is_tty(self) -> bool {
        match self {
            Stream::Stdout => std::io::stdout().is_terminal(),
            Stream::Stderr => std::io::stderr().is_terminal(),
        }
    }
}

/// Styles text for one output stream. Colours are informational, never
/// decorative: green success · red error · yellow warning · cyan status ·
/// gray detail.
#[derive(Clone, Copy)]
pub struct Paint {
    pub enabled: bool,
    pub unicode: bool,
}

#[allow(clippy::new_without_default)]
impl Paint {
    /// Paint for stdout.
    pub fn new() -> Self {
        Self::for_stream(Stream::Stdout)
    }

    pub fn stderr() -> Self {
        Self::for_stream(Stream::Stderr)
    }

    pub fn for_stream(stream: Stream) -> Self {
        Self {
            enabled: (stream.is_tty() || color_forced()) && color_allowed(),
            unicode: unicode(),
        }
    }

    /// Fixed settings, for tests and snapshots.
    pub fn fixed(enabled: bool, unicode: bool) -> Self {
        Self { enabled, unicode }
    }

    fn wrap(&self, code: &str, text: &str) -> String {
        if self.enabled && !text.is_empty() {
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
    pub fn error_bold(&self, t: &str) -> String {
        self.wrap("1;31", t)
    }
    pub fn warn(&self, t: &str) -> String {
        self.wrap("33", t)
    }
    pub fn warn_bold(&self, t: &str) -> String {
        self.wrap("1;33", t)
    }
    pub fn info_bold(&self, t: &str) -> String {
        self.wrap("1;36", t)
    }
    pub fn gutter(&self, t: &str) -> String {
        self.wrap("34", t)
    }
    pub fn gray(&self, t: &str) -> String {
        self.wrap("90", t)
    }
    pub fn bold(&self, t: &str) -> String {
        self.wrap("1", t)
    }
    pub fn changed(&self, t: &str) -> String {
        self.wrap("1;32", t)
    }

    /// A symbol with an ASCII stand-in for non-UTF-8 terminals.
    pub fn sym(&self, uni: &'static str, ascii: &'static str) -> &'static str {
        if self.unicode {
            uni
        } else {
            ascii
        }
    }
    pub fn ok_mark(&self) -> String {
        self.success(self.sym("✓", "[ok]"))
    }
    pub fn err_mark(&self) -> String {
        self.error(self.sym("✗", "error:"))
    }
    pub fn warn_mark(&self) -> String {
        self.warn(self.sym("!", "[!]"))
    }
    pub fn dot(&self) -> &'static str {
        self.sym("·", "-")
    }
    /// The accent arrow used in headings and prompts: `›` or `>`.
    pub fn chevron(&self) -> &'static str {
        self.sym("›", ">")
    }
    /// A command heading such as `riscvsim › serve`, with the two-space margin.
    pub fn heading(&self, command: &str) -> String {
        format!("  {} {} {}", self.bold("riscvsim"), self.status(self.chevron()), self.bold(command))
    }
    /// A key hint such as `Enter next`: the key in cyan, the action dim.
    pub fn key(&self, key: &str, action: &str) -> String {
        format!("{} {}", self.status(key), self.gray(action))
    }
}

/// Visible width of a string that may contain our SGR escapes.
pub fn visible_width(s: &str) -> usize {
    let mut n = 0;
    let mut in_esc = false;
    for c in s.chars() {
        if in_esc {
            if c == 'm' {
                in_esc = false;
            }
        } else if c == '\x1b' {
            in_esc = true;
        } else {
            n += 1;
        }
    }
    n
}

/// Thousands separators: 1234567 -> "1,234,567".
pub fn group_thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Word-wrap `text` to `width` columns.
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut cur = String::new();
    for word in text.split_whitespace() {
        let need = if cur.is_empty() { word.chars().count() } else { cur.chars().count() + 1 + word.chars().count() };
        if need > width && !cur.is_empty() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_paint_emits_no_escapes() {
        let p = Paint::fixed(false, true);
        let s = format!("{}{}{}", p.error("x"), p.bold("y"), p.ok_mark());
        assert!(!s.contains('\x1b'));
    }

    #[test]
    fn ascii_fallback_marks() {
        let p = Paint::fixed(false, false);
        assert_eq!(p.ok_mark(), "[ok]");
        assert_eq!(p.err_mark(), "error:");
    }

    #[test]
    fn visible_width_ignores_sgr() {
        let p = Paint::fixed(true, true);
        assert_eq!(visible_width(&p.error("abc")), 3);
    }

    #[test]
    fn thousands() {
        assert_eq!(group_thousands(0), "0");
        assert_eq!(group_thousands(999), "999");
        assert_eq!(group_thousands(1000), "1,000");
        assert_eq!(group_thousands(1234567), "1,234,567");
    }

    #[test]
    fn wraps_words() {
        assert_eq!(wrap("aa bb cc", 5), vec!["aa bb", "cc"]);
    }
}

/// Full-screen drawing for small interactive views (the demo tour). All
/// cursor control lives here, so callers only hand over finished lines.
pub mod screen {
    use ratatui::crossterm::cursor::{Hide, Show};
    use ratatui::crossterm::execute;
    use ratatui::crossterm::terminal::{
        disable_raw_mode, enable_raw_mode, BeginSynchronizedUpdate, EndSynchronizedUpdate, EnterAlternateScreen,
        LeaveAlternateScreen,
    };
    use std::io::Write;

    /// Switch to the alternate screen with raw keys and a hidden cursor.
    pub fn enter() -> std::io::Result<()> {
        enable_raw_mode()?;
        execute!(std::io::stdout(), EnterAlternateScreen, Hide)
    }

    /// Put the terminal back exactly as it was.
    pub fn leave() -> std::io::Result<()> {
        let raw = disable_raw_mode();
        execute!(std::io::stdout(), EndSynchronizedUpdate, LeaveAlternateScreen, Show)?;
        raw
    }

    /// The bytes that redraw the whole screen in place: home, each line
    /// cleared to its end, then everything below cleared. Built as one
    /// string and written in one go (inside a synchronized update where the
    /// terminal supports it), so there is never a flicker.
    pub fn frame(lines: &[String], rows: usize) -> String {
        let mut out = String::from("\x1b[H");
        for (i, line) in lines.iter().take(rows).enumerate() {
            out.push_str(line);
            out.push_str("\x1b[K");
            if i + 1 < rows.min(lines.len()) {
                out.push_str("\r\n");
            }
        }
        out.push_str("\x1b[J");
        out
    }

    pub fn draw(lines: &[String], rows: usize) -> std::io::Result<()> {
        let mut stdout = std::io::stdout().lock();
        execute!(stdout, BeginSynchronizedUpdate)?;
        stdout.write_all(frame(lines, rows).as_bytes())?;
        execute!(stdout, EndSynchronizedUpdate)?;
        stdout.flush()
    }

    /// Terminal size as (columns, rows), with a safe default.
    pub fn size() -> (usize, usize) {
        // Some pseudo-terminals report 0x0; treat that as unknown.
        match ratatui::crossterm::terminal::size() {
            Ok((w, h)) if w > 0 && h > 0 => (w as usize, h as usize),
            _ => (80, 24),
        }
    }
}

//! Compiler-style diagnostics:
//!
//! ```text
//! error: unknown instruction 'adddi'
//!  --> bad.s:2:1
//!   |
//! 2 | adddi x2, x1, 3
//!   | ^^^^^ did you mean 'addi'?
//! ```
//!
//! The engine reports a line number and a plain-English message. This module
//! finds the column (the quoted token in the message, located in the source
//! line), lifts any "did you mean" out of the message to sit under the caret,
//! and adds a suggestion of its own for unknown labels and identifiers.

use crate::term::Paint;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    /// Rendered in yellow; no engine message produces one yet.
    #[allow(dead_code)]
    Warning,
}

#[derive(Debug, Clone)]
pub struct Diagnostic {
    pub severity: Severity,
    pub file: String,
    /// 1-based; 0 when unknown.
    pub line: usize,
    /// 1-based column of the problem, when known.
    pub col: Option<usize>,
    /// Width of the underline (at least 1).
    pub span: usize,
    pub source_line: Option<String>,
    pub message: String,
    /// "did you mean 'x'?" — shown next to the caret.
    pub suggestion: Option<String>,
    /// Extra guidance, shown as `= help: ...`.
    pub help: Option<String>,
}

impl Diagnostic {
    /// Build a diagnostic from an engine error (line + message) and the
    /// source it refers to.
    pub fn from_engine(file: &str, source: &str, line: usize, message: &str) -> Self {
        let (message, mut suggestion) = split_suggestion(message);
        let source_line = if line > 0 {
            source.lines().nth(line - 1).map(|l| l.trim_end_matches('\r').to_string())
        } else {
            None
        };
        let token = quoted_token(&message);
        let (col, span) = match (&source_line, &token) {
            (Some(text), Some(tok)) => match find_token(text, tok) {
                Some(c) => (Some(c + 1), tok.chars().count().max(1)),
                None => (None, 1),
            },
            _ => (None, 1),
        };
        if suggestion.is_none() {
            if let Some(tok) = &token {
                suggestion = suggest_for(&message, tok, source);
            }
        }
        let help = help_for(&message);
        Self {
            severity: Severity::Error,
            file: file.to_string(),
            line,
            col,
            span,
            source_line,
            message,
            suggestion,
            help,
        }
    }

    /// Render for a terminal `width` columns wide.
    pub fn render(&self, p: &Paint, width: usize) -> String {
        let mut out = String::new();
        let label = match self.severity {
            Severity::Error => p.error_bold("error"),
            Severity::Warning => p.warn_bold("warning"),
        };
        out.push_str(&format!("{label}{} {}\n", p.bold(":"), p.bold(&self.message)));

        let location = match (self.line, self.col) {
            (0, _) => self.file.clone(),
            (l, Some(c)) => format!("{}:{l}:{c}", self.file),
            (l, None) => format!("{}:{l}", self.file),
        };
        let num = if self.line > 0 { self.line.to_string() } else { String::new() };
        let pad = " ".repeat(num.len());
        let arrow = p.sym("-->", "-->");
        out.push_str(&format!("{pad}{} {location}\n", p.gutter(arrow)));

        let bar = p.gutter("|");
        if let Some(text) = &self.source_line {
            // Expand tabs so the caret lines up; window very long lines.
            let expanded = text.replace('\t', "    ");
            let col_disp = self.col.map(|c| {
                let before: String = text.chars().take(c - 1).collect();
                before.replace('\t', "    ").chars().count()
            });
            let avail = width.saturating_sub(num.len() + 3).max(20);
            let (shown, offset) = window(&expanded, col_disp.unwrap_or(0), self.span, avail, p);
            out.push_str(&format!("{pad} {bar}\n"));
            out.push_str(&format!("{} {bar} {shown}\n", p.gutter(&num)));
            if let Some(c) = col_disp {
                let lead = " ".repeat(c.saturating_sub(offset));
                let span = self.span.min(avail.saturating_sub(c.saturating_sub(offset)).max(1));
                let carets = "^".repeat(span);
                let mark = match self.severity {
                    Severity::Error => p.error_bold(&carets),
                    Severity::Warning => p.warn_bold(&carets),
                };
                let tail = match &self.suggestion {
                    Some(s) => format!(" {}", p.info_bold(s)),
                    None => String::new(),
                };
                out.push_str(&format!("{pad} {bar} {lead}{mark}{tail}\n"));
            } else if let Some(s) = &self.suggestion {
                out.push_str(&format!("{pad} {bar}\n"));
                out.push_str(&format!("{pad} {} {}: {s}\n", p.gutter("="), p.bold("help")));
            }
        } else if let Some(s) = &self.suggestion {
            out.push_str(&format!("{pad} {} {}: {s}\n", p.gutter("="), p.bold("help")));
        }
        if let Some(h) = &self.help {
            let indent = num.len() + 9; // " = help: "
            let lines = crate::term::wrap(h, width.saturating_sub(indent).max(20));
            for (i, l) in lines.iter().enumerate() {
                if i == 0 {
                    out.push_str(&format!("{pad} {} {}: {l}\n", p.gutter("="), p.bold("help")));
                } else {
                    out.push_str(&format!("{}{l}\n", " ".repeat(indent)));
                }
            }
        }
        out
    }
}

/// Cut `text` to `avail` columns around the highlighted span. Returns the
/// shown text and how many columns were dropped from the left.
fn window(text: &str, col: usize, span: usize, avail: usize, p: &Paint) -> (String, usize) {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= avail {
        return (text.to_string(), 0);
    }
    let ell = p.sym("…", "...");
    let ell_w = ell.chars().count();
    let mut start = 0usize;
    if col + span + ell_w > avail {
        start = (col + span + ell_w * 2 + 4).saturating_sub(avail).min(chars.len());
    }
    let mut shown = String::new();
    let mut offset = start;
    let mut budget = avail;
    if start > 0 {
        shown.push_str(ell);
        budget -= ell_w;
        offset = start - ell_w;
    }
    let end = (start + budget).min(chars.len());
    let cut = end < chars.len();
    let end = if cut { end - ell_w } else { end };
    shown.extend(&chars[start..end]);
    if cut {
        shown.push_str(ell);
    }
    (shown, offset)
}

/// Split "msg: did you mean 'x'? (rest)" into ("msg (rest)", "did you mean 'x'?").
pub fn split_suggestion(message: &str) -> (String, Option<String>) {
    let Some(at) = message.find("did you mean") else {
        return (message.to_string(), None);
    };
    let head = message[..at].trim_end().trim_end_matches([':', ',', ';', '—', '-']).trim_end();
    let rest = &message[at..];
    let end = rest.find('?').map(|i| i + 1).unwrap_or(rest.len());
    let suggestion = rest[..end].trim().to_string();
    let tail = rest[end..].trim();
    let mut main = head.to_string();
    if !tail.is_empty() {
        main.push(' ');
        main.push_str(tail);
    }
    (main, Some(suggestion))
}

/// The first 'single-quoted' token in a message.
pub fn quoted_token(message: &str) -> Option<String> {
    let start = message.find('\'')? + 1;
    let len = message[start..].find('\'')?;
    let tok = &message[start..start + len];
    (!tok.is_empty() && !tok.contains(' ')).then(|| tok.to_string())
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '.'
}

/// Char index of `token` in `line`, preferring a whole-word match and
/// ignoring anything after a comment marker.
pub fn find_token(line: &str, token: &str) -> Option<usize> {
    let code_end = ["#", "//"]
        .iter()
        .filter_map(|m| line.find(m))
        .min()
        .unwrap_or(line.len());
    let code = &line[..code_end];
    let mut fallback = None;
    let mut from = 0;
    while let Some(rel) = code[from..].find(token) {
        let at = from + rel;
        let before_ok = code[..at].chars().last().is_none_or(|c| !is_word(c));
        let after_ok = code[at + token.len()..].chars().next().is_none_or(|c| !is_word(c));
        let char_idx = code[..at].chars().count();
        if before_ok && after_ok {
            return Some(char_idx);
        }
        fallback.get_or_insert(char_idx);
        from = at + token.len();
    }
    fallback.or_else(|| line.find(token).map(|b| line[..b].chars().count()))
}

/// Edit distance where swapping two neighbouring letters counts as one
/// edit ("rnu" -> "run"), the most common typing slip.
pub fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[a.len()][b.len()]
}

/// The closest candidate within a length-scaled edit distance.
pub fn closest<'a>(word: &str, candidates: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let n = word.chars().count();
    if n < 3 {
        return None;
    }
    let max = if n <= 4 { 1 } else { 2 };
    candidates
        .into_iter()
        .filter(|c| *c != word)
        .map(|c| (edit_distance(&word.to_lowercase(), &c.to_lowercase()), c))
        .filter(|(d, _)| *d <= max)
        .min_by_key(|(d, _)| *d)
        .map(|(_, c)| c)
}

/// Labels defined in assembly source (`name:` at the start of a line).
fn asm_labels(source: &str) -> Vec<&str> {
    source
        .lines()
        .filter_map(|l| {
            let l = l.trim_start();
            let end = l.find(':')?;
            let name = &l[..end];
            (!name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.'))
                .then_some(name)
        })
        .collect()
}

/// Identifier-like words in source (for C/C++/Rust "not declared" errors).
fn identifiers(source: &str) -> Vec<&str> {
    let mut out: Vec<&str> = source
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| w.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_'))
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

fn suggest_for(message: &str, token: &str, source: &str) -> Option<String> {
    let lower = message.to_lowercase();
    let pick = if lower.contains("label") && lower.contains("not found") {
        closest(token, asm_labels(source))
    } else if lower.contains("not declared") || lower.contains("undeclared") || lower.contains("unknown function") || lower.contains("not defined") {
        closest(token, identifiers(source))
    } else {
        None
    };
    pick.map(|s| format!("did you mean '{s}'?"))
}

fn help_for(message: &str) -> Option<String> {
    let lower = message.to_lowercase();
    if lower.starts_with("invalid register") {
        return Some("registers are x0 to x31, or ABI names such as zero, ra, sp, a0-a7, t0-t6, s0-s11".into());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = "addi x1, x0, 5\nadddi x2, x1, 3\nadd x3, x1, x99\nloop: beq x1, x2, lopp\n";

    fn plain(d: &Diagnostic) -> String {
        d.render(&Paint::fixed(false, true), 80)
    }

    #[test]
    fn snapshot_unknown_instruction_plain() {
        let d = Diagnostic::from_engine("bad.s", SRC, 2, "unknown instruction 'adddi': did you mean 'addi'?");
        assert_eq!(
            plain(&d),
            "error: unknown instruction 'adddi'\n --> bad.s:2:1\n  |\n2 | adddi x2, x1, 3\n  | ^^^^^ did you mean 'addi'?\n"
        );
    }

    #[test]
    fn snapshot_unknown_instruction_color() {
        let d = Diagnostic::from_engine("bad.s", SRC, 2, "unknown instruction 'adddi': did you mean 'addi'?");
        let s = d.render(&Paint::fixed(true, true), 80);
        assert_eq!(
            s,
            "\x1b[1;31merror\x1b[0m\x1b[1m:\x1b[0m \x1b[1munknown instruction 'adddi'\x1b[0m\n \
             \x1b[34m-->\x1b[0m bad.s:2:1\n  \x1b[34m|\x1b[0m\n\x1b[34m2\x1b[0m \x1b[34m|\x1b[0m adddi x2, x1, 3\n  \
             \x1b[34m|\x1b[0m \x1b[1;31m^^^^^\x1b[0m \x1b[1;36mdid you mean 'addi'?\x1b[0m\n"
        );
        // Without colour, the same text with every escape removed.
        let stripped: String = {
            let mut out = String::new();
            let mut esc = false;
            for c in s.chars() {
                if esc {
                    esc = c != 'm';
                } else if c == '\x1b' {
                    esc = true;
                } else {
                    out.push(c);
                }
            }
            out
        };
        assert_eq!(stripped, plain(&d));
    }

    #[test]
    fn snapshot_register_help() {
        let d = Diagnostic::from_engine("bad.s", SRC, 3, "invalid register 'x99'");
        assert_eq!(
            plain(&d),
            "error: invalid register 'x99'\n --> bad.s:3:13\n  |\n3 | add x3, x1, x99\n  |             ^^^\n  \
             = help: registers are x0 to x31, or ABI names such as zero, ra, sp, a0-a7,\n          t0-t6, s0-s11\n"
        );
    }

    #[test]
    fn label_suggestion_from_source() {
        let d = Diagnostic::from_engine("bad.s", SRC, 4, "label 'lopp' not found");
        assert_eq!(d.col, Some(19));
        assert_eq!(d.suggestion.as_deref(), Some("did you mean 'loop'?"));
    }

    #[test]
    fn undeclared_identifier_suggestion() {
        let src = "int main() {\n  int count = 1;\n  return conut;\n}\n";
        let d = Diagnostic::from_engine("p.c", src, 3, "'conut' is not declared");
        assert_eq!(d.col, Some(10));
        assert_eq!(d.suggestion.as_deref(), Some("did you mean 'count'?"));
        // one-letter names never get a guess
        let d = Diagnostic::from_engine("p.c", "int x;\nreturn y;\n", 2, "'y' is not declared");
        assert_eq!(d.suggestion, None);
    }

    #[test]
    fn warning_severity_is_yellow() {
        let mut d = Diagnostic::from_engine("a.s", "nop\n", 1, "odd 'nop'");
        d.severity = Severity::Warning;
        let s = d.render(&Paint::fixed(true, true), 80);
        assert!(s.starts_with("\x1b[1;33mwarning\x1b[0m"));
        assert!(s.contains("\x1b[1;33m^^^\x1b[0m"));
    }

    #[test]
    fn transposed_letters_are_one_edit() {
        assert_eq!(edit_distance("rnu", "run"), 1);
        assert_eq!(closest("rnu", ["run", "tui", "demo"]), Some("run"));
        assert_eq!(closest("trnaslate", ["translate", "tui"]), Some("translate"));
    }

    #[test]
    fn no_line_known() {
        let d = Diagnostic::from_engine("p.c", "", 0, "unsupported: floating point");
        assert_eq!(plain(&d), "error: unsupported: floating point\n--> p.c\n");
    }

    #[test]
    fn suggestion_tail_is_kept() {
        let (m, s) = split_suggestion("unknown instruction 'x': did you mean 'y'? (RV64IM only)");
        assert_eq!(m, "unknown instruction 'x' (RV64IM only)");
        assert_eq!(s.as_deref(), Some("did you mean 'y'?"));
    }

    #[test]
    fn long_lines_fit_80_columns() {
        let long = format!("{}adddi x1, x2, 3", "    nop; ".repeat(20));
        let d = Diagnostic::from_engine("w.s", &long, 1, "unknown instruction 'adddi'");
        let out = plain(&d);
        for line in out.lines() {
            assert!(line.chars().count() <= 80, "{line}");
        }
        let caret = out.lines().find(|l| l.contains('^')).unwrap();
        let src = out.lines().find(|l| l.contains("adddi x1")).unwrap();
        let at = caret.find('^').unwrap();
        assert_eq!(&src[src.char_indices().nth(at).unwrap().0..][..5], "adddi");
    }

    #[test]
    fn ascii_mode_has_no_unicode() {
        let long = format!("{}adddi x1, x2, 3", "    nop; ".repeat(20));
        let d = Diagnostic::from_engine("w.s", &long, 1, "unknown instruction 'adddi'");
        assert!(d.render(&Paint::fixed(false, false), 80).is_ascii());
    }
}

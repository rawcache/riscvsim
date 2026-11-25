//! Source-level conveniences shared by the RV32 and RV64 assemblers.
//!
//! [`prepare`] rewrites a program line by line (line numbers never change)
//! before the two-pass assemblers see it:
//!
//! * `/* ... */` block comments (which may span lines) become spaces;
//! * `.equ name, value` / `.set name, value` define constants that replace
//!   later whole-word uses of `name`;
//! * GNU local numeric labels: `1:` defines, `1b` / `1f` refer to the
//!   nearest definition backwards / forwards;
//! * character literals such as `'a'`, `'\n'`, `'\''` become numbers;
//! * `.bss` and `.section .text/.data/.rodata/.bss` select sections;
//! * `.balign N` becomes the equivalent power-of-two `.align`.
//!
//! [`parse_int_literal`] is the single number parser both assemblers use:
//! decimal, `0x` hex, `0b` binary, `0o` or leading-zero octal (as GNU `as`),
//! character literals, with an optional sign.

use std::collections::BTreeMap;

pub(crate) struct Prepared {
    pub text: String,
    /// For lines the pre-pass changed: the original line (comment-free),
    /// used as display text so listings show what the user wrote.
    pub display: BTreeMap<usize, String>,
    /// Errors as (1-based line, message).
    pub errors: Vec<(usize, String)>,
}

/// Parse an integer literal. Returns `None` for anything malformed.
pub(crate) fn parse_int_literal(token: &str) -> Option<i128> {
    let t = token.trim();
    if let Some(v) = parse_char_literal(t) {
        return Some(v);
    }
    let (neg, body) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits = |s: &str, radix: u32| -> Option<i128> {
        if s.is_empty() || s.len() > 130 || !s.chars().all(|c| c.is_digit(radix)) {
            return None;
        }
        i128::from_str_radix(s, radix).ok()
    };
    let value = if let Some(hex) = body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")) {
        digits(hex, 16)?
    } else if let Some(bin) = body.strip_prefix("0b").or_else(|| body.strip_prefix("0B")) {
        digits(bin, 2)?
    } else if let Some(oct) = body.strip_prefix("0o").or_else(|| body.strip_prefix("0O")) {
        digits(oct, 8)?
    } else if body.len() > 1 && body.starts_with('0') {
        digits(&body[1..], 8)?
    } else {
        digits(body, 10)?
    };
    Some(if neg { -value } else { value })
}

fn escape_value(c: char) -> Option<u32> {
    Some(match c {
        'n' => 10,
        't' => 9,
        'r' => 13,
        '0' => 0,
        'a' => 7,
        'b' => 8,
        'f' => 12,
        'v' => 11,
        'e' => 27,
        '\\' => 92,
        '\'' => 39,
        '"' => 34,
        _ => return None,
    })
}

fn parse_char_literal(t: &str) -> Option<i128> {
    let inner = t.strip_prefix('\'')?.strip_suffix('\'')?;
    let mut chars = inner.chars();
    let value = match (chars.next()?, chars.next(), chars.next()) {
        ('\\', Some(e), None) => escape_value(e)?,
        (c, None, None) if c != '\\' && c != '\'' => c as u32,
        _ => return None,
    };
    Some(value as i128)
}

/// Remove `/* */` comments (keeping newlines) while respecting strings and
/// `#` / `//` line comments.
fn strip_block_comments(source: &str, errors: &mut Vec<(usize, String)>) -> String {
    let mut out = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    let mut line = 1usize;
    let mut in_string = false;
    let mut in_line_comment = false;
    while let Some(c) = chars.next() {
        if c == '\n' {
            line += 1;
            in_line_comment = false;
            in_string = false;
            out.push(c);
            continue;
        }
        if in_line_comment {
            out.push(c);
            continue;
        }
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(&n) = chars.peek() {
                    if n != '\n' {
                        out.push(n);
                        chars.next();
                    }
                }
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '\'' => {
                // Character literal: copy it whole so a quote inside it
                // ('"') does not start a string.
                out.push(c);
                let mut taken = 0;
                while let Some(&n) = chars.peek() {
                    if n == '\n' || taken > 3 {
                        break;
                    }
                    out.push(n);
                    chars.next();
                    taken += 1;
                    if n == '\\' {
                        if let Some(&e) = chars.peek() {
                            if e != '\n' {
                                out.push(e);
                                chars.next();
                            }
                        }
                    } else if n == '\'' {
                        break;
                    }
                }
            }
            '#' => {
                in_line_comment = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                in_line_comment = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let start = line;
                let mut closed = false;
                out.push(' ');
                while let Some(n) = chars.next() {
                    if n == '\n' {
                        line += 1;
                        out.push('\n');
                    } else if n == '*' && chars.peek() == Some(&'/') {
                        chars.next();
                        closed = true;
                        break;
                    }
                }
                if !closed {
                    errors.push((
                        start,
                        "unterminated /* comment: add */ to close it".to_string(),
                    ));
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// Split a line into (code, comment) at the first `#` or `//` outside a
/// string or character literal.
fn split_comment(line: &str) -> (&str, &str) {
    let bytes = line.as_bytes();
    let mut i = 0;
    let mut in_str = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if c == b'\\' {
                i += 1;
            } else if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if c == b'\'' {
            // skip a character literal
            let rest = &line[i..];
            if let Some(len) = char_literal_len(rest) {
                i += len;
                continue;
            }
        } else if c == b'#' || (c == b'/' && bytes.get(i + 1) == Some(&b'/')) {
            return (&line[..i], &line[i..]);
        }
        i += 1;
    }
    (line, "")
}

/// Byte length of a character literal at the start of `s`, if any.
fn char_literal_len(s: &str) -> Option<usize> {
    let mut it = s.char_indices();
    it.next()?; // opening quote
    let (_, c) = it.next()?;
    if c == '\\' {
        it.next()?;
    }
    let (end, close) = it.next()?;
    (close == '\'').then_some(end + 1)
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '$'
}

/// Apply `f` to every maximal identifier-like word outside strings and
/// character literals; `f` returns a replacement or `None` to keep it.
fn map_words(code: &str, mut f: impl FnMut(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(code.len());
    let mut chars = code.char_indices().peekable();
    let mut in_str = false;
    while let Some((i, c)) = chars.next() {
        if in_str {
            out.push(c);
            if c == '\\' {
                if let Some((_, n)) = chars.next() {
                    out.push(n);
                }
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            continue;
        }
        if c == '\'' {
            if let Some(len) = char_literal_len(&code[i..]) {
                let lit = &code[i..i + len];
                match parse_char_literal(lit) {
                    Some(v) => out.push_str(&v.to_string()),
                    None => out.push_str(lit),
                }
                while chars.peek().is_some_and(|(j, _)| *j < i + len) {
                    chars.next();
                }
                continue;
            }
        }
        if is_ident_char(c) {
            let mut end = i + c.len_utf8();
            while let Some(&(j, n)) = chars.peek() {
                if is_ident_char(n) {
                    end = j + n.len_utf8();
                    chars.next();
                } else {
                    break;
                }
            }
            let word = &code[i..end];
            match f(word) {
                Some(r) => out.push_str(&r),
                None => out.push_str(word),
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn local_label_name(n: &str, k: usize) -> String {
    format!(".Lnum{n}_{k}")
}

/// Leading `N:` local-label definitions on a code line: returns the numbers
/// and the remaining text.
fn leading_numeric_labels(code: &str) -> (Vec<String>, &str) {
    let mut labels = Vec::new();
    let mut rest = code.trim_start();
    loop {
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            break;
        }
        let after = rest[digits.len()..].trim_start();
        if let Some(r) = after.strip_prefix(':') {
            labels.push(digits);
            rest = r.trim_start();
        } else {
            break;
        }
    }
    (labels, rest)
}

/// Leading ordinary `name:` label definitions; returns the remaining text.
fn skip_named_labels(code: &str) -> &str {
    let mut rest = code.trim_start();
    while let Some(colon) = rest.find(':') {
        let candidate = rest[..colon].trim();
        if candidate.is_empty()
            || !candidate.chars().all(is_ident_char)
            || candidate.chars().next().is_some_and(|c| c.is_ascii_digit())
        {
            break;
        }
        rest = rest[colon + 1..].trim_start();
    }
    rest
}

pub(crate) fn prepare(source: &str) -> Prepared {
    let mut errors = Vec::new();
    let stripped = strip_block_comments(source, &mut errors);
    let lines: Vec<&str> = stripped.lines().collect();
    let originals: Vec<&str> = source.lines().collect();

    // Local numeric label definitions: number -> [(line index, ordinal)].
    let mut defs: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (idx, line) in lines.iter().enumerate() {
        let (code, _) = split_comment(line);
        let rest = skip_named_labels(code);
        let (nums, _) = leading_numeric_labels(rest);
        for n in nums {
            defs.entry(n).or_default().push(idx);
        }
    }

    let mut equs: BTreeMap<String, String> = BTreeMap::new();
    let mut out = String::with_capacity(stripped.len());
    let mut display = BTreeMap::new();
    for (idx, line) in lines.iter().enumerate() {
        let line_no = idx + 1;
        let (code, comment) = split_comment(line);
        let trimmed = code.trim();
        let lower = trimmed.to_ascii_lowercase();
        let mut new_code: Option<String> = None;

        // .equ / .set
        let directive = lower.split_whitespace().next().unwrap_or("");
        if directive == ".equ" || directive == ".set" || directive == ".equiv" {
            let body = trimmed[directive.len()..].trim();
            let mut parts = body.splitn(2, ',');
            let name = parts.next().unwrap_or("").trim();
            let value = parts.next().map(str::trim).unwrap_or("");
            let substituted = map_words(value, |w| equs.get(w).cloned());
            if name.is_empty() || !name.chars().all(is_ident_char) || name.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                errors.push((line_no, format!("{directive} expects 'name, value', but found '{body}'")));
            } else if parse_int_literal(&substituted).is_none() {
                errors.push((
                    line_no,
                    format!("{directive} {name}: expected an integer value, but found '{value}'"),
                ));
            } else if directive == ".equiv" && equs.contains_key(name) {
                errors.push((line_no, format!(".equiv {name}: '{name}' is already defined")));
            } else {
                let v = parse_int_literal(&substituted).unwrap_or(0);
                equs.insert(name.to_string(), v.to_string());
            }
            new_code = Some(String::new());
        } else if directive == ".bss" {
            new_code = Some(".data".to_string());
        } else if directive == ".section" {
            let name = lower[directive.len()..].trim().split(',').next().unwrap_or("").trim().to_string();
            new_code = Some(match name.as_str() {
                ".text" | ".text.startup" => ".text".to_string(),
                ".data" | ".rodata" | ".bss" | ".sdata" | ".sbss" | ".srodata" => ".data".to_string(),
                _ => {
                    errors.push((
                        line_no,
                        format!("unknown section '{name}': use .text, .data, .rodata or .bss"),
                    ));
                    String::new()
                }
            });
        } else if directive == ".balign" {
            let arg = trimmed[directive.len()..].trim().split(',').next().unwrap_or("").trim();
            match parse_int_literal(arg) {
                Some(n) if n > 0 && n <= 4096 && (n & (n - 1)) == 0 => {
                    new_code = Some(format!(".align {}", n.trailing_zeros()));
                }
                _ => errors.push((
                    line_no,
                    format!(".balign expects a power of two from 1 to 4096, but found '{arg}'"),
                )),
            }
        } else if directive == ".rodata" {
            new_code = Some(".data".to_string());
        }

        let code_now: String = new_code.clone().unwrap_or_else(|| code.to_string());

        // Local labels and references, equ substitution, char literals.
        let after_named = skip_named_labels(&code_now);
        let prefix_len = code_now.len() - after_named.len();
        let (nums, body) = leading_numeric_labels(after_named);
        let mut rebuilt = code_now[..prefix_len].to_string();
        for n in &nums {
            let k = defs
                .get(n)
                .and_then(|v| v.iter().position(|&l| l == idx))
                .unwrap_or(0);
            rebuilt.push_str(&local_label_name(n, k));
            rebuilt.push_str(": ");
        }
        let mut bad_refs = Vec::new();
        let body_mapped = map_words(body, |w| {
            if let Some(v) = equs.get(w) {
                return Some(v.clone());
            }
            let (num, dir) = w.split_at(w.len().saturating_sub(1));
            if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) || !(dir == "b" || dir == "f") {
                return None;
            }
            let list = defs.get(num).map(Vec::as_slice).unwrap_or(&[]);
            let k = if dir == "b" {
                list.iter().rposition(|&l| l <= idx)
            } else {
                list.iter().position(|&l| l > idx)
            };
            match k {
                Some(k) => Some(local_label_name(num, k)),
                None => {
                    bad_refs.push(w.to_string());
                    None
                }
            }
        });
        for r in bad_refs {
            let (num, dir) = r.split_at(r.len() - 1);
            let way = if dir == "b" { "before" } else { "after" };
            errors.push((
                line_no,
                format!("local label '{r}' has no matching '{num}:' definition {way} this line"),
            ));
        }
        rebuilt.push_str(&body_mapped);

        if rebuilt != code {
            let original = originals.get(idx).copied().unwrap_or("");
            let (orig_code, _) = split_comment(original);
            let shown = skip_named_labels(orig_code);
            let (_, shown) = leading_numeric_labels(shown);
            display.insert(line_no, shown.trim().to_string());
        }
        out.push_str(&rebuilt);
        out.push_str(comment);
        out.push('\n');
    }
    Prepared { text: out, display, errors }
}

/// Replace display text for instructions that came from lines the pre-pass
/// rewrote, so listings show the user's own spelling.
pub(crate) fn restore_display<'a>(
    prepared: &Prepared,
    items: impl Iterator<Item = (usize, &'a mut String)>,
) {
    if prepared.display.is_empty() {
        return;
    }
    let rewritten: Vec<&str> = prepared.text.lines().collect();
    for (line, text) in items {
        let Some(shown) = prepared.display.get(&line) else {
            continue;
        };
        let Some(raw) = rewritten.get(line.wrapping_sub(1)) else {
            continue;
        };
        let (code, _) = split_comment(raw);
        let body = skip_named_labels(code).trim();
        if text.trim() == body {
            *text = shown.clone();
        }
    }
}

/// Every mnemonic the RV32 assembler accepts (instructions and pseudos).
pub(crate) const RV32_MNEMONICS: &[&str] = &[
    "add", "sub", "sll", "slt", "sltu", "xor", "srl", "sra", "or", "and", "mul", "mulh",
    "mulhsu", "mulhu", "div", "divu", "rem", "remu", "addi", "slti", "sltiu", "xori", "ori",
    "andi", "slli", "srli", "srai", "lb", "lh", "lw", "lbu", "lhu", "sb", "sh", "sw", "beq",
    "bne", "blt", "bge", "bltu", "bgeu", "bgt", "ble", "bgtu", "bleu", "lui", "auipc", "jal",
    "jalr", "ecall", "ebreak", "fence", "fence.i", "nop", "mv", "li", "la", "not", "neg", "seqz",
    "snez", "sltz", "sgtz", "beqz", "bnez", "bltz", "bgez", "blez", "bgtz", "j", "jr", "ret",
    "call", "tail",
];

/// Mnemonics that exist only on RV64.
pub(crate) const RV64_ONLY_MNEMONICS: &[&str] = &[
    "addw", "subw", "sllw", "srlw", "sraw", "mulw", "divw", "divuw", "remw", "remuw", "addiw",
    "slliw", "srliw", "sraiw", "ld", "lwu", "sd", "negw", "sext.w",
];

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != *cb);
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// The closest known mnemonic (edit distance at most 2), if any.
pub(crate) fn suggest_mnemonic(mnemonic: &str, xlen: u32) -> Option<&'static str> {
    if mnemonic.len() > 24 {
        return None;
    }
    let extra: &[&str] = if xlen == 64 { RV64_ONLY_MNEMONICS } else { &[] };
    RV32_MNEMONICS
        .iter()
        .chain(extra.iter())
        .map(|m| (edit_distance(mnemonic, m), *m))
        .filter(|(d, _)| *d <= 2)
        .min()
        .map(|(_, m)| m)
}

/// Plain-English error for a mnemonic the assembler does not know.
pub(crate) fn unknown_mnemonic_message(mnemonic: &str, xlen: u32) -> String {
    if xlen == 32 && RV64_ONLY_MNEMONICS.contains(&mnemonic) {
        return format!(
            "'{mnemonic}' is an RV64-only instruction and is not valid for RV32: \
             switch the simulator to RV64, or use the 32-bit form"
        );
    }
    let shown: String = mnemonic.chars().take(40).collect();
    match suggest_mnemonic(mnemonic, xlen) {
        Some(s) => format!("unknown instruction '{shown}': did you mean '{s}'?"),
        None => format!("unknown instruction '{shown}'"),
    }
}

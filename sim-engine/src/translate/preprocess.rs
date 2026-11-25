//! A small C preprocessor for the C and C++ front ends.
//!
//! Supported: object-like and function-like `#define`, `#undef`, `#ifdef`,
//! `#ifndef`, `#if` / `#elif` with integer constant expressions (including
//! `defined(NAME)`), `#else`, `#endif`, line continuations, and comments.
//! `#include` is rejected with a clear error: there are no headers and no
//! standard library. Line numbers are preserved (every input line produces
//! exactly one output line), and macro expansion is bounded by
//! `limits::MAX_NESTING_DEPTH` and `limits::MAX_SOURCE_BYTES`.

use super::TranslateError;
use crate::limits::{MAX_NESTING_DEPTH, MAX_SOURCE_BYTES};
use std::collections::BTreeMap;

#[derive(Clone)]
struct Macro {
    params: Option<Vec<String>>,
    body: String,
}

/// True when the source contains anything for the preprocessor to do.
pub(super) fn needed(source: &str) -> bool {
    source.lines().any(|l| l.trim_start().starts_with('#')) || source.contains("\\\n")
}

fn err(line: usize, message: impl Into<String>) -> TranslateError {
    TranslateError::new(line, message)
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Join backslash-newline continuations, keeping one output line per input
/// line (continued lines become empty).
fn join_continuations(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut pending = String::new();
    let mut blanks = 0;
    for raw in source.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(head) = raw.strip_suffix('\\') {
            pending.push_str(head);
            pending.push(' ');
            blanks += 1;
            continue;
        }
        pending.push_str(raw);
        out.push(std::mem::take(&mut pending));
        for _ in 0..blanks {
            out.push(String::new());
        }
        blanks = 0;
    }
    if !pending.is_empty() {
        out.push(pending);
    }
    out
}

/// Remove comments (tracking `/* */` across lines) so directives and macro
/// bodies never see them. String and character literals are respected.
fn strip_comments(lines: &mut [String]) -> Result<(), TranslateError> {
    let mut in_block = false;
    let mut block_start = 0;
    for (index, line) in lines.iter_mut().enumerate() {
        let mut out = String::with_capacity(line.len());
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        let mut quote: Option<char> = None;
        while i < chars.len() {
            let c = chars[i];
            if in_block {
                if c == '*' && chars.get(i + 1) == Some(&'/') {
                    in_block = false;
                    out.push(' ');
                    i += 2;
                } else {
                    i += 1;
                }
                continue;
            }
            if let Some(q) = quote {
                out.push(c);
                if c == '\\' {
                    if let Some(&n) = chars.get(i + 1) {
                        out.push(n);
                        i += 1;
                    }
                } else if c == q {
                    quote = None;
                }
                i += 1;
                continue;
            }
            match c {
                '"' | '\'' => {
                    quote = Some(c);
                    out.push(c);
                }
                '/' if chars.get(i + 1) == Some(&'/') => break,
                '/' if chars.get(i + 1) == Some(&'*') => {
                    in_block = true;
                    block_start = index + 1;
                    i += 1;
                }
                _ => out.push(c),
            }
            i += 1;
        }
        *line = out;
    }
    if in_block {
        return Err(err(block_start, "unterminated /* comment"));
    }
    Ok(())
}

struct Pre {
    macros: BTreeMap<String, Macro>,
    output_bytes: usize,
    /// Active `expand` calls: nested macro bodies and nested arguments
    /// such as `F(F(F(1)))` both count.
    depth: usize,
}

impl Pre {
    /// Expand macros in `text`. `hidden` holds macros currently being
    /// expanded (they are not re-expanded, as in C).
    fn expand(&mut self, text: &str, line: usize, hidden: &mut Vec<String>) -> Result<String, TranslateError> {
        if hidden.len() > MAX_NESTING_DEPTH || self.depth >= MAX_NESTING_DEPTH {
            return Err(err(line, crate::limits::nesting_message("macro expansion")));
        }
        self.depth += 1;
        let result = self.expand_text(text, line, hidden);
        self.depth -= 1;
        result
    }

    fn expand_text(&mut self, text: &str, line: usize, hidden: &mut Vec<String>) -> Result<String, TranslateError> {
        let chars: Vec<char> = text.chars().collect();
        let mut out = String::with_capacity(text.len());
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '"' || c == '\'' {
                // copy literal verbatim
                out.push(c);
                i += 1;
                while i < chars.len() {
                    let d = chars[i];
                    out.push(d);
                    i += 1;
                    if d == '\\' && i < chars.len() {
                        out.push(chars[i]);
                        i += 1;
                    } else if d == c {
                        break;
                    }
                }
                continue;
            }
            if c.is_ascii_digit() {
                while i < chars.len() && (is_ident(chars[i]) || chars[i] == '.') {
                    out.push(chars[i]);
                    i += 1;
                }
                continue;
            }
            if !is_ident_start(c) {
                out.push(c);
                i += 1;
                continue;
            }
            let start = i;
            while i < chars.len() && is_ident(chars[i]) {
                i += 1;
            }
            let name: String = chars[start..i].iter().collect();
            let Some(m) = self.macros.get(&name).cloned().filter(|_| !hidden.contains(&name)) else {
                out.push_str(&name);
                continue;
            };
            let replacement = match &m.params {
                None => m.body.clone(),
                Some(params) => {
                    // A function-like macro name not followed by '(' is left alone.
                    let mut j = i;
                    while j < chars.len() && chars[j].is_whitespace() {
                        j += 1;
                    }
                    if chars.get(j) != Some(&'(') {
                        out.push_str(&name);
                        continue;
                    }
                    let (args, end) = collect_args(&chars, j, line, &name)?;
                    i = end;
                    let args = if params.is_empty() && args.len() == 1 && args[0].trim().is_empty() {
                        Vec::new()
                    } else {
                        args
                    };
                    if args.len() != params.len() {
                        return Err(err(
                            line,
                            format!(
                                "macro '{name}' expects {} argument(s), but {} were given",
                                params.len(),
                                args.len()
                            ),
                        ));
                    }
                    let mut expanded_args = Vec::new();
                    for a in &args {
                        expanded_args.push(self.expand(a.trim(), line, hidden)?);
                    }
                    substitute(&m.body, params, &expanded_args)
                }
            };
            hidden.push(name);
            let expanded = self.expand(&replacement, line, hidden)?;
            hidden.pop();
            self.output_bytes += expanded.len();
            if self.output_bytes > MAX_SOURCE_BYTES * 4 {
                return Err(err(
                    line,
                    format!(
                        "macro expansion is too large: the expanded program would exceed {} bytes",
                        MAX_SOURCE_BYTES * 4
                    ),
                ));
            }
            out.push(' ');
            out.push_str(&expanded);
            out.push(' ');
        }
        Ok(out)
    }
}

fn collect_args(chars: &[char], open: usize, line: usize, name: &str) -> Result<(Vec<String>, usize), TranslateError> {
    let mut depth = 0usize;
    let mut args = vec![String::new()];
    let mut i = open;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '(' => {
                depth += 1;
                if depth > 1 {
                    args.last_mut().map(|a| a.push(c));
                }
            }
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Ok((args, i + 1));
                }
                args.last_mut().map(|a| a.push(c));
            }
            ',' if depth == 1 => args.push(String::new()),
            _ => {
                args.last_mut().map(|a| a.push(c));
            }
        }
        i += 1;
    }
    Err(err(
        line,
        format!("the arguments of macro '{name}' must close with ')' on the same line"),
    ))
}

fn substitute(body: &str, params: &[String], args: &[String]) -> String {
    let chars: Vec<char> = body.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if is_ident_start(chars[i]) {
            let start = i;
            while i < chars.len() && is_ident(chars[i]) {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            match params.iter().position(|p| *p == word) {
                Some(k) => {
                    out.push('(');
                    out.push_str(&args[k]);
                    out.push(')');
                }
                None => out.push_str(&word),
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

// -- #if expression evaluation ------------------------------------------------

struct Eval<'a> {
    toks: Vec<String>,
    pos: usize,
    line: usize,
    depth: usize,
    _src: &'a str,
}

fn tokenize_expr(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if is_ident(c) {
            let start = i;
            while i < chars.len() && is_ident(chars[i]) {
                i += 1;
            }
            toks.push(chars[start..i].iter().collect());
        } else if c == '\'' {
            let start = i;
            i += 1;
            while i < chars.len() && chars[i] != '\'' {
                if chars[i] == '\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            toks.push(chars[start..i.min(chars.len())].iter().collect());
        } else {
            let two: String = chars[i..(i + 2).min(chars.len())].iter().collect();
            if ["||", "&&", "==", "!=", "<=", ">=", "<<", ">>"].contains(&two.as_str()) {
                toks.push(two);
                i += 2;
            } else {
                toks.push(c.to_string());
                i += 1;
            }
        }
    }
    toks
}

impl Eval<'_> {
    fn peek(&self) -> &str {
        self.toks.get(self.pos).map(String::as_str).unwrap_or("")
    }
    fn next(&mut self) -> String {
        let t = self.peek().to_string();
        self.pos += 1;
        t
    }
    fn fail(&self, what: &str) -> TranslateError {
        err(self.line, format!("invalid #if expression: {what}"))
    }
    fn expr(&mut self, min_prec: u8) -> Result<i64, TranslateError> {
        self.depth += 1;
        if self.depth > MAX_NESTING_DEPTH {
            return Err(err(self.line, crate::limits::nesting_message("this #if expression")));
        }
        let mut left = self.unary()?;
        loop {
            let op = self.peek().to_string();
            let prec = match op.as_str() {
                "||" => 1,
                "&&" => 2,
                "|" => 3,
                "^" => 4,
                "&" => 5,
                "==" | "!=" => 6,
                "<" | ">" | "<=" | ">=" => 7,
                "<<" | ">>" => 8,
                "+" | "-" => 9,
                "*" | "/" | "%" => 10,
                "?" => 0,
                _ => break,
            };
            if op == "?" {
                if min_prec > 0 {
                    break;
                }
                self.next();
                let a = self.expr(0)?;
                if self.next() != ":" {
                    return Err(self.fail("expected ':' in a conditional"));
                }
                let b = self.expr(0)?;
                left = if left != 0 { a } else { b };
                continue;
            }
            if prec < min_prec.max(1) {
                break;
            }
            self.next();
            let right = self.expr(prec + 1)?;
            left = match op.as_str() {
                "||" => i64::from(left != 0 || right != 0),
                "&&" => i64::from(left != 0 && right != 0),
                "|" => left | right,
                "^" => left ^ right,
                "&" => left & right,
                "==" => i64::from(left == right),
                "!=" => i64::from(left != right),
                "<" => i64::from(left < right),
                ">" => i64::from(left > right),
                "<=" => i64::from(left <= right),
                ">=" => i64::from(left >= right),
                "<<" => left.wrapping_shl((right & 63) as u32),
                ">>" => left.wrapping_shr((right & 63) as u32),
                "+" => left.wrapping_add(right),
                "-" => left.wrapping_sub(right),
                "*" => left.wrapping_mul(right),
                "/" | "%" if right == 0 => return Err(self.fail("division by zero")),
                "/" => left.wrapping_div(right),
                _ => left.wrapping_rem(right),
            };
        }
        self.depth -= 1;
        Ok(left)
    }
    /// Prefix operators are collected in a loop (not by recursion), so a
    /// long chain such as `- - - - 1` cannot exhaust the stack.
    fn unary(&mut self) -> Result<i64, TranslateError> {
        let mut prefixes = Vec::new();
        while matches!(self.peek(), "-" | "+" | "!" | "~") {
            prefixes.push(self.next());
        }
        let mut value = self.operand()?;
        for op in prefixes.iter().rev() {
            value = match op.as_str() {
                "-" => value.wrapping_neg(),
                "!" => i64::from(value == 0),
                "~" => !value,
                _ => value,
            };
        }
        Ok(value)
    }

    fn operand(&mut self) -> Result<i64, TranslateError> {
        let t = self.next();
        match t.as_str() {
            "(" => {
                let v = self.expr(0)?;
                if self.next() != ")" {
                    return Err(self.fail("missing ')'"));
                }
                Ok(v)
            }
            "" => Err(self.fail("expected a value")),
            _ if t.starts_with('\'') => {
                let body = t.trim_start_matches('\'').trim_end_matches('\'');
                super::c_char_literal_value(body).ok_or_else(|| self.fail("bad character literal"))
            }
            _ if t.chars().next().is_some_and(|c| c.is_ascii_digit()) => {
                let digits = t.trim_end_matches(['u', 'U', 'l', 'L']);
                let parsed = if let Some(h) = digits.strip_prefix("0x").or_else(|| digits.strip_prefix("0X")) {
                    i64::from_str_radix(h, 16).ok()
                } else if digits.len() > 1 && digits.starts_with('0') {
                    i64::from_str_radix(&digits[1..], 8).ok()
                } else {
                    digits.parse().ok()
                };
                parsed.ok_or_else(|| self.fail(&format!("'{t}' is not a number")))
            }
            // Identifiers left after macro expansion evaluate to 0, as in C.
            _ if t.chars().next().is_some_and(is_ident_start) => Ok(0),
            other => Err(self.fail(&format!("unexpected '{other}'"))),
        }
    }
}

impl Pre {
    fn eval_condition(&mut self, text: &str, line: usize) -> Result<bool, TranslateError> {
        // Resolve defined(X) / defined X before macro expansion.
        let mut resolved = String::new();
        let toks = tokenize_expr(text);
        let mut i = 0;
        while i < toks.len() {
            if toks[i] == "defined" {
                let (name, step) = if toks.get(i + 1).map(String::as_str) == Some("(") {
                    if toks.get(i + 3).map(String::as_str) != Some(")") {
                        return Err(err(line, "invalid #if expression: write defined(NAME)"));
                    }
                    (toks.get(i + 2).cloned().unwrap_or_default(), 4)
                } else {
                    (toks.get(i + 1).cloned().unwrap_or_default(), 2)
                };
                resolved.push_str(if self.macros.contains_key(&name) { " 1 " } else { " 0 " });
                i += step;
            } else {
                resolved.push(' ');
                resolved.push_str(&toks[i]);
                i += 1;
            }
        }
        let expanded = self.expand(&resolved, line, &mut Vec::new())?;
        let mut e = Eval { toks: tokenize_expr(&expanded), pos: 0, line, depth: 0, _src: text };
        if e.toks.is_empty() {
            return Err(err(line, "#if needs an expression"));
        }
        let v = e.expr(0)?;
        if e.pos < e.toks.len() {
            return Err(e.fail(&format!("unexpected '{}'", e.peek())));
        }
        Ok(v != 0)
    }
}

/// Run the preprocessor; returns source with one output line per input line.
pub(super) fn preprocess(source: &str) -> Result<String, TranslateError> {
    let mut lines = join_continuations(source);
    strip_comments(&mut lines)?;
    let mut pre = Pre { macros: BTreeMap::new(), output_bytes: 0, depth: 0 };
    // (active, any branch taken, saw #else, opening line)
    let mut stack: Vec<(bool, bool, bool, usize)> = Vec::new();
    let mut out = String::with_capacity(source.len());
    for (index, text) in lines.iter().enumerate() {
        let line = index + 1;
        let active = stack.iter().all(|s| s.0);
        let trimmed = text.trim_start();
        if let Some(directive) = trimmed.strip_prefix('#') {
            let directive = directive.trim_start();
            let name: String = directive.chars().take_while(|c| is_ident(*c)).collect();
            let rest = directive[name.len()..].trim();
            match name.as_str() {
                "ifdef" | "ifndef" => {
                    let defined = pre.macros.contains_key(rest.split_whitespace().next().unwrap_or(""));
                    let cond = if name == "ifdef" { defined } else { !defined };
                    if stack.len() >= MAX_NESTING_DEPTH {
                        return Err(err(line, crate::limits::nesting_message("#if/#ifdef")));
                    }
                    stack.push((active && cond, cond, false, line));
                }
                "if" => {
                    let cond = active && pre.eval_condition(rest, line)?;
                    if stack.len() >= MAX_NESTING_DEPTH {
                        return Err(err(line, crate::limits::nesting_message("#if/#ifdef")));
                    }
                    stack.push((cond, cond, false, line));
                }
                "elif" => {
                    let parent_active = stack.len() < 2 || stack[..stack.len() - 1].iter().all(|s| s.0);
                    let Some(top) = stack.last().copied() else {
                        return Err(err(line, "#elif without a matching #if"));
                    };
                    if top.2 {
                        return Err(err(line, "#elif after #else"));
                    }
                    let cond = !top.1 && parent_active && pre.eval_condition(rest, line)?;
                    if let Some(t) = stack.last_mut() {
                        *t = (cond, top.1 || cond, false, top.3);
                    }
                }
                "else" => {
                    let parent_active = stack.len() < 2 || stack[..stack.len() - 1].iter().all(|s| s.0);
                    let Some(top) = stack.last_mut() else {
                        return Err(err(line, "#else without a matching #if"));
                    };
                    if top.2 {
                        return Err(err(line, "a second #else for the same #if"));
                    }
                    *top = (parent_active && !top.1, true, true, top.3);
                }
                "endif" => {
                    if stack.pop().is_none() {
                        return Err(err(line, "#endif without a matching #if"));
                    }
                }
                _ if !active => {}
                "define" => {
                    let mname: String = rest.chars().take_while(|c| is_ident(*c)).collect();
                    if mname.is_empty() || mname.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                        return Err(err(line, format!("#define needs a macro name, found '{rest}'")));
                    }
                    let after = &rest[mname.len()..];
                    let (params, body) = if let Some(p) = after.strip_prefix('(') {
                        let Some(close) = p.find(')') else {
                            return Err(err(line, format!("#define {mname}(...): missing ')' in the parameter list")));
                        };
                        let params: Vec<String> = p[..close]
                            .split(',')
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .collect();
                        if params.iter().any(|p| !p.chars().all(is_ident)) {
                            return Err(err(line, format!("#define {mname}: macro parameters must be plain names")));
                        }
                        (Some(params), p[close + 1..].trim().to_string())
                    } else {
                        (None, after.trim().to_string())
                    };
                    if body.contains('#') {
                        return Err(err(line, "unsupported: the # and ## macro operators are not supported"));
                    }
                    pre.macros.insert(mname, Macro { params, body });
                }
                "undef" => {
                    pre.macros.remove(rest.split_whitespace().next().unwrap_or(""));
                }
                "include" => {
                    return Err(err(
                        line,
                        "unsupported preprocessor directive #include: there are no header files and no \
                         standard library here; the program runs on its own and its result is main's \
                         return value (supported: #define, #undef, #ifdef, #ifndef, #if, #elif, #else, #endif)",
                    ));
                }
                "" => {} // a lone '#' is a null directive
                other => {
                    return Err(err(
                        line,
                        format!(
                            "unsupported preprocessor directive '#{other}': supported are #define, #undef, \
                             #ifdef, #ifndef, #if, #elif, #else and #endif"
                        ),
                    ));
                }
            }
            out.push('\n');
            continue;
        }
        if active {
            let expanded = pre.expand(text, line, &mut Vec::new())?;
            out.push_str(&expanded);
        }
        out.push('\n');
    }
    if let Some(open) = stack.last() {
        return Err(err(open.3, "this #if/#ifdef has no matching #endif"));
    }
    Ok(out)
}

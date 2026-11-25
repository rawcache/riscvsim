//! Guard against personal strings leaking into the public CLI sources.
//!
//! Every pattern is assembled from fragments at runtime so this file does
//! not itself contain any of the strings it looks for.

use std::fs;
use std::path::{Path, PathBuf};

fn files_under(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files_under(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs" || e == "txt" || e == "snap") {
            out.push(path);
        }
    }
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// True when `word` appears in `line` with no letter, digit or underscore on
/// either side, and is not part of a hyphenated or dotted name.
fn has_standalone_word(line: &str, word: &str) -> bool {
    let mut start = 0;
    while let Some(pos) = line[start..].find(word) {
        let at = start + pos;
        let before = line[..at].chars().next_back();
        let after = line[at + word.len()..].chars().next();
        let joined = |c: Option<char>| c.is_some_and(|c| is_word_char(c) || c == '-' || c == '.' || c == '/');
        if !joined(before) && !joined(after) {
            return true;
        }
        start = at + word.len();
    }
    false
}

/// A rough email check: a local part, an at sign, and a dotted domain.
fn has_email(line: &str) -> bool {
    let bytes: Vec<char> = line.chars().collect();
    for (i, &c) in bytes.iter().enumerate() {
        if c != '@' || i == 0 {
            continue;
        }
        let local_ok = bytes[i - 1].is_ascii_alphanumeric();
        let rest: String = bytes[i + 1..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == '.' || **c == '-').collect();
        if local_ok && rest.contains('.') && rest.rsplit('.').next().is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic())) {
            return true;
        }
    }
    false
}

/// A web URL naming a GitHub owner, such as the site followed by `/name`.
/// The API host (`api.` prefix) with a `{placeholder}` owner is fine.
fn has_owner_url(line: &str) -> bool {
    let host = ["github", ".com/"].concat();
    let mut start = 0;
    while let Some(pos) = line[start..].find(&host) {
        let at = start + pos;
        let api = line[..at].ends_with("api.");
        let next = line[at + host.len()..].chars().next();
        if !api && next.is_some_and(|c| c.is_ascii_alphanumeric()) {
            return true;
        }
        start = at + host.len();
    }
    false
}

fn findings(text: &str) -> Vec<(usize, &'static str)> {
    let d = ["d", "ev"].concat();
    let cap_d = ["D", "ev"].concat();
    let plain_needles: Vec<(String, &'static str)> = vec![
        ([d.as_str(), "user"].concat(), "placeholder user name"),
        ([cap_d.as_str(), " User"].concat(), "placeholder user name"),
        (["no", "reply"].concat(), "no-reply address"),
        (["/", "Users", "/"].concat(), "absolute home path"),
        (["/", "home", "/"].concat(), "absolute home path"),
        (["gm", "ail."].concat(), "mail provider"),
        (["ya", "hoo."].concat(), "mail provider"),
        (["hot", "mail."].concat(), "mail provider"),
        (["out", "look.com"].concat(), "mail provider"),
        (["i", "cloud.com"].concat(), "mail provider"),
        (["proton", "mail"].concat(), "mail provider"),
    ];
    let mut found = Vec::new();
    for (n, line) in text.lines().enumerate() {
        for (needle, what) in &plain_needles {
            if line.contains(needle.as_str()) {
                found.push((n + 1, *what));
            }
        }
        if has_standalone_word(line, &d) || has_standalone_word(line, &cap_d) {
            found.push((n + 1, "standalone placeholder word"));
        }
        if has_owner_url(line) {
            found.push((n + 1, "GitHub owner URL"));
        }
        if has_email(line) {
            found.push((n + 1, "email address"));
        }
    }
    found
}

#[test]
fn cli_sources_and_tests_contain_no_personal_strings() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    files_under(&root.join("src"), &mut files);
    files_under(&root.join("tests"), &mut files);
    assert!(files.len() > 5, "expected to scan the cli sources");
    let mut problems = Vec::new();
    for file in &files {
        let text = fs::read_to_string(file).unwrap_or_default();
        for (line, what) in findings(&text) {
            let rel = file.strip_prefix(root).unwrap_or(file);
            problems.push(format!("{}:{line}: {what}", rel.display()));
        }
    }
    assert!(problems.is_empty(), "personal strings found:\n{}", problems.join("\n"));
}

#[test]
fn the_scanner_catches_each_pattern() {
    let d = ["d", "ev"].concat();
    let samples = [
        format!("let who = \"{d}\";"),
        format!("// owner {}", [d.as_str(), "user"].concat()),
        format!("path {}x/y", ["/", "Users", "/"].concat()),
        format!("see https://{}someone/repo", ["github", ".com/"].concat()),
        format!("mail me at a{}b.org", "@"),
    ];
    for sample in &samples {
        assert!(!findings(sample).is_empty(), "missed: {sample}");
    }
    // Ordinary words that merely contain the letters are fine.
    for ok in ["device", "devices", "/dev/null", "stdev", "x86-dev-tools", "api.github.com/repos"] {
        assert!(findings(ok).is_empty(), "false positive: {ok}");
    }
}

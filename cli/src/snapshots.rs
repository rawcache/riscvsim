//! Snapshot files for render tests: `cli/tests/snapshots/<name>.snap`.
//!
//! A test renders a screen to text and calls [`check`]. A missing file is
//! written; an existing one must match exactly. After an intended change,
//! rerun with `UPDATE_SNAPSHOTS=1` and review the diff. With
//! `RISCVSIM_CAPTURE_DIR` set, every screen is also copied there.

use std::path::PathBuf;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("snapshots")
}

/// Compare `text` with the stored snapshot `name`.
pub fn check(name: &str, text: &str) {
    if let Some(capture) = std::env::var_os("RISCVSIM_CAPTURE_DIR") {
        let capture = PathBuf::from(capture);
        let _ = std::fs::create_dir_all(&capture);
        let _ = std::fs::write(capture.join(format!("{name}.txt")), text);
    }
    let path = dir().join(format!("{name}.snap"));
    let update = std::env::var_os("UPDATE_SNAPSHOTS").is_some();
    match std::fs::read_to_string(&path) {
        Ok(expected) if !update => {
            assert!(
                expected == text,
                "snapshot {name} changed; rerun with UPDATE_SNAPSHOTS=1 if intended\n--- expected\n{expected}\n--- got\n{text}"
            );
        }
        _ => {
            std::fs::create_dir_all(dir()).unwrap();
            std::fs::write(&path, text).unwrap();
        }
    }
}

/// A styled line as plain text plus a `[style]` marker per colored run, so
/// a snapshot also records where color goes. ANSI SGR codes become names.
pub fn mark_ansi(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            let mut code = String::new();
            for d in chars.by_ref() {
                if d == 'm' {
                    break;
                }
                code.push(d);
            }
            out.push_str(&format!("<{code}>"));
        } else {
            out.push(c);
        }
    }
    out
}

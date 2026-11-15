//! First-run walkthrough gating.
//!
//! The browser simulator gates its tour on a localStorage key
//! (studyriscv-sim-tour-v1); the terminal equivalent is a marker file in
//! the XDG config directory. Delete it (or pass --tour) to see the
//! walkthrough again.

use std::path::PathBuf;

fn config_dir() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return Some(PathBuf::from(xdg).join("riscvsim"));
        }
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config").join("riscvsim"))
}

fn marker_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("tour-seen"))
}

pub fn seen() -> bool {
    marker_path().map(|p| p.exists()).unwrap_or(true)
}

pub fn mark_seen() {
    let Some(path) = marker_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Contents are irrelevant; existence is the flag.
    let _ = std::fs::write(&path, "1\n");
}

// ---------------------------------------------------------------------------
// Trusted directories (the Claude Code-style first-run safety check).
//
// Loading a .s file from a directory the user hasn't confirmed before shows
// the trust prompt; confirming remembers the directory (one canonical path
// per line in ~/.config/riscvsim/trusted). Built-in samples load nothing
// from disk and never prompt.
// ---------------------------------------------------------------------------

fn trusted_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("trusted"))
}

/// Canonical directory a program file lives in (for the trust check).
pub fn trust_key(file: &std::path::Path) -> Option<String> {
    let dir = file.parent().filter(|p| !p.as_os_str().is_empty())?;
    let canon = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    Some(canon.to_string_lossy().to_string())
}

pub fn is_trusted(key: &str) -> bool {
    let Some(path) = trusted_path() else { return false };
    let Ok(contents) = std::fs::read_to_string(path) else {
        return false;
    };
    contents.lines().any(|line| line.trim() == key)
}

pub fn mark_trusted(key: &str) {
    let Some(path) = trusted_path() else { return };
    if is_trusted(key) {
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut contents = std::fs::read_to_string(&path).unwrap_or_default();
    if !contents.is_empty() && !contents.ends_with('\n') {
        contents.push('\n');
    }
    contents.push_str(key);
    contents.push('\n');
    let _ = std::fs::write(&path, contents);
}

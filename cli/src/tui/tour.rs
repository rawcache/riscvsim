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

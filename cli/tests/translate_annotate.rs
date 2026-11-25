//! `riscvsim translate --annotate`: snapshots for five realistic C programs
//! on RV32 and RV64 (plus C++), and proof that the annotated output is the
//! plain translation plus comments only, so it still assembles and runs the
//! same way. Set UPDATE_SNAPSHOTS=1 to rewrite the snapshot files.

use std::path::{Path, PathBuf};
use std::process::Command;

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/annotate")
}

fn translate(from: &str, to: &str, file: &Path, annotate: bool) -> String {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_riscvsim"));
    cmd.args(["translate", "--from", from, "--to", to]).arg(file);
    if annotate {
        cmd.arg("--annotate");
    }
    let out = cmd.env("RISCVSIM_NO_UPDATE_CHECK", "1").env_remove("CLICOLOR_FORCE").output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

fn run_json(asm: &str, xlen: &str, name: &str) -> serde_json::Value {
    let path = std::env::temp_dir().join(format!("riscvsim-annot-{}-{name}.s", std::process::id()));
    std::fs::write(&path, asm).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_riscvsim"))
        .args(["run", path.to_str().unwrap(), "--json", &format!("--xlen={xlen}")])
        .env("RISCVSIM_NO_UPDATE_CHECK", "1")
        .output()
        .unwrap();
    let _ = std::fs::remove_file(&path);
    serde_json::from_slice(&out.stdout).expect("json")
}

#[test]
fn annotated_snapshots() {
    let update = std::env::var_os("UPDATE_SNAPSHOTS").is_some();
    let mut cases = 0;
    for (file, from) in [
        ("loop.c", "c"),
        ("call.c", "c"),
        ("array.c", "c"),
        ("pointer.c", "c"),
        ("switch.c", "c"),
        ("loop.cpp", "cpp"),
    ] {
        for to in ["rv32", "rv64"] {
            let src = dir().join(file);
            let annotated = translate(from, to, &src, true);
            assert!(!annotated.contains('\x1b'), "piped output is plain");
            let snap = dir().join(format!("{file}.{to}.snap"));
            if update || !snap.exists() {
                std::fs::write(&snap, &annotated).unwrap();
            } else {
                let expected = std::fs::read_to_string(&snap).unwrap();
                assert_eq!(annotated, expected, "{file} {to} changed; rerun with UPDATE_SNAPSHOTS=1 if intended");
            }

            // Only comments and blank lines were added.
            let plain = translate(from, to, &src, false);
            assert!(!plain.contains("#@line") && !plain.contains("# 1 |"), "plain output is untouched");
            let strip = |t: &str| -> Vec<String> {
                t.lines()
                    .filter(|l| !l.trim().is_empty())
                    .filter(|l| !(l.starts_with("# ") && l.contains(" | ")))
                    .map(str::to_string)
                    .collect()
            };
            assert_eq!(strip(&annotated), strip(&plain), "{file} {to}");

            // And it runs to the same result.
            let xlen = &to[2..];
            let a = run_json(&annotated, xlen, &format!("{file}-{to}-a"));
            let b = run_json(&plain, xlen, &format!("{file}-{to}-b"));
            assert_eq!(a["ok"], serde_json::Value::Bool(true), "{file} {to}: {a}");
            assert_eq!(a["registers"], b["registers"], "{file} {to}");
            cases += 1;
        }
    }
    assert_eq!(cases, 12);
}

#[test]
fn every_source_line_with_code_is_shown() {
    let text = translate("c", "rv32", &dir().join("loop.c"), true);
    for needle in ["# 2 | int main() {", "# 3 | int sum = 0;", "# 4 | for (int i = 0; i < 10; i++) {", "# 5 | sum += i;", "# 7 | return sum;"] {
        assert!(text.contains(needle), "{needle} missing:\n{text}");
    }
}

#[test]
fn annotate_explains_what_it_supports() {
    let out = Command::new(env!("CARGO_BIN_EXE_riscvsim"))
        .args(["translate", "--from", "c", "--to", "rust"])
        .arg(dir().join("loop.c"))
        .arg("--annotate")
        .env("NO_COLOR", "1")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("--annotate needs an assembly target: --to rv32 or --to rv64"), "{err}");
}

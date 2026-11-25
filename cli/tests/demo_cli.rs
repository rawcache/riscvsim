//! `riscvsim demo`: the static tour when piped, and real key handling
//! through a pseudo-terminal where the system `script` tool allows it.

use std::process::{Command, Stdio};

fn demo(args: &[&str], env: &[(&str, &str)]) -> (i32, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_riscvsim"));
    cmd.arg("demo").args(args).env("RISCVSIM_NO_UPDATE_CHECK", "1").env("LANG", "en_US.UTF-8").env_remove("CLICOLOR_FORCE");
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd.output().expect("run");
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned())
}

#[test]
fn piped_demo_prints_one_block_per_cycle_without_escape_codes() {
    let (code, text) = demo(&[], &[]);
    assert_eq!(code, 0);
    assert!(!text.contains('\x1b'), "piped output must be plain");
    assert!(text.contains("  riscvsim › demo 1 · Add + forwarding"), "{text}");
    for n in 1..=7 {
        assert!(text.contains(&format!("\n  cycle {n}\n")), "missing cycle {n}");
    }
    assert!(text.contains("CPI 2.33"));
    assert!(text.trim_end().ends_with("Next: riscvsim demo 2, riscvsim tui, riscvsim serve"), "{text}");
    for line in text.lines() {
        assert!(line.chars().count() <= 78, "{line}");
    }
}

#[test]
fn dumb_terminal_and_ascii_locale_get_plain_text() {
    let (_, text) = demo(&["2"], &[("TERM", "dumb"), ("LANG", "C"), ("LC_ALL", "C")]);
    assert!(text.is_ascii(), "{text}");
    assert!(text.contains("! lw is reading memory. add must wait one cycle"), "{text}");
}

#[test]
fn summary_flag_keeps_the_classic_run_output() {
    let (code, text) = demo(&["--summary"], &[]);
    assert_eq!(code, 0);
    assert!(text.contains("✓ add-forward.s · 3 instructions · RV32IM 5-stage pipeline"), "{text}");
    assert!(!text.contains("cycle 1\n"));
}

/// Drive the interactive tour through a pseudo-terminal: Space steps, q
/// quits and leaves a one-line record. Skipped where `script` is missing.
#[test]
#[cfg(target_os = "macos")]
fn keys_work_in_a_real_terminal() {
    if Command::new("script").arg("-q").arg("/dev/null").arg("true").stdin(Stdio::null()).output().is_err() {
        eprintln!("skipped: no script tool");
        return;
    }
    let mut child = Command::new("script")
        .args(["-q", "/dev/null", env!("CARGO_BIN_EXE_riscvsim"), "demo"])
        .env("TERM", "xterm-256color")
        .env("LANG", "en_US.UTF-8")
        .env("RISCVSIM_NO_UPDATE_CHECK", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn script");
    let mut stdin = child.stdin.take().unwrap();
    std::thread::spawn(move || {
        use std::io::Write;
        std::thread::sleep(std::time::Duration::from_millis(600));
        let _ = stdin.write_all(b" ");
        let _ = stdin.flush();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = stdin.write_all(b"q");
        let _ = stdin.flush();
        std::thread::sleep(std::time::Duration::from_millis(300));
    });
    let out = child.wait_with_output().expect("wait");
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("\x1b[?1049h"), "uses the alternate screen");
    assert!(text.contains("The first instruction, addi, is fetched from memory."), "stepped to cycle 1");
    assert!(text.contains("stopped at cycle 1 of 7"), "{text}");
}

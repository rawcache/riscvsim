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
    assert!(text.contains("  riscvsim › demo 1 · Your first instructions"), "{text}");
    for n in 1..=9 {
        assert!(text.contains(&format!("\n  cycle {n}\n")), "missing cycle {n}");
    }
    assert!(text.contains("CPI 1.80"));
    assert!(text.trim_end().ends_with("Next: riscvsim demo 2 (Waiting for memory)"), "{text}");
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
    assert!(text.contains("✓ first-steps.s · 5 instructions · RV32IM 5-stage pipeline"), "{text}");
    assert!(!text.contains("cycle 1\n"));
}

fn demo_err(args: &[&str]) -> (i32, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_riscvsim"))
        .arg("demo")
        .args(args)
        .env("RISCVSIM_NO_UPDATE_CHECK", "1")
        .env("LANG", "en_US.UTF-8")
        .env_remove("CLICOLOR_FORCE")
        .output()
        .expect("run");
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stderr).into_owned())
}

#[test]
fn list_prints_the_six_lessons() {
    let (code, text) = demo(&["--list"], &[]);
    assert_eq!(code, 0);
    assert!(!text.contains('\x1b'));
    for (n, title) in [
        (1, "Your first instructions"),
        (2, "Waiting for memory"),
        (3, "Skipping the wait"),
        (4, "Guessing wrong"),
        (5, "Loops"),
        (6, "Wide values (RV64)"),
    ] {
        assert!(text.contains(&format!(" {n}  {title}")), "{text}");
    }
    assert!(text.contains("Start: riscvsim demo 1"), "{text}");
}

#[test]
fn every_lesson_runs_by_number_and_name_and_points_to_the_next() {
    for (n, name, next) in [
        (1, "first-steps", Some("Next: riscvsim demo 2 (Waiting for memory)")),
        (2, "load-use", Some("Next: riscvsim demo 3 (Skipping the wait)")),
        (3, "forwarding", Some("Next: riscvsim demo 4 (Guessing wrong)")),
        (4, "branches", Some("Next: riscvsim demo 5 (Loops)")),
        (5, "loops", Some("Next: riscvsim demo 6 (Wide values)")),
        (6, "wide-values", None),
    ] {
        let (code, by_number) = demo(&[&n.to_string()], &[]);
        assert_eq!(code, 0, "lesson {n}");
        let (_, by_name) = demo(&[name], &[]);
        assert_eq!(by_number, by_name, "lesson {n} by name");
        match next {
            Some(next) => assert!(by_number.trim_end().ends_with(next), "lesson {n}:\n{by_number}"),
            None => assert!(by_number.contains("You finished all six lessons."), "{by_number}"),
        }
    }
    // the old sample names still work and lead to their lesson
    assert_eq!(demo(&["add-forward"], &[]).1, demo(&["3"], &[]).1);
    let (code, sum) = demo(&["array-sum"], &[]);
    assert_eq!(code, 0);
    assert!(sum.contains("demo array-sum · Array sum") && sum.contains("Next: riscvsim demo --list"), "{sum}");
}

#[test]
fn unknown_lessons_get_a_suggestion() {
    let (code, err) = demo_err(&["lops"]);
    assert_eq!(code, 2, "{err}");
    assert!(err.contains("there is no lesson called 'lops'"), "{err}");
    assert!(err.contains("did you mean 'loops'?"), "{err}");
    assert!(err.contains("riscvsim demo --list shows all six lessons"), "{err}");
    let (_, err) = demo_err(&["forwrding"]);
    assert!(err.contains("did you mean 'forwarding'?"), "{err}");
    let (code, err) = demo_err(&["7"]);
    assert_eq!(code, 2);
    assert!(err.contains("there is no lesson 7") && err.contains("lessons are 1 to 6"), "{err}");
}

#[test]
fn rv64_lesson_summary_runs_at_64_bits() {
    let (code, text) = demo(&["6", "--summary"], &[]);
    assert_eq!(code, 0, "{text}");
    assert!(text.contains("RV64IM") && text.contains("0x0000_0100_0000_0005"), "{text}");
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
    assert!(text.contains("stopped at cycle 1 of 9"), "{text}");
}

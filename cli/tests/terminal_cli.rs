//! Terminal behaviour of the real binary: no escape codes when piped,
//! NO_COLOR / --no-color / TERM=dumb honoured, 80-column output, friendly
//! errors with suggestions, and a clean Ctrl-C.

use std::process::{Command, Output};

const ESC: char = '\x1b';

fn temp(name: &str, contents: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("riscvsim-term-{}-{name}", std::process::id()));
    std::fs::write(&path, contents).expect("write fixture");
    path
}

fn riscvsim(args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_riscvsim"));
    cmd.args(args)
        .env("RISCVSIM_NO_UPDATE_CHECK", "1")
        .env_remove("NO_COLOR")
        .env_remove("CLICOLOR_FORCE")
        .env("TERM", "xterm-256color")
        .env("LANG", "en_US.UTF-8")
        .env("COLUMNS", "80");
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.output().expect("run riscvsim")
}

fn all(o: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))
}

const BAD: &str = "addi x1, x0, 5\nadddi x2, x1, 3\nadd x3, x1, x99\n";

#[test]
fn piped_output_has_no_escape_codes() {
    let good = temp("good.s", "addi x1, x0, 5\naddi x2, x1, 3\n");
    let bad = temp("bad.s", BAD);
    for args in [
        vec!["--help"],
        vec!["run", "--help"],
        vec!["run", good.to_str().unwrap()],
        vec!["run", good.to_str().unwrap(), "-v"],
        vec!["run", bad.to_str().unwrap()],
        vec!["demo"],
        vec!["rnu"],
        vec![],
    ] {
        let o = riscvsim(&args, &[]);
        assert!(!all(&o).contains(ESC), "{args:?} printed escapes:\n{}", all(&o));
    }
}

#[test]
fn color_can_be_forced_and_no_color_always_wins() {
    let bad = temp("bad2.s", BAD);
    let path = bad.to_str().unwrap();
    let forced = riscvsim(&["run", path], &[("CLICOLOR_FORCE", "1")]);
    assert!(all(&forced).contains(ESC), "CLICOLOR_FORCE should colour");
    for env in [
        vec![("CLICOLOR_FORCE", "1"), ("NO_COLOR", "1")],
        vec![("CLICOLOR_FORCE", "1"), ("TERM", "dumb")],
    ] {
        let o = riscvsim(&["run", path], &env);
        assert!(!all(&o).contains(ESC), "{env:?}:\n{}", all(&o));
    }
    let o = riscvsim(&["run", path, "--no-color"], &[("CLICOLOR_FORCE", "1")]);
    assert!(!all(&o).contains(ESC), "--no-color:\n{}", all(&o));
    // The same words either way.
    let strip = |s: String| -> String {
        let mut out = String::new();
        let mut esc = false;
        for c in s.chars() {
            if esc {
                esc = c != 'm';
            } else if c == ESC {
                esc = true;
            } else {
                out.push(c);
            }
        }
        out
    };
    let plain = riscvsim(&["run", path], &[]);
    assert_eq!(strip(all(&forced)), all(&plain));
}

#[test]
fn json_is_untouched_by_color_settings() {
    let good = temp("json.s", "addi x1, x0, 5\n");
    let a = riscvsim(&["run", good.to_str().unwrap(), "--json"], &[("CLICOLOR_FORCE", "1")]);
    let b = riscvsim(&["run", good.to_str().unwrap(), "--json"], &[]);
    assert_eq!(a.stdout, b.stdout);
    assert!(!String::from_utf8_lossy(&a.stdout).contains(ESC));
    serde_json::from_slice::<serde_json::Value>(&a.stdout).expect("valid json");
}

#[test]
fn ascii_fallback_when_locale_is_not_utf8() {
    let good = temp("ascii.s", "addi x1, x0, 5\n");
    let bad = temp("ascii-bad.s", BAD);
    for args in [vec!["run", good.to_str().unwrap()], vec!["run", bad.to_str().unwrap()], vec!["--help"], vec![]] {
        let o = riscvsim(&args, &[("LANG", "C"), ("LC_ALL", "C")]);
        let text = all(&o);
        // file paths are ASCII here, so everything printed must be
        assert!(text.is_ascii(), "{args:?}:\n{text}");
    }
}

#[test]
fn output_fits_80_columns() {
    let bad = temp("wide.s", &format!("{}adddi x1, x2, 3\n", "addi x5, x5, 1; ".repeat(12)));
    let long = temp("loop.s", "li t0, 0\nli t1, 3000000\nloop:\n addi t0, t0, 1\n blt t0, t1, loop\n");
    for args in [
        vec!["--help"],
        vec!["run", "--help"],
        vec!["translate", "--help"],
        vec!["demo", "3", "-v"],
        vec!["run", bad.to_str().unwrap()],
        vec!["run", long.to_str().unwrap()],
        vec!["translate", "--subset", "c"],
    ] {
        let o = riscvsim(&args, &[]);
        for line in all(&o).lines() {
            // the temp path itself may be long; everything else must fit
            let line = line.replace(std::env::temp_dir().to_str().unwrap(), "");
            assert!(line.chars().count() <= 80, "{args:?}: {} cols: {line}", line.chars().count());
        }
    }
}

#[test]
fn diagnostics_point_at_the_problem() {
    let bad = temp("diag.s", BAD);
    let o = riscvsim(&["run", bad.to_str().unwrap()], &[]);
    assert_eq!(o.status.code(), Some(1), "assembly and translation errors exit 1 (problem with the input)");
    let err = String::from_utf8_lossy(&o.stderr);
    assert!(err.contains("error: unknown instruction 'adddi'"), "{err}");
    assert!(err.contains(":2:1"), "{err}");
    assert!(err.contains("2 | adddi x2, x1, 3"), "{err}");
    assert!(err.contains("  | ^^^^^ did you mean 'addi'?"), "{err}");
    assert!(err.contains("3 | add x3, x1, x99"), "{err}");
    assert!(err.contains("2 errors in"), "{err}");
}

#[test]
fn typos_get_suggestions() {
    let o = riscvsim(&["rnu"], &[]);
    assert_eq!(o.status.code(), Some(2));
    assert!(all(&o).contains("did you mean 'riscvsim run'?"), "{}", all(&o));
    let good = temp("typo.s", "nop\n");
    let o = riscvsim(&["run", good.to_str().unwrap(), "--verbos"], &[]);
    assert_eq!(o.status.code(), Some(2));
    assert!(all(&o).contains("did you mean '--verbose'?"), "{}", all(&o));
    let missing = format!("{}x", good.to_str().unwrap());
    let o = riscvsim(&["run", &missing], &[]);
    assert_eq!(o.status.code(), Some(1));
    assert!(all(&o).contains("did you mean"), "{}", all(&o));
}

#[test]
fn home_screen_without_a_terminal() {
    let o = riscvsim(&[], &[]);
    assert!(o.status.success());
    let text = String::from_utf8_lossy(&o.stdout);
    assert!(text.contains("riscvsim demo") && text.contains("riscvsim --help"), "{text}");
    assert!(text.lines().count() <= 12, "home screen should be short:\n{text}");
}

#[test]
fn translate_header_and_subset_pointer() {
    let c = temp("t.c", "int main() { int s = 0; for (int i = 0; i < 3; i++) s += i; return s; }\n");
    let out = temp("t.s", "");
    let o = riscvsim(&["translate", "--from", "c", "--to", "rv64", c.to_str().unwrap(), "-o", out.to_str().unwrap()], &[]);
    assert!(o.status.success());
    let err = String::from_utf8_lossy(&o.stderr);
    assert!(err.contains("C to RV64, ") && err.contains(" instructions"), "{err}");
    let f = temp("f.c", "int main() { float x = 1.0; return 0; }\n");
    let o = riscvsim(&["translate", "--from", "c", "--to", "rv32", f.to_str().unwrap()], &[]);
    assert_eq!(o.status.code(), Some(1), "assembly and translation errors exit 1 (problem with the input)");
    assert!(all(&o).contains("riscvsim translate --subset c"), "{}", all(&o));
}

#[cfg(unix)]
#[test]
fn ctrl_c_stops_cleanly_with_a_summary() {
    let long = temp("forever.s", "loop:\n addi t0, t0, 1\n j loop\n");
    let child = Command::new(env!("CARGO_BIN_EXE_riscvsim"))
        .args(["run", long.to_str().unwrap(), "--limit", "2000000000"])
        .env("RISCVSIM_NO_UPDATE_CHECK", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn");
    std::thread::sleep(std::time::Duration::from_millis(400));
    let ok = Command::new("kill").args(["-INT", &child.id().to_string()]).status().expect("kill");
    assert!(ok.success());
    let o = child.wait_with_output().expect("wait");
    let text = all(&o);
    assert_eq!(o.status.code(), Some(130), "{text}");
    assert!(text.contains("stopped by Ctrl-C at cycle"), "{text}");
    assert!(text.contains("CPI"), "{text}");
    assert!(!text.contains("panicked"), "{text}");
}

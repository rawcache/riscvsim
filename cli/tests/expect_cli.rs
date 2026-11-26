//! `riscvsim run FILE --expect REG=VALUE`: scriptable checks on the final
//! registers, for grading and CI.

use std::process::{Command, Output};

fn fixture(name: &str, source: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("riscvsim-expect-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, source).unwrap();
    path
}

fn run(file: &std::path::Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_riscvsim"))
        .arg("run")
        .arg(file)
        .args(args)
        .env("RISCVSIM_NO_UPDATE_CHECK", "1")
        .env("NO_COLOR", "1")
        .env("LANG", "en_US.UTF-8")
        .env_remove("CLICOLOR_FORCE")
        .output()
        .expect("run riscvsim")
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}
fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

const PROG: &str = "addi x5, x0, 6\naddi x6, x0, 7\nadd x7, x5, x6\naddi x10, x0, -1\naddi x11, x0, 42\n";

#[test]
fn passing_check_prints_one_line_and_exits_0() {
    let f = fixture("pass.s", PROG);
    let o = run(&f, &["--expect", "x7=13"]);
    assert_eq!(o.status.code(), Some(0), "{}", stdout(&o));
    assert!(stdout(&o).trim_end().ends_with("\n✓ x7 = 13"), "{}", stdout(&o));
}

#[test]
fn failing_check_shows_expected_and_actual_and_exits_1() {
    let f = fixture("fail.s", PROG);
    let o = run(&f, &["--expect", "x7=12"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(stdout(&o).contains("✗ x7 expected 12, got 13"), "{}", stdout(&o));
}

#[test]
fn multiple_checks_hex_negative_and_abi_names() {
    let f = fixture("many.s", PROG);
    let o = run(&f, &["--expect", "x7=13", "--expect", "a0=-1", "--expect", "a1=0x2a", "--expect", "t1=7", "--expect=x10=0xffffffff"]);
    assert_eq!(o.status.code(), Some(0), "{}", stdout(&o));
    let out = stdout(&o);
    for line in ["✓ x7 = 13", "✓ a0 = -1", "✓ a1 = 0x2a", "✓ t1 = 7", "✓ x10 = 0xffffffff"] {
        assert!(out.contains(line), "{line}:\n{out}");
    }
    // one wrong among right ones fails the whole run, in hex when asked in hex
    let o = run(&f, &["--expect", "x7=13", "--expect", "a1=0x2b"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(stdout(&o).contains("✓ x7 = 13") && stdout(&o).contains("✗ a1 expected 0x2b, got 0x2a"), "{}", stdout(&o));
}

#[test]
fn rv64_compares_all_64_bits() {
    let f = fixture("wide.s", "addi x5, x0, 1\nslli x5, x5, 40\naddi x6, x5, 5\naddi x7, x0, -1\n");
    let o = run(&f, &["--xlen=64", "--expect", "x6=0x10000000005", "--expect", "x6=1099511627781", "--expect", "x7=-1", "--expect", "x7=0xffffffffffffffff"]);
    assert_eq!(o.status.code(), Some(0), "{}{}", stdout(&o), stderr(&o));
    let o = run(&f, &["--xlen=64", "--expect", "x6=5"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(stdout(&o).contains("✗ x6 expected 5, got 1099511627781"), "{}", stdout(&o));
    // a 64-bit value does not fit an RV32 register
    let o = run(&f, &["--expect", "x6=0x10000000005"]);
    assert_eq!(o.status.code(), Some(2));
    assert!(stderr(&o).contains("does not fit in a 32-bit register") && stderr(&o).contains("--xlen=64"), "{}", stderr(&o));
}

#[test]
fn step_limit_still_compares_and_says_so() {
    let f = fixture("loop.s", "addi x5, x0, 9\nloop:\nj loop\n");
    let o = run(&f, &["--limit", "50", "--expect", "x5=9"]);
    let out = stdout(&o);
    assert!(out.contains("step limit reached after 50 cycles"), "{out}");
    assert!(out.contains("✓ x5 = 9"), "{out}");
    assert_eq!(o.status.code(), Some(0));
    let o = run(&f, &["--limit", "50", "--expect", "x5=1"]);
    assert_eq!(o.status.code(), Some(1));
}

#[test]
fn json_adds_an_expect_array_and_keeps_the_rest() {
    let f = fixture("json.s", PROG);
    let plain = stdout(&run(&f, &["--json"]));
    let o = run(&f, &["--json", "--expect", "x7=13", "--expect", "a1=0x2b"]);
    assert_eq!(o.status.code(), Some(1));
    let with = stdout(&o);
    let prefix = plain.trim_end().strip_suffix("\n}").unwrap();
    assert!(with.starts_with(prefix), "everything before expect is byte-identical");
    let v: serde_json::Value = serde_json::from_str(&with).expect("valid JSON");
    assert_eq!(v["expect"][0], serde_json::json!({"register": "x7", "expected": "13", "actual": "13", "pass": true}));
    assert_eq!(v["expect"][1], serde_json::json!({"register": "a1", "expected": "0x2b", "actual": "0x2a", "pass": false}));
    // without --expect, --json is unchanged
    assert!(!plain.contains("expect"));
    assert_eq!(run(&f, &["--json", "--expect", "x7=13"]).status.code(), Some(0));
}

#[test]
fn bad_input_is_a_usage_error_with_a_suggestion() {
    let f = fixture("bad.s", PROG);
    for (arg, want) in [
        ("x33=1", "did you mean 'x3'?"),
        ("tt0=1", "did you mean 't0'?"),
        ("x7", "--expect needs REG=VALUE"),
        ("x7=4z", "is not a number"),
        ("x7=", "is not a number"),
    ] {
        let o = run(&f, &["--expect", arg]);
        assert_eq!(o.status.code(), Some(2), "{arg}");
        assert!(stderr(&o).contains(want), "{arg}: {}", stderr(&o));
        assert!(stdout(&o).is_empty(), "nothing runs on bad input");
    }
}

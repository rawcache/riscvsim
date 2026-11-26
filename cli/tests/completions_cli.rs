//! `riscvsim completions bash|zsh|fish`: the real scripts name every lesson
//! and the new flags, and parse in the shells that are installed here.

use std::process::Command;

fn script(shell: &str) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_riscvsim"))
        .args(["completions", shell])
        .env("RISCVSIM_NO_UPDATE_CHECK", "1")
        .output()
        .expect("run");
    assert!(out.status.success(), "{shell}");
    String::from_utf8(out.stdout).expect("utf-8")
}

fn shell_present(name: &str) -> bool {
    Command::new(name).arg("-c").arg("exit 0").output().is_ok_and(|o| o.status.success())
}

#[test]
fn scripts_offer_the_lessons_and_new_flags() {
    for shell in ["bash", "zsh", "fish"] {
        let s = script(shell);
        for word in ["first-steps", "load-use", "forwarding", "branches", "loops", "wide-values", "list", "xlen"] {
            assert!(s.contains(word), "{shell} completion lacks {word}");
        }
    }
}

#[test]
fn scripts_parse_where_the_shell_exists() {
    for shell in ["bash", "zsh"] {
        if !shell_present(shell) {
            eprintln!("{shell} not installed; syntax check skipped");
            continue;
        }
        let path = std::env::temp_dir().join(format!("riscvsim-completion-{}.{shell}", std::process::id()));
        std::fs::write(&path, script(shell)).unwrap();
        let out = Command::new(shell).arg("-n").arg(&path).output().expect("run shell");
        let _ = std::fs::remove_file(&path);
        assert!(out.status.success(), "{shell} -n: {}", String::from_utf8_lossy(&out.stderr));
    }
}

#[test]
fn bash_completes_lesson_names() {
    if !shell_present("bash") {
        return;
    }
    let path = std::env::temp_dir().join(format!("riscvsim-completion-run-{}.bash", std::process::id()));
    std::fs::write(&path, script("bash")).unwrap();
    let probe = format!(
        "source '{}'; COMP_WORDS=(riscvsim demo lo); COMP_CWORD=2; _riscvsim; echo \"${{COMPREPLY[*]}}\"",
        path.display()
    );
    let out = Command::new("bash").arg("-c").arg(probe).output().expect("bash");
    let _ = std::fs::remove_file(&path);
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "load-use loops");
}

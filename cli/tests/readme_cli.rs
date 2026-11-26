//! The README is the first thing a stranger reads, so it must match the
//! tool exactly: the demo block is the real piped output, and every hard
//! number it states is the constant the engine uses. Skips cleanly in a
//! checkout without README.md.

use std::path::PathBuf;
use std::process::{Command, Stdio};

fn readme() -> Option<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("README.md");
    match std::fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(_) => {
            eprintln!("note: README.md not found; skipping the README checks");
            None
        }
    }
}

/// The fenced ```text block that follows `heading`.
fn block_after(text: &str, heading: &str) -> String {
    let at = text.find(heading).unwrap_or_else(|| panic!("README has no '{heading}'"));
    let open = "```text\n";
    let start = text[at..].find(open).expect("a text block") + at + open.len();
    let end = text[start..].find("```").expect("the block ends") + start;
    text[start..end].to_string()
}

fn demo_piped() -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_riscvsim"))
        .arg("demo")
        .env("RISCVSIM_NO_UPDATE_CHECK", "1")
        .env("LANG", "en_US.UTF-8")
        .env("COLUMNS", "80")
        .env_remove("LC_ALL")
        .env_remove("CLICOLOR_FORCE")
        .env_remove("NO_COLOR")
        .stdin(Stdio::null())
        .output()
        .expect("run riscvsim demo");
    assert!(out.status.success());
    String::from_utf8(out.stdout).expect("utf-8")
}

#[test]
fn first_ten_seconds_block_is_the_real_demo_output() {
    let Some(text) = readme() else { return };
    let shown = block_after(&text, "## The first ten seconds");
    let real = demo_piped();
    let real = format!("{}\n", real.trim_matches('\n'));
    assert!(
        shown == real,
        "README 'The first ten seconds' differs from `riscvsim demo | cat`.\n\
         Paste this output into the README block:\n{real}"
    );
}

#[test]
fn title_names_the_tool_and_its_home() {
    let Some(text) = readme() else { return };
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    assert_eq!(lines.next(), Some("# riscvsim"));
    let second = lines.next().unwrap_or_default();
    assert!(second.contains("StudyRISC-V") && second.contains("studyriscv.com"), "{second}");
}

#[test]
fn install_line_is_the_one_doctor_prints() {
    let Some(text) = readme() else { return };
    let doctor = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/doctor.rs")).unwrap();
    let line = doctor
        .lines()
        .find(|l| l.contains("QUICK_INSTALL_COMMAND: &str"))
        .and_then(|l| l.split('"').nth(1))
        .expect("doctor's install command");
    assert!(text.contains(&format!("```sh\n{line}\n```")), "README must show: {line}");
    assert!(text.contains("](../../releases)"), "releases page as a relative link");
    assert!(text.contains("cargo install --path cli"));
    for absent in ["Homebrew", "brew install", "Windows", "install.ps1"] {
        assert!(!text.contains(absent), "the release workflow does not ship {absent}");
    }
}

fn mentions(text: &str, phrase: &str) {
    assert!(text.contains(phrase), "README should say: {phrase}");
}

#[test]
fn implementation_numbers_match_the_engine() {
    let Some(text) = readme() else { return };
    let section = {
        let at = text.find("## What it implements").expect("a 'What it implements' section");
        let end = text[at + 3..].find("\n## ").map(|e| e + at + 3).unwrap_or(text.len());
        text[at..end].to_string()
    };
    mentions(&section, &format!("Code starts at `0x{:08x}`", sim_engine::TEXT_BASE));
    mentions(&section, &format!("data (`.data`) at `0x{:08x}`", sim_engine::DATA_BASE));
    mentions(&section, &format!("`0x{:08x}` on RV32", sim_engine::STACK_TOP));
    mentions(&section, &format!("`0x{:08x}` on RV64", sim_engine::pipeline64::STACK_TOP64));
    mentions(&section, &format!("{}-entry direct-mapped", sim_engine::BTB_ENTRIES));
    let limit = sim_engine::DEFAULT_MAX_CYCLES.to_string();
    let grouped: String = limit
        .chars()
        .rev()
        .collect::<Vec<_>>()
        .chunks(3)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join(",")
        .chars()
        .rev()
        .collect();
    mentions(&section, &format!("stops after {grouped} cycles"));

    // The penalties have no constant; measure them on the real pipeline.
    let cycles = |src: &str| {
        let mut p = sim_engine::Pipeline::new(sim_engine::assemble(src).expect("assembles"));
        assert!(p.run(1000));
        p.snapshot().stats
    };
    let data = ".data\nv: .word 7\n.text\nlui x8, 0x10000\n";
    let independent = cycles(&format!("{data}lw x5, 0(x8)\naddi x6, x0, 1\naddi x7, x0, 2\n"));
    let dependent = cycles(&format!("{data}lw x5, 0(x8)\naddi x6, x5, 1\naddi x7, x0, 2\n"));
    let stall = dependent.cycles - independent.cycles;
    assert_eq!(dependent.stalls, 1);
    mentions(&section, &format!("waits {stall} cycle (a load-use stall)"));

    // A taken branch the cold predictor guesses wrong, against one it never sees.
    let straight = cycles("addi x5, x0, 1\naddi x6, x0, 2\naddi x7, x0, 3\naddi x10, x0, 4\n");
    let taken = cycles("addi x5, x0, 1\nbeq x0, x0, skip\naddi x6, x0, 2\nskip:\naddi x7, x0, 3\naddi x10, x0, 4\n");
    assert_eq!(taken.mispredictions, 1);
    // Same instructions retired minus the skipped one, plus the branch itself.
    let penalty = taken.cycles - straight.cycles;
    mentions(&section, &format!("throws away the {penalty} instructions fetched behind"));
    mentions(&section, &format!("a {penalty}-cycle penalty"));
    mentions(&section, "Five stages: IF, ID, EX, MEM, WB");
}

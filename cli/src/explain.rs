//! One plain-English sentence about what happened in a pipeline cycle.
//!
//! Shared by `riscvsim demo` (the guided tour) and the `tui` pipeline pane,
//! so both always say the same thing. It reads only the engine's public
//! per-cycle view (stall cause, forwards, flushes, predictor, register
//! writes), so it needs no engine changes.

use sim_engine::pipeline::{StageState, StageView};
use sim_engine::Snapshot;

/// The mnemonic of an instruction's text: `"lw x1, 0(x2)"` -> `"lw"`.
pub fn mnemonic(text: &str) -> &str {
    text.split_whitespace().next().unwrap_or(text)
}

/// `"ra"` -> `"x1"`; names that are already `xN` pass through.
pub fn x_name(reg: &str) -> String {
    if reg.starts_with('x') && reg[1..].parse::<u8>().is_ok() {
        return reg.to_string();
    }
    if reg == "fp" {
        return "x8".into();
    }
    (0u8..32)
        .find(|r| sim_engine::assembler::abi_name(*r) == reg)
        .map(|r| format!("x{r}"))
        .unwrap_or_else(|| reg.to_string())
}

/// A register value as a learner reads it: decimal when small, hex when big.
fn value(v: u32) -> String {
    let signed = v as i32;
    if (-4096..=4096).contains(&signed) {
        signed.to_string()
    } else {
        format!("0x{v:08x}")
    }
}

fn number_word(n: usize) -> String {
    match n {
        1 => "one".into(),
        2 => "two".into(),
        3 => "three".into(),
        n => n.to_string(),
    }
}

fn stage<'a>(snap: &'a Snapshot, name: &str) -> Option<&'a StageView> {
    snap.stages.iter().find(|s| s.name == name)
}

fn stage_instr<'a>(snap: &'a Snapshot, name: &str) -> Option<&'a str> {
    stage(snap, name)
        .filter(|s| s.state == StageState::Normal)
        .and_then(|s| s.text.as_deref())
}

fn is_jump(m: &str) -> bool {
    matches!(m, "j" | "jal" | "jalr" | "jr" | "ret" | "call" | "tail")
}

/// What kind of event a cycle was, for summaries and styling.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Start,
    Plain,
    Forward,
    Stall,
    Flush,
    Branch,
    Done,
    Error,
}

/// The sentence for this cycle, plus what kind of cycle it was.
pub fn cycle(snap: &Snapshot) -> (Kind, String) {
    if snap.cycle == 0 {
        return (Kind::Start, "Nothing has happened yet. Each step moves every instruction one stage to the right.".into());
    }
    if let Some(halt) = &snap.halt {
        if halt.kind == "complete" {
            if let Some(w) = snap.view.reg_writes.first() {
                let by = stage(snap, "WB").and_then(|s| s.text.as_deref()).map(mnemonic).unwrap_or("the last instruction");
                return (Kind::Done, format!("{by} writes x{} = {}, and the program is finished.", w.reg, value(w.after)));
            }
            return (Kind::Done, "The program finished: the last instruction has left the pipeline.".into());
        }
        return (Kind::Error, format!("The program stopped: {}.", halt.message.trim_end_matches('.')));
    }
    let view = &snap.view;

    if !view.flushed.is_empty() {
        let n = view.flushed.len();
        let thrown = if n == 1 { "one instruction was".to_string() } else { format!("{} instructions were", number_word(n)) };
        if let Some(p) = view.predictor.as_ref().filter(|p| p.mispredicted == Some(true)) {
            let m = mnemonic(&p.text);
            if is_jump(m) {
                return (Kind::Flush, format!("{m} jumps somewhere new, so {thrown} thrown away."));
            }
            let guess = if p.predicted_taken { "taken" } else { "not taken" };
            let real = if p.actual_taken == Some(true) { "it was taken" } else { "it fell through" };
            return (Kind::Flush, format!("The branch was wrong ({m} was guessed {guess}, but {real}), so {thrown} thrown away."));
        }
        return (Kind::Flush, format!("The program changed direction, so {thrown} thrown away."));
    }

    if let Some(reason) = &view.stall {
        // "load-use hazard: waiting for x1 from 'lw x1, 0(x2)'"
        let reg = reason
            .split("waiting for ")
            .nth(1)
            .and_then(|r| r.split_whitespace().next())
            .unwrap_or("a register");
        let producer = reason.split('\'').nth(1).map(mnemonic).unwrap_or("the load");
        let consumer = stage(snap, "ID").and_then(|s| s.text.as_deref()).map(mnemonic).unwrap_or("the next instruction");
        return (
            Kind::Stall,
            format!("{producer} is reading memory. {consumer} must wait one cycle because it needs {reg} from {producer}."),
        );
    }

    if let Some(f) = view.forwards.first() {
        let consumer = stage_instr(snap, "EX").map(mnemonic).unwrap_or("the instruction in EX");
        let (from_stage, latch) = if f.from == "exmem" { ("MEM", "EX/MEM") } else { ("WB", "MEM/WB") };
        let producer = stage(snap, from_stage).and_then(|s| s.text.as_deref()).map(mnemonic).unwrap_or("an earlier instruction");
        let regs: Vec<String> = view.forwards.iter().map(|f| x_name(&f.reg)).collect();
        let what = if regs.len() > 1 && regs.iter().any(|r| *r != regs[0]) {
            format!("{} and {}", regs[0], regs[1])
        } else {
            regs[0].clone()
        };
        return (
            Kind::Forward,
            format!("{consumer} needs {what} from {producer}, so it is forwarded from the {latch} latch and nobody waits."),
        );
    }

    if let Some(p) = view.predictor.as_ref().filter(|p| p.mispredicted == Some(false)) {
        let m = mnemonic(&p.text);
        if !is_jump(m) {
            let went = if p.actual_taken == Some(true) { "taken" } else { "not taken" };
            return (Kind::Branch, format!("{m} was guessed {went} and the guess was right, so nothing is thrown away."));
        }
    }

    if let Some(w) = view.reg_writes.first() {
        let by = stage(snap, "WB").and_then(|s| s.text.as_deref()).map(mnemonic).unwrap_or("an instruction");
        let reg = format!("x{}", w.reg);
        return (Kind::Plain, format!("{by} finishes and writes {reg} = {}.", value(w.after)));
    }

    if let Some(text) = stage_instr(snap, "IF") {
        if snap.cycle == 1 {
            return (Kind::Plain, format!("The first instruction, {}, is fetched from memory.", mnemonic(text)));
        }
    }
    if let Some(text) = stage_instr(snap, "MEM") {
        let m = mnemonic(text);
        if m.starts_with('l') && m != "li" && m != "lui" && m != "la" {
            return (Kind::Plain, format!("{m} reads memory this cycle."));
        }
        if m.starts_with('s') && matches!(m, "sb" | "sh" | "sw" | "sd") {
            return (Kind::Plain, format!("{m} writes memory this cycle."));
        }
    }
    if let Some(text) = stage_instr(snap, "EX") {
        return (Kind::Plain, format!("{} is computing in the ALU; everything else moves one stage on.", mnemonic(text)));
    }
    if let Some(text) = stage_instr(snap, "ID") {
        return (Kind::Plain, format!("{} is decoded and reads its source registers.", mnemonic(text)));
    }
    if stage_instr(snap, "IF").is_none() {
        return (Kind::Plain, "Nothing is left to fetch, so the pipeline is emptying.".into());
    }
    (Kind::Plain, "Every instruction moves one stage to the right.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim_engine::{assemble, Pipeline};

    /// Run `src` and collect the sentence for each cycle (1-based index).
    fn sentences(src: &str) -> Vec<(Kind, String)> {
        let mut p = Pipeline::new(assemble(src).expect("assembles"));
        let mut out = vec![cycle(&p.snapshot())];
        while !p.halted() && out.len() < 200 {
            p.step_cycle();
            out.push(cycle(&p.snapshot()));
        }
        out
    }

    fn first(src: &str, kind: Kind) -> String {
        sentences(src).into_iter().find(|(k, _)| *k == kind).map(|(_, s)| s).unwrap_or_default()
    }

    #[test]
    fn stall_snapshot() {
        let src = crate::tui::samples::SAMPLES[1].source;
        assert_eq!(
            first(src, Kind::Stall),
            "lw is reading memory. add must wait one cycle because it needs x1 from lw."
        );
    }

    #[test]
    fn forward_snapshot() {
        let src = crate::tui::samples::SAMPLES[0].source;
        assert_eq!(
            first(src, Kind::Forward),
            "addi needs x1 from addi, so it is forwarded from the EX/MEM latch and nobody waits."
        );
    }

    #[test]
    fn flush_snapshot() {
        let src = "addi x1, x0, 1\nbeq x1, x1, done\naddi x2, x0, 2\naddi x3, x0, 3\ndone:\naddi x4, x0, 4\n";
        assert_eq!(
            first(src, Kind::Flush),
            "The branch was wrong (beq was guessed not taken, but it was taken), so two instructions were thrown away."
        );
    }

    #[test]
    fn plain_and_end_snapshots() {
        let all = sentences("addi x1, x0, 7\n");
        assert_eq!(all[0].1, "Nothing has happened yet. Each step moves every instruction one stage to the right.");
        assert_eq!(all[1].1, "The first instruction, addi, is fetched from memory.");
        assert_eq!(all[2].1, "addi is decoded and reads its source registers.");
        assert_eq!(all.last().unwrap(), &(Kind::Done, "addi writes x1 = 7, and the program is finished.".to_string()));
        let two = sentences("addi x1, x0, 7\naddi x2, x0, 8\n");
        assert!(two.iter().any(|(_, s)| s == "addi finishes and writes x1 = 7."), "{two:?}");
        assert_eq!(value(0x1000_0000), "0x10000000");
        assert_eq!(value(u32::MAX), "-1");
    }

    #[test]
    fn every_sentence_is_plain_and_short() {
        for sample in crate::tui::samples::SAMPLES {
            for (_, s) in sentences(sample.source) {
                assert!(s.chars().count() <= 120, "{s}");
                assert!(s.ends_with('.'), "{s}");
                assert!(!s.contains("Some(") && !s.contains("::"), "{s}");
            }
        }
    }

    #[test]
    fn abi_names_become_x_names() {
        assert_eq!(x_name("ra"), "x1");
        assert_eq!(x_name("t0"), "x5");
        assert_eq!(x_name("x7"), "x7");
        assert_eq!(x_name("fp"), "x8");
    }
}

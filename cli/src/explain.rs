//! One plain-English sentence about what happened in a pipeline cycle.
//!
//! Shared by `riscvsim demo` (the lessons) and the `tui` pipeline pane,
//! so both always say the same thing. It reads only the engine's public
//! per-cycle view (stall cause, forwards, flushes, predictor, register
//! writes), so it needs no engine changes.

use crate::machine::{Snap as Snapshot, StageState, StageView};

/// The mnemonic of an instruction's text: `"lw x1, 0(x2)"` -> `"lw"`.
pub fn mnemonic(text: &str) -> &str {
    text.split_whitespace().next().unwrap_or(text)
}

/// Instruction text that fits `room` columns without cutting a token:
/// spaces collapse first (`addi x1, x0, 5` -> `addi x1,x0,5`), then whole
/// operands drop from the right behind an ellipsis (`addi x1,x0…`), then
/// all operands (`addi…`). Only a mnemonic wider than the room is cut.
pub fn fit_instr(text: &str, room: usize, unicode: bool) -> String {
    let ellipsis = if unicode { "…" } else { "~" };
    let width = |s: &str| s.chars().count();
    let spaced: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if width(&spaced) <= room {
        return spaced;
    }
    let tight = spaced.replace(", ", ",");
    if width(&tight) <= room {
        return tight;
    }
    let (op, args) = tight.split_once(' ').unwrap_or((tight.as_str(), ""));
    let parts: Vec<&str> = args.split(',').filter(|a| !a.is_empty()).collect();
    for keep in (1..parts.len()).rev() {
        let s = format!("{op} {}{ellipsis}", parts[..keep].join(","));
        if width(&s) <= room {
            return s;
        }
    }
    let bare = format!("{op}{ellipsis}");
    if width(&bare) <= room {
        return bare;
    }
    if width(op) <= room {
        return op.to_string();
    }
    let mut cut: String = op.chars().take(room.saturating_sub(1)).collect();
    cut.push_str(ellipsis);
    cut
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
#[cfg(test)]
fn value(v: u32) -> String {
    crate::machine::short_value(v as u64, 32)
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

/// How a sentence names an in-flight instruction: its mnemonic, plus its
/// first operand when another instruction in the pipeline has the same
/// mnemonic ("addi x6 needs x5 from addi x5", never "addi needs x5 from addi").
fn name_of(snap: &Snapshot, text: &str) -> String {
    let m = mnemonic(text);
    let same = snap
        .stages
        .iter()
        .filter(|s| s.state == StageState::Normal)
        .filter_map(|s| s.text.as_deref())
        .filter(|t| mnemonic(t) == m)
        .count();
    match text.split_whitespace().nth(1).map(|op| op.trim_end_matches(',')) {
        Some(op) if same > 1 && !op.is_empty() => format!("{m} {op}"),
        _ => m.to_string(),
    }
}

/// Short plain-English definitions, shown the first time a lesson's
/// sentence uses the term: (phrase in the sentence, definition).
pub const GLOSSARY: &[(&str, &str)] = &[
    ("forwarded", "Forwarding: a result goes straight to the instruction that needs it, before it is written to its register."),
    ("pipeline register", "A pipeline register holds an instruction and its values between two stages."),
    ("must wait", "A stall: the instruction stays where it is for a cycle, and an empty slot (a bubble) moves on instead."),
    ("thrown away", "A flush: instructions fetched down the wrong path are removed before they change anything."),
];

/// For each sentence, the definitions of terms it is the first to use.
pub fn first_use_glosses(sentences: &[String]) -> Vec<Vec<&'static str>> {
    let mut seen = vec![false; GLOSSARY.len()];
    sentences
        .iter()
        .map(|s| {
            let mut out = Vec::new();
            for (i, (term, gloss)) in GLOSSARY.iter().enumerate() {
                if !seen[i] && s.contains(term) {
                    seen[i] = true;
                    out.push(*gloss);
                }
            }
            out
        })
        .collect()
}

fn is_jump(m: &str) -> bool {
    matches!(m, "j" | "jal" | "jalr" | "jr" | "ret" | "call" | "tail")
}

/// Two instructions with the same mnemonic, each named with its first
/// operand ("addi x6" and "addi x5"), or in full when that is the same too
/// ("addi x6, x6, 1" and "addi x6, x0, 0").
fn names_of_pair(a: &str, b: &str) -> (String, String) {
    let short = |text: &str| {
        let m = mnemonic(text);
        match text.split_whitespace().nth(1).map(|op| op.trim_end_matches(',')) {
            Some(op) if !op.is_empty() => format!("{m} {op}"),
            _ => m.to_string(),
        }
    };
    let full = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let (sa, sb) = (short(a), short(b));
    if sa == sb { (full(a), full(b)) } else { (sa, sb) }
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
                return (Kind::Done, format!("{by} writes x{} = {}, and the program is finished.", w.reg, snap.value(w.after)));
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
        let producer_text = reason.split('\'').nth(1);
        let consumer_text = stage(snap, "ID").and_then(|s| s.text.as_deref());
        let (producer, consumer) = match (producer_text, consumer_text) {
            (Some(p), Some(c)) if mnemonic(p) == mnemonic(c) => names_of_pair(p, c),
            (p, c) => (
                p.map(|t| name_of(snap, t)).unwrap_or_else(|| "the load".into()),
                c.map(|t| name_of(snap, t)).unwrap_or_else(|| "the next instruction".into()),
            ),
        };
        return (
            Kind::Stall,
            format!("{producer} is reading memory. {consumer} must wait one cycle because it needs {reg} from {producer}."),
        );
    }

    if let Some(f) = view.forwards.first() {
        let (from_stage, latch) = if f.from == "exmem" { ("MEM", "EX/MEM") } else { ("WB", "MEM/WB") };
        let consumer_text = stage_instr(snap, "EX");
        let producer_text = stage(snap, from_stage).and_then(|s| s.text.as_deref());
        let (consumer, producer) = match (consumer_text, producer_text) {
            (Some(c), Some(p)) if mnemonic(c) == mnemonic(p) => names_of_pair(c, p),
            (c, p) => (
                c.map(|t| name_of(snap, t)).unwrap_or_else(|| "the instruction in EX".into()),
                p.map(|t| name_of(snap, t)).unwrap_or_else(|| "an earlier instruction".into()),
            ),
        };
        // Two values from two different instructions: name each source.
        if let Some(g) = view.forwards.iter().find(|g| g.from != f.from && x_name(&g.reg) != x_name(&f.reg)) {
            let other_stage = if g.from == "exmem" { "MEM" } else { "WB" };
            let other = stage(snap, other_stage).and_then(|s| s.text.as_deref());
            let (p1, p2) = match (producer_text, other) {
                (Some(a), Some(b)) => names_of_pair(a, b),
                _ => (producer.clone(), "an earlier instruction".into()),
            };
            return (
                Kind::Forward,
                format!(
                    "{consumer} needs {} from {p1} and {} from {p2}, so both are forwarded from pipeline registers and nobody waits.",
                    x_name(&f.reg),
                    x_name(&g.reg)
                ),
            );
        }
        let regs: Vec<String> = view.forwards.iter().map(|f| x_name(&f.reg)).collect();
        let what = if regs.len() > 1 && regs.iter().any(|r| *r != regs[0]) {
            format!("{} and {}", regs[0], regs[1])
        } else {
            regs[0].clone()
        };
        return (
            Kind::Forward,
            format!("{consumer} needs {what} from {producer}, so it is forwarded from the {latch} pipeline register and nobody waits."),
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
        // "writes x5" already says which instruction it is.
        let by = stage(snap, "WB").and_then(|s| s.text.as_deref()).map(mnemonic).unwrap_or("an instruction");
        let reg = format!("x{}", w.reg);
        return (Kind::Plain, format!("{by} finishes and writes {reg} = {}.", snap.value(w.after)));
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
        return (Kind::Plain, format!("{} is computing in the ALU; everything else moves one stage on.", name_of(snap, text)));
    }
    if let Some(text) = stage_instr(snap, "ID") {
        return (Kind::Plain, format!("{} is decoded and reads its source registers.", name_of(snap, text)));
    }
    if stage_instr(snap, "IF").is_none() {
        return (Kind::Plain, "Nothing is left to fetch, so the pipeline is emptying.".into());
    }
    (Kind::Plain, "Every instruction moves one stage to the right.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run `src` and collect the sentence for each cycle (1-based index).
    fn sentences(src: &str) -> Vec<(Kind, String)> {
        sentences_at(src, 32)
    }

    fn sentences_at(src: &str, xlen: u32) -> Vec<(Kind, String)> {
        let mut p = crate::machine::build(src, xlen).expect("assembles").machine;
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
            "addi x2 needs x1 from addi x1, so it is forwarded from the EX/MEM pipeline register and nobody waits."
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
            for (_, s) in sentences_at(sample.source, sample.xlen) {
                assert!(s.chars().count() <= 120, "{s}");
                assert!(s.ends_with('.'), "{s}");
                assert!(!s.contains("Some(") && !s.contains("::"), "{s}");
            }
        }
    }

    #[test]
    fn rv64_sentences_use_64_bit_values() {
        let all = sentences_at(crate::tui::samples::RV64_SAMPLE.source, 64);
        let text: Vec<&str> = all.iter().map(|(_, s)| s.as_str()).collect();
        assert!(text.contains(&"addi finishes and writes x6 = 0x0000_0100_0000_0005."), "{text:#?}");
        assert!(text.contains(&"addw finishes and writes x7 = 5."), "{text:#?}");
        assert!(text.iter().any(|s| s.starts_with("addw needs x6 from addi")), "{text:#?}");
        assert_eq!(all.last().unwrap().1, "addi writes x10 = -1, and the program is finished.");
    }

    #[test]
    fn fit_instr_never_cuts_a_token() {
        assert_eq!(fit_instr("add  x3, x2, x1", 20, true), "add x3, x2, x1");
        assert_eq!(fit_instr("add  x3, x2, x1", 12, true), "add x3,x2,x1");
        assert_eq!(fit_instr("add  x3, x2, x1", 11, true), "add x3,x2…");
        assert_eq!(fit_instr("add  x3, x2, x1", 8, true), "add x3…");
        assert_eq!(fit_instr("add  x3, x2, x1", 6, true), "add…");
        assert_eq!(fit_instr("lw   x1, 0(x2)", 9, false), "lw x1~");
        assert_eq!(fit_instr("ecall", 5, true), "ecall");
        assert_eq!(fit_instr("ecall", 3, true), "ec…");
    }

    #[test]
    fn abi_names_become_x_names() {
        assert_eq!(x_name("ra"), "x1");
        assert_eq!(x_name("t0"), "x5");
        assert_eq!(x_name("x7"), "x7");
        assert_eq!(x_name("fp"), "x8");
    }

    #[test]
    fn same_mnemonics_are_named_by_their_first_operand() {
        let all = sentences("addi x5, x0, 6\naddi x6, x0, 7\naddi x7, x5, 1\n");
        let text: Vec<&str> = all.iter().map(|(_, s)| s.as_str()).collect();
        assert!(text.contains(&"addi x5 is decoded and reads its source registers."), "{text:#?}");
        assert!(text.iter().any(|s| s.starts_with("addi x7 needs x5 from addi x5")), "{text:#?}");
        // same first operand too: the full instructions
        let lp = sentences("addi x6, x0, 0\naddi x6, x6, 1\n");
        assert!(lp.iter().any(|(_, s)| s.starts_with("addi x6, x6, 1 needs x6 from addi x6, x0, 0")), "{lp:#?}");
        // two values from two instructions: each source is named
        let two = sentences("addi x5, x0, 10\naddi x6, x0, 0\nadd x6, x6, x5\n");
        assert!(two.iter().any(|(_, s)| s == "add needs x6 from addi x6 and x5 from addi x5, so both are forwarded from pipeline registers and nobody waits."), "{two:#?}");
        // one addi alone keeps the short name
        assert_eq!(sentences("addi x5, x0, 7\n")[2].1, "addi is decoded and reads its source registers.");
    }

    #[test]
    fn each_gloss_is_given_once_where_the_term_first_appears() {
        let said: Vec<String> = vec![
            "a plain cycle.".into(),
            "it is forwarded from the EX/MEM pipeline register and nobody waits.".into(),
            "it is forwarded again.".into(),
            "add must wait one cycle.".into(),
        ];
        let g = first_use_glosses(&said);
        assert!(g[0].is_empty() && g[2].is_empty());
        assert_eq!(g[1], vec![GLOSSARY[0].1, GLOSSARY[1].1]);
        assert_eq!(g[3], vec![GLOSSARY[2].1]);
        for (_, gloss) in GLOSSARY {
            assert!(gloss.chars().count() <= 120 && gloss.ends_with('.'), "{gloss}");
        }
    }
}

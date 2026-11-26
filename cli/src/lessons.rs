//! `riscvsim demo`: a six-lesson course on the pipeline.
//!
//! Each lesson is a tiny program with comments that explain the idea, a
//! plain-English title and a one-line promise for the menu, and the
//! register results it must reach (checked by the tests below). Lessons 2,
//! 3, 4 and 6 are the built-in samples' programs; 1 and 5 are new.

use crate::tui::samples::{Sample, RV64_SAMPLE, SAMPLES};

pub struct Lesson {
    /// Short name for `riscvsim demo <name>`.
    pub slug: &'static str,
    /// The program; `sample.name` is the lesson title.
    pub sample: Sample,
    /// One line for the menu: what the lesson shows.
    pub promise: &'static str,
    /// Registers worth watching every cycle: (register, what it holds).
    pub watch: &'static [(u8, &'static str)],
    /// Register values the program must end with.
    pub expect: &'static [(u8, u64)],
    /// Built-in sample names that lead here (`riscvsim demo load-use`).
    pub aliases: &'static [&'static str],
}

impl Lesson {
    pub fn title(&self) -> &'static str {
        self.sample.name
    }
}

pub const LESSONS: &[Lesson] = &[
    Lesson {
        slug: "first-steps",
        promise: "Watch five instructions move through the five stages.",
        sample: Sample {
            name: "Your first instructions",
            file: "first-steps.s",
            source: "# Each line is one instruction. Every cycle, each one
# moves one stage to the right: IF, ID, EX, MEM, WB.
# Registers are x0 to x31 (x0 is always 0). Each also has
# an ABI name, such as sp for x2; these lessons use x names.
addi x5, x0, 6     # x5 = 0 + 6
addi x6, x0, 7     # x6 = 0 + 7
addi x7, x0, 100   # x7 = 100
addi x10, x0, 1    # x10 = 1
add  x11, x5, x6   # x11 = 6 + 7 = 13
",
            xlen: 32,
        },
        watch: &[],
        expect: &[(5, 6), (6, 7), (7, 100), (10, 1), (11, 13)],
        aliases: &[],
    },
    Lesson {
        slug: "load-use",
        promise: "See why an add must wait one cycle for a load.",
        sample: Sample {
            name: "Waiting for memory",
            file: "load-use.s",
            source: "# A load reads memory in MEM, one stage later than the
# ALU, so the add right after it must wait one cycle.
.data
value:  .word 41

.text
addi x5, x0, 1     # x5 = 1
# lui puts 0x10000 in the upper 20 bits of x6, so x6
# shows 0x10000000: the address where .data starts.
lui  x6, 0x10000   # x6 = 0x10000000, where value is
lw   x7, 0(x6)     # x7 = 41, read from memory
add  x10, x7, x5   # needs x7 now: one stall
",
            xlen: 32,
        },
        watch: &[],
        expect: &[(5, 1), (6, 0x1000_0000), (7, 41), (10, 42)],
        aliases: &["load-use"],
    },
    Lesson {
        slug: "forwarding",
        promise: "Pass a result straight to the next instruction.",
        sample: Sample {
            name: "Skipping the wait",
            file: "forwarding.s",
            source: "# Each add needs the result just computed. Forwarding
# hands it over between stages, so nothing waits.
addi x5, x0, 5     # x5 = 5
addi x6, x5, 3     # needs x5: forwarded, x6 = 8
add  x7, x6, x5    # needs x6 and x5: x7 = 13
",
            xlen: 32,
        },
        watch: &[],
        expect: &[(5, 5), (6, 8), (7, 13)],
        aliases: &["add-forward"],
    },
    Lesson {
        slug: "branches",
        promise: "A branch guesses, misses, and wrong work is thrown away.",
        sample: Sample {
            name: "Guessing wrong",
            file: "branches.s",
            source: "# The pipeline guesses where a branch goes before it
# knows. A wrong guess throws away what came in behind it.
addi x5, x0, 3     # run the loop 3 times
addi x6, x0, 0
loop:
addi x6, x6, 1     # count each pass
addi x5, x5, -1
bne  x5, x0, loop  # guessed, then checked in EX
addi x7, x0, 99    # after the loop
",
            xlen: 32,
        },
        watch: &[],
        expect: &[(5, 0), (6, 3), (7, 99)],
        aliases: &["branch-loop"],
    },
    Lesson {
        slug: "loops",
        promise: "Add 1 to 10 and watch the counter count down.",
        sample: Sample {
            name: "Loops",
            file: "loops.s",
            source: "# Add 1 + 2 + ... + 10. x5 counts down from 10 and
# x6 collects the sum; bne repeats until x5 is 0.
addi x5, x0, 10    # counter
addi x6, x0, 0     # sum
loop:
add  x6, x6, x5    # sum = sum + counter
addi x5, x5, -1    # counter = counter - 1
bne  x5, x0, loop  # again until the counter is 0
",
            xlen: 32,
        },
        watch: &[(5, "counter"), (6, "sum")],
        expect: &[(5, 0), (6, 55)],
        aliases: &[],
    },
    Lesson {
        slug: "wide-values",
        promise: "RV64 registers hold 64 bits; see what addw keeps.",
        sample: Sample { name: "Wide values", ..RV64_SAMPLE },
        watch: &[],
        expect: &[(5, 0x0000_0100_0000_0000), (6, 0x0000_0100_0000_0005), (7, 5), (10, u64::MAX)],
        aliases: &["wide-values"],
    },
];

/// What `riscvsim demo <pick>` names.
pub enum Pick {
    /// A lesson, by its 1-based number.
    Lesson(usize),
    /// A built-in sample that is not a lesson (by index into SAMPLES).
    Sample(usize),
}

/// Find a lesson by number (`3`), name (`loops`) or sample name
/// (`add-forward`); other built-in samples still run as extra tours.
pub fn find(pick: &str) -> Option<Pick> {
    let pick = pick.trim().to_ascii_lowercase();
    let pick = pick.trim_end_matches(".s");
    if let Ok(n) = pick.parse::<usize>() {
        return (1..=LESSONS.len()).contains(&n).then_some(Pick::Lesson(n));
    }
    if let Some(i) = LESSONS.iter().position(|l| l.slug == pick || l.aliases.contains(&pick)) {
        return Some(Pick::Lesson(i + 1));
    }
    SAMPLES.iter().position(|s| s.file.trim_end_matches(".s") == pick).map(Pick::Sample)
}

/// Every name `riscvsim demo` accepts, for suggestions and completion.
pub fn names() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = LESSONS.iter().map(|l| l.slug).collect();
    for s in SAMPLES {
        let n = s.file.trim_end_matches(".s");
        if !names.contains(&n) && !LESSONS.iter().any(|l| l.aliases.contains(&n)) {
            names.push(n);
        }
    }
    names
}

/// "Next: riscvsim demo 3 (Skipping the wait)", or the end of the course.
pub fn next_line(number: usize) -> String {
    match LESSONS.get(number) {
        Some(next) => format!("riscvsim demo {} ({})", number + 1, next.title()),
        None => "riscvsim tui (step through your own program)".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_lesson_reaches_its_documented_registers() {
        for (i, lesson) in LESSONS.iter().enumerate() {
            let s = &lesson.sample;
            let mut m = crate::machine::build(s.source, s.xlen)
                .unwrap_or_else(|e| panic!("lesson {} does not assemble: {e:?}", i + 1))
                .machine;
            let mut cycles = 0;
            while !m.halted() && cycles < 1000 {
                m.step_cycle();
                cycles += 1;
            }
            let snap = m.snapshot();
            assert_eq!(snap.halt.as_ref().map(|h| h.kind), Some("complete"), "lesson {}", i + 1);
            for &(reg, want) in lesson.expect {
                assert_eq!(snap.registers[reg as usize], want, "lesson {} x{reg}", i + 1);
            }
        }
    }

    #[test]
    fn lessons_teach_what_their_titles_promise() {
        use crate::explain::Kind;
        let kinds = |n: usize| -> Vec<Kind> {
            let t = crate::demo::Tour::lesson(n).unwrap();
            t.snaps.iter().map(|s| crate::explain::cycle(s).0).collect()
        };
        assert!(!kinds(1).iter().any(|k| matches!(k, Kind::Stall | Kind::Flush)), "lesson 1 is plain");
        assert!(kinds(2).contains(&Kind::Stall), "lesson 2 stalls");
        let three = kinds(3);
        assert!(three.contains(&Kind::Forward) && !three.contains(&Kind::Stall), "lesson 3 forwards");
        assert!(kinds(4).contains(&Kind::Flush), "lesson 4 flushes");
        assert!(kinds(5).contains(&Kind::Branch) || kinds(5).contains(&Kind::Flush), "lesson 5 loops");
        assert_eq!(LESSONS[5].sample.xlen, 64, "lesson 6 is RV64");
    }

    #[test]
    fn sources_are_commented_and_fit_the_listing() {
        for lesson in LESSONS {
            let src = lesson.sample.source;
            assert!(src.lines().next().unwrap().starts_with('#'), "{}", lesson.slug);
            for line in src.lines() {
                assert!(line.chars().count() <= 60, "{}: {line}", lesson.slug);
            }
        }
    }

    /// Lessons use x names only, and never registers whose ABI names
    /// carry a job (x1 ra, x2 sp, x3 gp, x4 tp) as scratch values.
    #[test]
    fn lessons_use_plain_scratch_registers_and_x_names() {
        for lesson in LESSONS {
            for line in lesson.sample.source.lines() {
                let code = line.split('#').next().unwrap_or("");
                for bad in ["x1,", "x2,", "x3,", "x4,", "(x1)", "(x2)", "x1 ", "x2 ", "x3 ", "x4 "] {
                    assert!(!format!("{code} ").contains(bad), "{}: {line}", lesson.slug);
                }
                for abi in ["ra", "sp", "gp", "tp", "t0", "a0", "s0", "zero"] {
                    assert!(!code.split(|c: char| !c.is_alphanumeric()).any(|w| w == abi), "{}: {line}", lesson.slug);
                }
            }
            for &(reg, _) in lesson.expect {
                assert!((5..=7).contains(&reg) || (10..=12).contains(&reg), "{} uses x{reg}", lesson.slug);
            }
        }
        assert!(LESSONS[0].sample.source.contains("such as sp for x2"), "lesson 1 mentions ABI names once");
        assert!(LESSONS[1].sample.source.contains("upper 20 bits"), "lesson 2 explains lui");
    }

    #[test]
    fn picks_by_number_name_and_sample() {
        assert!(matches!(find("1"), Some(Pick::Lesson(1))));
        assert!(matches!(find("loops"), Some(Pick::Lesson(5))));
        assert!(matches!(find("LOOPS"), Some(Pick::Lesson(5))));
        assert!(matches!(find("add-forward"), Some(Pick::Lesson(3))));
        assert!(matches!(find("load-use.s"), Some(Pick::Lesson(2))));
        assert!(matches!(find("array-sum"), Some(Pick::Sample(3))));
        assert!(find("7").is_none() && find("0").is_none() && find("lops").is_none());
        assert_eq!(next_line(2), "riscvsim demo 3 (Skipping the wait)");
        assert!(names().contains(&"array-sum") && !names().contains(&"add-forward"));
    }
}

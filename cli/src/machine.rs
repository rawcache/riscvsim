//! One pipeline, either width: the interactive tools (`tui`, `demo`) drive
//! an RV32 or an RV64 engine through this type and always read a 64-bit
//! shaped snapshot. RV32 values are widened with zero extension, so every
//! formatter uses the width (see [`Snap::xlen`]).
//!
//! The width is chosen the same way `riscvsim run` chooses it: `--xlen=64`
//! on the command line, or a sample that is marked RV64.

use sim_engine::pipeline as p32;
use sim_engine::pipeline64 as p64;
use sim_engine::{assemble, assemble64, Pipeline, Pipeline64};

pub use p64::{CycleView, LogLine, StageState, StageView};

/// A cycle's snapshot plus the register width it was taken at.
#[derive(Clone, Debug)]
pub struct Snap {
    pub xlen: u32,
    pub inner: p64::Snapshot,
}

impl std::ops::Deref for Snap {
    type Target = p64::Snapshot;
    fn deref(&self) -> &p64::Snapshot {
        &self.inner
    }
}

impl Snap {
    /// A register value as a learner reads it: decimal when small, hex when
    /// big (8 digits on RV32, 4-digit groups on RV64).
    pub fn value(&self, v: u64) -> String {
        short_value(v, self.xlen)
    }
}

/// Decimal for small values, grouped hex otherwise. RV32 output is exactly
/// what the 32-bit tools always printed.
pub fn short_value(v: u64, xlen: u32) -> String {
    let signed = signed(v, xlen);
    if (-4096..=4096).contains(&signed) {
        signed.to_string()
    } else {
        crate::run::hex(v, xlen)
    }
}

/// A register value as a signed number of the right width.
pub fn signed(v: u64, xlen: u32) -> i64 {
    if xlen == 64 {
        v as i64
    } else {
        v as u32 as i32 as i64
    }
}

/// An address: 8 hex digits on RV32 (as before), and also on RV64 while the
/// address fits, since every RV64 program here lives below 4 GiB.
pub fn addr(v: u64) -> String {
    if v <= u32::MAX as u64 {
        format!("0x{v:08x}")
    } else {
        crate::run::hex(v, 64)
    }
}

// One machine per session, so the size difference between the variants
// costs nothing worth a Box.
#[allow(clippy::large_enum_variant)]
pub enum Machine {
    Rv32(Pipeline),
    Rv64(Pipeline64),
}

/// An assembled program: the machine and its (addr, text) listing.
pub struct Assembled {
    pub machine: Machine,
    pub listing: Vec<(u64, String)>,
}

/// Assemble `source` at `xlen` (32 or 64). Errors are (line, message).
pub fn build(source: &str, xlen: u32) -> Result<Assembled, Vec<(usize, String)>> {
    if xlen == 64 {
        let program = assemble64(source).map_err(|e| e.into_iter().map(|e| (e.line, e.message)).collect::<Vec<_>>())?;
        let listing = program.instrs.iter().map(|i| (i.addr, i.text.clone())).collect();
        Ok(Assembled { machine: Machine::Rv64(Pipeline64::new(program)), listing })
    } else {
        let program = assemble(source).map_err(|e| e.into_iter().map(|e| (e.line, e.message)).collect::<Vec<_>>())?;
        let listing = program.instrs.iter().map(|i| (i.addr as u64, i.text.clone())).collect();
        Ok(Assembled { machine: Machine::Rv32(Pipeline::new(program)), listing })
    }
}

macro_rules! both {
    ($self:expr, $p:ident => $e:expr) => {
        match $self {
            Machine::Rv32($p) => $e,
            Machine::Rv64($p) => $e,
        }
    };
}

impl Machine {
    pub fn halted(&self) -> bool {
        both!(self, p => p.halted())
    }
    pub fn step_cycle(&mut self) {
        both!(self, p => p.step_cycle())
    }
    pub fn step_back(&mut self) -> bool {
        both!(self, p => p.step_back())
    }
    pub fn reset(&mut self) {
        both!(self, p => p.reset())
    }
    pub fn fetch_pc(&self) -> u64 {
        match self {
            Machine::Rv32(p) => p.fetch_pc() as u64,
            Machine::Rv64(p) => p.fetch_pc(),
        }
    }
    pub fn log_seq(&self) -> u64 {
        both!(self, p => p.log_seq())
    }
    #[cfg(test)]
    pub fn registers(&self) -> [u64; 32] {
        match self {
            Machine::Rv32(p) => p.registers().map(u64::from),
            Machine::Rv64(p) => p.registers(),
        }
    }
    /// Source line (1-based) of the instruction at `pc`, if any.
    pub fn line_at(&self, pc: u64) -> Option<usize> {
        match self {
            Machine::Rv32(p) => u32::try_from(pc).ok().and_then(|pc| p.program().instr_at(pc)).map(|i| i.line),
            Machine::Rv64(p) => p.program().instr_at(pc).map(|i| i.line),
        }
    }
    pub fn read_memory(&self, addr: u64, len: usize) -> Vec<u8> {
        match self {
            Machine::Rv32(p) => p.read_memory(addr as u32, len),
            Machine::Rv64(p) => p.read_memory(addr, len),
        }
    }
    pub fn log_since(&self, seq: u64) -> Vec<LogLine> {
        match self {
            Machine::Rv32(p) => p.log_since(seq).into_iter().map(widen_log).collect(),
            Machine::Rv64(p) => p.log_since(seq),
        }
    }
    pub fn snapshot(&self) -> Snap {
        match self {
            Machine::Rv32(p) => Snap { xlen: 32, inner: widen(p.snapshot()) },
            Machine::Rv64(p) => Snap { xlen: 64, inner: p.snapshot() },
        }
    }
}

fn widen_log(l: p32::LogLine) -> LogLine {
    LogLine { seq: l.seq, cycle: l.cycle, kind: l.kind, text: l.text }
}

fn widen_state(s: p32::StageState) -> StageState {
    match s {
        p32::StageState::Empty => StageState::Empty,
        p32::StageState::Normal => StageState::Normal,
        p32::StageState::Stall => StageState::Stall,
        p32::StageState::Flush => StageState::Flush,
    }
}

/// An RV32 snapshot in the 64-bit shape (values zero-extended).
pub fn widen(s: p32::Snapshot) -> p64::Snapshot {
    let v = s.view;
    p64::Snapshot {
        cycle: s.cycle,
        pc: s.pc as u64,
        halted: s.halted,
        halt: s.halt.map(|h| p64::HaltInfo { kind: h.kind, message: h.message }),
        stages: s
            .stages
            .into_iter()
            .map(|st| StageView {
                name: st.name,
                state: widen_state(st.state),
                text: st.text,
                pc: st.pc.map(u64::from),
                line: st.line,
                detail: st.detail,
            })
            .collect(),
        view: CycleView {
            forwards: v
                .forwards
                .into_iter()
                .map(|f| p64::ForwardView { from: f.from, reg: f.reg, operand: f.operand, value: f.value as u64 })
                .collect(),
            flushed: v
                .flushed
                .into_iter()
                .map(|f| p64::FlushView { stage: f.stage, text: f.text, pc: f.pc as u64 })
                .collect(),
            stall: v.stall,
            predictor: v.predictor.map(|p| p64::PredictorView {
                pc: p.pc as u64,
                text: p.text,
                stage: p.stage,
                predicted_taken: p.predicted_taken,
                counter: p.counter,
                actual_taken: p.actual_taken,
                mispredicted: p.mispredicted,
            }),
            reg_writes: v
                .reg_writes
                .into_iter()
                .map(|w| p64::RegWrite { reg: w.reg, name: w.name, before: w.before as u64, after: w.after as u64 })
                .collect(),
        },
        registers: s.registers.into_iter().map(u64::from).collect(),
        stats: p64::Stats {
            cycles: s.stats.cycles,
            instructions: s.stats.instructions,
            stalls: s.stats.stalls,
            flushes: s.stats.flushes,
            branches: s.stats.branches,
            mispredictions: s.stats.mispredictions,
        },
        log: s.log.into_iter().map(widen_log).collect(),
        can_step_back: s.can_step_back,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(src: &str, xlen: u32) -> Machine {
        let mut m = build(src, xlen).expect("assembles").machine;
        let mut n = 0;
        while !m.halted() && n < 1000 {
            m.step_cycle();
            n += 1;
        }
        m
    }

    #[test]
    fn rv64_state_matches_the_engine() {
        // Builds 0x0000_0100_0000_0005 and checks it against the engine's
        // own report for the same program.
        let src = crate::tui::samples::RV64_SAMPLE.source;
        let m = run(src, 64);
        let report = sim_engine::report::run64(src, 10_000);
        assert!(report.ok, "{}", report.message);
        let regs = m.registers();
        assert_eq!(regs.to_vec(), m.snapshot().registers);
        assert_eq!(report.registers.len(), 32);
        for (i, r) in regs.iter().enumerate() {
            let engine = u64::from_str_radix(report.registers[i].trim_start_matches("0x"), 16).unwrap();
            assert_eq!(*r, engine, "x{i}");
        }
        assert!(regs.contains(&0x0000_0100_0000_0005), "{regs:x?}");
    }

    #[test]
    fn rv32_widening_keeps_every_value() {
        for sample in crate::tui::samples::SAMPLES.iter().filter(|s| s.xlen == 32) {
            let mut a = build(sample.source, 32).unwrap().machine;
            let mut b = Pipeline::new(assemble(sample.source).unwrap());
            while !b.halted() {
                b.step_cycle();
                a.step_cycle();
                let (wa, wb) = (a.snapshot(), b.snapshot());
                assert_eq!(wa.registers, wb.registers.iter().map(|&r| r as u64).collect::<Vec<_>>());
                assert_eq!(wa.cycle, wb.cycle);
                assert_eq!(wa.stages.len(), wb.stages.len());
                for (x, y) in wa.stages.iter().zip(&wb.stages) {
                    assert_eq!(x.text, y.text);
                    assert_eq!(x.pc, y.pc.map(u64::from));
                }
                assert_eq!(wa.view.stall, wb.view.stall);
                assert_eq!(wa.view.flushed.len(), wb.view.flushed.len());
            }
        }
    }

    #[test]
    fn values_keep_their_width() {
        assert_eq!(short_value(u32::MAX as u64, 32), "-1");
        assert_eq!(short_value(u64::MAX, 64), "-1");
        assert_eq!(short_value(0x1_0000_0007, 64), "0x0000_0001_0000_0007");
        assert_eq!(short_value(0x1000_0000, 32), "0x10000000");
        assert_eq!(addr(0x1000_0000), "0x10000000");
    }
}

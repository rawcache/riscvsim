//! WASM bindings for the shared 5-stage pipeline engine (sim-engine crate).
//!
//! This module is additive: the original single-cycle `Simulator` export in
//! lib.rs is untouched and still backs the older pages. The rebuilt
//! /simulator/ page and the `riscvsim` CLI both run on sim-engine, so the
//! browser and terminal execute the exact same pipeline.

use sim_engine::pipeline64::{HaltInfo, LogLine, StageState, Stats};
use sim_engine::{
    assemble, assemble64, AsmError64, Pipeline, Pipeline64, Snapshot64, DEFAULT_MAX_CYCLES,
};
use wasm_bindgen::prelude::*;

fn to_js<T: serde::Serialize>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value)
        .map_err(|e| JsValue::from_str(&format!("serialization failed: {e}")))
}

#[wasm_bindgen]
pub struct PipelineSim {
    pipeline: Pipeline,
}

/// RV64IM counterpart to `PipelineSim`. The RV32 export remains the default
/// and retains its existing API and value widths.
#[wasm_bindgen]
pub struct PipelineSim64 {
    pipeline: Pipeline64,
}

/// Assemble a program. On success returns a PipelineSim ready to step;
/// on failure returns a JS array of `{ line, message }` errors.
#[wasm_bindgen]
pub fn assemble_pipeline(source: &str) -> Result<PipelineSim, JsValue> {
    match assemble(source) {
        Ok(program) => Ok(PipelineSim {
            pipeline: Pipeline::new(program),
        }),
        Err(errors) => Err(to_js(&errors)?),
    }
}

/// Assemble an RV64IM program. This is a separate entry point so existing
/// callers of `assemble_pipeline` continue to select RV32IM implicitly.
///
/// On failure this throws `{ ok: false, output: null, line, message, errors }`
/// (the `{ ok, output, line, message }` shape the translate API uses), where
/// `line`/`message` describe the first error and `errors` lists them all.
#[wasm_bindgen]
pub fn assemble_pipeline64(source: &str) -> Result<PipelineSim64, JsValue> {
    match assemble64(source) {
        Ok(program) => Ok(PipelineSim64 {
            pipeline: Pipeline64::new(program),
        }),
        Err(errors) => Err(to_js(&Rv64AssembleError::from_errors(errors))?),
    }
}

/// Assemble and run an RV64IM program to completion in one call, returning
/// `{ ok, output, line, message, registers, pc, cycles }`. Every 64-bit value
/// (`registers`, `pc`) is a `0x`-prefixed 16-digit hex string so it never
/// passes through a JS Number.
#[wasm_bindgen]
pub fn run_rv64(source: &str, max_cycles: Option<u32>) -> Result<JsValue, JsValue> {
    to_js(&run_rv64_result(
        source,
        max_cycles.map(u64::from).unwrap_or(DEFAULT_MAX_CYCLES),
    ))
}

#[wasm_bindgen]
impl PipelineSim {
    pub fn step_cycle(&mut self) {
        self.pipeline.step_cycle();
    }

    /// Step up to `cycles` cycles (stops early on halt). Used for fast run.
    pub fn step_cycles(&mut self, cycles: u32) {
        for _ in 0..cycles {
            if self.pipeline.halted() {
                break;
            }
            self.pipeline.step_cycle();
        }
    }

    /// Run to completion with the safety cycle cap.
    pub fn run_to_completion(&mut self, max_cycles: Option<u32>) {
        self.pipeline
            .run(max_cycles.map(u64::from).unwrap_or(DEFAULT_MAX_CYCLES));
    }

    pub fn step_back(&mut self) -> bool {
        self.pipeline.step_back()
    }

    pub fn reset(&mut self) {
        self.pipeline.reset();
    }

    pub fn halted(&self) -> bool {
        self.pipeline.halted()
    }

    /// Full per-cycle snapshot (stages, forwards, stalls, flushes,
    /// predictor, registers, stats, log) as a JS object.
    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        to_js(&self.pipeline.snapshot())
    }

    /// The assembled program listing: [{ addr, text, line }].
    pub fn listing(&self) -> Result<JsValue, JsValue> {
        let listing: Vec<_> = self
            .pipeline
            .program()
            .instrs
            .iter()
            .map(|i| ListingEntry {
                addr: i.addr,
                text: i.text.clone(),
                line: i.line,
            })
            .collect();
        to_js(&listing)
    }

    pub fn read_memory(&self, addr: u32, len: usize) -> Box<[u8]> {
        self.pipeline
            .read_memory(addr, len.min(4096))
            .into_boxed_slice()
    }
}

#[wasm_bindgen]
impl PipelineSim64 {
    pub fn step_cycle(&mut self) {
        self.pipeline.step_cycle();
    }

    pub fn step_cycles(&mut self, cycles: u32) {
        for _ in 0..cycles {
            if self.pipeline.halted() {
                break;
            }
            self.pipeline.step_cycle();
        }
    }

    pub fn run_to_completion(&mut self, max_cycles: Option<u32>) {
        self.pipeline
            .run(max_cycles.map(u64::from).unwrap_or(DEFAULT_MAX_CYCLES));
    }

    pub fn step_back(&mut self) -> bool {
        self.pipeline.step_back()
    }

    pub fn reset(&mut self) {
        self.pipeline.reset();
    }

    pub fn halted(&self) -> bool {
        self.pipeline.halted()
    }

    /// Same shape as `PipelineSim::snapshot`, except every register, PC,
    /// address and forwarded value is a `0x`-prefixed 16-digit hex string.
    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        to_js(&JsSnapshot64::from(&self.pipeline.snapshot()))
    }

    /// `[{ addr, text, line }]` with `addr` as a 16-digit hex string.
    pub fn listing(&self) -> Result<JsValue, JsValue> {
        let listing: Vec<_> = self
            .pipeline
            .program()
            .instrs
            .iter()
            .map(|i| ListingEntry64 {
                addr: hex64(i.addr),
                text: i.text.clone(),
                line: i.line,
            })
            .collect();
        to_js(&listing)
    }

    /// `addr` is a u64, so JS passes it as a BigInt.
    pub fn read_memory(&self, addr: u64, len: usize) -> Box<[u8]> {
        self.pipeline
            .read_memory(addr, len.min(4096))
            .into_boxed_slice()
    }
}

#[derive(serde::Serialize)]
struct ListingEntry {
    addr: u32,
    text: String,
    line: usize,
}

#[derive(serde::Serialize)]
struct ListingEntry64 {
    addr: String,
    text: String,
    line: usize,
}

// ---------------------------------------------------------------------------
// RV64 JS boundary: 64-bit values cross as hex strings, never JS Numbers.
// Counters (cycle, stats, log seq) stay numeric; they are bounded by the
// cycle cap and are not machine words.
// ---------------------------------------------------------------------------

/// `0x` + exactly 16 lowercase hex digits.
pub(crate) fn hex64(value: u64) -> String {
    format!("0x{value:016x}")
}

#[derive(serde::Serialize)]
struct JsStage64 {
    name: &'static str,
    state: StageState,
    text: Option<String>,
    pc: Option<String>,
    line: Option<usize>,
    detail: Option<String>,
}

#[derive(serde::Serialize)]
struct JsForward64 {
    from: &'static str,
    reg: String,
    operand: &'static str,
    value: String,
}

#[derive(serde::Serialize)]
struct JsFlush64 {
    stage: &'static str,
    text: String,
    pc: String,
}

#[derive(serde::Serialize)]
struct JsPredictor64 {
    pc: String,
    text: String,
    stage: &'static str,
    predicted_taken: bool,
    counter: u8,
    actual_taken: Option<bool>,
    mispredicted: Option<bool>,
}

#[derive(serde::Serialize)]
struct JsRegWrite64 {
    reg: u8,
    name: String,
    before: String,
    after: String,
}

#[derive(serde::Serialize)]
struct JsCycleView64 {
    forwards: Vec<JsForward64>,
    flushed: Vec<JsFlush64>,
    stall: Option<String>,
    predictor: Option<JsPredictor64>,
    reg_writes: Vec<JsRegWrite64>,
}

#[derive(serde::Serialize)]
struct JsSnapshot64 {
    xlen: u8,
    cycle: u64,
    pc: String,
    halted: bool,
    halt: Option<HaltInfo>,
    stages: Vec<JsStage64>,
    view: JsCycleView64,
    registers: Vec<String>,
    stats: Stats,
    log: Vec<LogLine>,
    can_step_back: bool,
}

impl From<&Snapshot64> for JsSnapshot64 {
    fn from(s: &Snapshot64) -> Self {
        Self {
            xlen: 64,
            cycle: s.cycle,
            pc: hex64(s.pc),
            halted: s.halted,
            halt: s.halt.clone(),
            stages: s
                .stages
                .iter()
                .map(|st| JsStage64 {
                    name: st.name,
                    state: st.state.clone(),
                    text: st.text.clone(),
                    pc: st.pc.map(hex64),
                    line: st.line,
                    detail: st.detail.clone(),
                })
                .collect(),
            view: JsCycleView64 {
                forwards: s
                    .view
                    .forwards
                    .iter()
                    .map(|f| JsForward64 {
                        from: f.from,
                        reg: f.reg.clone(),
                        operand: f.operand,
                        value: hex64(f.value),
                    })
                    .collect(),
                flushed: s
                    .view
                    .flushed
                    .iter()
                    .map(|f| JsFlush64 {
                        stage: f.stage,
                        text: f.text.clone(),
                        pc: hex64(f.pc),
                    })
                    .collect(),
                stall: s.view.stall.clone(),
                predictor: s.view.predictor.as_ref().map(|p| JsPredictor64 {
                    pc: hex64(p.pc),
                    text: p.text.clone(),
                    stage: p.stage,
                    predicted_taken: p.predicted_taken,
                    counter: p.counter,
                    actual_taken: p.actual_taken,
                    mispredicted: p.mispredicted,
                }),
                reg_writes: s
                    .view
                    .reg_writes
                    .iter()
                    .map(|w| JsRegWrite64 {
                        reg: w.reg,
                        name: w.name.clone(),
                        before: hex64(w.before),
                        after: hex64(w.after),
                    })
                    .collect(),
            },
            registers: s.registers.iter().copied().map(hex64).collect(),
            stats: s.stats,
            log: s.log.clone(),
            can_step_back: s.can_step_back,
        }
    }
}

#[derive(serde::Serialize)]
struct Rv64AssembleError {
    ok: bool,
    output: Option<String>,
    line: usize,
    message: String,
    errors: Vec<AsmError64>,
}

impl Rv64AssembleError {
    fn from_errors(errors: Vec<AsmError64>) -> Self {
        let (line, message) = errors
            .first()
            .map(|e| (e.line, e.message.clone()))
            .unwrap_or((0, "assembly failed".to_string()));
        Self {
            ok: false,
            output: None,
            line,
            message,
            errors,
        }
    }
}

type Rv64RunResult = sim_engine::report::RunReport;


fn run_rv64_result(source: &str, max_cycles: u64) -> Rv64RunResult {
    // One source of truth with the CLI (`riscvsim run --xlen=64 --json`).
    sim_engine::report::run64(source, max_cycles)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex64_is_always_sixteen_digits() {
        assert_eq!(hex64(0), "0x0000000000000000");
        assert_eq!(hex64(u64::MAX), "0xffffffffffffffff");
        // 2^53 + 1: the first integer a JS Number cannot represent.
        assert_eq!(hex64((1u64 << 53) + 1), "0x0020000000000001");
    }

    #[test]
    fn snapshot_carries_values_above_2_pow_53_exactly() {
        let program = assemble64("li x5, 0x20000000000001\nli x6, 0xfedcba9876543210\necall\n")
            .expect("assembles");
        let mut p = Pipeline64::new(program);
        p.run(10_000);
        let js = JsSnapshot64::from(&p.snapshot());
        assert_eq!(js.registers[5], "0x0020000000000001");
        assert_eq!(js.registers[6], "0xfedcba9876543210");
        assert_eq!(js.registers[0], "0x0000000000000000");
        assert!(js.registers.iter().all(|r| r.len() == 18));
        assert_eq!(js.pc.len(), 18);
    }

    #[test]
    fn run_result_reports_assembly_errors_with_line() {
        let r = run_rv64_result("addi x1, x0, 1\nfmul.d f1, f2, f3\n", 1000);
        assert!(!r.ok);
        assert_eq!(r.line, 2);
        assert!(r.message.starts_with("unsupported instruction 'fmul.d'"));
        assert!(r.output.is_none());
    }

    #[test]
    fn run_result_reports_runtime_traps_with_line() {
        let r = run_rv64_result("li x1, 3\nld x2, 0(x1)\n", 1000);
        assert!(!r.ok);
        assert_eq!(r.line, 2);
        assert!(r.message.starts_with("misaligned load"), "{}", r.message);
    }

    #[test]
    fn run_result_success_lists_changed_registers() {
        let r = run_rv64_result("li a0, -1\necall\n", 1000);
        assert!(r.ok, "{}", r.message);
        assert_eq!(r.line, 0);
        assert_eq!(r.registers[10], "0xffffffffffffffff");
        assert_eq!(
            r.output.as_deref(),
            Some("x10 (a0) = 0xffffffffffffffff (-1)")
        );
    }

    #[test]
    fn assemble_error_uses_shared_shape() {
        let e = Rv64AssembleError::from_errors(assemble64("nop\nbogus x1\n").unwrap_err());
        assert!(!e.ok);
        assert_eq!(e.line, 2);
        assert!(e.message.contains("unknown instruction 'bogus'"));
        assert_eq!(e.errors.len(), 1);
    }
}

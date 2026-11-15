//! WASM bindings for the shared 5-stage pipeline engine (sim-engine crate).
//!
//! This module is additive: the original single-cycle `Simulator` export in
//! lib.rs is untouched and still backs the older pages. The rebuilt
//! /simulator/ page and the `riscvsim` CLI both run on sim-engine, so the
//! browser and terminal execute the exact same pipeline.

use sim_engine::{assemble, assemble64, Pipeline, Pipeline64, DEFAULT_MAX_CYCLES};
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
#[wasm_bindgen]
pub fn assemble_pipeline64(source: &str) -> Result<PipelineSim64, JsValue> {
    match assemble64(source) {
        Ok(program) => Ok(PipelineSim64 {
            pipeline: Pipeline64::new(program),
        }),
        Err(errors) => Err(to_js(&errors)?),
    }
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

    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        to_js(&self.pipeline.snapshot())
    }

    pub fn listing(&self) -> Result<JsValue, JsValue> {
        let listing: Vec<_> = self
            .pipeline
            .program()
            .instrs
            .iter()
            .map(|i| ListingEntry64 {
                addr: i.addr,
                text: i.text.clone(),
                line: i.line,
            })
            .collect();
        to_js(&listing)
    }

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
    addr: u64,
    text: String,
    line: usize,
}

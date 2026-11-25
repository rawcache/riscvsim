//! PART D: the pipelines against the reference interpreters.

mod support;

use sim_engine::{assemble, assemble64, Pipeline, Pipeline64, DATA_BASE};
use support::programs::{Generator, BUF_BYTES};
use support::reference::{run32, run64, Outcome};
use support::{iterations, Rng};

const STEP_BUDGET: u64 = 100_000;

fn outcome_of(kind: Option<&str>, completed: bool) -> Outcome {
    match (completed, kind) {
        (true, Some("complete")) => Outcome::Complete,
        (false, _) => Outcome::StepLimit,
        _ => Outcome::Error,
    }
}

/// Bytes of the data buffer and the top of the stack, for comparison.
fn regions32() -> Vec<(u64, usize)> {
    vec![(DATA_BASE as u64, BUF_BYTES as usize), (sim_engine::STACK_TOP as u64 - 252, 256)]
}
fn regions64() -> Vec<(u64, usize)> {
    let top = sim_engine::pipeline64::STACK_TOP64;
    vec![(DATA_BASE as u64, BUF_BYTES as usize), (top - 248, 256)]
}

fn reference_bytes(mem: &std::collections::BTreeMap<u64, u8>, addr: u64, len: usize) -> Vec<u8> {
    (0..len as u64).map(|i| *mem.get(&(addr + i)).unwrap_or(&0)).collect()
}

fn check32(src: &str, case: usize) -> (sim_engine::pipeline::Stats, Outcome) {
    let program = assemble(src).unwrap_or_else(|e| panic!("case {case}: {}\n{src}", e[0].message));
    let expected = run32(&program, STEP_BUDGET);
    let mut p = Pipeline::new(program);
    let completed = p.run(STEP_BUDGET * 10);
    let snap = p.snapshot();
    let outcome = outcome_of(snap.halt.as_ref().map(|h| h.kind), completed);
    assert_eq!(outcome, expected.outcome, "case {case}: outcome\n{src}");
    assert_eq!(p.registers(), expected.regs, "case {case}: registers\n{src}");
    for (addr, len) in regions32() {
        assert_eq!(p.read_memory(addr as u32, len), reference_bytes(&expected.mem, addr, len), "case {case}: memory at {addr:#x}\n{src}");
    }
    if expected.outcome == Outcome::Complete {
        assert_eq!(p.stats().instructions, expected.retired, "case {case}: retired count\n{src}");
    }
    (p.stats(), expected.outcome)
}

fn check64(src: &str, case: usize) -> (sim_engine::pipeline64::Stats, Outcome) {
    let program = assemble64(src).unwrap_or_else(|e| panic!("case {case}: {}\n{src}", e[0].message));
    let expected = run64(&program, STEP_BUDGET);
    let mut p = Pipeline64::new(program);
    let completed = p.run(STEP_BUDGET * 10);
    let snap = p.snapshot();
    let outcome = outcome_of(snap.halt.as_ref().map(|h| h.kind), completed);
    assert_eq!(outcome, expected.outcome, "case {case}: outcome\n{src}");
    assert_eq!(p.registers(), expected.regs, "case {case}: registers\n{src}");
    for (addr, len) in regions64() {
        assert_eq!(p.read_memory(addr, len), reference_bytes(&expected.mem, addr, len), "case {case}: memory at {addr:#x}\n{src}");
    }
    if expected.outcome == Outcome::Complete {
        assert_eq!(p.stats().instructions, expected.retired, "case {case}: retired count\n{src}");
    }
    (p.stats(), expected.outcome)
}

#[test]
fn rv32_pipeline_matches_reference_on_random_programs() {
    let mut rng = Rng::new(0x3232);
    let mut totals = [0u64; 4];
    for case in 0..iterations(500, 20_000) {
        let src = Generator::new(&mut rng, 32).program();
        let (s, _) = check32(&src, case);
        totals = [totals[0] + s.stalls, totals[1] + s.mispredictions, totals[2] + s.flushes, totals[3] + s.branches];
    }
    assert!(totals.iter().all(|&t| t > 100), "coverage too thin: stalls, mispredictions, flushes, branches = {totals:?}");
}

#[test]
fn rv64_pipeline_matches_reference_on_random_programs() {
    let mut rng = Rng::new(0x6464);
    let mut totals = [0u64; 4];
    for case in 0..iterations(500, 20_000) {
        let src = Generator::new(&mut rng, 64).program();
        let (s, _) = check64(&src, case);
        totals = [totals[0] + s.stalls, totals[1] + s.mispredictions, totals[2] + s.flushes, totals[3] + s.branches];
    }
    assert!(totals.iter().all(|&t| t > 100), "coverage too thin: {totals:?}");
}

#[test]
fn faulting_accesses_end_identically() {
    let mut rng = Rng::new(0xFA17);
    let mut errors = 0;
    for case in 0..iterations(200, 5_000) {
        let mut g = Generator::new(&mut rng, 32);
        g.allow_faults = true;
        let src = g.program();
        errors += usize::from(check32(&src, case).1 == Outcome::Error);
        let mut g = Generator::new(&mut rng, 64);
        g.allow_faults = true;
        let src = g.program();
        errors += usize::from(check64(&src, case).1 == Outcome::Error);
    }
    assert!(errors > 50, "only {errors} programs faulted");
}

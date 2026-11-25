//! Test-only cross-check: programs assembled by `sim-engine`, encoded to
//! machine code with `sim_engine::encoding`, and executed by this crate's
//! independent binary-decoding RV32IM `Simulator` must end with the same
//! registers as the `sim-engine` pipeline. Two decoders written separately
//! agreeing on every instruction validates the encoder.

use super::*;
use sim_engine::{assemble, encoding::program_bytes32, Pipeline};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const R_OPS: &[&str] = &[
    "add", "sub", "sll", "slt", "sltu", "xor", "srl", "sra", "or", "and", "mul", "mulh",
    "mulhsu", "mulhu", "div", "divu", "rem", "remu",
];
const I_OPS: &[&str] = &["addi", "slti", "sltiu", "xori", "ori", "andi"];
const SHIFTS: &[&str] = &["slli", "srli", "srai"];
const BRANCHES: &[&str] = &["beq", "bne", "blt", "bge", "bltu", "bgeu"];

fn random_program(rng: &mut Rng) -> String {
    let reg = |rng: &mut Rng| format!("x{}", 5 + rng.below(10));
    let mut s = String::from(".data\nbuf: .space 64\n.text\nla x31, buf\n");
    for r in 5..15 {
        s.push_str(&format!("li x{r}, {}\n", rng.next() as i32));
    }
    let n = 40;
    for i in 0..n {
        let line = match rng.below(9) {
            0..=2 => format!("{} {}, {}, {}", R_OPS[rng.below(R_OPS.len() as u64) as usize], reg(rng), reg(rng), reg(rng)),
            3 | 4 => format!("{} {}, {}, {}", I_OPS[rng.below(6) as usize], reg(rng), reg(rng), rng.below(4096) as i64 - 2048),
            5 => format!("{} {}, {}, {}", SHIFTS[rng.below(3) as usize], reg(rng), reg(rng), rng.below(32)),
            6 => {
                let (op, w) = [("sw", 4), ("sh", 2), ("sb", 1)][rng.below(3) as usize];
                format!("{op} {}, {}(x31)", reg(rng), rng.below(64 / w) * w)
            }
            7 => {
                let (op, w) = [("lw", 4), ("lh", 2), ("lhu", 2), ("lb", 1), ("lbu", 1)][rng.below(5) as usize];
                format!("{op} {}, {}(x31)", reg(rng), rng.below(64 / w) * w)
            }
            _ => format!("{} {}, {}, L{}", BRANCHES[rng.below(6) as usize], reg(rng), reg(rng), i + 1 + rng.below(3)),
        };
        s.push_str(&format!("L{i}: {line}\n"));
    }
    for i in n..n + 4 {
        s.push_str(&format!("L{i}: lui x{}, {}\n", 5 + rng.below(10), rng.below(1 << 20)));
    }
    s.push_str("auipc x15, 3\nlw x16, 0(x31)\necall\n");
    s
}

fn run_legacy(bytes: &[u8], data: &[u8]) -> [u32; 32] {
    let mut sim = Simulator::new(0);
    sim.load_program_internal(bytes).expect("load text");
    sim.load_segment(data, DATA_BASE).expect("load data");
    for _ in 0..10_000 {
        let delta = sim.step_internal();
        if let Some(trap) = delta.trap {
            assert_eq!(trap.cause, "environment_call", "legacy CPU trapped: {}", trap.message);
            return sim.registers;
        }
    }
    panic!("legacy run did not reach ecall");
}

#[test]
fn encoded_programs_run_identically_on_the_independent_decoder() {
    let mut rng = Rng(0x00C0_FFEE_1234_5678);
    for case in 0..300 {
        let src = random_program(&mut rng);
        let program = assemble(&src).unwrap_or_else(|e| panic!("case {case}: {}", e[0].message));
        let bytes = program_bytes32(&program).expect("every assembled instruction encodes");
        let legacy = run_legacy(&bytes, &program.data);
        let mut pipeline = Pipeline::new(program);
        assert!(pipeline.run(100_000));
        assert_eq!(pipeline.registers(), legacy, "case {case}\n{src}");
    }
}

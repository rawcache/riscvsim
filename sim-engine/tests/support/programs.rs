//! Seeded random assembly program generator for differential testing.
//!
//! Programs always terminate: backward branches only close counted loops,
//! calls go to leaf subroutines placed after the final `ecall`.
#![allow(dead_code)]

use super::Rng;

/// Registers holding random values (few of them, so dependencies are dense).
const VALUE_REGS: [u8; 8] = [5, 6, 7, 8, 9, 10, 11, 12];
/// x31 = buffer base, x30 = loop counter, x29 = indirect jump target, x1 = ra.
const BUF: &str = "x31";
pub const BUF_BYTES: u64 = 128;

const R32: &[&str] = &[
    "add", "sub", "sll", "slt", "sltu", "xor", "srl", "sra", "or", "and", "mul", "mulh",
    "mulhsu", "mulhu", "div", "divu", "rem", "remu",
];
const R64_ONLY: &[&str] = &[
    "addw", "subw", "sllw", "srlw", "sraw", "mulw", "divw", "divuw", "remw", "remuw",
];
const I_OPS: &[&str] = &["addi", "slti", "sltiu", "xori", "ori", "andi"];
const BRANCHES: &[&str] = &["beq", "bne", "blt", "bge", "bltu", "bgeu"];

pub struct Generator<'a> {
    rng: &'a mut Rng,
    xlen: u32,
    labels: usize,
    /// Allow faulting accesses (misaligned / out of bounds) occasionally.
    pub allow_faults: bool,
}

impl<'a> Generator<'a> {
    pub fn new(rng: &'a mut Rng, xlen: u32) -> Self {
        Self { rng, xlen, labels: 0, allow_faults: false }
    }

    fn label(&mut self) -> String {
        self.labels += 1;
        format!("G{}", self.labels)
    }

    fn reg(&mut self) -> String {
        format!("x{}", self.rng.pick(&VALUE_REGS))
    }

    /// Destination: occasionally x0 (writes must be discarded).
    fn rd(&mut self) -> String {
        if self.rng.chance(4) {
            "x0".to_string()
        } else {
            self.reg()
        }
    }

    fn constant(&mut self) -> String {
        let v = self.rng.next_u64();
        let interesting: [u64; 8] = [0, 1, u64::MAX, 0x8000_0000, 0x7fff_ffff, 0xffff_ffff, 1 << 63, (1 << 63) - 1];
        let v = if self.rng.chance(30) { *self.rng.pick(&interesting) } else { v };
        if self.xlen == 32 {
            format!("{}", v as u32 as i32)
        } else {
            format!("{}", v as i64)
        }
    }

    fn alu(&mut self) -> String {
        let rd = self.rd();
        match self.rng.below(10) {
            0..=3 => {
                let op = if self.xlen == 64 && self.rng.chance(35) {
                    *self.rng.pick(R64_ONLY)
                } else {
                    *self.rng.pick(R32)
                };
                format!("{op} {rd}, {}, {}", self.reg(), self.reg())
            }
            4 | 5 => {
                let op = if self.xlen == 64 && self.rng.chance(20) { "addiw" } else { *self.rng.pick(I_OPS) };
                format!("{op} {rd}, {}, {}", self.reg(), self.rng.below(4096) as i64 - 2048)
            }
            6 => {
                let (op, max) = match (self.xlen, self.rng.below(6)) {
                    (64, 3) => ("slliw", 32),
                    (64, 4) => ("srliw", 32),
                    (64, 5) => ("sraiw", 32),
                    (x, n) => (["slli", "srli", "srai"][(n % 3) as usize], x as u64),
                };
                format!("{op} {rd}, {}, {}", self.reg(), self.rng.below(max))
            }
            7 => format!("li {rd}, {}", self.constant()),
            8 => format!("lui {rd}, {}", self.rng.below(1 << 20)),
            _ => format!("auipc {rd}, {}", self.rng.below(1 << 20)),
        }
    }

    fn memory(&mut self) -> String {
        let store = self.rng.chance(45);
        let widths: &[(&str, &str, u64)] = if self.xlen == 64 {
            &[("sd", "ld", 8), ("sw", "lw", 4), ("sw", "lwu", 4), ("sh", "lh", 2), ("sh", "lhu", 2), ("sb", "lb", 1), ("sb", "lbu", 1)]
        } else {
            &[("sw", "lw", 4), ("sh", "lh", 2), ("sh", "lhu", 2), ("sb", "lb", 1), ("sb", "lbu", 1)]
        };
        let (st, ld, w) = *self.rng.pick(widths);
        let mut offset = self.rng.below(BUF_BYTES / w) * w;
        let mut base = BUF.to_string();
        if self.allow_faults && self.rng.chance(3) {
            match self.rng.below(2) {
                0 if w > 1 => offset += 1, // misaligned
                _ => base = "x0".to_string(), // address 0: outside data and stack
            }
        } else if self.rng.chance(15) {
            let slot = self.rng.below(16) * 8;
            let off = -(slot as i64) - 8;
            let off = off - off.rem_euclid(w as i64);
            return if store {
                format!("{st} {}, {off}(sp)", self.reg())
            } else {
                format!("{ld} {}, {off}(sp)", self.rd())
            };
        }
        if store {
            format!("{st} {}, {offset}({base})", self.reg())
        } else {
            format!("{ld} {}, {offset}({base})", self.rd())
        }
    }

    /// A straight-line item (one or more lines).
    fn simple(&mut self, out: &mut Vec<String>) {
        match self.rng.below(10) {
            0..=5 => {
                let l = self.alu();
                out.push(l);
            }
            6..=8 => {
                let l = self.memory();
                out.push(l);
            }
            _ => {
                // load-use: load then immediately consume
                let l = self.memory();
                out.push(l.replace("sd ", "ld ").replace("sw ", "lw ").replace("sh ", "lh ").replace("sb ", "lb ").replace(", ", ", ").to_string());
                let rd = self.rd();
                let a = self.reg();
                out.push(format!("add {rd}, {a}, {a}"));
            }
        }
    }

    fn block(&mut self, out: &mut Vec<String>, depth: usize, leaf_calls: &[String]) {
        let items = 3 + self.rng.below(8);
        for _ in 0..items {
            match self.rng.below(12) {
                0..=6 => self.simple(out),
                7 | 8 => {
                    // forward branch over a few items
                    let target = self.label();
                    let op = *self.rng.pick(BRANCHES);
                    out.push(format!("{op} {}, {}, {target}", self.reg(), self.reg()));
                    for _ in 0..1 + self.rng.below(3) {
                        self.simple(out);
                    }
                    out.push(format!("{target}:"));
                }
                9 if depth == 0 => {
                    // counted loop (x30 is reserved for the counter)
                    let top = self.label();
                    out.push(format!("li x30, {}", 1 + self.rng.below(5)));
                    out.push(format!("{top}:"));
                    for _ in 0..1 + self.rng.below(4) {
                        self.simple(out);
                    }
                    out.push("addi x30, x30, -1".to_string());
                    out.push(format!("bnez x30, {top}"));
                }
                10 if !leaf_calls.is_empty() => {
                    let f = self.rng.pick(leaf_calls).clone();
                    if self.rng.chance(50) {
                        out.push(format!("call {f}"));
                    } else {
                        out.push(format!("jal ra, {f}"));
                    }
                }
                _ => {
                    // indirect jump through jalr
                    let target = self.label();
                    out.push(format!("la x29, {target}"));
                    out.push("jalr x0, 0(x29)".to_string());
                    self.simple(out);
                    out.push(format!("{target}:"));
                }
            }
        }
    }

    /// A complete program ending in `ecall`.
    pub fn program(&mut self) -> String {
        let leaves: Vec<String> = (0..self.rng.below(3)).map(|i| format!("leaf{i}")).collect();
        let mut out = vec![
            ".data".to_string(),
            format!("buf: .space {BUF_BYTES}"),
            ".text".to_string(),
            "la x31, buf".to_string(),
        ];
        for r in VALUE_REGS {
            let c = self.constant();
            out.push(format!("li x{r}, {c}"));
        }
        self.block(&mut out, 0, &leaves);
        self.block(&mut out, 0, &leaves);
        out.push("ecall".to_string());
        for leaf in &leaves {
            out.push(format!("{leaf}:"));
            self.block(&mut out, 1, &[]);
            out.push("ret".to_string());
        }
        out.join("\n") + "\n"
    }
}

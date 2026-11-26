//! Built-in sample programs. The first four are the SAME programs the
//! browser simulator ships (see the samples embedded in cli/web/index.html);
//! keep the two lists in sync when one of them changes. The last one is an
//! RV64 program for the terminal tools (`xlen: 64`).

pub struct Sample {
    pub name: &'static str,
    pub file: &'static str,
    pub source: &'static str,
    /// Register width the sample is written for: 32 or 64.
    pub xlen: u32,
}

pub const SAMPLES: &[Sample] = &[
    Sample {
        name: "Add + forwarding",
        file: "add-forward.s",
        source: "# each add uses the previous result (watch the forwarded values travel)
addi x1, x0, 5
addi x2, x1, 3
add  x3, x2, x1
",
        xlen: 32,
    },
    Sample {
        name: "Load-use stall",
        file: "load-use.s",
        source: "# the add needs x1 one cycle before the load can deliver it (one stall)
.data
value:  .word 41

.text
addi x4, x0, 1
la   x2, value
lw   x1, 0(x2)
add  x3, x1, x4
",
        xlen: 32,
    },
    Sample {
        name: "Branch prediction",
        file: "branch-loop.s",
        source: "# a 3x loop: the predictor misses cold, learns, then misses the exit
addi x1, x0, 3
addi x2, x0, 0
loop:
addi x2, x2, 1
addi x1, x1, -1
bne  x1, x0, loop
addi x3, x0, 99
",
        xlen: 32,
    },
    Sample {
        name: "Array sum",
        file: "array-sum.s",
        source: "# sum four words from memory into a0
.data
readings: .word 12, 7, 31, 4

.text
la   t0, readings
addi t1, x0, 4
addi t2, x0, 0
loop:
lw   t3, 0(t0)
add  t2, t2, t3
addi t0, t0, 4
addi t1, t1, -1
bne  t1, x0, loop
mv   a0, t2
ecall
",
        xlen: 32,
    },
    RV64_SAMPLE,
];

/// The RV64 sample: 64-bit values, and what the word instructions (addw)
/// do to them.
pub const RV64_SAMPLE: Sample = Sample {
    name: "64-bit values",
    file: "wide-values.s",
    source: "# RV64 registers hold 64 bits; build 0x0000_0100_0000_0005
addi x5, x0, 1     # x5 = 1
slli x5, x5, 40    # x5 = 1 << 40
addi x6, x5, 5     # x6 = 0x0000_0100_0000_0005
addw x7, x6, x0    # addw keeps the low 32 bits: 5
addi x10, x0, -1   # -1 sets all 64 bits
",
    xlen: 64,
};

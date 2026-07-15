//! Built-in sample programs — the SAME four programs the browser simulator
//! ships (frontend/src/pipeline-sim.ts SAMPLES). Keep the two lists in sync
//! when a sample changes.

pub struct Sample {
    pub name: &'static str,
    pub file: &'static str,
    pub source: &'static str,
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
    },
];

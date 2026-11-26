# riscvsim

Part of StudyRISC-V, the RISC-V course and simulator at [studyriscv.com](https://studyriscv.com).

`riscvsim` is a RISC-V simulator for your terminal: it runs RV32IM and
RV64IM programs on a 5-stage pipeline and explains every cycle in plain
English.

## The first ten seconds

```sh
riscvsim demo
```

This is the whole output when it is piped (`riscvsim demo | cat`):

```text
  riscvsim › demo 1 · Your first instructions
  Watch five instructions move through the five stages.

   1  # Each line is one instruction. Every cycle, each one
   2  # moves one stage to the right: IF, ID, EX, MEM, WB.
   3  # Registers are x0 to x31 (x0 is always 0). Each also has
   4  # an ABI name, such as sp for x2; these lessons use x names.
   5  addi x5, x0, 6     # x5 = 0 + 6
   6  addi x6, x0, 7     # x6 = 0 + 7
   7  addi x7, x0, 100   # x7 = 100
   8  addi x10, x0, 1    # x10 = 1
   9  add  x11, x5, x6   # x11 = 6 + 7 = 13

  cycle 1
    IF addi x5, x0, 6  ID ·  EX ·  MEM ·  WB ·
    › The first instruction, addi, is fetched from memory.

  cycle 2
    IF addi x6, x0, 7  ID addi x5, x0, 6  EX ·  MEM ·  WB ·
    › addi x5 is decoded and reads its source registers.

  cycle 3
    IF addi x7, x0, 100  ID addi x6, x0, 7  EX addi x5, x0, 6  MEM ·  WB ·
    › addi x5 is computing in the ALU; everything else moves one stage on.

  cycle 4
    IF addi x10,x0,1  ID addi x7,x0…  EX addi x6,x0,7  MEM addi x5,x0,6  WB ·
    › addi x6 is computing in the ALU; everything else moves one stage on.

  cycle 5
    IF add x11,x5…  ID addi x10…  EX addi x7,x0…  MEM addi x6,x0…  WB addi x5…
    ✓ x5 = 6
    › addi finishes and writes x5 = 6.

  cycle 6
    IF ·  ID add x11,x5,x6  EX addi x10,x0,1  MEM addi x7,x0…  WB addi x6,x0,7
    ✓ x6 = 7
    › addi finishes and writes x6 = 7.

  cycle 7
    IF ·  ID ·  EX add x11, x5, x6  MEM addi x10, x0, 1  WB addi x7, x0, 100
    ✓ x7 = 100
    › addi finishes and writes x7 = 100.

  cycle 8
    IF ·  ID ·  EX ·  MEM add x11, x5, x6  WB addi x10, x0, 1
    ✓ x10 = 1
    › addi finishes and writes x10 = 1.

  cycle 9
    IF ·  ID ·  EX ·  MEM ·  WB add x11, x5, x6
    ✓ x11 = 13
    ✓ add writes x11 = 13, and the program is finished.

  ✓ 9 cycles · 5 instructions · CPI 1.80 · 0 stalls · 0 mispredictions
    Ends with x5 = 6 · x6 = 7 · x7 = 100 · x10 = 1 · x11 = 13
    No stalls: every instruction moved one stage each cycle.

  Next: riscvsim demo 2 (Waiting for memory)
```

On a terminal the lesson is interactive: `Enter` next cycle, `a` autoplay,
`+`/`-` speed, `b` back, `r` restart, `q` quit. When a lesson ends, `Enter`
starts the next one.

## Install

```sh
curl -fsSL https://studyriscv.com/install.sh | sh
```

The script downloads the archive for your system from the latest release
into `~/.local/bin` (set `RISCVSIM_INSTALL_DIR` to change it). Prebuilt
archives for macOS (arm64, x86_64) and Linux (x86_64), with a `SHA256SUMS`
file to check them against, are on the [releases page](../../releases). To
build and install from this repo instead:

```sh
cargo install --path cli
```

## Commands

| Command | Example |
| --- | --- |
| `demo` | `riscvsim demo 2` (lesson 2: why a load makes the next instruction wait) |
| `demo --list` | `riscvsim demo --list` (six short lessons, from first instructions to 64-bit values) |
| `run` | `riscvsim run prog.s --watch t0` (registers, cycles, CPI, stalls) |
| `run --expect` | `riscvsim run hw1.s --expect a0=55 --expect x6=0x2a` (check final registers; exit 0 if all match, 1 if not) |
| `tui` | `riscvsim tui prog.s` (step, rewind, breakpoints with `b`, help with `?`; `--xlen=64` for RV64) |
| `translate` | `riscvsim translate --from c --to rv32 prog.c --annotate` |
| `serve` | `riscvsim serve prog.s` (the browser simulator, on this computer; `--xlen=64` for RV64) |
| `doctor` | `riscvsim doctor` (check the install, PATH and updates) |
| `completions` | `source <(riscvsim completions bash)` (also `zsh`, `fish`; completes commands, flags and lesson names) |
| *(none)* | `riscvsim` (the interactive session; `/help` lists its commands) |

Every command has `--help` with examples. Colors follow your terminal theme
and turn off with `NO_COLOR=1`, `--no-color` or when output is piped.

## What it implements

**Instruction set.** RV32IM (the default) and RV64IM (`--xlen=64`): the
base integer instructions plus M (multiply and divide). RV64 adds `ld`,
`sd`, `lwu` and the word forms (`addw`, `addiw`, `subw`, `sllw`, `slliw`,
`srlw`, `srliw`, `sraw`, `sraiw`, `mulw`, `divw`, `divuw`, `remw`, `remuw`).
Pseudo-instructions: `nop`, `mv`, `li`, `la`, `not`, `neg`, `seqz`, `snez`,
`sltz`, `sgtz`, `beqz`, `bnez`, `bltz`, `bgez`, `blez`, `bgtz`, `bgt`,
`ble`, `bgtu`, `bleu`, `j`, `jr`, `ret`, `call`, `tail` (RV64 also `negw`
and `sext.w`).

**Not implemented.** The A (atomics), F and D (floating point) and C
(compressed) extensions, CSR instructions, privileged instructions and
modes, and interrupts. Using one is an assembly error. `fence` and
`fence.i` are accepted and do nothing.

**System calls.** There are none: when an `ecall` (or `ebreak`) reaches the
last stage, the program ends. A program also ends when it runs past its
last instruction. A misaligned or out-of-range load or store stops it with
an error.

**Pipeline.** Five stages: IF, ID, EX, MEM, WB. Results are forwarded from
the EX/MEM and MEM/WB pipeline registers into EX, so an instruction can use
the result of the one just before it without waiting. The one exception is
a load followed right away by an instruction that needs the loaded value:
that instruction waits 1 cycle (a load-use stall). Branches and jumps
resolve in EX; a wrong guess throws away the 2 instructions fetched behind
it, a 2-cycle penalty. The predictor is a 16-entry direct-mapped branch
target buffer with a 2-bit counter per entry; a branch not in it is guessed
not taken.

**Memory.** Code starts at `0x00000000` and data (`.data`) at `0x10000000`.
The stack pointer `x2` (`sp`) starts at `0x7ffffffc` on RV32 and
`0x7ffffff0` on RV64. A run stops after 1,000,000 cycles unless
`--limit N` says otherwise.

**Translation.** `riscvsim translate` compiles a documented subset of C,
C++ and Rust to RV32 or RV64 assembly, and lifts assembly back to C
pseudocode. `riscvsim translate --subset c|cpp|rust` lists exactly what
each one accepts.

## Web version

The same engine runs in the browser at [studyriscv.com](https://studyriscv.com/simulator/).
`riscvsim serve` shows that simulator locally: nothing is uploaded, and only
this computer can reach it.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 1 | a problem with the program or input (assembly or translation error, trap, step limit, unreadable file, busy port) |
| 2 | usage error (unknown command or option, missing argument) |
| 130 | stopped with Ctrl-C |

## Build from source

```sh
cd sim-engine && cargo build --release && cargo test   # the engine
cd cli && cargo build --release && cargo test          # riscvsim, in cli/target/release
```

## How it fits together

- **One engine:** `sim-engine` assembles and runs RV32IM and RV64IM programs on a 5-stage pipeline.
- **A terminal tool:** `cli` links the engine directly and builds the `riscvsim` binary.
- **A browser version:** `rust-core` compiles the engine to WebAssembly, so the web simulator gives identical results, cycle for cycle.

## Folders

- [`sim-engine/`](sim-engine): the simulator core (assemblers, pipelines, forwarding, stalls, branch prediction), pure Rust.
- [`cli/`](cli): the `riscvsim` command and its embedded browser UI.
- [`rust-core/`](rust-core): WebAssembly bindings that expose the engine to the browser.

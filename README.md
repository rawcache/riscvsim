# StudyRISC-V

`riscvsim` is a RISC-V simulator for your terminal: it runs RV32IM and
RV64IM programs on a real 5-stage pipeline and explains every cycle in plain
English.

## The first ten seconds

```sh
riscvsim demo
```

```text
  riscvsim › demo 1 · Add + forwarding

   1  # each add uses the previous result (watch the forwarded values travel)
   2  addi x1, x0, 5
   3  addi x2, x1, 3
   4  add  x3, x2, x1

  cycle 1
    IF addi x1, x0, 5  ID ·  EX ·  MEM ·  WB ·
    › The first instruction, addi, is fetched from memory.

  cycle 2
    IF addi x2, x1, 3  ID addi x1, x0, 5  EX ·  MEM ·  WB ·
    › addi is decoded and reads its source registers.

  cycle 3
    IF add x3, x2, x1  ID addi x2, x1, 3  EX addi x1, x0, 5  MEM ·  WB ·
    › addi is computing in the ALU; everything else moves one stage on.

  cycle 4
    IF ·  ID add x3, x2, x1  EX addi x2, x1, 3  MEM addi x1, x0, 5  WB ·
    › addi needs x1 from addi, so it is forwarded from the EX/MEM latch and
      nobody waits.
```

...one block per cycle, then the summary:

```text
  ✓ 7 cycles · 3 instructions · CPI 2.33 · 0 stalls · 0 mispredictions
    No stalls: forwarding kept every instruction moving.

  Next: riscvsim demo 2, riscvsim tui, riscvsim serve
```

On a terminal the tour is interactive: `Enter` next cycle, `a` autoplay,
`+`/`-` speed, `b` back, `r` restart, `q` quit.

## Install

Prebuilt archives with checksums are on the [releases page](../../releases).
To build and install from this repo instead:

```sh
cargo install --path cli
```

## Commands

| Command | Example |
| --- | --- |
| `demo` | `riscvsim demo 2` (lesson 2: why a load makes the next instruction wait) |
| `demo --list` | `riscvsim demo --list` (six short lessons, from first instructions to 64-bit values) |
| `run` | `riscvsim run prog.s --watch t0` (registers, cycles, CPI, stalls) |
| `tui` | `riscvsim tui prog.s` (step, rewind, breakpoints with `b`, help with `?`; `--xlen=64` for RV64) |
| `translate` | `riscvsim translate --from c --to rv32 prog.c --annotate` |
| `serve` | `riscvsim serve prog.s` (the browser simulator, on this computer) |
| `doctor` | `riscvsim doctor` (check the install, PATH and updates) |
| `completions` | `source <(riscvsim completions bash)` (also `zsh`, `fish`; completes commands, flags and lesson names) |
| *(none)* | `riscvsim` (the interactive session; `/help` lists its commands) |

Every command has `--help` with examples. Colors follow your terminal theme
and turn off with `NO_COLOR=1`, `--no-color` or when output is piped.

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

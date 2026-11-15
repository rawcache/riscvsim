# StudyRISC-V

RISC-V (RV32IM) 5-stage pipeline simulator — in the browser at
[studyriscv.com/simulator](https://studyriscv.com/simulator/), and in your
terminal as the `riscvsim` CLI.

Watch real assembly move through Fetch → Decode → Execute → Memory →
Writeback cycle by cycle: forwarding paths light up as they trigger,
load-use hazards insert visible stall bubbles, and a 2-bit branch predictor
learns your loops (and gets flushed when it guesses wrong).

## Install the CLI

**macOS / Linux**

```sh
curl -fsSL https://studyriscv.com/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://studyriscv.com/install.ps1 | iex
```

**Homebrew**

```sh
brew tap rawcache/riscvsim
brew install riscvsim
```

If no prebuilt binary is published for your platform yet, the scripts fall
back to building from this repo with `cargo` (requires
[Rust](https://rustup.rs)).

## Use it

```sh
riscvsim run program.s        # assemble + run, print final registers and stats
riscvsim run program.s -v     # full instruction-by-instruction trace
riscvsim serve program.s      # step through it in the browser UI, cycle by cycle
riscvsim --help               # usage, examples, exit codes
```

`riscvsim serve` starts a local server (default `http://localhost:4200`)
hosting the same simulator UI as studyriscv.com, pointed at the live
in-memory session — step, rewind, and inspect registers and memory. The
session ends when the process exits.

A minimal first program:

```asm
addi x1, x0, 5      # x1 = 5
addi x2, x1, 3      # x2 = 8   (forwarded from EX/MEM)
add  x3, x2, x1     # x3 = 13  (both operands forwarded)
```

```
$ riscvsim run add.s
Loading add.s...
Assembling program...
✓ assembled 3 instructions
Running simulator...

x1: 0 -> 5
x2: 0 -> 8
x3: 0 -> 13

3 instructions, 7 cycles, 0 stalls, 0 mispredictions
✓ program complete
```

## What's in this repo

| Directory | What it is |
|---|---|
| `sim-engine/` | The simulator core: RV32IM two-pass assembler + classic 5-stage pipeline (explicit pipeline registers, EX/MEM & MEM/WB forwarding with correct priority, precisely-scoped load-use stalls, 2-bit predictor with BTB, branches resolved in EX with a 2-cycle mispredict penalty). Pure Rust, no platform deps. |
| `cli/` | The `riscvsim` binary: `run` and `serve`, plus the embedded browser UI (`cli/web/`, generated from the frontend sources by `cli/build-web.mjs`). |
| `rust-core/` | WASM bindings that compile the same engine for the browser. |
| `frontend/` | The browser simulator. |
| `Formula/` | Homebrew formula for the tap `rawcache/homebrew-riscvsim`. |

One engine, two surfaces: the browser consumes `sim-engine` through WASM,
the CLI links it directly — identical results, cycle for cycle.

The hosted product's backend (accounts, saved programs, hosting config) is
not in this repo; the simulator engine and CLI here are the complete,
buildable open-source surface, in the same way most products split an open
CLI from a closed platform.

## Build from source

```sh
cd cli && cargo build --release     # -> cli/target/release/riscvsim
cd sim-engine && cargo test         # engine test suite
```

## ISA coverage

RV32I base + M extension (`mul`/`div`/`rem` families, spec-correct
non-trapping division by zero), and the common pseudo-instructions
(`li`, `la`, `mv`, `nop`, `j`, `jr`, `ret`, `call`, `beqz`/`bnez`/…,
`not`, `neg`, `seqz`/`snez`). Sections and data directives: `.text`,
`.data`, `.word`, `.half`, `.byte`, `.asciz`, `.space`, `.align`.

Memory map: text at `0x00000000`, data at `0x10000000`, stack pointer
initialized to `0x7FFFFFFC`.

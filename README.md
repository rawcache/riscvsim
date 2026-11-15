# StudyRISC-V

RISC-V (RV32IM and RV64IM) 5-stage pipeline simulator, in the browser at
[studyriscv.com/simulator](https://studyriscv.com/simulator/) and in your
terminal as the `riscvsim` CLI.

Watch real assembly move through Fetch, Decode, Execute, Memory and
Writeback cycle by cycle: forwarding paths light up as they trigger,
load-use hazards insert visible stall bubbles, and a 2-bit branch predictor
learns your loops (and gets flushed when it guesses wrong).

## Install the CLI

### Quick start (macOS / Linux)

```sh
curl -fsSL https://studyriscv.com/install.sh | sh
```

The script downloads the prebuilt release binary for your platform and
installs it to `~/.local/bin/riscvsim` (override with `RISCVSIM_INSTALL_DIR`).
If that directory is not on your `PATH`, it prints the line to add to your
shell config:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Scripted / CI installs:

```sh
curl -fsSL https://studyriscv.com/install.sh | sh -s -- --yes
```

### Homebrew

```sh
brew tap rawcache/riscvsim && brew install riscvsim
```

Quick start and Homebrew install the same binary from the same GitHub
release assets. If no prebuilt binary exists for your platform, the quick
start script falls back to building from source with `cargo` (requires
[Rust](https://rustup.rs)).

### Windows

```powershell
irm https://studyriscv.com/install.ps1 | iex
```

Windows currently builds from source: no Windows binary is published yet,
so the script needs `cargo` and `git`. The Windows installer is not
release-ready.

### PATH shadowing

If you install with both Homebrew and the quick start script, two copies of
`riscvsim` end up on your `PATH` and whichever directory comes first wins.
The quick start script warns when Homebrew already manages `riscvsim`.
Run `riscvsim doctor` to list every copy on your `PATH`, which one your shell
selects, how each was installed, and how to update or remove it.

## Use it

```sh
riscvsim                          # interactive session (slash commands below)
riscvsim run program.s            # assemble + run, print final registers and stats
riscvsim run program.s -v         # full instruction-by-instruction trace
riscvsim run wide.s --xlen=64     # run an RV64IM program
riscvsim tui program.s            # step through it in the terminal
riscvsim serve program.s          # step through it in the browser UI
riscvsim doctor                   # versions, PATH copies, update instructions
riscvsim --help                   # usage, examples, exit codes
```

### Interactive session

Run `riscvsim` with no arguments to open the interactive session, then
drive it with slash commands:

| Command | What it does |
|---|---|
| `/help` | list every command |
| `/doctor` | inspect versions, PATH copies and update instructions |
| `/run <file>` | load and run an assembly file |
| `/demo [n]` | load a built-in sample program and run it |
| `/serve [--port N]` | open the loaded program in the browser UI |
| `/reset` | reset the loaded program |
| `/version` | show installed and latest versions |
| `/examples` | show the sample-program walkthrough |
| `/exit`, `/quit` | leave the session |

Anything not starting with `/` is assembled and run as RISC-V source.

### Browser UI

`riscvsim serve` starts a local server (default `http://localhost:4200`)
hosting the simulator UI, pointed at the live in-memory RV32IM session:
step, rewind, and inspect registers and memory. The session ends when the
process exits.

### Update check

Except for `doctor` and the interactive session (which check on their own),
each command checks for a newer release in the background with a 300 ms
timeout and caches the result for one hour. Failures are silent and never
change the exit code; when an update exists, a one-line notice is printed to
stderr. Set `RISCVSIM_NO_UPDATE_CHECK=1` to disable it.

### A first program

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
| `sim-engine/` | The simulator core: RV32IM and RV64IM two-pass assemblers and classic 5-stage pipelines (explicit pipeline registers, EX/MEM and MEM/WB forwarding, load-use stalls, 2-bit predictor with BTB, branches resolved in EX), RV32/RV64 conversion, and source translation. Pure Rust. |
| `cli/` | The `riscvsim` binary: `run`, `tui`, `serve`, `doctor` and the interactive session. |
| `rust-core/` | WASM bindings that compile the same engine for the browser. |
| `Formula/` | Homebrew formula for the tap `rawcache/homebrew-riscvsim`. |

`cli/web/index.html` is a generated asset embedded into the binary for
`riscvsim serve`; do not edit it by hand.

One engine, two surfaces: the browser consumes `sim-engine` through WASM,
the CLI links it directly, with identical results cycle for cycle.

## Translation

`sim-engine` (and the WASM bindings in `rust-core`) translate between
languages for documented subsets:

- C, C++ and Rust to RV32IM or RV64IM assembly
- RV32IM or RV64IM assembly to C
- C, C++ and Rust to each other
- RV32IM to RV64IM and RV64IM to RV32IM

Each source language has a published supported and unsupported subset
(`C_SUBSET_SUPPORTED`, `C_SUBSET_UNSUPPORTED` and the C++ and Rust
equivalents). Input outside the subset is rejected with an error (with a source
line number where one applies) rather than translated approximately. Translation is a
library and browser feature; the CLI does not expose it.

## Build from source

```sh
cd cli && cargo build --release     # -> cli/target/release/riscvsim
cd sim-engine && cargo test         # engine test suite
cd cli && cargo test                # CLI tests
cd rust-core && cargo test          # WASM binding tests (native)
```

## ISA coverage

RV32I and RV64I base + M extension (`mul`/`div`/`rem` families, spec-correct
non-trapping division by zero), and the common pseudo-instructions
(`li`, `la`, `mv`, `nop`, `j`, `jr`, `ret`, `call`, `beqz`/`bnez` and
friends, `not`, `neg`, `seqz`/`snez`). Sections and data directives:
`.text`, `.data`, `.word`, `.half`, `.byte`, `.asciz`, `.space`, `.align`.
RV64 runs through `riscvsim run --xlen=64`; `tui` and `serve` are RV32IM.

Memory map: text at `0x00000000`, data at `0x10000000`, stack pointer
initialized to `0x7FFFFFFC` (RV32) or `0x7FFFFFF0` (RV64).

## Releases

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds
`riscvsim` for macOS and Linux on arm64 and x86_64 and attaches the tarballs
the install script and Homebrew formula download. A tag that already has a
published release is rejected, and existing assets are never overwritten.

## License

[MIT](LICENSE)

# StudyRISC-V Changelog

This changelog covers the open-source simulator engine (`sim-engine/`), the
WASM bindings (`rust-core/`) and the `riscvsim` CLI (`cli/`).

## Unreleased

## 0.2.0 - 2026-11-15
### Simulator core
- RV64IM support alongside RV32IM; RV32IM remains the default
- `riscvsim run <file.s> --xlen=64` runs RV64IM programs
- RV64 is run-only: `--xlen=64` with `tui`, `serve` or `run --interactive` is
  a usage error
- RV64IM assembler and 5-stage pipeline (`assembler64`, `pipeline64`)
- RV32IM to RV64IM and RV64IM to RV32IM source conversion (`xlen_convert`)

### Translation
- C, C++ and Rust subset translation to RV32IM/RV64IM assembly and between
  subsets, plus assembly to C pseudocode
- Exposed through the WASM API only; the CLI has no translate subcommand

### WASM bindings
- Pipeline and translation bindings (`pipeline_api`, `translate_api`)

### CLI
- `riscvsim doctor` reports the active executable and version, install method,
  every PATH copy and which one shadows the others, the latest release, and
  per-method update instructions
- REPL slash commands: /help, /doctor, /run, /demo, /serve, /reset, /version,
  /examples, /exit (also /quit)
- Fail-open update check: 300 ms timeout, one-hour cache, silent on failure;
  set `RISCVSIM_NO_UPDATE_CHECK` to disable it

### Installers
- Non-interactive install with `--yes`/`-y` or `RISCVSIM_INSTALL_YES=1`
  (`-Yes` in `install.ps1`)
- `install.sh` warns when Homebrew manages riscvsim
- Both installers verify the installed binary runs before reporting success

### Release workflow
- Refuses to re-release an existing tag: a `preflight` job runs
  `gh release view` for the pushed tag and fails if a release already exists,
  and every build job depends on it; asset upload also sets
  `overwrite_files: false` so a rerun cannot replace published archives

## Session 4 - March 2026
- No engine or CLI changes in this session.

## Session 3 - March 2026
### Simulator core
- Rust/WASM contract fix: step delta now emits typed reg/mem/pc/trap effects
- Data directives: .data, .text, .word, .byte, .half, .ascii, .asciz, .space, .align
- la pseudo-instruction
- Fixed memory map: text=0x00000000, data=0x10000000, stack=0x7FFFFFFC
- call pseudo fixed: two-instruction lowering with pass-1 sizing
- imm12 validation across all I-type and S-type paths

### Regression suite
- Covers: pseudos, labels, immediates, branches, memory, ALU, M-ext,
  traps, data directives

## Session 2 - March 2026
### Assembler
- Two-pass assembler with label resolution
- Pseudo-instruction expansion (li, mv, nop, j, ret, call)
- Symbol directives (#sym)
- ABI register name support

## Session 1 - March 2026
### Core
- Rust CPU interpreter for RV32IM subset
- wasm-bindgen exports

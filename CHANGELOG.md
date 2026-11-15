# StudyRISC-V Changelog

This changelog covers the open-source simulator engine (`sim-engine/`), the
WASM bindings (`rust-core/`) and the `riscvsim` CLI (`cli/`).

## Unreleased
### Simulator core
- RV64IM assembler and 5-stage pipeline (`assembler64`, `pipeline64`)
- RV32IM to RV64IM and RV64IM to RV32IM source conversion (`xlen_convert`)
- Translation between C, C++, Rust and RISC-V assembly for documented
  language subsets, with explicit rejection of unsupported constructs

### CLI
- `riscvsim run <file> --xlen=64` runs RV64IM programs
- Interactive terminal session (`riscvsim` with no arguments, or `riscvsim tui`)
  with slash commands: /help, /doctor, /run, /demo, /serve, /reset, /version,
  /examples, /exit, /quit
- `riscvsim doctor` reports the active binary, every PATH-visible copy, its
  install method (Homebrew, curl quick start, source build) and PATH shadowing
- Background update check: 300 ms timeout, one-hour cache, silent on failure,
  disabled with `RISCVSIM_NO_UPDATE_CHECK`

### WASM bindings
- Pipeline and translation bindings (`pipeline_api`, `translate_api`)

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

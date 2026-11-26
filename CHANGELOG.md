# Changelog

All notable changes to riscvsim and the StudyRISC-V simulator. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

On a tag `vX.Y.Z`, `.github/workflows/release.yml` checks that no release
exists for the tag and that the tag matches the CLI version, creates a
draft release, builds `riscvsim` for macOS (arm64, x86_64) and Linux
(x86_64), uploads the archives, a `SHA256SUMS` file and a checksum-verifying
`install.sh`, then publishes the release. It fails instead of replacing an
existing release or asset.

## [Unreleased]

### Added
- `riscvsim demo`: a six-lesson course on the pipeline (first instructions,
  waiting for memory, forwarding, wrong branch guesses, loops, 64-bit
  values). Interactive on a terminal, plain text when piped; `--list` shows
  the lessons.
- `riscvsim translate --from LANG --to LANG`, with `--annotate` (each C or
  C++ line above the instructions it became) and `--subset c|cpp|rust`
  (exactly what each translator accepts).
- `tui --xlen=64` and `run -i --xlen=64` step through RV64 programs; RV64
  samples in the sample menu.
- `riscvsim serve` works without a file or an account, binds to 127.0.0.1
  only and picks a free port when the default is busy.
- `riscvsim completions bash|zsh|fish`; `run --watch REG`; `run --json`;
  `run --limit N`.
- The browser simulator runs RV64IM programs (an RV32 / RV64 switch; a
  saved program whose first line is `# xlen=64` opens in RV64 mode).
- C and C++ translation: pointers, globals, strings, block scopes, `switch`,
  `void` functions, pointer casts, enums, structs and unions; C and
  assembly can call each other. The supported subset is listed by
  `riscvsim translate --subset c` and in the docs.
- `riscvsim run FILE --expect REG=VALUE` (repeatable; decimal, negative or
  hex; `x3` or `a0`): checks the final registers, prints one line per check
  and exits 0 when all match, 1 when any does not. With `--json` the result
  gains an `expect` array.
- `riscvsim serve --xlen=64`, and the `tui` `/serve` command for RV64
  programs: the page receives the program with a `# xlen=64` first line (the
  file itself is not changed). A file that starts with that line is RV64 too.
- In `riscvsim demo`, Enter at the end of a lesson starts the next one on a
  terminal.
- `.github/workflows/ci.yml` runs the engine, CLI and WebAssembly crate
  tests on Ubuntu and macOS for every push and pull request.

### Changed
- `--version` and `--help` say the translators handle a documented subset
  of C, C++ and Rust.
- Exit codes: 0 ok, 1 a problem with the program or input (assembly and
  translation errors included; they used to exit 3), 2 usage error, 130
  Ctrl-C.
- Errors show `file:line:col`, the source line, a caret and a did-you-mean;
  unknown flags are errors instead of being ignored.
- Colors and symbols follow one rule everywhere: `--no-color`, a non-empty
  `NO_COLOR` or `TERM=dumb` turn color off; ASCII symbols when the locale is
  not UTF-8.
- The update check no longer delays startup; its notice comes from a cache.
- Lessons use only `x` register names and plain scratch registers (x5 to
  x7, x10, x11); lesson 1 mentions ABI names, lesson 2 explains `lui`. The
  `tui` register pane is labelled `x0` to `x31` to match.
- Explanations name two in-flight instructions with the same mnemonic by
  their first operand ("addi x6 needs x5 from addi x5"), say "pipeline
  register" instead of "latch", and define forwarding, pipeline registers,
  stalls and flushes the first time a lesson uses them.
- An RV64-only instruction in an RV32 run says to add `--xlen=64`.
- The release workflow checks that no release exists for the tag before it
  builds, never replaces a release or an asset, and grants write access only
  to the jobs that write to the release.

### Removed
- The "do you trust this folder" prompt before `tui` opened a file, and the
  `trusted` file it wrote to the config folder. It protected nothing: a
  program only ever runs inside the simulator, and the file was already
  read before the prompt appeared.

### Fixed
- `tui` follows `--no-color`, `TERM=dumb` and an empty `NO_COLOR` like
  every other command (it used to read `NO_COLOR` on its own).
- The unknown-command error lists every command, `completions` included.
- RV64 `%lo(symbol)` now sign-extends, so `lui` + `addi` build the right
  address when the low 12 bits are 0x800 or more.
- No input makes the assemblers, pipelines or translators panic or hang;
  each documented limit (source size, nesting, labels, instructions, data,
  cycles) ends with an error that names it.

## [0.2.0] - 2026-11-14

### Added
- The `riscvsim` command: `run` (RV32, or RV64 with `--xlen=64`), `tui`
  (RV32), `serve` (the browser simulator on localhost) and `doctor`.
- Translators in the engine and the browser: a subset of C, C++ and Rust to
  RV32 or RV64 assembly and between the three, assembly to C pseudocode,
  and RV32 to RV64 conversion.

## [0.1.0]

### Added
- The browser simulator: an RV32IM assembler (labels, pseudo-instructions,
  data directives) and a 5-stage pipeline with forwarding, load-use stalls
  and branch prediction, compiled to WebAssembly.
- Register, memory, call-stack and effect views; saved programs; shareable
  links.

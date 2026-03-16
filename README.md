# RISC-V Simulator

Browser-based RISC-V simulator for learning, demos, and lightweight instruction-set experimentation.

This project assembles a focused RV32 subset in TypeScript, encodes it into machine code, executes it in a Rust WebAssembly runtime, and renders register, memory, control-flow, and pseudo-C views in the browser. Local development is frontend-only. No Java or Amplify backend is required.

## Highlights

- Rust/WASM execution in the browser
- Step, run, and step-back debugging flow
- Register diffs, memory write tracking, and PC tracing
- Inline disassembly and C-like translation for each program
- Built-in sample programs for loops, memory access, function calls, arithmetic, and `ecall`
- Static production build with Vite

## Stack

- Frontend: Vite, TypeScript
- Runtime: Rust, `wasm-bindgen`, `wasm-pack`
- Build: `rolldown-vite`, `vite-plugin-wasm`, `vite-plugin-top-level-await`

## Architecture

1. [`frontend/src/asm.ts`](frontend/src/asm.ts) parses source text, resolves labels and symbols, and expands pseudos.
2. [`frontend/src/wasm-runtime.ts`](frontend/src/wasm-runtime.ts) encodes parsed instructions into RV32 machine code and loads the generated WASM module.
3. [`rust-core/src/lib.rs`](rust-core/src/lib.rs) executes the program and returns compact state deltas.
4. [`frontend/src/main.ts`](frontend/src/main.ts) renders program state, effects, memory windows, and sample programs in the UI.

## Supported ISA Subset

Arithmetic and compare:
- `addi`, `add`, `sub`
- `slt`, `sltu`, `slti`, `sltiu`
- `mul`, `mulh`, `mulhsu`, `mulhu`
- `div`, `divu`, `rem`, `remu`

Bitwise and shifts:
- `andi`, `ori`, `xori`, `and`, `or`, `xor`
- `slli`, `srli`, `srai`, `sll`, `srl`, `sra`

Control flow:
- `lui`, `auipc`
- `jal`, `jalr`
- `beq`, `bne`, `blt`, `bge`, `bltu`, `bgeu`
- `ecall`

Loads and stores:
- `lb`, `lbu`, `lh`, `lhu`, `lw`
- `sb`, `sh`, `sw`

Pseudoinstructions:
- `li`, `mv`, `nop`, `j`, `call`, `ret`

Assembler features:
- labels
- `#sym name=value` symbol definitions
- ABI register aliases such as `a0`, `sp`, `ra`
- `#` and `//` comments

## Local Development

### Prerequisites

- Node.js 18+
- npm
- Rust toolchain
- `wasm32-unknown-unknown` target
- `wasm-pack`

If you do not already have the Rust target and `wasm-pack` installed:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
```

### Start the app

Option 1:

```bash
./run.sh
```

Option 2:

```bash
cd frontend
npm ci
npm run dev
```

What happens:

- `npm run dev` triggers `predev`
- `predev` runs `npm run wasm:build`
- `wasm:build` runs `wasm-pack` in [`rust-core/`](rust-core) and writes the generated package to `frontend/src/pkg`
- Vite starts the dev server after the WASM package is generated

The default dev server URL is:

```text
http://localhost:5173
```

## Production Build

```bash
cd frontend
npm run build
```

This generates:

- `frontend/src/pkg/`: generated JS/WASM bridge from `wasm-pack`
- `frontend/dist/`: production-ready static site from Vite

## Project Structure

```text
.
├── frontend/      # Vite + TypeScript UI
├── rust-core/     # Rust simulator compiled to WebAssembly
├── run.sh         # Root-level local dev launcher
├── amplify.yml    # Static hosting build recipe
└── README.md
```

Key files:

- [`frontend/src/main.ts`](frontend/src/main.ts): UI orchestration and sample programs
- [`frontend/src/disasm.ts`](frontend/src/disasm.ts): instruction rendering
- [`frontend/src/memory.ts`](frontend/src/memory.ts): memory window and write visualization
- [`frontend/src/types.ts`](frontend/src/types.ts): shared frontend runtime types
- [`rust-core/src/lib.rs`](rust-core/src/lib.rs): simulator core

## Built-In Sample Programs

The UI includes sample programs for:

- array summation
- string length
- memory copy
- function calls with `jal` and `jalr`
- temperature conversion with multiply and divide
- XOR checksum
- `ecall`

## Deployment Notes

- [`amplify.yml`](amplify.yml) builds the Rust WASM package first, then runs the frontend production build.
- The app is designed to be deployed as a static site once `frontend/dist` has been generated.

## Troubleshooting

If the app fails to initialize the WASM runtime:

- confirm `wasm-pack --version` works
- confirm `rustup target list --installed` includes `wasm32-unknown-unknown`
- rerun:

```bash
cd frontend
npm run wasm:build
```

If you see a message about missing generated WASM entrypoints in `./pkg`, it means `frontend/src/pkg` has not been generated yet.

## Development Notes

- The simulator enforces alignment checks in the Rust runtime.
- `frontend/src/pkg` is generated code and should be treated as build output.
- `rust-core/target` and `frontend/dist` are disposable build artifacts and can be regenerated at any time.

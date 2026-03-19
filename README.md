# StudyRISC-V

A browser-based RV32IM simulator with step execution, pseudo-C translation, and a full two-pass assembler. Runs entirely in the browser via Rust + WebAssembly.

[Live demo](https://studyriscv.com)

## Features

StudyRISC-V is built for interactive debugging rather than batch execution. You can assemble source, step forward, step backward through recorded states, or run to completion while inspecting register changes, memory writes, and PC flow. The register file highlights what changed, the memory panel can follow key registers or jump to an explicit address, and the pseudo-C explainer translates the current instruction into a compact C-like expression as you move through the program.

The assembler supports both instruction and data authoring in one source file. `.data`, `.word`, `.half`, `.byte`, `.ascii`, `.asciz`, `.string`, `.space`, `.align`, and the `la` pseudo are all supported, so array and string examples can be written naturally instead of being hand-built with stores. The effect log can be filtered by register, memory, or PC updates, permalink sharing restores a full program from the URL hash, light and dark mode are built in, and the whole simulator is local-first with no server round-trips or account requirements.

## Supported ISA

| Group | Instructions |
|---|---|
| Arithmetic | add, sub, addi, lui, auipc |
| Comparison | slt, sltu, slti, sltiu |
| Bitwise | and, or, xor, andi, ori, xori |
| Shifts | sll, srl, sra, slli, srli, srai |
| M Extension | mul, mulh, mulhu, mulhsu, div, divu, rem, remu |
| Control flow | jal, jalr, beq, bne, blt, bge, bltu, bgeu |
| Memory | lw, lh, lb, lhu, lbu, sw, sh, sb |
| Pseudos | li, mv, nop, j, ret, call, la |
| System | ecall, ebreak |

## Memory Map

| Region | Base address | Notes |
|---|---|---|
| Text | 0x00000000 | Instruction memory |
| Data | 0x10000000 | `.data` segment |
| Stack | 0x7FFFFFFC | `sp` initialized here |

## Development Setup

Prerequisites: Rust + `wasm-pack`, Node 18+

```bash
# Install wasm-pack
cargo install wasm-pack

# Run dev server (builds WASM automatically via predev script)
cd frontend && npm install && npm run dev

# Run tests
cd frontend && npm test

# Production build
cd frontend && npm run build
```

## Authentication

StudyRISC-V uses AWS Cognito for auth. The simulator is fully usable without an account. Signing in with a `@gatech.edu` email unlocks saved programs (coming soon).

### Deploying the auth infrastructure

Prerequisites: AWS CLI configured, CDK bootstrapped in `us-east-1`

```bash
cd infra
npm install
npx cdk deploy
```

After deploy, copy the stack outputs into `frontend/.env`:

```bash
VITE_COGNITO_USER_POOL_ID=<UserPoolId output>
VITE_COGNITO_CLIENT_ID=<UserPoolClientId output>
VITE_COGNITO_DOMAIN=<CognitoHostedUiDomain output>
```

### Local dev without auth

Leave `frontend/.env` absent or use placeholder values. The signin button will redirect to Cognito but return to `localhost:5173`. The simulator works fully without completing auth.

## Project Structure

```text
riscvsim/
├── frontend/
│   ├── index.html          # Simulator app
│   ├── landing.html        # Marketing landing page
│   └── src/
│       ├── asm.ts          # Two-pass assembler with pseudo expansion
│       ├── auth.ts         # Cognito session handling + PKCE helpers
│       ├── auth-config.ts  # Vite auth environment wiring
│       ├── auth-ui.ts      # Shared auth nav state for landing + simulator
│       ├── wasm-runtime.ts # Machine code encoder + WASM bridge
│       ├── main.ts         # UI orchestration
│       ├── disasm.ts       # Disassembly view
│       ├── memory.ts       # Memory panel
│       ├── format.ts       # Pseudo-C and effect formatting
│       ├── animator.ts     # Step animations
│       ├── permalink.ts    # URL state sharing
│       └── types.ts        # Shared types (StepDelta)
├── infra/
│   ├── bin/app.ts          # CDK entry point
│   ├── lib/stack.ts        # Cognito, API Gateway, Lambda, DynamoDB
│   └── lambda/             # Inline-authored Lambda handlers
├── rust-core/
│   └── src/lib.rs          # RV32IM CPU interpreter (Rust/WASM)
└── frontend/tests/
    └── regression/         # 90+ fixture and end-to-end tests
```

## Testing

The regression suite covers pseudo expansion, label resolution, immediates, branches, loads/stores, ALU behavior, M extension instructions, traps, data directives, permalink encoding, auth helpers, and end-to-end programs.

Run with:

```bash
cd frontend && npm test
```

## License

MIT

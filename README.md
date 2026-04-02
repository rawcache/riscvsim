# StudyRISC-V

A browser-based RV32IM simulator with step execution, pseudo-C translation, and a full two-pass assembler. Runs entirely in the browser via Rust + WebAssembly.

[studyriscv.com](https://studyriscv.com)

## Features

StudyRISC-V is built for interactive debugging rather t4han batch execution. You can assemble source, step forward, step backward through recorded states, or run to completion while inspecting register changes, memory writes, and PC flow. The register file highlights what changed, the memory panel can follow key registers or jump to an explicit address, and the pseudo-C explainer translates the current instruction into a compact C-like expression as you move through the program.

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

## Call Stack Visualizer

The call stack panel shows live stack frame state as programs execute. Each function call pushes a new frame showing saved registers, local slots, and the return address. Frames animate in and out as calls are made and returned from.

Load the "Function call (calling convention)" or "Recursive factorial" sample programs to see the visualizer in action.

The visualizer derives all state from the step delta stream -- no changes to the Rust core were required.

## Guided Learning

Twenty structured lessons live at `/learn/`, covering the full ECE 2035 path from registers and memory to pipelines, interrupts, and a mini-kernel capstone.

Each lesson has:
- Explanatory content with tips and warnings
- Pre-loaded assembly programs
- Specific goals with pass/fail checking
- Hints after multiple failed attempts
- Progress saved to account or localStorage for guests

Lessons: Registers · Memory · Branches · Functions · Sorting · Bitwise · Shifts · Comparison · Stack · M Extension · Strings · Linked Lists · Recursion · Syscalls · Capstone · Pipeline · Cache · Floating Point Concepts · Interrupts · Mini Kernel

## Challenges

Fifteen graded challenges live at `/challenges/`, with one challenge attached to each lesson.

Each challenge includes:
- A standalone problem statement
- Starter assembly code
- Multiple hidden test cases
- Point scoring, retries, and best-score tracking
- Hint and answer reveal controls inside the simulator

The `/learn/` page also includes a public leaderboard powered by the backend API.

## Checkpoints

Eight LeetCode-style checkpoints live at `/checkpoints/`, each with a two-panel IDE, visible and hidden register-state tests, and local/account-backed progress.

## Labs

Five lab-style assignments live at `/labs/`, designed to feel like real ECE 2035 programming labs.

Each lab includes:
- A full assignment spec and function signature
- Visible and hidden grader test cases
- Hints that unlock over time
- Best-score tracking and repeat submissions
- Lab-mode execution directly inside the simulator

## Quizzes

Five timed quizzes live at `/quiz/`, ranging from quick checks to a full-curriculum final.

Each quiz includes:
- Mixed MCQ, trace, fill-in, and assembly questions
- Per-quiz timers with auto-submit
- Review mode with explanations
- XP awards for passing attempts

## Leaderboard

The public leaderboard lives at `/leaderboard/` and supports both all-time and weekly XP views.

It tracks:
- Total XP
- Weekly XP
- Lessons completed
- Challenges passed
- Badge count and streaks

## Frontend Rewrites

If you deploy on Amplify or another static host, add rewrites for the multi-page routes:

| Source | Target | Status |
|---|---|---|
| `/learn/` | `/learn/index.html` | `200` |
| `/learn` | `/learn/index.html` | `200` |
| `/quiz/` | `/quiz/index.html` | `200` |
| `/quiz` | `/quiz/index.html` | `200` |
| `/labs/` | `/labs/index.html` | `200` |
| `/labs` | `/labs/index.html` | `200` |
| `/checkpoints/` | `/checkpoints/index.html` | `200` |
| `/checkpoints` | `/checkpoints/index.html` | `200` |
| `/challenges/` | `/challenges/index.html` | `200` |
| `/challenges` | `/challenges/index.html` | `200` |
| `/leaderboard/` | `/leaderboard/index.html` | `200` |
| `/leaderboard` | `/leaderboard/index.html` | `200` |
| `/profile/` | `/profile/index.html` | `200` |
| `/profile` | `/profile/index.html` | `200` |
| `/groups/` | `/groups/index.html` | `200` |
| `/groups` | `/groups/index.html` | `200` |
| `/about/` | `/about/index.html` | `200` |
| `/about` | `/about/index.html` | `200` |
| `/docs/` | `/docs/index.html` | `200` |
| `/docs` | `/docs/index.html` | `200` |

Weekly digest data is already structured on the client. To turn the digest preview into real weekly email delivery later, add an SES-backed Lambda that reads the same summary fields now rendered on `/leaderboard/`.

Open Graph workflow:
- `frontend/public/og-image.svg` is the editable source asset.
- Generate `frontend/public/og-image.png` once with:
  `npx sharp-cli -i public/og-image.svg -o public/og-image.png --width 1200 --height 630`

Future enhancement:
- Permalink-specific Open Graph cards for `/simulator/#p=...` still need an edge worker or Lambda@Edge because crawlers do not execute the client-side hash renderer.

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

Leave `frontend/.env` absent or use placeholder values. The auth UI will still render on localhost, and Cognito sign-out will return to the landing page. The simulator works fully without completing auth.

## Project Structure

```text
riscvsim/
├── frontend/
│   ├── index.html          # Marketing landing page at /
│   ├── landing.html        # Legacy redirect to /
│   ├── simulator/
│   │   └── index.html      # Simulator app at /simulator/
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
│       ├── stack-tracker.ts # Call stack state derived from step deltas
│       ├── stack-ui.ts     # Call stack visualizer rendering
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

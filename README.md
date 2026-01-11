RISC-V Simulator (RV32 Teaching Tool)
=====================================
GO TO: <https://studyriscv.com>

A lightweight RV32 learning rig: assemble a small subset of RISC-V in the browser, single-step it on a Java backend, and see registers/memory/branches come alive with C-like explanations and an auto-generated C “switch(pc)” mapping.

Why this exists
---------------
- Fast, zero-install emulator for the classroom or self-study.
- Visualize effects: every step reports register writes, memory writes, and PC movement.
- Understand control flow: see both a humanized C-like explanation and a faithful RV→C mapping.
- Extendable: the codebase is small, typed, and easy to grow (currently implements BEQ/BNE/BLT/BGE and unsigned variants).

What’s implemented
------------------
- ISA subset:
  - Arithmetic/compare: `addi`, `add`, `sub`, `slt`, `sltu`, `slti`, `sltiu`, `mul`, `mulh`, `mulhsu`, `mulhu`, `div`, `divu`, `rem`, `remu`
  - Shifts/logic: `slli`, `srli`, `srai`, `sll`, `srl`, `sra`, `andi`, `ori`, `xori`, `and`, `or`, `xor`
  - Immediates/jumps/branches: `lui`, `auipc`, `jal`, `jalr`, `beq`, `bne`, `blt`, `bge`, `bltu`, `bgeu`
  - Loads/stores: `lb`, `lbu`, `lh`, `lhu`, `lw`, `sb`, `sh`, `sw`
  - Pseudos: `li`, `mv`, `nop`, `j`, `call`, `ret`
- Parser: labels, symbols (`#sym name=value`), ABI register aliases, alignment checks (toggleable), `#` and `//` comments, instruction/size limits.
- CPU: 32 regs, 64 KB memory, per-step interpreter with effect tracking and traps (`TRAP_*` codes for alignment/memory/PC faults).
- Views:
  - C-like explainer (semantic, human friendly).
  - RV→C mapper (mechanical switch-on-pc rendering).
- HTTP API (localhost:8080): `/api/session`, `/api/assemble`, `/api/step`, `/api/reset` with CORS.
- Frontend: Vite/TS UI with textarea + stepping, register/effect rendering helpers.

Quick start
-----------
Prereqs: Java 17+, Node 18+, npm.

Backend
```
cd backend
mvn clean package
./run.sh   # or: java -jar target/riscvsim-backend-0.1.0.jar
```

Frontend (in another shell)
```
cd frontend
npm install
npm run dev   # Vite dev server, proxies /api to backend
```

Usage
-----
1) Paste RV32 assembly (subset above) into the frontend textarea.
2) Click “Assemble” to create a session.
3) Click “Step” to execute one instruction at a time; see effects, registers, C-like view, and RV→C mapping.

Sample program (signed/unsigned branches)
```
addi x1, x0, -1      # 0xffffffff
addi x2, x0, 1
bltu x1, x2, not_taken   # unsigned: false
addi x3, x0, 123         # executes
not_taken:
bgeu x1, x2, done        # unsigned: true
addi x3, x0, 999         # skipped
done:
```

Other built-in samples in the UI include a `jal/jalr + lw/sw` round trip and a memory test
that exercises `sb`/`sh`/`sw` plus `lb`/`lbu`/`lh`/`lhu`/`lw`.

Project layout
--------------
- `backend/`: Java simulator, server, and explainers.
  - `Server.java`: HTTP API + session management.
  - `Simulator.java`, `Cpu.java`, `Memory.java`: execution engine.
  - `Parser.java`, `Instruction.java`: assembler/IR.
  - `CLikeExplainer.java`, `Rv2CMapper.java`: textual views.
- `frontend/`: Vite/TypeScript UI; proxy configured to backend.

API (quick sketch)
------------------
- `POST /api/session` `{ source }` → `{ sessionId, regs, pc, clike, rv2c, effects }`
- `POST /api/assemble` `{ sessionId, source }` → same shape
- `POST /api/step` `{ sessionId }` → next step snapshot
- `POST /api/reset` `{ sessionId }` → reset CPU with current program

Extending the ISA
-----------------
Add a new op in five spots:
1) `Instruction.Op` enum + factory.
2) `Parser` opcode branch.
3) `Cpu` execution switch (+ unsigned handling as needed).
4) `CLikeExplainer` case.
5) `Rv2CMapper` case + helper for C output.

Contributing / notes
--------------------
- Keep methods short (parser/explainer already split for checkstyle).
- Use unsigned masks (`& 0xffffffffL`) for BLTU/BGEU in the CPU.
- Tests are not yet formalized; use the sample programs in the README and step through the UI.

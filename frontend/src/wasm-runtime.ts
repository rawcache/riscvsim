import type { InstructionWire, WasmEffectDelta, WasmStateDelta } from "./types";

export interface StepResult {
  instruction_hex: string;
  new_pc: number;
  changed_registers: Record<string, number>;
  halted: boolean;
  trap?: string | null;
}

type SimulatorHandle = {
  reset(): void;
  load_program(bytes: Uint8Array): void;
  step(): unknown;
  get_registers(): Uint32Array;
  get_register(index: number): number;
  pc(): number;
  halted(): boolean;
  memory_ptr(): number;
  memory_len(): number;
  registers_ptr(): number;
  registers_len(): number;
};

type WasmModule = {
  default(input?: unknown): Promise<any>;
  Simulator: new (memorySize: number) => SimulatorHandle;
  memory?: WebAssembly.Memory;
};

type LoadedWasm = {
  module: WasmModule;
  wasmInstance: any;
};

let wasmModulePromise: Promise<LoadedWasm> | null = null;

async function loadWasmModule(): Promise<LoadedWasm> {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      const configuredPath = import.meta.env.VITE_WASM_MODULE as string | undefined;
      const candidates = configuredPath ? [configuredPath] : ["./pkg/riscvsim", "./pkg/riscvsim_core"];
      let lastError: unknown = null;

      for (const candidate of candidates) {
        try {
          const mod = (await import(
            /* @vite-ignore */
            candidate
          )) as unknown as WasmModule;
          const wasmInstance = await mod.default();
          return { module: mod, wasmInstance };
        } catch (err) {
          lastError = err;
        }
      }

      const details =
        lastError instanceof Error ? lastError.message : `Unknown error: ${String(lastError)}`;
      throw new Error(
        `Unable to initialize WASM module. Tried ${candidates.join(", ")}. ${details}`
      );
    })();
  }
  return wasmModulePromise;
}

export class RiscvEngine {
  private readonly module: WasmModule;
  private readonly wasmInstance: any;
  private readonly sim: SimulatorHandle;
  private memPtr = 0;
  private memLen = 0;
  private regsPtr = 0;
  private regsLen = 0;
  private memView: Uint8Array | null = null;
  private regsView: Uint32Array | null = null;
  private lastBuffer: ArrayBufferLike | null = null;

  private constructor(module: WasmModule, wasmInstance: any, memorySize: number) {
    this.module = module;
    this.wasmInstance = wasmInstance;
    this.sim = new module.Simulator(memorySize);
    this.refreshPointers();
  }

  static async create(memorySize = 64 * 1024): Promise<RiscvEngine> {
    const { module, wasmInstance } = await loadWasmModule();
    return new RiscvEngine(module, wasmInstance, memorySize);
  }

  loadProgram(bytes: Uint8Array): void {
    this.sim.load_program(bytes);
    this.refreshPointers();
  }

  reset(): void {
    this.sim.reset();
    this.refreshPointers();
  }

  step(): StepResult {
    const raw = this.sim.step() as StepResult;
    this.refreshPointers();
    return raw;
  }

  getRegister(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= 32) {
      throw new Error(`Register index out of range: ${index}`);
    }
    return this.registersView()[index];
  }

  getRegisters(): Uint32Array {
    return this.sim.get_registers();
  }

  pc(): number {
    return this.sim.pc();
  }

  halted(): boolean {
    return this.sim.halted();
  }

  memoryView(): Uint8Array {
    this.ensureViews();
    return this.memView as Uint8Array;
  }

  registersView(): Uint32Array {
    this.ensureViews();
    return this.regsView as Uint32Array;
  }

  private refreshPointers(): void {
    this.memPtr = this.sim.memory_ptr();
    this.memLen = this.sim.memory_len();
    this.regsPtr = this.sim.registers_ptr();
    this.regsLen = this.sim.registers_len();
    this.lastBuffer = null;
  }

  private ensureViews(): void {
    const memory = this.module.memory || this.wasmInstance?.memory;
    if (!memory) {
      throw new Error("WASM memory not found. Ensure your Rust crate is compiled with wasm-pack.");
    }
    const buffer = memory.buffer;
    if (this.lastBuffer === buffer && this.memView && this.regsView) {
      return;
    }
    this.lastBuffer = buffer;
    this.memView = new Uint8Array(buffer, this.memPtr, this.memLen);
    this.regsView = new Uint32Array(buffer, this.regsPtr, this.regsLen);
  }
}

function requiredNumber(value: number | undefined, field: string, op: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Instruction "${op}" is missing numeric field "${field}"`);
  }
  return value | 0;
}

function encodeR(rd: number, rs1: number, rs2: number, funct3: number, funct7: number, opcode: number): number {
  return (
    ((funct7 & 0x7f) << 25) |
    ((rs2 & 0x1f) << 20) |
    ((rs1 & 0x1f) << 15) |
    ((funct3 & 0x7) << 12) |
    ((rd & 0x1f) << 7) |
    (opcode & 0x7f)
  ) >>> 0;
}

function encodeI(rd: number, rs1: number, imm: number, funct3: number, opcode: number): number {
  return (
    (((imm & 0x0fff) << 20) >>> 0) |
    ((rs1 & 0x1f) << 15) |
    ((funct3 & 0x7) << 12) |
    ((rd & 0x1f) << 7) |
    (opcode & 0x7f)
  ) >>> 0;
}

function encodeS(rs1: number, rs2: number, imm: number, funct3: number, opcode: number): number {
  const imm12 = imm & 0x0fff;
  return (
    (((imm12 >> 5) & 0x7f) << 25) |
    ((rs2 & 0x1f) << 20) |
    ((rs1 & 0x1f) << 15) |
    ((funct3 & 0x7) << 12) |
    ((imm12 & 0x1f) << 7) |
    (opcode & 0x7f)
  ) >>> 0;
}

function encodeB(rs1: number, rs2: number, offset: number, funct3: number, opcode: number): number {
  if ((offset & 1) !== 0) {
    throw new Error(`Branch offset must be even, got ${offset}`);
  }
  if (offset < -4096 || offset > 4094) {
    throw new Error(`Branch offset out of range: ${offset}`);
  }
  const imm13 = offset & 0x1fff;
  return (
    (((imm13 >> 12) & 0x1) << 31) |
    (((imm13 >> 5) & 0x3f) << 25) |
    ((rs2 & 0x1f) << 20) |
    ((rs1 & 0x1f) << 15) |
    ((funct3 & 0x7) << 12) |
    (((imm13 >> 1) & 0x0f) << 8) |
    (((imm13 >> 11) & 0x1) << 7) |
    (opcode & 0x7f)
  ) >>> 0;
}

function encodeU(rd: number, imm20: number, opcode: number): number {
  return ((((imm20 & 0x000f_ffff) << 12) >>> 0) | ((rd & 0x1f) << 7) | (opcode & 0x7f)) >>> 0;
}

function encodeJ(rd: number, offset: number, opcode: number): number {
  if ((offset & 1) !== 0) {
    throw new Error(`Jump offset must be even, got ${offset}`);
  }
  if (offset < -1_048_576 || offset > 1_048_574) {
    throw new Error(`Jump offset out of range: ${offset}`);
  }
  const imm21 = offset & 0x1f_ffff;
  return (
    (((imm21 >> 20) & 0x1) << 31) |
    (((imm21 >> 1) & 0x03ff) << 21) |
    (((imm21 >> 11) & 0x1) << 20) |
    (((imm21 >> 12) & 0x00ff) << 12) |
    ((rd & 0x1f) << 7) |
    (opcode & 0x7f)
  ) >>> 0;
}

function encodeInstruction(inst: InstructionWire, pc: number): number {
  const op = inst.op.toLowerCase();
  const rEncodings: Record<string, { funct3: number; funct7: number }> = {
    add: { funct3: 0x0, funct7: 0x00 },
    sub: { funct3: 0x0, funct7: 0x20 },
    sll: { funct3: 0x1, funct7: 0x00 },
    slt: { funct3: 0x2, funct7: 0x00 },
    sltu: { funct3: 0x3, funct7: 0x00 },
    xor: { funct3: 0x4, funct7: 0x00 },
    srl: { funct3: 0x5, funct7: 0x00 },
    sra: { funct3: 0x5, funct7: 0x20 },
    or: { funct3: 0x6, funct7: 0x00 },
    and: { funct3: 0x7, funct7: 0x00 },
    mul: { funct3: 0x0, funct7: 0x01 },
    mulh: { funct3: 0x1, funct7: 0x01 },
    mulhsu: { funct3: 0x2, funct7: 0x01 },
    mulhu: { funct3: 0x3, funct7: 0x01 },
    div: { funct3: 0x4, funct7: 0x01 },
    divu: { funct3: 0x5, funct7: 0x01 },
    rem: { funct3: 0x6, funct7: 0x01 },
    remu: { funct3: 0x7, funct7: 0x01 },
  };

  const iAluEncodings: Record<string, number> = {
    addi: 0x0,
    slti: 0x2,
    sltiu: 0x3,
    xori: 0x4,
    ori: 0x6,
    andi: 0x7,
  };

  const loadEncodings: Record<string, number> = {
    lb: 0x0,
    lh: 0x1,
    lw: 0x2,
    lbu: 0x4,
    lhu: 0x5,
  };

  const storeEncodings: Record<string, number> = {
    sb: 0x0,
    sh: 0x1,
    sw: 0x2,
  };

  const branchEncodings: Record<string, number> = {
    beq: 0x0,
    bne: 0x1,
    blt: 0x4,
    bge: 0x5,
    bltu: 0x6,
    bgeu: 0x7,
  };

  if (op in rEncodings) {
    const encoding = rEncodings[op];
    return encodeR(
      requiredNumber(inst.rd, "rd", op),
      requiredNumber(inst.rs1, "rs1", op),
      requiredNumber(inst.rs2, "rs2", op),
      encoding.funct3,
      encoding.funct7,
      0x33
    );
  }

  if (op in iAluEncodings) {
    return encodeI(
      requiredNumber(inst.rd, "rd", op),
      requiredNumber(inst.rs1, "rs1", op),
      requiredNumber(inst.imm, "imm", op),
      iAluEncodings[op],
      0x13
    );
  }

  if (op === "slli") {
    const imm = requiredNumber(inst.imm, "imm", op);
    return encodeI(
      requiredNumber(inst.rd, "rd", op),
      requiredNumber(inst.rs1, "rs1", op),
      imm & 0x1f,
      0x1,
      0x13
    );
  }

  if (op === "srli") {
    const imm = requiredNumber(inst.imm, "imm", op);
    return encodeI(
      requiredNumber(inst.rd, "rd", op),
      requiredNumber(inst.rs1, "rs1", op),
      imm & 0x1f,
      0x5,
      0x13
    );
  }

  if (op === "srai") {
    const imm = requiredNumber(inst.imm, "imm", op) & 0x1f;
    return encodeI(
      requiredNumber(inst.rd, "rd", op),
      requiredNumber(inst.rs1, "rs1", op),
      imm | 0x400,
      0x5,
      0x13
    );
  }

  if (op in loadEncodings) {
    return encodeI(
      requiredNumber(inst.rd, "rd", op),
      requiredNumber(inst.rs1, "rs1", op),
      requiredNumber(inst.imm, "imm", op),
      loadEncodings[op],
      0x03
    );
  }

  if (op in storeEncodings) {
    return encodeS(
      requiredNumber(inst.rs1, "rs1", op),
      requiredNumber(inst.rs2, "rs2", op),
      requiredNumber(inst.imm, "imm", op),
      storeEncodings[op],
      0x23
    );
  }

  if (op in branchEncodings) {
    const targetPc = requiredNumber(inst.target_pc, "target_pc", op);
    const offset = targetPc - pc;
    return encodeB(
      requiredNumber(inst.rs1, "rs1", op),
      requiredNumber(inst.rs2, "rs2", op),
      offset,
      branchEncodings[op],
      0x63
    );
  }

  if (op === "lui") {
    return encodeU(requiredNumber(inst.rd, "rd", op), requiredNumber(inst.imm, "imm", op), 0x37);
  }

  if (op === "auipc") {
    return encodeU(requiredNumber(inst.rd, "rd", op), requiredNumber(inst.imm, "imm", op), 0x17);
  }

  if (op === "jal") {
    const targetPc = requiredNumber(inst.target_pc, "target_pc", op);
    const offset = targetPc - pc;
    return encodeJ(requiredNumber(inst.rd, "rd", op), offset, 0x6f);
  }

  if (op === "jalr") {
    return encodeI(
      requiredNumber(inst.rd, "rd", op),
      requiredNumber(inst.rs1, "rs1", op),
      requiredNumber(inst.imm, "imm", op),
      0x0,
      0x67
    );
  }

  if (op === "ecall") {
    return 0x0000_0073;
  }

  throw new Error(`Unsupported instruction for binary encoding: "${op}"`);
}

function encodeInstructionProgram(program: InstructionWire[]): Uint8Array {
  const bytes = new Uint8Array(program.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < program.length; i++) {
    const pc = i * 4;
    const word = encodeInstruction(program[i], pc);
    view.setUint32(pc, word, true);
  }
  return bytes;
}

export class WasmRuntime {
  private readonly engine: RiscvEngine;

  private constructor(engine: RiscvEngine) {
    this.engine = engine;
  }

  static async create(memorySize = 64 * 1024): Promise<WasmRuntime> {
    const engine = await RiscvEngine.create(memorySize);
    return new WasmRuntime(engine);
  }

  setAlignmentChecks(_enabled: boolean): void {
    // Alignment checks are always enforced by the Rust engine.
  }

  loadProgram(program: InstructionWire[] | Uint8Array | number[]): void {
    let bytes: Uint8Array;
    if (program instanceof Uint8Array) {
      bytes = program;
    } else if (Array.isArray(program) && program.every((value): value is number => typeof value === "number")) {
      bytes = Uint8Array.from(program);
    } else if (Array.isArray(program)) {
      bytes = encodeInstructionProgram(program as InstructionWire[]);
    } else {
      throw new Error("loadProgram expects InstructionWire[], Uint8Array, or number[]");
    }
    this.engine.loadProgram(bytes);
  }

  reset(): void {
    this.engine.reset();
  }

  step(): WasmStateDelta {
    const beforePc = this.engine.pc();
    const beforeRegs = this.engine.registersView().slice();
    const step = this.engine.step();

    const effects: WasmEffectDelta[] = [];
    for (const [key, after] of Object.entries(step.changed_registers)) {
      const reg = Number.parseInt(key.replace(/^x/i, ""), 10);
      if (Number.isFinite(reg) && reg >= 0 && reg < 32) {
        effects.push({
          kind: "reg",
          reg,
          before: beforeRegs[reg],
          after,
        });
      }
    }

    effects.push({
      kind: "pc",
      before: beforePc,
      after: step.new_pc,
    });

    return {
      pc: step.new_pc,
      halted: step.halted,
      trap: step.trap ? { code: "TRAP_RUNTIME", message: step.trap } : null,
      effects,
    };
  }

  pc(): number {
    return this.engine.pc();
  }

  readRegisters(): number[] {
    return Array.from(this.engine.registersView());
  }

  memorySlice(start: number, length: number): Uint8Array {
    const memory = this.engine.memoryView();
    const safeStart = Math.max(0, Math.min(memory.length, start));
    const safeEnd = Math.max(safeStart, Math.min(memory.length, safeStart + length));
    return memory.subarray(safeStart, safeEnd);
  }
}

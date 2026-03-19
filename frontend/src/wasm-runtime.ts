import { DATA_BASE } from "./memory-map";
import { encodeInstructionProgram } from "./riscv-encode";
import type { InstructionWire, WasmStateDelta } from "./types";

type SimulatorHandle = {
  reset(): void;
  load_program(bytes: Uint8Array): void;
  load_data(bytes: Uint8Array, base: number): void;
  step(): unknown;
  get_registers(): Uint32Array;
  get_register(index: number): number;
  pc(): number;
  halted(): boolean;
  read_memory(addr: number, length: number): Uint8Array;
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
const generatedWasmModules = import.meta.glob<WasmModule>("./pkg/*.js");

type WasmModuleLoader = {
  label: string;
  load: () => Promise<WasmModule>;
};

async function loadWasmModule(): Promise<LoadedWasm> {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      const configuredPath = import.meta.env.VITE_WASM_MODULE as string | undefined;
      const generatedCandidates = ["./pkg/riscvsim.js", "./pkg/riscvsim_core.js"]
        .filter((path) => path in generatedWasmModules)
        .map(
          (path) =>
            ({
              label: path,
              load: async () => (await generatedWasmModules[path]!()) as WasmModule
            }) satisfies WasmModuleLoader
        );
      const candidates: WasmModuleLoader[] = configuredPath
        ? [
            {
              label: configuredPath,
              load: async () =>
                ((await import(
                  /* @vite-ignore */
                  configuredPath
                )) as unknown as WasmModule)
            }
          ]
        : generatedCandidates;

      if (candidates.length === 0) {
        throw new Error(
          configuredPath
            ? `Unable to initialize WASM module. VITE_WASM_MODULE is set to "${configuredPath}", but it could not be loaded.`
            : 'Unable to initialize WASM module. No generated WASM entrypoints were found in "./pkg". Run `npm run wasm:build` from `frontend` or use `npm run dev`/`npm run build` so the pre-script generates them.'
        );
      }

      let lastError: unknown = null;

      for (const candidate of candidates) {
        try {
          const mod = await candidate.load();
          const wasmInstance = await mod.default();
          return { module: mod, wasmInstance };
        } catch (err) {
          lastError = err;
        }
      }

      const details =
        lastError instanceof Error ? lastError.message : `Unknown error: ${String(lastError)}`;
      throw new Error(
        `Unable to initialize WASM module. Tried ${candidates.map((candidate) => candidate.label).join(", ")}. ${details}`
      );
    })();
  }
  return wasmModulePromise;
}

export class RiscvEngine {
  private readonly sim: SimulatorHandle;

  private constructor(module: WasmModule, memorySize: number) {
    this.sim = new module.Simulator(memorySize);
  }

  static async create(memorySize = 64 * 1024): Promise<RiscvEngine> {
    const { module } = await loadWasmModule();
    return new RiscvEngine(module, memorySize);
  }

  loadProgram(text: Uint8Array, data: Uint8Array = new Uint8Array()): void {
    this.sim.load_program(text);
    if (data.length > 0) {
      this.sim.load_data(data, DATA_BASE);
    }
  }

  reset(): void {
    this.sim.reset();
  }

  step(): WasmStateDelta {
    return this.sim.step() as WasmStateDelta;
  }

  getRegister(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= 32) {
      throw new Error(`Register index out of range: ${index}`);
    }
    return this.sim.get_register(index);
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

  readMemory(addr: number, length: number): Uint8Array {
    if (length <= 0) {
      return new Uint8Array();
    }
    return this.sim.read_memory(addr >>> 0, length | 0);
  }
}

type ProgramImage = {
  text: Uint8Array;
  data?: Uint8Array;
};

type InstructionProgramWithSegments = InstructionWire[] & ProgramImage;

function isProgramImage(value: unknown): value is ProgramImage {
  return typeof value === "object" && value !== null && "text" in value;
}

function toProgramImage(program: InstructionWire[] | Uint8Array | number[] | ProgramImage): ProgramImage {
  if (program instanceof Uint8Array) {
    return { text: program, data: new Uint8Array() };
  }
  if (Array.isArray(program) && program.every((value): value is number => typeof value === "number")) {
    return { text: Uint8Array.from(program), data: new Uint8Array() };
  }
  if (Array.isArray(program)) {
    const segmented = program as InstructionProgramWithSegments;
    if (segmented.text instanceof Uint8Array) {
      return {
        text: segmented.text,
        data: segmented.data instanceof Uint8Array ? segmented.data : new Uint8Array(),
      };
    }
    return { text: encodeInstructionProgram(program as InstructionWire[]), data: new Uint8Array() };
  }
  if (isProgramImage(program) && program.text instanceof Uint8Array) {
    return {
      text: program.text,
      data: program.data instanceof Uint8Array ? program.data : new Uint8Array(),
    };
  }
  throw new Error("loadProgram expects InstructionWire[], Uint8Array, number[], or { text, data }");
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

  loadProgram(program: InstructionWire[] | Uint8Array | number[] | ProgramImage): void {
    const image = toProgramImage(program);
    this.engine.loadProgram(image.text, image.data);
  }

  reset(): void {
    this.engine.reset();
  }

  step(): WasmStateDelta {
    return this.engine.step();
  }

  pc(): number {
    return this.engine.pc();
  }

  readRegisters(): number[] {
    return Array.from(this.engine.getRegisters());
  }

  memorySlice(start: number, length: number): Uint8Array {
    if (length <= 0) {
      return new Uint8Array();
    }
    const safeStart = Math.max(0, start | 0);
    return this.engine.readMemory(safeStart, length | 0);
  }
}

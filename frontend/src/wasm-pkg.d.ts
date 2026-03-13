declare module "../../rust-core/pkg/riscvsim_core.js" {
  export default function init(input?: unknown): Promise<void>;

  export class WasmSimulator {
    constructor(memory_size: number);
    reset(): void;
    set_alignment_checks(enabled: boolean): void;
    load_program(program: unknown): void;
    step(): unknown;
    memory_ptr(): number;
    memory_len(): number;
    registers_ptr(): number;
    registers_len(): number;
    pc(): number;
  }

  export const memory: WebAssembly.Memory;
}

declare module "./pkg/*.js" {
  export default function init(input?: unknown): Promise<unknown>;

  export class Simulator {
    constructor(memorySize: number);
    reset(): void;
    load_program(program: Uint8Array): void;
    step(): unknown;
    get_registers(): Uint32Array;
    get_register(index: number): number;
    memory_ptr(): number;
    memory_len(): number;
    registers_ptr(): number;
    registers_len(): number;
    pc(): number;
    halted(): boolean;
  }

  export const memory: WebAssembly.Memory;
}

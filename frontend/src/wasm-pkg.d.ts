declare module "../../rust-core/pkg/riscvsim_core.js" {
  export default function init(input?: unknown): Promise<void>;

  export class Simulator {
    constructor(memory_size: number);
    reset(): void;
    load_program(program: Uint8Array): void;
    load_data(program: Uint8Array, base: number): void;
    step(): unknown;
    get_registers(): Uint32Array;
    get_register(index: number): number;
    read_memory(addr: number, length: number): Uint8Array;
    pc(): number;
    halted(): boolean;
  }

  export const memory: WebAssembly.Memory;
}

declare module "./pkg/*.js" {
  export default function init(input?: unknown): Promise<unknown>;

  export class Simulator {
    constructor(memorySize: number);
    reset(): void;
    load_program(program: Uint8Array): void;
    load_data(program: Uint8Array, base: number): void;
    step(): unknown;
    get_registers(): Uint32Array;
    get_register(index: number): number;
    read_memory(addr: number, length: number): Uint8Array;
    pc(): number;
    halted(): boolean;
  }

  export const memory: WebAssembly.Memory;
}

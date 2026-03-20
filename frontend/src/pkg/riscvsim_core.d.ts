/* tslint:disable */
/* eslint-disable */

export class Simulator {
    free(): void;
    [Symbol.dispose](): void;
    get_register(index: number): number;
    get_registers(): Uint32Array;
    halted(): boolean;
    load_data(bytes: Uint8Array, base: number): void;
    load_program(bytes: Uint8Array): void;
    constructor(_memory_size: number);
    pc(): number;
    read_memory(addr: number, len: number): Uint8Array;
    reset(): void;
    step(): any;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_simulator_free: (a: number, b: number) => void;
    readonly simulator_get_register: (a: number, b: number) => number;
    readonly simulator_get_registers: (a: number) => [number, number];
    readonly simulator_halted: (a: number) => number;
    readonly simulator_load_data: (a: number, b: number, c: number, d: number) => [number, number];
    readonly simulator_load_program: (a: number, b: number, c: number) => [number, number];
    readonly simulator_new: (a: number) => number;
    readonly simulator_pc: (a: number) => number;
    readonly simulator_read_memory: (a: number, b: number, c: number) => [number, number];
    readonly simulator_reset: (a: number) => void;
    readonly simulator_step: (a: number) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

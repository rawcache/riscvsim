import { parseAssembly } from "../../src/asm";
import type { Effect, WasmStateDelta } from "../../src/types";
import { WasmRuntime } from "../../src/wasm-runtime";

export type StepDelta = WasmStateDelta;

type RuntimeProbe =
  | { ok: true }
  | { ok: false; error: Error };

export async function canLoadRuntime(): Promise<RuntimeProbe> {
  try {
    await WasmRuntime.create();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export async function assemble(src: string): Promise<Uint8Array> {
  const runtime = await WasmRuntime.create();
  const parsed = parseAssembly(src);
  runtime.loadProgram(parsed.instructions);
  return Uint8Array.from(runtime.memorySlice(0, parsed.instructions.length * 4));
}

export async function run(src: string, maxSteps: number): Promise<StepDelta[]> {
  const runtime = await WasmRuntime.create();
  const parsed = parseAssembly(src);
  runtime.loadProgram(parsed.instructions);
  runtime.reset();
  return runLoaded(runtime, maxSteps);
}

export async function runBytes(bytes: Uint8Array, maxSteps: number): Promise<StepDelta[]> {
  const runtime = await WasmRuntime.create();
  runtime.loadProgram(bytes);
  runtime.reset();
  return runLoaded(runtime, maxSteps);
}

async function runLoaded(runtime: WasmRuntime, maxSteps: number): Promise<StepDelta[]> {
  const deltas: StepDelta[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const delta = runtime.step();
    deltas.push(delta);
    if (delta.halted || delta.trap) {
      break;
    }
  }
  return deltas;
}

export function finalRegs(deltas: StepDelta[]): Record<number, number> {
  const regs = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [index, 0])
  ) as Record<number, number>;

  for (const delta of deltas) {
    for (const effect of delta.effects) {
      if (effect.kind === "reg") {
        regs[effect.reg] = effect.after >>> 0;
      }
    }
  }

  return regs;
}

export function wordAt(bytes: Uint8Array, instructionIndex = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    instructionIndex * 4,
    true
  );
}

export function decodeIImmediate(word: number): number {
  return signExtend(word >>> 20, 12);
}

export function decodeBImmediate(word: number): number {
  const bit12 = ((word >>> 31) & 0x1) << 12;
  const bit11 = ((word >>> 7) & 0x1) << 11;
  const bits10_5 = ((word >>> 25) & 0x3f) << 5;
  const bits4_1 = ((word >>> 8) & 0x0f) << 1;
  return signExtend(bit12 | bit11 | bits10_5 | bits4_1, 13);
}

export function decodeJImmediate(word: number): number {
  const bit20 = ((word >>> 31) & 0x1) << 20;
  const bits19_12 = ((word >>> 12) & 0xff) << 12;
  const bit11 = ((word >>> 20) & 0x1) << 11;
  const bits10_1 = ((word >>> 21) & 0x03ff) << 1;
  return signExtend(bit20 | bits19_12 | bit11 | bits10_1, 21);
}

export function trapCauseCode(delta: StepDelta): number | undefined {
  const cause = delta.trap?.cause;
  if (!cause) return undefined;

  if (/^\d+$/.test(cause)) {
    return Number.parseInt(cause, 10);
  }

  const causeCodes: Record<string, number> = {
    instruction_address_misaligned: 0,
    instruction_access_fault: 1,
    illegal_instruction: 2,
    breakpoint: 3,
    load_address_misaligned: 4,
    load_access_fault: 5,
    store_address_misaligned: 6,
    store_access_fault: 7,
    environment_call: 11,
  };

  return causeCodes[cause];
}

export function pcAfter(delta: StepDelta): number | undefined {
  const pcEffect = delta.effects.find(
    (effect): effect is Extract<Effect, { kind: "pc" }> => effect.kind === "pc"
  );
  return pcEffect?.after;
}

export function u32le(word: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, word >>> 0, true);
  return bytes;
}

function signExtend(value: number, bits: number): number {
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

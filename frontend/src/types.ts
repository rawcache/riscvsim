export type Effect = {
  kind: string; // "reg" | "mem" | "pc"
  reg?: number;
  addr?: number;
  size?: number;
  before?: number;
  after?: number;
  beforeBytes?: number[];
  afterBytes?: number[];
};

export type Trap = {
  code: string;
  message: string;
};

export type DisasmLine = {
  pc: number;
  text: string;
  label?: boolean;
};

export type InstructionWire = {
  op: string;
  rd?: number;
  rs1?: number;
  rs2?: number;
  imm?: number;
  target_pc?: number;
  src_line?: number;
};

export type WasmEffectDelta =
  | { kind: "reg"; reg: number; before: number; after: number }
  | { kind: "pc"; before: number; after: number }
  | { kind: "mem"; addr: number; size: number; before: number[]; after: number[] };

export type WasmTrapDelta = {
  code: string;
  message: string;
};

export type WasmStateDelta = {
  pc: number;
  halted: boolean;
  trap?: WasmTrapDelta | null;
  effects: WasmEffectDelta[];
};

export type ApiResponse = {
  sessionId?: string;
  pc?: number;
  regs?: number[];
  halted?: boolean;
  effects?: Effect[];
  clike?: string;
  rv2c?: string;
  error?: string | null;
  trap?: Trap | null;
  disasm?: DisasmLine[];
};

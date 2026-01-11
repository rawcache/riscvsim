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

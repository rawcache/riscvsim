import { parseAssembly } from "./asm";

export interface Breakpoint {
  id: string;
  line: number;
  address?: number;
  enabled: boolean;
  hitCount: number;
  condition?: string;
}

export type ParsedProgram = ReturnType<typeof parseAssembly>;

export type BreakpointConditionOperator = "==" | "!=" | "<" | ">" | "<=" | ">=";

export interface ParsedBreakpointCondition {
  registerName: string;
  registerIndex: number;
  operator: BreakpointConditionOperator;
  value: number;
}

const REGISTER_ALIASES: Record<string, number> = {
  zero: 0,
  ra: 1,
  sp: 2,
  gp: 3,
  tp: 4,
  t0: 5,
  t1: 6,
  t2: 7,
  s0: 8,
  fp: 8,
  s1: 9,
  a0: 10,
  a1: 11,
  a2: 12,
  a3: 13,
  a4: 14,
  a5: 15,
  a6: 16,
  a7: 17,
  s2: 18,
  s3: 19,
  s4: 20,
  s5: 21,
  s6: 22,
  s7: 23,
  s8: 24,
  s9: 25,
  s10: 26,
  s11: 27,
  t3: 28,
  t4: 29,
  t5: 30,
  t6: 31,
};

function registerIndexForName(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (normalized in REGISTER_ALIASES) {
    return REGISTER_ALIASES[normalized] ?? null;
  }
  if (/^x(?:[0-9]|[12][0-9]|3[01])$/.test(normalized)) {
    return Number.parseInt(normalized.slice(1), 10);
  }
  return null;
}

function parseLiteral(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const base = /^0x/i.test(body) ? 16 : 10;
  const digits = /^0x/i.test(body) ? body.slice(2) : body;
  if (!digits || !/^[0-9a-fA-F]+$/.test(digits)) {
    return null;
  }
  const parsed = Number.parseInt(digits, base);
  const value32 = negative ? -parsed : parsed;
  return value32 >>> 0;
}

export function parseBreakpointCondition(condition: string): ParsedBreakpointCondition | null {
  const match = /^\s*([A-Za-z_.$][\w.$]*|x(?:[0-9]|[12][0-9]|3[01]))\s*(==|!=|<=|>=|<|>)\s*(-?(?:0x[0-9a-fA-F]+|\d+))\s*$/.exec(
    condition
  );
  if (!match) {
    return null;
  }
  const registerIndex = registerIndexForName(match[1]);
  const value = parseLiteral(match[3]);
  if (registerIndex === null || value === null) {
    return null;
  }
  return {
    registerName: match[1].trim(),
    registerIndex,
    operator: match[2] as BreakpointConditionOperator,
    value,
  };
}

export function evaluateBreakpointCondition(condition: string | undefined, regs?: number[]): boolean {
  if (!condition) {
    return true;
  }
  if (!regs || regs.length < 32) {
    return false;
  }
  const parsed = parseBreakpointCondition(condition);
  if (!parsed) {
    return false;
  }
  const actual = regs[parsed.registerIndex] >>> 0;
  const expected = parsed.value >>> 0;
  switch (parsed.operator) {
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case "<":
      return actual < expected;
    case ">":
      return actual > expected;
    case "<=":
      return actual <= expected;
    case ">=":
      return actual >= expected;
    default:
      return false;
  }
}

export class BreakpointManager {
  private breakpoints: Breakpoint[] = [];

  add(line: number): Breakpoint {
    const existing = this.breakpoints.find((breakpoint) => breakpoint.line === line);
    if (existing) {
      return existing;
    }
    if (this.breakpoints.length >= 10) {
      return this.breakpoints[this.breakpoints.length - 1]!;
    }
    const breakpoint: Breakpoint = {
      id: `bp-${line}-${Math.random().toString(36).slice(2, 8)}`,
      line,
      enabled: true,
      hitCount: 0,
    };
    this.breakpoints.push(breakpoint);
    this.breakpoints.sort((left, right) => left.line - right.line);
    return breakpoint;
  }

  remove(id: string): void {
    this.breakpoints = this.breakpoints.filter((breakpoint) => breakpoint.id !== id);
  }

  toggle(line: number): void {
    const existing = this.breakpoints.find((breakpoint) => breakpoint.line === line);
    if (existing) {
      this.breakpoints = this.breakpoints.filter((breakpoint) => breakpoint.id !== existing.id);
      return;
    }
    if (this.breakpoints.length < 10) {
      this.add(line);
    }
  }

  getAll(): Breakpoint[] {
    return this.breakpoints.map((breakpoint) => ({ ...breakpoint }));
  }

  getById(id: string): Breakpoint | null {
    return this.breakpoints.find((breakpoint) => breakpoint.id === id) ?? null;
  }

  getByLine(line: number): Breakpoint | null {
    return this.breakpoints.find((breakpoint) => breakpoint.line === line) ?? null;
  }

  setCondition(id: string, condition?: string): boolean {
    if (condition && !parseBreakpointCondition(condition)) {
      return false;
    }
    let updated = false;
    this.breakpoints = this.breakpoints.map((breakpoint) => {
      if (breakpoint.id !== id) {
        return breakpoint;
      }
      updated = true;
      const nextCondition = condition?.trim() ? condition.trim() : undefined;
      return { ...breakpoint, condition: nextCondition };
    });
    return updated;
  }

  resolveAddresses(parsed: ParsedProgram): void {
    const addressByLine = new Map<number, number>();
    for (let index = 0; index < (parsed.instructions?.length ?? 0); index += 1) {
      const inst = parsed.instructions[index];
      const line = typeof inst.src_line === "number" ? inst.src_line + 1 : undefined;
      if (line === undefined || addressByLine.has(line)) {
        continue;
      }
      addressByLine.set(line, index * 4);
    }

    this.breakpoints = this.breakpoints.map((breakpoint) => ({
      ...breakpoint,
      address: addressByLine.get(breakpoint.line),
    }));
  }

  getMatchingBreakpoint(pc: number, regs?: number[]): Breakpoint | null {
    return (
      this.breakpoints.find(
        (breakpoint) =>
          breakpoint.enabled &&
          breakpoint.address !== undefined &&
          (breakpoint.address >>> 0) === (pc >>> 0) &&
          evaluateBreakpointCondition(breakpoint.condition, regs)
      ) ?? null
    );
  }

  isBreakpointAt(pc: number, regs?: number[]): boolean {
    return this.getMatchingBreakpoint(pc, regs) !== null;
  }

  recordHit(pc: number): void {
    this.breakpoints = this.breakpoints.map((breakpoint) =>
      breakpoint.enabled && breakpoint.address !== undefined && (breakpoint.address >>> 0) === (pc >>> 0)
        ? { ...breakpoint, hitCount: breakpoint.hitCount + 1 }
        : breakpoint
    );
  }

  clear(): void {
    this.breakpoints = [];
  }
}

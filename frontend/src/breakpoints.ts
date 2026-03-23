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

  isBreakpointAt(pc: number): boolean {
    return this.breakpoints.some(
      (breakpoint) => breakpoint.enabled && breakpoint.address !== undefined && (breakpoint.address >>> 0) === (pc >>> 0)
    );
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

import { isValidImm12, parseAssembly } from "./asm";
import { TEXT_BASE } from "./memory-map";
import type { Problem, ProblemTestCase, ProblemVerdict } from "./problem-data";
import { WasmRuntime } from "./wasm-runtime";

export interface RunResult {
  caseId: string;
  label: string;
  passed: boolean;
  verdict: ProblemVerdict;
  actualRegisters: Partial<Record<string, number>>;
  actualMemory: Array<{ address: number; value: number }>;
  expectedRegisters: Partial<Record<string, number>>;
  expectedMemory: Array<{ address: number; value: number }>;
  diff: Array<{
    key: string;
    expected: number;
    actual: number;
  }>;
  errorMessage?: string;
  stepsTaken: number;
  timedOut: boolean;
  executionTimeMs: number;
}

export interface RunSummary {
  verdict: ProblemVerdict;
  passedCount: number;
  totalCount: number;
  results: RunResult[];
  firstFailedResult?: RunResult;
  totalSteps: number;
  totalTimeMs: number;
}

type MemoryEntry = NonNullable<ProblemTestCase["initialMemory"]>[number];
type ExpectedMemoryEntry = NonNullable<ProblemTestCase["expectedMemory"]>[number];
type ParsedProgramBundle = {
  parsed: ReturnType<typeof parseAssembly>;
  studentPcs: Set<number>;
};

const ENTRY_LABEL = "__studyriscv_problem_user_start__";
const EXIT_LABEL = "__studyriscv_problem_done__";

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function toUint32(value: number): number {
  return value >>> 0;
}

function hex32(value: number): string {
  return `0x${toUint32(value).toString(16).padStart(8, "0")}`;
}

function memoryEntrySize(entry: MemoryEntry | ExpectedMemoryEntry): "byte" | "half" | "word" {
  return entry.size ?? "word";
}

function loadImmediateInstructions(registerName: string, value: number): string[] {
  const normalized = value | 0;
  if (isValidImm12(normalized)) {
    return [`addi ${registerName}, x0, ${normalized}`];
  }

  const hi = (normalized + 0x800) >> 12;
  const lo = normalized - (hi << 12);
  return [`lui ${registerName}, ${hi}`, `addi ${registerName}, ${registerName}, ${lo}`];
}

function buildRegisterSetupLines(initialRegisters: ProblemTestCase["initialRegisters"]): string[] {
  const registerNames = Object.keys(initialRegisters ?? {}).sort((left, right) => {
    const leftIndex = Number.parseInt(left.replace(/^\D+/u, ""), 10);
    const rightIndex = Number.parseInt(right.replace(/^\D+/u, ""), 10);
    return leftIndex - rightIndex;
  });
  const lines: string[] = [];

  for (const registerName of registerNames) {
    if (registerName === "x0" || registerName === "zero") {
      continue;
    }

    const value = initialRegisters?.[registerName];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    lines.push(...loadImmediateInstructions(registerName, value));
  }

  return lines;
}

function buildMemorySetupLines(initialMemory: ProblemTestCase["initialMemory"]): string[] {
  const lines: string[] = [];

  for (const entry of initialMemory ?? []) {
    lines.push(...loadImmediateInstructions("x31", entry.address));
    lines.push(...loadImmediateInstructions("x30", entry.value));
    switch (memoryEntrySize(entry)) {
      case "byte":
        lines.push("sb x30, 0(x31)");
        break;
      case "half":
        lines.push("sh x30, 0(x31)");
        break;
      default:
        lines.push("sw x30, 0(x31)");
        break;
    }
  }

  return lines;
}

function buildProgramBundle(source: string, testCase: ProblemTestCase): ParsedProgramBundle {
  const lines = [
    ".text",
    "__studyriscv_problem_boot__:",
    ...buildRegisterSetupLines(testCase.initialRegisters),
    ...buildMemorySetupLines(testCase.initialMemory),
    `j ${ENTRY_LABEL}`,
    `${ENTRY_LABEL}:`,
  ];

  const studentStartLine = lines.length;
  lines.push(...source.split(/\r?\n/u));
  const studentEndLine = lines.length - 1;
  lines.push(`${EXIT_LABEL}:`);
  lines.push(`beq x0, x0, ${EXIT_LABEL}`);

  const parsed = parseAssembly(lines.join("\n"));
  const studentPcs = new Set<number>();

  parsed.instructions.forEach((instruction, index) => {
    if (
      typeof instruction.src_line === "number" &&
      instruction.src_line >= studentStartLine &&
      instruction.src_line <= studentEndLine
    ) {
      studentPcs.add(TEXT_BASE + index * 4);
    }
  });

  return {
    parsed,
    studentPcs,
  };
}

function registersToRecord(registers: number[]): Partial<Record<string, number>> {
  return Object.fromEntries(registers.map((value, index) => [`x${index}`, value >>> 0]));
}

function normalizeExpectedRegisters(expectedRegisters: ProblemTestCase["expectedRegisters"]): Partial<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(expectedRegisters ?? {}).map(([registerName, value]) => [registerName, toUint32(value ?? 0)])
  );
}

function readMemoryValue(runtime: WasmRuntime, entry: MemoryEntry | ExpectedMemoryEntry): number {
  const size = memoryEntrySize(entry);
  const length = size === "byte" ? 1 : size === "half" ? 2 : 4;
  const bytes = runtime.memorySlice(entry.address, length);

  if (size === "byte") {
    return bytes[0] ?? 0;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (size === "half") {
    return view.getUint16(0, true);
  }
  return view.getUint32(0, true);
}

function buildMemoryResults(runtime: WasmRuntime, expectedMemory: ProblemTestCase["expectedMemory"]) {
  const actualMemory: Array<{ address: number; value: number }> = [];
  const normalizedExpectedMemory: Array<{ address: number; value: number }> = [];

  for (const entry of expectedMemory ?? []) {
    actualMemory.push({
      address: entry.address,
      value: toUint32(readMemoryValue(runtime, entry)),
    });
    normalizedExpectedMemory.push({
      address: entry.address,
      value: toUint32(entry.value),
    });
  }

  return {
    actualMemory,
    expectedMemory: normalizedExpectedMemory,
  };
}

function buildDiff(
  actualRegisters: Partial<Record<string, number>>,
  expectedRegisters: Partial<Record<string, number>>,
  actualMemory: Array<{ address: number; value: number }>,
  expectedMemory: Array<{ address: number; value: number }>
): RunResult["diff"] {
  const diff: RunResult["diff"] = [];

  for (const [registerName, expected] of Object.entries(expectedRegisters)) {
    if (typeof expected !== "number") {
      continue;
    }
    const actual = actualRegisters[registerName] ?? 0;
    if ((actual >>> 0) !== (expected >>> 0)) {
      diff.push({
        key: registerName,
        expected: expected >>> 0,
        actual: actual >>> 0,
      });
    }
  }

  const actualMemoryMap = new Map(actualMemory.map((entry) => [entry.address, entry.value >>> 0]));
  for (const entry of expectedMemory) {
    const actual = actualMemoryMap.get(entry.address) ?? 0;
    if ((actual >>> 0) !== (entry.value >>> 0)) {
      diff.push({
        key: `mem[${hex32(entry.address)}]`,
        expected: entry.value >>> 0,
        actual: actual >>> 0,
      });
    }
  }

  return diff;
}

function summarize(results: RunResult[]): RunSummary {
  const firstFailedResult = results.find((result) => !result.passed);
  return {
    verdict: firstFailedResult?.verdict ?? "Accepted",
    passedCount: results.filter((result) => result.passed).length,
    totalCount: results.length,
    results,
    firstFailedResult,
    totalSteps: results.reduce((total, result) => total + result.stepsTaken, 0),
    totalTimeMs: results.reduce((total, result) => total + result.executionTimeMs, 0),
  };
}

function firstTrapMessage(delta: ReturnType<WasmRuntime["step"]> | null): string | undefined {
  if (!delta?.trap) {
    return undefined;
  }
  return delta.trap.message?.trim() || delta.trap.cause?.trim() || undefined;
}

function withLabel(result: RunResult, label: string): RunResult {
  return {
    ...result,
    label,
  };
}

function assemblyErrorResult(testCase: ProblemTestCase, message: string, executionTimeMs: number): RunResult {
  return {
    caseId: testCase.id,
    label: testCase.label,
    passed: false,
    verdict: "Assembly Error",
    actualRegisters: {},
    actualMemory: [],
    expectedRegisters: normalizeExpectedRegisters(testCase.expectedRegisters),
    expectedMemory: (testCase.expectedMemory ?? []).map((entry) => ({
      address: entry.address,
      value: toUint32(entry.value),
    })),
    diff: [],
    errorMessage: message,
    stepsTaken: 0,
    timedOut: false,
    executionTimeMs,
  };
}

export async function runTestCase(
  source: string,
  testCase: ProblemTestCase,
  runtime: WasmRuntime
): Promise<RunResult> {
  runtime.reset();

  const buildStartedAt = now();
  let bundle: ParsedProgramBundle;
  try {
    bundle = buildProgramBundle(source, testCase);
  } catch (error) {
    return assemblyErrorResult(
      testCase,
      error instanceof Error ? error.message : String(error),
      now() - buildStartedAt
    );
  }

  runtime.loadProgram(bundle.parsed.instructions);
  runtime.reset();

  const expectedRegisters = normalizeExpectedRegisters(testCase.expectedRegisters);
  const limit = testCase.stepLimit ?? 1000;
  const startedAt = now();
  let stepsTaken = 0;
  let timedOut = false;
  let lastDelta: ReturnType<WasmRuntime["step"]> | null = null;

  while (stepsTaken < limit) {
    const preStepPc = runtime.pc();
    const delta = runtime.step();
    lastDelta = delta;

    if (bundle.studentPcs.has(preStepPc)) {
      stepsTaken += 1;
    }

    const pcEffect = delta.effects.find(
      (effect): effect is Extract<(typeof delta.effects)[number], { kind: "pc" }> => effect.kind === "pc"
    );
    const stalled = Boolean(pcEffect && pcEffect.before === pcEffect.after);

    if (delta.halted || delta.trap) {
      break;
    }

    if (stalled && !bundle.studentPcs.has(preStepPc)) {
      break;
    }
  }

  if (lastDelta && !lastDelta.halted && !lastDelta.trap && stepsTaken >= limit) {
    timedOut = true;
  }

  const executionTimeMs = now() - startedAt;
  const actualRegisters = registersToRecord(runtime.readRegisters());
  const memoryResults = buildMemoryResults(runtime, testCase.expectedMemory);
  const diff = buildDiff(actualRegisters, expectedRegisters, memoryResults.actualMemory, memoryResults.expectedMemory);

  let verdict: ProblemVerdict = "Accepted";
  let errorMessage: string | undefined;

  if (timedOut) {
    verdict = "Time Limit Exceeded";
    errorMessage = `Exceeded ${limit} steps before reaching ${EXIT_LABEL}.`;
  } else if (lastDelta?.trap) {
    verdict = "Runtime Error";
    errorMessage = firstTrapMessage(lastDelta);
  } else if (diff.length > 0) {
    verdict = "Wrong Answer";
  }

  return {
    caseId: testCase.id,
    label: testCase.label,
    passed: verdict === "Accepted",
    verdict,
    actualRegisters,
    actualMemory: memoryResults.actualMemory,
    expectedRegisters,
    expectedMemory: memoryResults.expectedMemory,
    diff,
    errorMessage,
    stepsTaken,
    timedOut,
    executionTimeMs,
  };
}

export async function runVisible(
  source: string,
  problem: Problem,
  runtime: WasmRuntime
): Promise<RunSummary> {
  const results: RunResult[] = [];
  for (const testCase of problem.testCases.filter((candidate) => candidate.visible)) {
    results.push(await runTestCase(source, testCase, runtime));
  }
  return summarize(results);
}

export async function runAll(
  source: string,
  problem: Problem,
  runtime: WasmRuntime
): Promise<RunSummary> {
  const results: RunResult[] = [];
  for (const [index, testCase] of problem.testCases.entries()) {
    const result = await runTestCase(source, testCase, runtime);
    results.push(testCase.visible ? result : withLabel(result, `Hidden Case ${index + 1}`));
  }
  return summarize(results);
}

export function formatProblemDiffValue(value: number): string {
  const normalized = toUint32(value);
  return `${hex32(normalized)} (${normalized >> 0})`;
}

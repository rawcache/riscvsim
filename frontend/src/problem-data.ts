export type Difficulty = "Easy" | "Medium" | "Hard";
export type ProblemTag =
  | "Arithmetic"
  | "Control Flow"
  | "Memory"
  | "Loops"
  | "Functions"
  | "Bit Manipulation"
  | "Arrays"
  | "Strings"
  | "Stack"
  | "Sorting";

export type ProblemVerdict =
  | "Accepted"
  | "Wrong Answer"
  | "Runtime Error"
  | "Time Limit Exceeded"
  | "Assembly Error";

export interface ProblemTestCase {
  id: string;
  label: string;
  visible: boolean;
  description: string;
  initialRegisters: Partial<Record<string, number>>;
  initialMemory?: Array<{
    address: number;
    value: number;
    label?: string;
    size?: "byte" | "half" | "word";
  }>;
  expectedRegisters: Partial<Record<string, number>>;
  expectedMemory?: Array<{
    address: number;
    value: number;
    size?: "byte" | "half" | "word";
  }>;
  stepLimit?: number;
}

export interface ProblemExample {
  input: string;
  output: string;
  explanation?: string;
  registerTable?: Array<{
    name: string;
    before: string;
    after: string;
  }>;
}

export interface Problem {
  id: string;
  number: number;
  title: string;
  difficulty: Difficulty;
  tags: ProblemTag[];
  acceptanceRate: number;
  description: string;
  constraints: string[];
  examples: ProblemExample[];
  hints: string[];
  starterCode: string;
  testCases: ProblemTestCase[];
  companies?: string[];
  relatedProblems?: string[];
  editorial?: string;
  stepLimit?: number;
}

export interface ProblemSubmission {
  id: string;
  problemId: string;
  code: string;
  verdict: ProblemVerdict;
  passedCases: number;
  totalCases: number;
  stepsTaken: number;
  submittedAt: string;
  failedCaseId?: string;
  errorMessage?: string;
  elapsedMs?: number;
}

export interface ProblemProgress {
  [problemId: string]: {
    status: "solved" | "attempted" | "unsolved";
    submissions: ProblemSubmission[];
    lastCode?: string;
    lastSavedAt?: string;
    hintsRevealed?: number;
  };
}

const DATA_BASE = 0x10000000;
const STACK_BASE = 0x7ffffffc;

function toUint32(value: number): number {
  return value >>> 0;
}

function toSigned32(value: number): number {
  return value >> 0;
}

function formatValue(value: number): string {
  const normalized = toUint32(value);
  return `0x${normalized.toString(16).padStart(8, "0")} (${toSigned32(normalized)})`;
}

function registerTable(rows: Array<[string, number, number]>): NonNullable<ProblemExample["registerTable"]> {
  return rows.map(([name, before, after]) => ({
    name,
    before: formatValue(before),
    after: formatValue(after),
  }));
}

function createTestCase(testCase: ProblemTestCase): ProblemTestCase {
  return testCase;
}

function wordMemory(base: number, values: number[], labelPrefix = "arr"): NonNullable<ProblemTestCase["initialMemory"]> {
  return values.map((value, index) => ({
    address: base + index * 4,
    value,
    label: `${labelPrefix}[${index}]`,
    size: "word",
  }));
}

function wordExpected(base: number, values: number[]): NonNullable<ProblemTestCase["expectedMemory"]> {
  return values.map((value, index) => ({
    address: base + index * 4,
    value,
    size: "word",
  }));
}

function byteMemory(base: number, values: number[], labelPrefix = "str"): NonNullable<ProblemTestCase["initialMemory"]> {
  return values.map((value, index) => ({
    address: base + index,
    value,
    label: `${labelPrefix}[${index}]`,
    size: "byte",
  }));
}

function asciiBytes(value: string): number[] {
  return Array.from(value, (char) => char.charCodeAt(0));
}

function nullTerminatedAscii(value: string): number[] {
  return [...asciiBytes(value), 0];
}

const P001_TESTS = [
  createTestCase({
    id: "p001-case-1",
    label: "Case 1",
    visible: true,
    description: "x10=3, x11=5 → x12=8",
    initialRegisters: { x10: 3, x11: 5 },
    expectedRegisters: { x10: 3, x11: 5, x12: 8 },
  }),
  createTestCase({
    id: "p001-case-2",
    label: "Case 2",
    visible: true,
    description: "x10=0, x11=0 → x12=0",
    initialRegisters: { x10: 0, x11: 0 },
    expectedRegisters: { x10: 0, x11: 0, x12: 0 },
  }),
  createTestCase({
    id: "p001-case-3",
    label: "Case 3",
    visible: true,
    description: "x10=100, x11=200 → x12=300",
    initialRegisters: { x10: 100, x11: 200 },
    expectedRegisters: { x10: 100, x11: 200, x12: 300 },
  }),
  createTestCase({
    id: "p001-case-4",
    label: "Case 4",
    visible: false,
    description: "x10=2147483647, x11=0 → x12=2147483647",
    initialRegisters: { x10: 2147483647, x11: 0 },
    expectedRegisters: { x10: 2147483647, x11: 0, x12: 2147483647 },
  }),
  createTestCase({
    id: "p001-case-5",
    label: "Case 5",
    visible: false,
    description: "x10=1, x11=1 → x12=2",
    initialRegisters: { x10: 1, x11: 1 },
    expectedRegisters: { x10: 1, x11: 1, x12: 2 },
  }),
  createTestCase({
    id: "p001-case-6",
    label: "Case 6",
    visible: false,
    description: "x10=255, x11=1 → x12=256",
    initialRegisters: { x10: 255, x11: 1 },
    expectedRegisters: { x10: 255, x11: 1, x12: 256 },
  }),
  createTestCase({
    id: "p001-case-7",
    label: "Case 7",
    visible: false,
    description: "x10=1000, x11=337 → x12=1337",
    initialRegisters: { x10: 1000, x11: 337 },
    expectedRegisters: { x10: 1000, x11: 337, x12: 1337 },
  }),
];

const P002_TESTS = [
  createTestCase({
    id: "p002-case-1",
    label: "Case 1",
    visible: true,
    description: "x10=5 → x11=5",
    initialRegisters: { x10: 5 },
    expectedRegisters: { x10: 5, x11: 5 },
  }),
  createTestCase({
    id: "p002-case-2",
    label: "Case 2",
    visible: true,
    description: "x10=-5 → x11=5",
    initialRegisters: { x10: -5 },
    expectedRegisters: { x11: 5 },
  }),
  createTestCase({
    id: "p002-case-3",
    label: "Case 3",
    visible: true,
    description: "x10=0 → x11=0",
    initialRegisters: { x10: 0 },
    expectedRegisters: { x10: 0, x11: 0 },
  }),
  createTestCase({
    id: "p002-case-4",
    label: "Case 4",
    visible: false,
    description: "x10=-2147483648 → x11=-2147483648",
    initialRegisters: { x10: -2147483648 },
    expectedRegisters: { x11: 0x80000000 },
  }),
  createTestCase({
    id: "p002-case-5",
    label: "Case 5",
    visible: false,
    description: "x10=2147483647 → x11=2147483647",
    initialRegisters: { x10: 2147483647 },
    expectedRegisters: { x11: 2147483647 },
  }),
  createTestCase({
    id: "p002-case-6",
    label: "Case 6",
    visible: false,
    description: "x10=-1 → x11=1",
    initialRegisters: { x10: -1 },
    expectedRegisters: { x11: 1 },
  }),
  createTestCase({
    id: "p002-case-7",
    label: "Case 7",
    visible: false,
    description: "x10=100 → x11=100",
    initialRegisters: { x10: 100 },
    expectedRegisters: { x10: 100, x11: 100 },
  }),
];

const P003_TESTS = [
  createTestCase({
    id: "p003-case-1",
    label: "Case 1",
    visible: true,
    description: "x10=7, x11=3 → x12=7",
    initialRegisters: { x10: 7, x11: 3 },
    expectedRegisters: { x10: 7, x11: 3, x12: 7 },
  }),
  createTestCase({
    id: "p003-case-2",
    label: "Case 2",
    visible: true,
    description: "x10=3, x11=7 → x12=7",
    initialRegisters: { x10: 3, x11: 7 },
    expectedRegisters: { x10: 3, x11: 7, x12: 7 },
  }),
  createTestCase({
    id: "p003-case-3",
    label: "Case 3",
    visible: true,
    description: "x10=5, x11=5 → x12=5",
    initialRegisters: { x10: 5, x11: 5 },
    expectedRegisters: { x10: 5, x11: 5, x12: 5 },
  }),
  createTestCase({
    id: "p003-case-4",
    label: "Case 4",
    visible: false,
    description: "x10=-1, x11=0 → x12=0",
    initialRegisters: { x10: -1, x11: 0 },
    expectedRegisters: { x12: 0 },
  }),
  createTestCase({
    id: "p003-case-5",
    label: "Case 5",
    visible: false,
    description: "x10=0, x11=-1 → x12=0",
    initialRegisters: { x10: 0, x11: -1 },
    expectedRegisters: { x12: 0 },
  }),
  createTestCase({
    id: "p003-case-6",
    label: "Case 6",
    visible: false,
    description: "x10=-5, x11=-3 → x12=-3",
    initialRegisters: { x10: -5, x11: -3 },
    expectedRegisters: { x12: 0xfffffffd },
  }),
  createTestCase({
    id: "p003-case-7",
    label: "Case 7",
    visible: false,
    description: "x10=2147483647, x11=0 → x12=2147483647",
    initialRegisters: { x10: 2147483647, x11: 0 },
    expectedRegisters: { x12: 2147483647 },
  }),
];

const P004_TESTS = [
  createTestCase({
    id: "p004-case-1",
    label: "Case 1",
    visible: true,
    description: "x10=1, x11=0 → x12=1",
    initialRegisters: { x10: 1, x11: 0 },
    expectedRegisters: { x12: 1 },
  }),
  createTestCase({
    id: "p004-case-2",
    label: "Case 2",
    visible: true,
    description: "x10=1, x11=3 → x12=8",
    initialRegisters: { x10: 1, x11: 3 },
    expectedRegisters: { x12: 8 },
  }),
  createTestCase({
    id: "p004-case-3",
    label: "Case 3",
    visible: true,
    description: "x10=5, x11=2 → x12=20",
    initialRegisters: { x10: 5, x11: 2 },
    expectedRegisters: { x12: 20 },
  }),
  createTestCase({
    id: "p004-case-4",
    label: "Case 4",
    visible: false,
    description: "x10=1, x11=31 → x12=0x80000000",
    initialRegisters: { x10: 1, x11: 31 },
    expectedRegisters: { x12: 0x80000000 },
  }),
  createTestCase({
    id: "p004-case-5",
    label: "Case 5",
    visible: false,
    description: "x10=0, x11=10 → x12=0",
    initialRegisters: { x10: 0, x11: 10 },
    expectedRegisters: { x12: 0 },
  }),
  createTestCase({
    id: "p004-case-6",
    label: "Case 6",
    visible: false,
    description: "x10=3, x11=4 → x12=48",
    initialRegisters: { x10: 3, x11: 4 },
    expectedRegisters: { x12: 48 },
  }),
];

const P005_TESTS = [
  createTestCase({
    id: "p005-case-1",
    label: "Case 1",
    visible: true,
    description: "x10=5 → x11=5",
    initialRegisters: { x10: 5 },
    expectedRegisters: { x11: 5 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p005-case-2",
    label: "Case 2",
    visible: true,
    description: "x10=0 → x11=0",
    initialRegisters: { x10: 0 },
    expectedRegisters: { x11: 0 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p005-case-3",
    label: "Case 3",
    visible: true,
    description: "x10=10 → x11=10",
    initialRegisters: { x10: 10 },
    expectedRegisters: { x11: 10 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p005-case-4",
    label: "Case 4",
    visible: false,
    description: "x10=1 → x11=1",
    initialRegisters: { x10: 1 },
    expectedRegisters: { x11: 1 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p005-case-5",
    label: "Case 5",
    visible: false,
    description: "x10=100 → x11=100",
    initialRegisters: { x10: 100 },
    expectedRegisters: { x11: 100 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p005-case-6",
    label: "Case 6",
    visible: false,
    description: "x10=3 → x11=3",
    initialRegisters: { x10: 3 },
    expectedRegisters: { x11: 3 },
    stepLimit: 5000,
  }),
];

const P006_TESTS = [
  createTestCase({
    id: "p006-case-1",
    label: "Case 1",
    visible: true,
    description: "arr=[1,2,3,4,5], n=5 → x12=15",
    initialRegisters: { x10: DATA_BASE, x11: 5 },
    initialMemory: wordMemory(DATA_BASE, [1, 2, 3, 4, 5]),
    expectedRegisters: { x10: DATA_BASE, x11: 5, x12: 15 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p006-case-2",
    label: "Case 2",
    visible: true,
    description: "arr=[10,20], n=2 → x12=30",
    initialRegisters: { x10: DATA_BASE, x11: 2 },
    initialMemory: wordMemory(DATA_BASE, [10, 20]),
    expectedRegisters: { x10: DATA_BASE, x11: 2, x12: 30 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p006-case-3",
    label: "Case 3",
    visible: true,
    description: "n=0 → x12=0",
    initialRegisters: { x10: DATA_BASE, x11: 0 },
    expectedRegisters: { x10: DATA_BASE, x11: 0, x12: 0 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p006-case-4",
    label: "Case 4",
    visible: false,
    description: "arr=[-1,1], n=2 → x12=0",
    initialRegisters: { x10: DATA_BASE, x11: 2 },
    initialMemory: wordMemory(DATA_BASE, [-1, 1]),
    expectedRegisters: { x12: 0 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p006-case-5",
    label: "Case 5",
    visible: false,
    description: "arr=[100]*10, n=10 → x12=1000",
    initialRegisters: { x10: DATA_BASE, x11: 10 },
    initialMemory: wordMemory(DATA_BASE, Array.from({ length: 10 }, () => 100)),
    expectedRegisters: { x12: 1000 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p006-case-6",
    label: "Case 6",
    visible: false,
    description: "arr=[-5,-3,-2], n=3 → x12=-10",
    initialRegisters: { x10: DATA_BASE, x11: 3 },
    initialMemory: wordMemory(DATA_BASE, [-5, -3, -2]),
    expectedRegisters: { x12: 0xfffffff6 },
    stepLimit: 5000,
  }),
];

const P007_TESTS = [
  createTestCase({
    id: "p007-case-1",
    label: "Case 1",
    visible: true,
    description: "x10=0 → x11=0",
    initialRegisters: { x10: 0 },
    expectedRegisters: { x11: 0 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p007-case-2",
    label: "Case 2",
    visible: true,
    description: "x10=1 → x11=1",
    initialRegisters: { x10: 1 },
    expectedRegisters: { x11: 1 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p007-case-3",
    label: "Case 3",
    visible: true,
    description: "x10=6 → x11=8",
    initialRegisters: { x10: 6 },
    expectedRegisters: { x11: 8 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p007-case-4",
    label: "Case 4",
    visible: false,
    description: "x10=10 → x11=55",
    initialRegisters: { x10: 10 },
    expectedRegisters: { x11: 55 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p007-case-5",
    label: "Case 5",
    visible: false,
    description: "x10=20 → x11=6765",
    initialRegisters: { x10: 20 },
    expectedRegisters: { x11: 6765 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p007-case-6",
    label: "Case 6",
    visible: false,
    description: "x10=2 → x11=1",
    initialRegisters: { x10: 2 },
    expectedRegisters: { x11: 1 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p007-case-7",
    label: "Case 7",
    visible: false,
    description: "x10=15 → x11=610",
    initialRegisters: { x10: 15 },
    expectedRegisters: { x11: 610 },
    stepLimit: 10000,
  }),
];

const P008_TESTS = [
  createTestCase({
    id: "p008-case-1",
    label: "Case 1",
    visible: true,
    description: "0x00000001 → 0x80000000",
    initialRegisters: { x10: 0x00000001 },
    expectedRegisters: { x11: 0x80000000 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p008-case-2",
    label: "Case 2",
    visible: true,
    description: "0x80000000 → 0x00000001",
    initialRegisters: { x10: 0x80000000 },
    expectedRegisters: { x11: 0x00000001 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p008-case-3",
    label: "Case 3",
    visible: true,
    description: "0xFFFFFFFF → 0xFFFFFFFF",
    initialRegisters: { x10: 0xffffffff },
    expectedRegisters: { x11: 0xffffffff },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p008-case-4",
    label: "Case 4",
    visible: false,
    description: "0x0F0F0F0F → 0xF0F0F0F0",
    initialRegisters: { x10: 0x0f0f0f0f },
    expectedRegisters: { x11: 0xf0f0f0f0 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p008-case-5",
    label: "Case 5",
    visible: false,
    description: "0x00000000 → 0x00000000",
    initialRegisters: { x10: 0x00000000 },
    expectedRegisters: { x11: 0x00000000 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p008-case-6",
    label: "Case 6",
    visible: false,
    description: "0xAAAAAAAA → 0x55555555",
    initialRegisters: { x10: 0xaaaaaaaa },
    expectedRegisters: { x11: 0x55555555 },
    stepLimit: 5000,
  }),
];

const P009_TESTS = [
  createTestCase({
    id: "p009-case-1",
    label: "Case 1",
    visible: true,
    description: "x10=1, x11=2, sp=0x7FFFFFFC → x12=2, x13=1",
    initialRegisters: { x10: 1, x11: 2, x2: STACK_BASE },
    expectedRegisters: { x10: 1, x11: 2, x12: 2, x13: 1, x2: STACK_BASE },
    expectedMemory: [
      { address: STACK_BASE - 4, value: 1, size: "word" },
      { address: STACK_BASE - 8, value: 2, size: "word" },
    ],
  }),
  createTestCase({
    id: "p009-case-2",
    label: "Case 2",
    visible: true,
    description: "x10=0, x11=0, sp=0x7FFFFFFC → x12=0, x13=0",
    initialRegisters: { x10: 0, x11: 0, x2: STACK_BASE },
    expectedRegisters: { x12: 0, x13: 0, x2: STACK_BASE },
    expectedMemory: [
      { address: STACK_BASE - 4, value: 0, size: "word" },
      { address: STACK_BASE - 8, value: 0, size: "word" },
    ],
  }),
  createTestCase({
    id: "p009-case-3",
    label: "Case 3",
    visible: true,
    description: "x10=42, x11=7, sp=0x7FFFFFFC → x12=7, x13=42",
    initialRegisters: { x10: 42, x11: 7, x2: STACK_BASE },
    expectedRegisters: { x12: 7, x13: 42, x2: STACK_BASE },
    expectedMemory: [
      { address: STACK_BASE - 4, value: 42, size: "word" },
      { address: STACK_BASE - 8, value: 7, size: "word" },
    ],
  }),
  createTestCase({
    id: "p009-case-4",
    label: "Case 4",
    visible: false,
    description: "x10=-1, x11=1, sp=0x7FFFFFFC → x12=1, x13=-1",
    initialRegisters: { x10: -1, x11: 1, x2: STACK_BASE },
    expectedRegisters: { x12: 1, x13: 0xffffffff, x2: STACK_BASE },
    expectedMemory: [
      { address: STACK_BASE - 4, value: 0xffffffff, size: "word" },
      { address: STACK_BASE - 8, value: 1, size: "word" },
    ],
  }),
  createTestCase({
    id: "p009-case-5",
    label: "Case 5",
    visible: false,
    description: "x10=100, x11=200, sp=0x7FFFFFFC → x12=200, x13=100",
    initialRegisters: { x10: 100, x11: 200, x2: STACK_BASE },
    expectedRegisters: { x12: 200, x13: 100, x2: STACK_BASE },
    expectedMemory: [
      { address: STACK_BASE - 4, value: 100, size: "word" },
      { address: STACK_BASE - 8, value: 200, size: "word" },
    ],
  }),
];

const P010_TESTS = [
  createTestCase({
    id: "p010-case-1",
    label: "Case 1",
    visible: true,
    description: "0x0000000B → x11=3",
    initialRegisters: { x10: 0x0000000b },
    expectedRegisters: { x11: 3 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p010-case-2",
    label: "Case 2",
    visible: true,
    description: "0x00000000 → x11=0",
    initialRegisters: { x10: 0x00000000 },
    expectedRegisters: { x11: 0 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p010-case-3",
    label: "Case 3",
    visible: true,
    description: "0xFFFFFFFF → x11=32",
    initialRegisters: { x10: 0xffffffff },
    expectedRegisters: { x11: 32 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p010-case-4",
    label: "Case 4",
    visible: false,
    description: "0x80000001 → x11=2",
    initialRegisters: { x10: 0x80000001 },
    expectedRegisters: { x11: 2 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p010-case-5",
    label: "Case 5",
    visible: false,
    description: "0x0F0F0F0F → x11=16",
    initialRegisters: { x10: 0x0f0f0f0f },
    expectedRegisters: { x11: 16 },
    stepLimit: 5000,
  }),
  createTestCase({
    id: "p010-case-6",
    label: "Case 6",
    visible: false,
    description: "0x00000001 → x11=1",
    initialRegisters: { x10: 1 },
    expectedRegisters: { x11: 1 },
    stepLimit: 5000,
  }),
];

const P011_TESTS = [
  createTestCase({
    id: "p011-case-1",
    label: "Case 1",
    visible: true,
    description: "[3,1,4,1,5,9,2,6], n=8 → x12=9",
    initialRegisters: { x10: DATA_BASE, x11: 8 },
    initialMemory: wordMemory(DATA_BASE, [3, 1, 4, 1, 5, 9, 2, 6]),
    expectedRegisters: { x12: 9 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p011-case-2",
    label: "Case 2",
    visible: true,
    description: "[42], n=1 → x12=42",
    initialRegisters: { x10: DATA_BASE, x11: 1 },
    initialMemory: wordMemory(DATA_BASE, [42]),
    expectedRegisters: { x12: 42 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p011-case-3",
    label: "Case 3",
    visible: true,
    description: "[-1,-2,-3], n=3 → x12=-1",
    initialRegisters: { x10: DATA_BASE, x11: 3 },
    initialMemory: wordMemory(DATA_BASE, [-1, -2, -3]),
    expectedRegisters: { x12: 0xffffffff },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p011-case-4",
    label: "Case 4",
    visible: false,
    description: "[2147483647,-1], n=2 → x12=2147483647",
    initialRegisters: { x10: DATA_BASE, x11: 2 },
    initialMemory: wordMemory(DATA_BASE, [2147483647, -1]),
    expectedRegisters: { x12: 2147483647 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p011-case-5",
    label: "Case 5",
    visible: false,
    description: "[-2147483648], n=1 → x12=-2147483648",
    initialRegisters: { x10: DATA_BASE, x11: 1 },
    initialMemory: wordMemory(DATA_BASE, [-2147483648]),
    expectedRegisters: { x12: 0x80000000 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p011-case-6",
    label: "Case 6",
    visible: false,
    description: "[0], n=1 → x12=0",
    initialRegisters: { x10: DATA_BASE, x11: 1 },
    initialMemory: wordMemory(DATA_BASE, [0]),
    expectedRegisters: { x12: 0 },
    stepLimit: 10000,
  }),
];

const P012_TESTS = [
  createTestCase({
    id: "p012-case-1",
    label: "Case 1",
    visible: true,
    description: "\"hello\\0\" → x11=5",
    initialRegisters: { x10: DATA_BASE },
    initialMemory: byteMemory(DATA_BASE, nullTerminatedAscii("hello")),
    expectedRegisters: { x11: 5 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p012-case-2",
    label: "Case 2",
    visible: true,
    description: "\"\\0\" → x11=0",
    initialRegisters: { x10: DATA_BASE },
    initialMemory: byteMemory(DATA_BASE, [0]),
    expectedRegisters: { x11: 0 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p012-case-3",
    label: "Case 3",
    visible: true,
    description: "\"a\\0\" → x11=1",
    initialRegisters: { x10: DATA_BASE },
    initialMemory: byteMemory(DATA_BASE, nullTerminatedAscii("a")),
    expectedRegisters: { x11: 1 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p012-case-4",
    label: "Case 4",
    visible: false,
    description: "\"RISC-V\\0\" → x11=6",
    initialRegisters: { x10: DATA_BASE },
    initialMemory: byteMemory(DATA_BASE, nullTerminatedAscii("RISC-V")),
    expectedRegisters: { x11: 6 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p012-case-5",
    label: "Case 5",
    visible: false,
    description: "\"ab\\0\" → x11=2",
    initialRegisters: { x10: DATA_BASE },
    initialMemory: byteMemory(DATA_BASE, nullTerminatedAscii("ab")),
    expectedRegisters: { x11: 2 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p012-case-6",
    label: "Case 6",
    visible: false,
    description: "\"ECE2035\\0\" → x11=7",
    initialRegisters: { x10: DATA_BASE },
    initialMemory: byteMemory(DATA_BASE, nullTerminatedAscii("ECE2035")),
    expectedRegisters: { x11: 7 },
    stepLimit: 10000,
  }),
];

const P013_TESTS = [
  createTestCase({
    id: "p013-case-1",
    label: "Case 1",
    visible: true,
    description: "[3,1,2], n=3 → [1,2,3]",
    initialRegisters: { x10: DATA_BASE, x11: 3 },
    initialMemory: wordMemory(DATA_BASE, [3, 1, 2]),
    expectedRegisters: {},
    expectedMemory: wordExpected(DATA_BASE, [1, 2, 3]),
    stepLimit: 50000,
  }),
  createTestCase({
    id: "p013-case-2",
    label: "Case 2",
    visible: true,
    description: "[5], n=1 → [5]",
    initialRegisters: { x10: DATA_BASE, x11: 1 },
    initialMemory: wordMemory(DATA_BASE, [5]),
    expectedRegisters: {},
    expectedMemory: wordExpected(DATA_BASE, [5]),
    stepLimit: 50000,
  }),
  createTestCase({
    id: "p013-case-3",
    label: "Case 3",
    visible: true,
    description: "[2,1], n=2 → [1,2]",
    initialRegisters: { x10: DATA_BASE, x11: 2 },
    initialMemory: wordMemory(DATA_BASE, [2, 1]),
    expectedRegisters: {},
    expectedMemory: wordExpected(DATA_BASE, [1, 2]),
    stepLimit: 50000,
  }),
  createTestCase({
    id: "p013-case-4",
    label: "Case 4",
    visible: false,
    description: "[5,4,3,2,1], n=5 → [1,2,3,4,5]",
    initialRegisters: { x10: DATA_BASE, x11: 5 },
    initialMemory: wordMemory(DATA_BASE, [5, 4, 3, 2, 1]),
    expectedRegisters: {},
    expectedMemory: wordExpected(DATA_BASE, [1, 2, 3, 4, 5]),
    stepLimit: 50000,
  }),
  createTestCase({
    id: "p013-case-5",
    label: "Case 5",
    visible: false,
    description: "[-3,0,5,-1], n=4 → [-3,-1,0,5]",
    initialRegisters: { x10: DATA_BASE, x11: 4 },
    initialMemory: wordMemory(DATA_BASE, [-3, 0, 5, -1]),
    expectedRegisters: {},
    expectedMemory: wordExpected(DATA_BASE, [-3, -1, 0, 5]),
    stepLimit: 50000,
  }),
  createTestCase({
    id: "p013-case-6",
    label: "Case 6",
    visible: false,
    description: "[42,42,42], n=3 → [42,42,42]",
    initialRegisters: { x10: DATA_BASE, x11: 3 },
    initialMemory: wordMemory(DATA_BASE, [42, 42, 42]),
    expectedRegisters: {},
    expectedMemory: wordExpected(DATA_BASE, [42, 42, 42]),
    stepLimit: 50000,
  }),
];

const P014_TESTS = [
  createTestCase({
    id: "p014-case-1",
    label: "Case 1",
    visible: true,
    description: "x10=48, x11=18 → x12=6",
    initialRegisters: { x10: 48, x11: 18 },
    expectedRegisters: { x12: 6 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p014-case-2",
    label: "Case 2",
    visible: true,
    description: "x10=7, x11=5 → x12=1",
    initialRegisters: { x10: 7, x11: 5 },
    expectedRegisters: { x12: 1 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p014-case-3",
    label: "Case 3",
    visible: true,
    description: "x10=12, x11=4 → x12=4",
    initialRegisters: { x10: 12, x11: 4 },
    expectedRegisters: { x12: 4 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p014-case-4",
    label: "Case 4",
    visible: false,
    description: "x10=100, x11=75 → x12=25",
    initialRegisters: { x10: 100, x11: 75 },
    expectedRegisters: { x12: 25 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p014-case-5",
    label: "Case 5",
    visible: false,
    description: "x10=1, x11=1 → x12=1",
    initialRegisters: { x10: 1, x11: 1 },
    expectedRegisters: { x12: 1 },
    stepLimit: 10000,
  }),
  createTestCase({
    id: "p014-case-6",
    label: "Case 6",
    visible: false,
    description: "x10=1000000, x11=999999 → x12=1",
    initialRegisters: { x10: 1000000, x11: 999999 },
    expectedRegisters: { x12: 1 },
    stepLimit: 10000,
  }),
];

const P015_TESTS = [
  createTestCase({
    id: "p015-case-1",
    label: "Case 1",
    visible: true,
    description: "[[1,2],[3,4]], N=2 → x12=5",
    initialRegisters: { x10: DATA_BASE, x11: 2 },
    initialMemory: wordMemory(DATA_BASE, [1, 2, 3, 4], "mat"),
    expectedRegisters: { x12: 5 },
    stepLimit: 20000,
  }),
  createTestCase({
    id: "p015-case-2",
    label: "Case 2",
    visible: true,
    description: "[[5]], N=1 → x12=5",
    initialRegisters: { x10: DATA_BASE, x11: 1 },
    initialMemory: wordMemory(DATA_BASE, [5], "mat"),
    expectedRegisters: { x12: 5 },
    stepLimit: 20000,
  }),
  createTestCase({
    id: "p015-case-3",
    label: "Case 3",
    visible: true,
    description: "identity 3x3 → x12=3",
    initialRegisters: { x10: DATA_BASE, x11: 3 },
    initialMemory: wordMemory(DATA_BASE, [1, 0, 0, 0, 1, 0, 0, 0, 1], "mat"),
    expectedRegisters: { x12: 3 },
    stepLimit: 20000,
  }),
  createTestCase({
    id: "p015-case-4",
    label: "Case 4",
    visible: false,
    description: "[[1,2,3],[4,5,6],[7,8,9]], N=3 → x12=15",
    initialRegisters: { x10: DATA_BASE, x11: 3 },
    initialMemory: wordMemory(DATA_BASE, [1, 2, 3, 4, 5, 6, 7, 8, 9], "mat"),
    expectedRegisters: { x12: 15 },
    stepLimit: 20000,
  }),
  createTestCase({
    id: "p015-case-5",
    label: "Case 5",
    visible: false,
    description: "[[0,0],[0,0]], N=2 → x12=0",
    initialRegisters: { x10: DATA_BASE, x11: 2 },
    initialMemory: wordMemory(DATA_BASE, [0, 0, 0, 0], "mat"),
    expectedRegisters: { x12: 0 },
    stepLimit: 20000,
  }),
];

export const PROBLEMS: Problem[] = [
  {
    id: "p001",
    number: 1,
    title: "Add Two Registers",
    difficulty: "Easy",
    tags: ["Arithmetic"],
    acceptanceRate: 74.2,
    companies: ["ECE 2035 Fundamentals"],
    relatedProblems: ["p002", "p003"],
    description: `
      <p>Given two integer values in registers <code>x10</code> and <code>x11</code>, compute their sum and store the result in <code>x12</code>.</p>
      <p>This is the most fundamental RISC-V operation. The <code>ADD</code> instruction computes <code>rd = rs1 + rs2</code>.</p>
    `,
    constraints: [
      "0 ≤ x10, x11 ≤ 2^31 - 1",
      "Use exactly one instruction",
      "Do not modify x10 or x11",
    ],
    examples: [
      {
        input: "x10 = 3, x11 = 5",
        output: "x12 = 8",
        explanation: "3 + 5 = 8",
        registerTable: registerTable([
          ["x10", 3, 3],
          ["x11", 5, 5],
          ["x12", 0, 8],
        ]),
      },
    ],
    hints: [
      "ADD computes rd = rs1 + rs2.",
      "Syntax: add rd, rs1, rs2",
      "add x12, x10, x11 stores the sum in x12.",
    ],
    starterCode: [
      "# Add Two Registers",
      "# Input:  x10 = first operand",
      "#         x11 = second operand",
      "# Output: x12 = x10 + x11",
      "",
    ].join("\n"),
    testCases: P001_TESTS,
  },
  {
    id: "p002",
    number: 2,
    title: "Absolute Value",
    difficulty: "Easy",
    tags: ["Arithmetic", "Control Flow"],
    acceptanceRate: 68.5,
    description: `
      <p>Given a signed 32-bit integer in <code>x10</code>, store its absolute value in <code>x11</code>.</p>
      <p>For positive numbers, the answer is the number itself. For negative numbers, negate it.</p>
      <p><strong>Note:</strong> Do not use pseudo-instructions like <code>neg</code>. Use base instructions only.</p>
    `,
    constraints: [
      "x10 is any signed 32-bit integer",
      "Do not use pseudo-instructions",
      "Special case: abs(-2147483648) = -2147483648",
    ],
    examples: [
      {
        input: "x10 = -5",
        output: "x11 = 5",
        explanation: "Negate the negative value.",
      },
      {
        input: "x10 = 5",
        output: "x11 = 5",
        explanation: "Positive values are unchanged.",
      },
    ],
    hints: [
      "Branch on whether x10 < 0.",
      "To negate, subtract from x0: sub x11, x0, x10.",
      "BLT x10, x0, negative_branch is the key comparison.",
    ],
    starterCode: [
      "# Absolute Value",
      "# Input:  x10 = signed integer",
      "# Output: x11 = |x10|",
      "",
    ].join("\n"),
    testCases: P002_TESTS,
  },
  {
    id: "p003",
    number: 3,
    title: "Max of Two",
    difficulty: "Easy",
    tags: ["Control Flow"],
    acceptanceRate: 71.3,
    relatedProblems: ["p001", "p011"],
    description: `
      <p>Given two signed integers in <code>x10</code> and <code>x11</code>, store the larger value in <code>x12</code>.</p>
      <p>If they are equal, storing either value is correct because they are the same.</p>
    `,
    constraints: [
      "x10 and x11 are signed 32-bit integers",
      "If equal, store either value",
      "Do not modify x10 or x11",
    ],
    examples: [
      {
        input: "x10 = 7, x11 = 3",
        output: "x12 = 7",
      },
      {
        input: "x10 = -5, x11 = -3",
        output: "x12 = -3",
      },
    ],
    hints: [
      "Compare the registers with a branch instruction.",
      "A clean pattern is to assume one answer, then overwrite it in the other branch.",
      "BLT x10, x11, use_x11 branches when x11 is larger.",
    ],
    starterCode: [
      "# Max of Two",
      "# Input:  x10 = first value, x11 = second value",
      "# Output: x12 = max(x10, x11)",
      "",
    ].join("\n"),
    testCases: P003_TESTS,
  },
  {
    id: "p004",
    number: 4,
    title: "Multiply by Power of Two",
    difficulty: "Easy",
    tags: ["Bit Manipulation"],
    acceptanceRate: 69.1,
    description: `
      <p>Given a value in <code>x10</code> and a shift amount in <code>x11</code>, store <code>x10 × 2^x11</code> in <code>x12</code>.</p>
      <p>In RISC-V, a left shift is equivalent to multiplying by a power of two.</p>
    `,
    constraints: [
      "0 ≤ x11 ≤ 31",
      "Use a shift instruction, not MUL",
      "Overflow behavior is not graded",
    ],
    examples: [
      {
        input: "x10 = 5, x11 = 2",
        output: "x12 = 20",
        explanation: "5 shifted left by 2 becomes 20.",
      },
    ],
    hints: [
      "Logical left shift is the right operation here.",
      "RISC-V has a register-based shift instruction as well as an immediate form.",
      "SLL x12, x10, x11 multiplies by 2^x11.",
    ],
    starterCode: [
      "# Multiply by Power of Two",
      "# Input:  x10 = value, x11 = shift amount",
      "# Output: x12 = x10 << x11",
      "",
    ].join("\n"),
    testCases: P004_TESTS,
  },
  {
    id: "p005",
    number: 5,
    title: "Count Down",
    difficulty: "Easy",
    tags: ["Loops"],
    acceptanceRate: 65.8,
    stepLimit: 5000,
    description: `
      <p>Starting from the value in <code>x10</code>, count down to zero. Store the number of iterations in <code>x11</code>.</p>
      <p>Each iteration decrements a counter by 1 until it reaches zero.</p>
    `,
    constraints: [
      "x10 ≥ 0",
      "Use a loop with a branch instruction",
      "x11 should equal the original x10 when the loop finishes",
    ],
    examples: [
      {
        input: "x10 = 5",
        output: "x11 = 5",
        explanation: "The loop executes exactly 5 times.",
      },
    ],
    hints: [
      "Keep one register as the countdown value and one register as the iteration counter.",
      "Decrement until the countdown register reaches zero.",
      "A BEQ or BNE check around the loop is enough.",
    ],
    starterCode: [
      "# Count Down",
      "# Input:  x10 = starting count",
      "# Output: x11 = number of loop iterations",
      "",
    ].join("\n"),
    testCases: P005_TESTS,
  },
  {
    id: "p006",
    number: 6,
    title: "Sum Array",
    difficulty: "Medium",
    tags: ["Memory", "Loops", "Arrays"],
    acceptanceRate: 52.4,
    stepLimit: 5000,
    relatedProblems: ["p011", "p015"],
    description: `
      <p>Given a base address in <code>x10</code> and element count in <code>x11</code>, sum all word-sized (32-bit) elements and store the result in <code>x12</code>.</p>
      <p>This is the assembly equivalent of:</p>
      <pre><code>int sum = 0;
for (int i = 0; i &lt; n; i++) sum += arr[i];</code></pre>
    `,
    constraints: [
      "Elements are signed 32-bit integers",
      "x11 ≥ 0. If x11 = 0, result is 0",
      "Elements are word-aligned (4 bytes apart)",
      "Use LW to load each element",
      "Do not modify x10 or x11",
    ],
    examples: [
      {
        input: "x10 = 0x10000000, x11 = 3, arr = [10, 20, 30]",
        output: "x12 = 60",
        explanation: "10 + 20 + 30 = 60",
      },
    ],
    hints: [
      "Walk the array with a pointer that advances by 4 bytes.",
      "Track the remaining count separately from the pointer.",
      "Initialize the sum to zero before entering the loop.",
    ],
    starterCode: [
      "# Sum Array",
      "# Input:  x10 = base address, x11 = element count",
      "# Output: x12 = sum of all elements",
      "",
    ].join("\n"),
    testCases: P006_TESTS,
  },
  {
    id: "p007",
    number: 7,
    title: "Fibonacci (Iterative)",
    difficulty: "Medium",
    tags: ["Loops", "Arithmetic"],
    acceptanceRate: 47.3,
    stepLimit: 10000,
    description: `
      <p>Compute the Nth Fibonacci number where N is in <code>x10</code>. Store the result in <code>x11</code>.</p>
      <p>F(0) = 0, F(1) = 1, F(N) = F(N−1) + F(N−2)</p>
      <p><strong>Use an iterative solution.</strong> Recursive solutions will exceed the step limit for large N.</p>
    `,
    constraints: [
      "0 ≤ N ≤ 20",
      "Use a loop, not recursion",
      "Handle N = 0 and N = 1 as base cases",
    ],
    examples: [
      {
        input: "x10 = 6",
        output: "x11 = 8",
        explanation: "F(6) = 0, 1, 1, 2, 3, 5, 8",
      },
    ],
    hints: [
      "Handle the two base cases before the loop.",
      "Track the previous two Fibonacci values in registers.",
      "Each loop iteration computes the next value and shifts the window forward.",
    ],
    starterCode: [
      "# Fibonacci (Iterative)",
      "# Input:  x10 = N",
      "# Output: x11 = F(N)",
      "",
    ].join("\n"),
    testCases: P007_TESTS,
  },
  {
    id: "p008",
    number: 8,
    title: "Reverse Bits",
    difficulty: "Medium",
    tags: ["Bit Manipulation"],
    acceptanceRate: 41.7,
    stepLimit: 5000,
    description: `
      <p>Given a 32-bit value in <code>x10</code>, store its bit-reversed value in <code>x11</code>.</p>
      <p>Bit 31 becomes bit 0, bit 30 becomes bit 1, and so on.</p>
      <table>
        <tr><th>Input</th><th>Output</th></tr>
        <tr><td>0x00000001</td><td>0x80000000</td></tr>
        <tr><td>0x80000000</td><td>0x00000001</td></tr>
      </table>
    `,
    constraints: [
      "Treat x10 as an unsigned 32-bit value",
      "Process all 32 bits",
      "A loop-based bit-by-bit solution is expected",
    ],
    examples: [
      {
        input: "x10 = 0x00000001",
        output: "x11 = 0x80000000",
        explanation: "The least significant set bit becomes the most significant set bit.",
      },
    ],
    hints: [
      "Read the low bit each iteration, then shift the input right.",
      "Build the reversed answer by shifting the output left before inserting the next bit.",
      "You need a 32-iteration loop.",
    ],
    starterCode: [
      "# Reverse Bits",
      "# Input:  x10 = 32-bit value",
      "# Output: x11 = bit-reversed value",
      "",
    ].join("\n"),
    testCases: P008_TESTS,
  },
  {
    id: "p009",
    number: 9,
    title: "Stack Push and Pop",
    difficulty: "Medium",
    tags: ["Stack", "Memory", "Functions"],
    acceptanceRate: 44.9,
    description: `
      <p>Using <code>x2</code> (<code>sp</code>) as the stack pointer, push <code>x10</code> then push <code>x11</code> onto the stack. Then pop into <code>x12</code>, then pop into <code>x13</code>.</p>
      <p>After execution, <code>x12 = x11</code> and <code>x13 = x10</code> because the stack is LIFO.</p>
    `,
    constraints: [
      "Use SW to push and LW to pop",
      "Decrement SP by 4 before each push",
      "Increment SP by 4 after each pop",
      "Do not modify x10 or x11",
    ],
    examples: [
      {
        input: "x10 = 1, x11 = 2, sp = 0x7FFFFFFC",
        output: "x12 = 2, x13 = 1",
        explanation: "Push 1, push 2. Pop 2 into x12, then pop 1 into x13.",
      },
    ],
    hints: [
      "A push is addi sp, sp, -4 followed by sw.",
      "A pop is lw followed by addi sp, sp, 4.",
      "Because the stack is LIFO, the last pushed value is popped first.",
    ],
    starterCode: [
      "# Stack Push and Pop",
      "# Input:  x10, x11, x2 = sp",
      "# Output: x12 = popped x11, x13 = popped x10",
      "",
    ].join("\n"),
    testCases: P009_TESTS,
  },
  {
    id: "p010",
    number: 10,
    title: "Count Set Bits",
    difficulty: "Medium",
    tags: ["Bit Manipulation", "Loops"],
    acceptanceRate: 43.2,
    stepLimit: 5000,
    description: `
      <p>Given a 32-bit value in <code>x10</code>, count the number of bits that are 1 and store the result in <code>x11</code>.</p>
      <p>This is also known as Hamming weight or popcount.</p>
    `,
    constraints: [
      "Treat x10 as an unsigned 32-bit value",
      "0 ≤ result ≤ 32",
      "Loop through all 32 bits",
    ],
    examples: [
      {
        input: "x10 = 0x0000000B (0b1011)",
        output: "x11 = 3",
        explanation: "Three bits are set: bits 0, 1, and 3.",
      },
    ],
    hints: [
      "Inspect the low bit with ANDI x?, x10, 1.",
      "Shift the input right each iteration.",
      "Run the loop exactly 32 times so leading zeros are handled correctly.",
    ],
    starterCode: [
      "# Count Set Bits",
      "# Input:  x10 = 32-bit value",
      "# Output: x11 = number of set bits",
      "",
    ].join("\n"),
    testCases: P010_TESTS,
  },
  {
    id: "p011",
    number: 11,
    title: "Find Max in Array",
    difficulty: "Hard",
    tags: ["Memory", "Loops", "Control Flow"],
    acceptanceRate: 36.8,
    stepLimit: 10000,
    description: `
      <p>Given a base address in <code>x10</code> and element count in <code>x11</code> (≥ 1), find the maximum signed 32-bit integer in the array and store it in <code>x12</code>.</p>
    `,
    constraints: [
      "x11 ≥ 1",
      "Elements are signed 32-bit integers",
      "Initialize max to the first element, not 0",
    ],
    examples: [
      {
        input: "arr = [-1, -2, -3], n = 3",
        output: "x12 = -1",
        explanation: "Starting with the first element is critical when all values are negative.",
      },
    ],
    hints: [
      "Load the first element before the loop and use it as the initial max.",
      "Start the loop at the second element.",
      "Only overwrite max when the new value is larger.",
    ],
    starterCode: [
      "# Find Max in Array",
      "# Input:  x10 = base address, x11 = element count",
      "# Output: x12 = maximum element",
      "",
    ].join("\n"),
    testCases: P011_TESTS,
  },
  {
    id: "p012",
    number: 12,
    title: "String Length",
    difficulty: "Hard",
    tags: ["Memory", "Loops", "Strings"],
    acceptanceRate: 33.1,
    stepLimit: 10000,
    description: `
      <p>Given the address of a null-terminated ASCII string in <code>x10</code>, store the length (not counting the null terminator) in <code>x11</code>.</p>
      <p>Walk memory byte by byte using <code>LBU</code> until you find a zero byte.</p>
    `,
    constraints: [
      "String is null-terminated",
      "Use LBU to read each byte",
      "Maximum string length is 100 bytes",
    ],
    examples: [
      {
        input: "\"hello\\0\" at 0x10000000",
        output: "x11 = 5",
        explanation: "\"hello\" has 5 characters.",
      },
    ],
    hints: [
      "Use a pointer register that starts at x10.",
      "Stop the loop when the loaded byte is zero.",
      "Increment both the pointer and the length counter together.",
    ],
    starterCode: [
      "# String Length",
      "# Input:  x10 = address of null-terminated string",
      "# Output: x11 = number of characters before the zero byte",
      "",
    ].join("\n"),
    testCases: P012_TESTS,
  },
  {
    id: "p013",
    number: 13,
    title: "Bubble Sort",
    difficulty: "Hard",
    tags: ["Sorting", "Memory", "Loops"],
    acceptanceRate: 27.4,
    stepLimit: 50000,
    description: `
      <p>Given a base address in <code>x10</code> and count in <code>x11</code>, sort the array of signed 32-bit integers in ascending order <strong>in place</strong>.</p>
      <p>Implement bubble sort:</p>
      <pre><code>for i in 0..n-1:
  for j in 0..n-i-2:
    if arr[j] &gt; arr[j+1]: swap</code></pre>
    `,
    constraints: [
      "Sort ascending",
      "Modify memory in place",
      "n ≥ 1 always",
    ],
    examples: [
      {
        input: "arr = [3, 1, 2], n = 3",
        output: "arr = [1, 2, 3]",
        explanation: "After two passes, the array is sorted.",
      },
    ],
    hints: [
      "Bubble sort needs a nested loop: passes on the outside, adjacent comparisons on the inside.",
      "The inner loop shrinks as the largest elements settle at the end.",
      "A swap needs two loads and two stores.",
    ],
    starterCode: [
      "# Bubble Sort",
      "# Input:  x10 = base address, x11 = element count",
      "# Output: array sorted in ascending order in memory",
      "",
    ].join("\n"),
    testCases: P013_TESTS,
  },
  {
    id: "p014",
    number: 14,
    title: "GCD (Euclidean)",
    difficulty: "Hard",
    tags: ["Arithmetic", "Loops", "Functions"],
    acceptanceRate: 29.6,
    stepLimit: 10000,
    description: `
      <p>Compute the Greatest Common Divisor of two positive integers in <code>x10</code> and <code>x11</code> using the Euclidean algorithm. Store the result in <code>x12</code>.</p>
      <p>Euclidean algorithm:</p>
      <pre><code>while b != 0:
  temp = b
  b = a % b
  a = temp
return a</code></pre>
      <p>In RISC-V, use the <code>REM</code> instruction for modulo.</p>
    `,
    constraints: [
      "x10, x11 > 0",
      "Use REM",
      "Iterative only",
    ],
    examples: [
      {
        input: "x10 = 48, x11 = 18",
        output: "x12 = 6",
        explanation: "GCD(48, 18) = 6",
      },
    ],
    hints: [
      "Keep swapping a and b until b becomes zero.",
      "Use a temporary register to preserve the old b value.",
      "REM gives you a % b directly.",
    ],
    starterCode: [
      "# GCD (Euclidean)",
      "# Input:  x10 = a, x11 = b",
      "# Output: x12 = gcd(a, b)",
      "",
    ].join("\n"),
    testCases: P014_TESTS,
  },
  {
    id: "p015",
    number: 15,
    title: "Matrix Trace",
    difficulty: "Hard",
    tags: ["Memory", "Loops", "Arrays"],
    acceptanceRate: 24.3,
    stepLimit: 20000,
    description: `
      <p>Given a base address in <code>x10</code> and dimension N in <code>x11</code>, compute the trace of an N×N matrix of 32-bit integers stored in row-major order. Store the result in <code>x12</code>.</p>
      <p>The trace is the sum of diagonal elements: <code>A[0][0] + A[1][1] + ... + A[N-1][N-1]</code></p>
      <p>Element <code>A[i][j]</code> is at <code>base + (i * N + j) * 4</code>.</p>
    `,
    constraints: [
      "1 ≤ N ≤ 8",
      "Elements are signed 32-bit integers",
      "Matrix is stored in row-major order",
    ],
    examples: [
      {
        input: "N = 2, matrix = [[1, 2], [3, 4]]",
        output: "x12 = 5",
        explanation: "1 + 4 = 5",
      },
    ],
    hints: [
      "Diagonal positions are A[i][i].",
      "For each i, compute the linear index i * N + i.",
      "Multiply the linear index by 4 to get the byte offset.",
    ],
    starterCode: [
      "# Matrix Trace",
      "# Input:  x10 = base address, x11 = dimension N",
      "# Output: x12 = sum of diagonal elements",
      "",
    ].join("\n"),
    testCases: P015_TESTS,
  },
];

export const PROBLEM_BY_ID: Record<string, Problem> = Object.fromEntries(PROBLEMS.map((problem) => [problem.id, problem]));

export function getProblems(): Problem[] {
  return PROBLEMS.slice();
}

export function getProblem(problemId: string | null | undefined): Problem | undefined {
  if (!problemId) {
    return undefined;
  }
  return PROBLEM_BY_ID[problemId];
}

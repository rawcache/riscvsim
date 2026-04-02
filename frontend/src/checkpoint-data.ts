export type Difficulty = "Easy" | "Medium" | "Hard";
export type Tier = "Guest" | "Free" | "Pro";
export type Verdict =
  | "Accepted"
  | "Wrong Answer"
  | "Runtime Error"
  | "Time Limit Exceeded"
  | "Assembly Error";

export interface TestCase {
  id: string;
  label: string;
  visible: boolean;
  description: string;
  initialRegisters: Partial<Record<string, number>>;
  initialMemory?: Array<{
    address: number;
    value: number;
    size: "byte" | "half" | "word";
  }>;
  expectedRegisters: Partial<Record<string, number>>;
  expectedMemory?: Array<{
    address: number;
    value: number;
    size: "byte" | "half" | "word";
  }>;
  stepLimit?: number;
  explanation?: string;
}

export interface CheckpointExample {
  input: string;
  output: string;
  explanation: string;
  registers?: Array<{
    name: string;
    value: string;
  }>;
}

export interface CheckpointProblem {
  id: "cp1" | "cp2" | "cp3" | "cp4" | "cp5" | "cp6" | "cp7" | "cp8";
  title: string;
  difficulty: Difficulty;
  tags: string[];
  unlocksAfterLessons: number[];
  requiredTier: Tier;
  estimatedMinutes: number;
  description: string;
  constraints: string[];
  examples: CheckpointExample[];
  hints: string[];
  approach: string;
  starterCode: string;
  testCases: TestCase[];
  companies?: string[];
  relatedLessons: number[];
  stepLimit?: number;
}

export interface CheckpointSubmission {
  problemId: string;
  code: string;
  verdict: Verdict;
  passedCases: number;
  totalCases: number;
  executionSteps: number;
  submittedAt: string;
  failedCaseId?: string;
  errorMessage?: string;
  elapsedSeconds?: number;
}

export interface CheckpointProgress {
  [problemId: string]: {
    completed: boolean;
    bestSubmission?: CheckpointSubmission;
    allSubmissions: CheckpointSubmission[];
    hintsRevealed: number;
    startedAt: string;
    completedAt?: string;
  };
}

export type CheckpointHarness = {
  type: "program" | "call";
  entryLabel?: string;
};

type InternalTestCase = TestCase & {
  __checkpointHarness?: CheckpointHarness;
};

const DATA_BASE = 0x10000000;

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

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

function exampleRegisters(entries: Array<[string, number]>): NonNullable<CheckpointExample["registers"]> {
  return entries.map(([name, value]) => ({
    name,
    value: formatValue(value),
  }));
}

function wordMemory(address: number, values: number[]): NonNullable<TestCase["initialMemory"]> {
  return values.map((value, index) => ({
    address: address + index * 4,
    value,
    size: "word" as const,
  }));
}

function wordExpectations(address: number, values: number[]): NonNullable<TestCase["expectedMemory"]> {
  return values.map((value, index) => ({
    address: address + index * 4,
    value,
    size: "word" as const,
  }));
}

function createTestCase(testCase: TestCase): TestCase {
  return testCase;
}

function withCallHarness(testCase: TestCase, entryLabel: string): TestCase {
  return Object.assign(testCase, {
    __checkpointHarness: {
      type: "call",
      entryLabel,
    } satisfies CheckpointHarness,
  } satisfies Pick<InternalTestCase, "__checkpointHarness">);
}

const CP1_TESTS = [
  createTestCase({
    id: "cp1-case-1",
    label: "Case 1",
    visible: true,
    description: "x10=3, x11=5 → x12=8",
    initialRegisters: { x10: 3, x11: 5 },
    expectedRegisters: { x10: 3, x11: 5, x12: 8 },
    explanation: "Basic addition.",
  }),
  createTestCase({
    id: "cp1-case-2",
    label: "Case 2",
    visible: true,
    description: "x10=0, x11=0 → x12=0",
    initialRegisters: { x10: 0, x11: 0 },
    expectedRegisters: { x10: 0, x11: 0, x12: 0 },
    explanation: "Zero case.",
  }),
  createTestCase({
    id: "cp1-case-3",
    label: "Case 3",
    visible: true,
    description: "x10=100, x11=200 → x12=300",
    initialRegisters: { x10: 100, x11: 200 },
    expectedRegisters: { x10: 100, x11: 200, x12: 300 },
    explanation: "Larger values.",
  }),
  createTestCase({
    id: "cp1-case-4",
    label: "Case 4",
    visible: false,
    description: "x10=1, x11=1 → x12=2",
    initialRegisters: { x10: 1, x11: 1 },
    expectedRegisters: { x10: 1, x11: 1, x12: 2 },
  }),
  createTestCase({
    id: "cp1-case-5",
    label: "Case 5",
    visible: false,
    description: "x10=2147483647, x11=0 → x12=2147483647",
    initialRegisters: { x10: 2147483647, x11: 0 },
    expectedRegisters: { x10: 2147483647, x11: 0, x12: 2147483647 },
  }),
  createTestCase({
    id: "cp1-case-6",
    label: "Case 6",
    visible: false,
    description: "x10=1000, x11=337 → x12=1337",
    initialRegisters: { x10: 1000, x11: 337 },
    expectedRegisters: { x10: 1000, x11: 337, x12: 1337 },
  }),
  createTestCase({
    id: "cp1-case-7",
    label: "Case 7",
    visible: false,
    description: "x10=255, x11=1 → x12=256",
    initialRegisters: { x10: 255, x11: 1 },
    expectedRegisters: { x10: 255, x11: 1, x12: 256 },
  }),
  createTestCase({
    id: "cp1-case-8",
    label: "Case 8",
    visible: false,
    description: "x10=16, x11=16 → x12=32",
    initialRegisters: { x10: 16, x11: 16 },
    expectedRegisters: { x10: 16, x11: 16, x12: 32 },
  }),
];

const CP2_TESTS = [
  createTestCase({
    id: "cp2-case-1",
    label: "Case 1",
    visible: true,
    description: "Start with x10=0 and load 42",
    initialRegisters: { x10: 0 },
    expectedRegisters: { x10: 42 },
    explanation: "The starting value should not matter.",
  }),
  createTestCase({
    id: "cp2-case-2",
    label: "Case 2",
    visible: true,
    description: "Start with x10=7 and still load 42",
    initialRegisters: { x10: 7 },
    expectedRegisters: { x10: 42 },
    explanation: "Using x10 as a source would fail here.",
  }),
  createTestCase({
    id: "cp2-case-3",
    label: "Case 3",
    visible: true,
    description: "Start with x10=-4 and still load 42",
    initialRegisters: { x10: -4 },
    expectedRegisters: { x10: 42 },
    explanation: "The correct source register is x0.",
  }),
  createTestCase({
    id: "cp2-case-4",
    label: "Case 4",
    visible: false,
    description: "Start with x10=99 and load 42",
    initialRegisters: { x10: 99 },
    expectedRegisters: { x10: 42 },
  }),
  createTestCase({
    id: "cp2-case-5",
    label: "Case 5",
    visible: false,
    description: "Start with x10=1234 and load 42",
    initialRegisters: { x10: 1234 },
    expectedRegisters: { x10: 42 },
  }),
  createTestCase({
    id: "cp2-case-6",
    label: "Case 6",
    visible: false,
    description: "Start with x10=-1024 and load 42",
    initialRegisters: { x10: -1024 },
    expectedRegisters: { x10: 42 },
  }),
];

const CP3_TESTS = [
  createTestCase({
    id: "cp3-case-1",
    label: "Case 1",
    visible: true,
    description: "x10=5 → x12=5",
    initialRegisters: { x10: 5 },
    expectedRegisters: { x10: 5, x12: 5 },
    explanation: "Positive input should be copied.",
  }),
  createTestCase({
    id: "cp3-case-2",
    label: "Case 2",
    visible: true,
    description: "x10=0 → x12=0",
    initialRegisters: { x10: 0 },
    expectedRegisters: { x10: 0, x12: 0 },
    explanation: "Zero is not strictly greater than zero.",
  }),
  createTestCase({
    id: "cp3-case-3",
    label: "Case 3",
    visible: true,
    description: "x10=-3 → x12=0",
    initialRegisters: { x10: -3 },
    expectedRegisters: { x10: -3, x12: 0 },
    explanation: "Negative inputs clamp to zero.",
  }),
  createTestCase({
    id: "cp3-case-4",
    label: "Case 4",
    visible: false,
    description: "x10=2147483647 → x12=2147483647",
    initialRegisters: { x10: 2147483647 },
    expectedRegisters: { x10: 2147483647, x12: 2147483647 },
  }),
  createTestCase({
    id: "cp3-case-5",
    label: "Case 5",
    visible: false,
    description: "x10=-1 → x12=0",
    initialRegisters: { x10: -1 },
    expectedRegisters: { x10: -1, x12: 0 },
  }),
  createTestCase({
    id: "cp3-case-6",
    label: "Case 6",
    visible: false,
    description: "x10=1 → x12=1",
    initialRegisters: { x10: 1 },
    expectedRegisters: { x10: 1, x12: 1 },
  }),
  createTestCase({
    id: "cp3-case-7",
    label: "Case 7",
    visible: false,
    description: "x10=-2147483648 → x12=0",
    initialRegisters: { x10: -2147483648 },
    expectedRegisters: { x10: -2147483648, x12: 0 },
  }),
  createTestCase({
    id: "cp3-case-8",
    label: "Case 8",
    visible: false,
    description: "x10=100 → x12=100",
    initialRegisters: { x10: 100 },
    expectedRegisters: { x10: 100, x12: 100 },
  }),
];

const CP4_TESTS = [
  createTestCase({
    id: "cp4-case-1",
    label: "Case 1",
    visible: true,
    description: "mem[0x10000000]=7 → x11=7, mem[0x10000004]=14",
    initialRegisters: {},
    initialMemory: wordMemory(DATA_BASE, [7]),
    expectedRegisters: { x11: 7 },
    expectedMemory: wordExpectations(DATA_BASE + 4, [14]),
    explanation: "Load 7, double it, store at the next word.",
  }),
  createTestCase({
    id: "cp4-case-2",
    label: "Case 2",
    visible: true,
    description: "mem[0x10000000]=0 → x11=0, mem[0x10000004]=0",
    initialRegisters: {},
    initialMemory: wordMemory(DATA_BASE, [0]),
    expectedRegisters: { x11: 0 },
    expectedMemory: wordExpectations(DATA_BASE + 4, [0]),
    explanation: "Zero should remain zero after doubling.",
  }),
  createTestCase({
    id: "cp4-case-3",
    label: "Case 3",
    visible: true,
    description: "mem[0x10000000]=50 → x11=50, mem[0x10000004]=100",
    initialRegisters: {},
    initialMemory: wordMemory(DATA_BASE, [50]),
    expectedRegisters: { x11: 50 },
    expectedMemory: wordExpectations(DATA_BASE + 4, [100]),
    explanation: "The input comes from memory, not a hardcoded constant.",
  }),
  createTestCase({
    id: "cp4-case-4",
    label: "Case 4",
    visible: false,
    description: "mem[0x10000000]=1 → mem[0x10000004]=2",
    initialRegisters: {},
    initialMemory: wordMemory(DATA_BASE, [1]),
    expectedRegisters: { x11: 1 },
    expectedMemory: wordExpectations(DATA_BASE + 4, [2]),
  }),
  createTestCase({
    id: "cp4-case-5",
    label: "Case 5",
    visible: false,
    description: "mem[0x10000000]=1000 → mem[0x10000004]=2000",
    initialRegisters: {},
    initialMemory: wordMemory(DATA_BASE, [1000]),
    expectedRegisters: { x11: 1000 },
    expectedMemory: wordExpectations(DATA_BASE + 4, [2000]),
  }),
  createTestCase({
    id: "cp4-case-6",
    label: "Case 6",
    visible: false,
    description: "mem[0x10000000]=2147483647 → mem[0x10000004]=4294967294",
    initialRegisters: {},
    initialMemory: wordMemory(DATA_BASE, [2147483647]),
    expectedRegisters: { x11: 2147483647 },
    expectedMemory: wordExpectations(DATA_BASE + 4, [-2]),
  }),
  createTestCase({
    id: "cp4-case-7",
    label: "Case 7",
    visible: false,
    description: "mem[0x10000000]=255 → mem[0x10000004]=510",
    initialRegisters: {},
    initialMemory: wordMemory(DATA_BASE, [255]),
    expectedRegisters: { x11: 255 },
    expectedMemory: wordExpectations(DATA_BASE + 4, [510]),
  }),
];

const CP5_STEP_LIMIT = 5000;
const CP5_TESTS = [
  createTestCase({
    id: "cp5-case-1",
    label: "Case 1",
    visible: true,
    description: "arr=[10,20,30], n=3 → x12=60",
    initialRegisters: { x10: DATA_BASE, x11: 3 },
    initialMemory: wordMemory(DATA_BASE, [10, 20, 30]),
    expectedRegisters: { x10: DATA_BASE, x11: 3, x12: 60 },
    stepLimit: CP5_STEP_LIMIT,
    explanation: "Sum the three array elements.",
  }),
  createTestCase({
    id: "cp5-case-2",
    label: "Case 2",
    visible: true,
    description: "arr=[], n=0 → x12=0",
    initialRegisters: { x10: DATA_BASE, x11: 0 },
    expectedRegisters: { x10: DATA_BASE, x11: 0, x12: 0 },
    stepLimit: CP5_STEP_LIMIT,
    explanation: "The empty array should return zero.",
  }),
  createTestCase({
    id: "cp5-case-3",
    label: "Case 3",
    visible: true,
    description: "arr=[5], n=1 → x12=5",
    initialRegisters: { x10: DATA_BASE, x11: 1 },
    initialMemory: wordMemory(DATA_BASE, [5]),
    expectedRegisters: { x10: DATA_BASE, x11: 1, x12: 5 },
    stepLimit: CP5_STEP_LIMIT,
    explanation: "Single-element arrays still use the loop pattern.",
  }),
  createTestCase({
    id: "cp5-case-4",
    label: "Case 4",
    visible: false,
    description: "arr=[-1,-2,-3], n=3 → x12=-6",
    initialRegisters: { x10: DATA_BASE, x11: 3 },
    initialMemory: wordMemory(DATA_BASE, [-1, -2, -3]),
    expectedRegisters: { x10: DATA_BASE, x11: 3, x12: -6 },
    stepLimit: CP5_STEP_LIMIT,
  }),
  createTestCase({
    id: "cp5-case-5",
    label: "Case 5",
    visible: false,
    description: "arr=[0,0,0,0], n=4 → x12=0",
    initialRegisters: { x10: DATA_BASE, x11: 4 },
    initialMemory: wordMemory(DATA_BASE, [0, 0, 0, 0]),
    expectedRegisters: { x10: DATA_BASE, x11: 4, x12: 0 },
    stepLimit: CP5_STEP_LIMIT,
  }),
  createTestCase({
    id: "cp5-case-6",
    label: "Case 6",
    visible: false,
    description: "arr=[1..10], n=10 → x12=55",
    initialRegisters: { x10: DATA_BASE, x11: 10 },
    initialMemory: wordMemory(DATA_BASE, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    expectedRegisters: { x10: DATA_BASE, x11: 10, x12: 55 },
    stepLimit: CP5_STEP_LIMIT,
  }),
  createTestCase({
    id: "cp5-case-7",
    label: "Case 7",
    visible: false,
    description: "arr=[2147483647], n=1 → x12=2147483647",
    initialRegisters: { x10: DATA_BASE, x11: 1 },
    initialMemory: wordMemory(DATA_BASE, [2147483647]),
    expectedRegisters: { x10: DATA_BASE, x11: 1, x12: 2147483647 },
    stepLimit: CP5_STEP_LIMIT,
  }),
  createTestCase({
    id: "cp5-case-8",
    label: "Case 8",
    visible: false,
    description: "arr=[100]*20, n=20 → x12=2000",
    initialRegisters: { x10: DATA_BASE, x11: 20 },
    initialMemory: wordMemory(DATA_BASE, Array.from({ length: 20 }, () => 100)),
    expectedRegisters: { x10: DATA_BASE, x11: 20, x12: 2000 },
    stepLimit: CP5_STEP_LIMIT,
  }),
];

const CP6_TESTS = [
  withCallHarness(
    createTestCase({
      id: "cp6-case-1",
      label: "Case 1",
      visible: true,
      description: "a0=3, a1=7 → a0=7",
      initialRegisters: { x10: 3, x11: 7, x2: 0x7ffffffc },
      expectedRegisters: { x10: 7, x11: 7, x2: 0x7ffffffc },
      explanation: "Return the larger argument.",
    }),
    "max"
  ),
  withCallHarness(
    createTestCase({
      id: "cp6-case-2",
      label: "Case 2",
      visible: true,
      description: "a0=10, a1=2 → a0=10",
      initialRegisters: { x10: 10, x11: 2, x2: 0x7ffffffc },
      expectedRegisters: { x10: 10, x11: 2, x2: 0x7ffffffc },
      explanation: "The first argument already wins.",
    }),
    "max"
  ),
  withCallHarness(
    createTestCase({
      id: "cp6-case-3",
      label: "Case 3",
      visible: true,
      description: "a0=5, a1=5 → a0=5",
      initialRegisters: { x10: 5, x11: 5, x2: 0x7ffffffc },
      expectedRegisters: { x10: 5, x11: 5, x2: 0x7ffffffc },
      explanation: "Equal arguments should still return cleanly.",
    }),
    "max"
  ),
  withCallHarness(
    createTestCase({
      id: "cp6-case-4",
      label: "Case 4",
      visible: false,
      description: "a0=-1, a1=0 → a0=0",
      initialRegisters: { x10: -1, x11: 0, x2: 0x7ffffffc },
      expectedRegisters: { x10: 0, x11: 0, x2: 0x7ffffffc },
    }),
    "max"
  ),
  withCallHarness(
    createTestCase({
      id: "cp6-case-5",
      label: "Case 5",
      visible: false,
      description: "a0=2147483647, a1=0 → a0=2147483647",
      initialRegisters: { x10: 2147483647, x11: 0, x2: 0x7ffffffc },
      expectedRegisters: { x10: 2147483647, x11: 0, x2: 0x7ffffffc },
    }),
    "max"
  ),
  withCallHarness(
    createTestCase({
      id: "cp6-case-6",
      label: "Case 6",
      visible: false,
      description: "a0=-100, a1=-200 → a0=-100",
      initialRegisters: { x10: -100, x11: -200, x2: 0x7ffffffc },
      expectedRegisters: { x10: -100, x11: -200, x2: 0x7ffffffc },
    }),
    "max"
  ),
  withCallHarness(
    createTestCase({
      id: "cp6-case-7",
      label: "Case 7",
      visible: false,
      description: "a0=0, a1=0 → a0=0",
      initialRegisters: { x10: 0, x11: 0, x2: 0x7ffffffc },
      expectedRegisters: { x10: 0, x11: 0, x2: 0x7ffffffc },
    }),
    "max"
  ),
  withCallHarness(
    createTestCase({
      id: "cp6-case-8",
      label: "Case 8",
      visible: false,
      description: "a0=1, a1=2 → a0=2",
      initialRegisters: { x10: 1, x11: 2, x2: 0x7ffffffc },
      expectedRegisters: { x10: 2, x11: 2, x2: 0x7ffffffc },
    }),
    "max"
  ),
];

const CP7_STEP_LIMIT = 10000;
const CP7_TESTS = [
  createTestCase({
    id: "cp7-case-1",
    label: "Case 1",
    visible: true,
    description: "x10=0 → x11=0",
    initialRegisters: { x10: 0 },
    expectedRegisters: { x10: 0, x11: 0 },
    stepLimit: CP7_STEP_LIMIT,
    explanation: "F(0)=0.",
  }),
  createTestCase({
    id: "cp7-case-2",
    label: "Case 2",
    visible: true,
    description: "x10=1 → x11=1",
    initialRegisters: { x10: 1 },
    expectedRegisters: { x10: 1, x11: 1 },
    stepLimit: CP7_STEP_LIMIT,
    explanation: "F(1)=1.",
  }),
  createTestCase({
    id: "cp7-case-3",
    label: "Case 3",
    visible: true,
    description: "x10=5 → x11=5",
    initialRegisters: { x10: 5 },
    expectedRegisters: { x10: 5, x11: 5 },
    stepLimit: CP7_STEP_LIMIT,
    explanation: "The loop should build up to F(5).",
  }),
  createTestCase({
    id: "cp7-case-4",
    label: "Case 4",
    visible: false,
    description: "x10=2 → x11=1",
    initialRegisters: { x10: 2 },
    expectedRegisters: { x10: 2, x11: 1 },
    stepLimit: CP7_STEP_LIMIT,
  }),
  createTestCase({
    id: "cp7-case-5",
    label: "Case 5",
    visible: false,
    description: "x10=6 → x11=8",
    initialRegisters: { x10: 6 },
    expectedRegisters: { x10: 6, x11: 8 },
    stepLimit: CP7_STEP_LIMIT,
  }),
  createTestCase({
    id: "cp7-case-6",
    label: "Case 6",
    visible: false,
    description: "x10=10 → x11=55",
    initialRegisters: { x10: 10 },
    expectedRegisters: { x10: 10, x11: 55 },
    stepLimit: CP7_STEP_LIMIT,
  }),
  createTestCase({
    id: "cp7-case-7",
    label: "Case 7",
    visible: false,
    description: "x10=15 → x11=610",
    initialRegisters: { x10: 15 },
    expectedRegisters: { x10: 15, x11: 610 },
    stepLimit: CP7_STEP_LIMIT,
  }),
  createTestCase({
    id: "cp7-case-8",
    label: "Case 8",
    visible: false,
    description: "x10=20 → x11=6765",
    initialRegisters: { x10: 20 },
    expectedRegisters: { x10: 20, x11: 6765 },
    stepLimit: CP7_STEP_LIMIT,
  }),
  createTestCase({
    id: "cp7-case-9",
    label: "Case 9",
    visible: false,
    description: "x10=3 → x11=2",
    initialRegisters: { x10: 3 },
    expectedRegisters: { x10: 3, x11: 2 },
    stepLimit: CP7_STEP_LIMIT,
  }),
];

const CP8_STEP_LIMIT = 50000;
const CP8_TESTS = [
  createTestCase({
    id: "cp8-case-1",
    label: "Case 1",
    visible: true,
    description: "arr=[3,1,2], n=3 → [1,2,3]",
    initialRegisters: { x10: DATA_BASE, x11: 3 },
    initialMemory: wordMemory(DATA_BASE, [3, 1, 2]),
    expectedRegisters: { x10: DATA_BASE, x11: 3 },
    expectedMemory: wordExpectations(DATA_BASE, [1, 2, 3]),
    stepLimit: CP8_STEP_LIMIT,
    explanation: "One swap on each pass should sort the array.",
  }),
  createTestCase({
    id: "cp8-case-2",
    label: "Case 2",
    visible: true,
    description: "arr=[5], n=1 → [5]",
    initialRegisters: { x10: DATA_BASE, x11: 1 },
    initialMemory: wordMemory(DATA_BASE, [5]),
    expectedRegisters: { x10: DATA_BASE, x11: 1 },
    expectedMemory: wordExpectations(DATA_BASE, [5]),
    stepLimit: CP8_STEP_LIMIT,
    explanation: "Single-element arrays are already sorted.",
  }),
  createTestCase({
    id: "cp8-case-3",
    label: "Case 3",
    visible: true,
    description: "arr=[2,1], n=2 → [1,2]",
    initialRegisters: { x10: DATA_BASE, x11: 2 },
    initialMemory: wordMemory(DATA_BASE, [2, 1]),
    expectedRegisters: { x10: DATA_BASE, x11: 2 },
    expectedMemory: wordExpectations(DATA_BASE, [1, 2]),
    stepLimit: CP8_STEP_LIMIT,
    explanation: "The minimal non-trivial sort case.",
  }),
  createTestCase({
    id: "cp8-case-4",
    label: "Case 4",
    visible: false,
    description: "arr=[5,4,3,2,1], n=5 → [1,2,3,4,5]",
    initialRegisters: { x10: DATA_BASE, x11: 5 },
    initialMemory: wordMemory(DATA_BASE, [5, 4, 3, 2, 1]),
    expectedRegisters: { x10: DATA_BASE, x11: 5 },
    expectedMemory: wordExpectations(DATA_BASE, [1, 2, 3, 4, 5]),
    stepLimit: CP8_STEP_LIMIT,
  }),
  createTestCase({
    id: "cp8-case-5",
    label: "Case 5",
    visible: false,
    description: "arr=[1,2,3,4,5], n=5 → [1,2,3,4,5]",
    initialRegisters: { x10: DATA_BASE, x11: 5 },
    initialMemory: wordMemory(DATA_BASE, [1, 2, 3, 4, 5]),
    expectedRegisters: { x10: DATA_BASE, x11: 5 },
    expectedMemory: wordExpectations(DATA_BASE, [1, 2, 3, 4, 5]),
    stepLimit: CP8_STEP_LIMIT,
  }),
  createTestCase({
    id: "cp8-case-6",
    label: "Case 6",
    visible: false,
    description: "arr=[-3,0,5,-1], n=4 → [-3,-1,0,5]",
    initialRegisters: { x10: DATA_BASE, x11: 4 },
    initialMemory: wordMemory(DATA_BASE, [-3, 0, 5, -1]),
    expectedRegisters: { x10: DATA_BASE, x11: 4 },
    expectedMemory: wordExpectations(DATA_BASE, [-3, -1, 0, 5]),
    stepLimit: CP8_STEP_LIMIT,
  }),
  createTestCase({
    id: "cp8-case-7",
    label: "Case 7",
    visible: false,
    description: "arr=[42,42,42], n=3 → [42,42,42]",
    initialRegisters: { x10: DATA_BASE, x11: 3 },
    initialMemory: wordMemory(DATA_BASE, [42, 42, 42]),
    expectedRegisters: { x10: DATA_BASE, x11: 3 },
    expectedMemory: wordExpectations(DATA_BASE, [42, 42, 42]),
    stepLimit: CP8_STEP_LIMIT,
  }),
  createTestCase({
    id: "cp8-case-8",
    label: "Case 8",
    visible: false,
    description: "arr=[100,1,50,2,75], n=5 → [1,2,50,75,100]",
    initialRegisters: { x10: DATA_BASE, x11: 5 },
    initialMemory: wordMemory(DATA_BASE, [100, 1, 50, 2, 75]),
    expectedRegisters: { x10: DATA_BASE, x11: 5 },
    expectedMemory: wordExpectations(DATA_BASE, [1, 2, 50, 75, 100]),
    stepLimit: CP8_STEP_LIMIT,
  }),
];

export const CHECKPOINT_PROBLEMS: CheckpointProblem[] = [
  {
    id: "cp1",
    title: "Add Two Registers",
    difficulty: "Easy",
    tags: ["Arithmetic", "Registers"],
    unlocksAfterLessons: range(1, 5),
    requiredTier: "Guest",
    estimatedMinutes: 5,
    description: `
      <p>Given two integer values in registers <code>x10</code> and <code>x11</code>, compute their sum and store it in <code>x12</code>.</p>
      <p>This is the most fundamental operation in RISC-V: adding two registers together. The <code>ADD</code> instruction takes three operands, destination first and then the two sources.</p>
    `,
    constraints: [
      "Values in x10 and x11 are non-negative 32-bit integers.",
      "Use exactly one instruction.",
      "Do not modify x10 or x11.",
    ],
    examples: [
      {
        input: "x10 = 3, x11 = 5",
        output: "x12 = 8",
        explanation: "3 + 5 = 8.",
        registers: exampleRegisters([
          ["x10", 3],
          ["x11", 5],
          ["x12", 8],
        ]),
      },
      {
        input: "x10 = 0, x11 = 42",
        output: "x12 = 42",
        explanation: "Adding zero returns the other value.",
      },
    ],
    hints: [
      "The ADD instruction computes rd = rs1 + rs2.",
      "Syntax: add rd, rs1, rs2 where rd is the destination.",
      "add x12, x10, x11 stores x10 + x11 into x12.",
    ],
    approach: `
      <p>The optimal solution is a single instruction:</p>
      <pre><code>add x12, x10, x11</code></pre>
      <p>This uses the R-type <code>ADD</code> instruction, which reads two source registers and writes the sum to one destination register in a single step.</p>
    `,
    starterCode: `# Checkpoint 1: Add Two Registers
# Input:  x10 = first operand
#         x11 = second operand
# Output: x12 = x10 + x11
#
# Hint: The ADD instruction takes three register operands.
# Write your solution below:
`,
    testCases: CP1_TESTS,
    companies: ["ECE 2035 Fundamentals"],
    relatedLessons: [1],
  },
  {
    id: "cp2",
    title: "Load Immediate Value",
    difficulty: "Easy",
    tags: ["Immediate", "Registers", "ADDI"],
    unlocksAfterLessons: range(1, 5),
    requiredTier: "Guest",
    estimatedMinutes: 5,
    description: `
      <p>Load the decimal value <strong>42</strong> into register <code>x10</code> without using any other registers as sources. Use <code>x0</code>, which is always zero.</p>
      <p>Loading a constant into a register is one of the most common operations in assembly programming. RISC-V uses <code>ADDI</code> to add a 12-bit signed immediate to a register.</p>
    `,
    constraints: [
      "Use only one instruction.",
      "The source register must be x0.",
      "The final value must be exactly 42 (0x0000002A).",
    ],
    examples: [
      {
        input: "No inputs — load a constant",
        output: "x10 = 42",
        explanation: "ADDI adds an immediate to a register. x0 + 42 = 42.",
      },
    ],
    hints: [
      "x0 is always 0. Adding 42 to 0 gives 42.",
      "ADDI syntax: addi rd, rs1, imm.",
      "addi x10, x0, 42 loads 42 into x10.",
    ],
    approach: `
      <p>You only need one instruction:</p>
      <pre><code>addi x10, x0, 42</code></pre>
      <p>Because <code>x0</code> is permanently zero, adding the immediate value <code>42</code> produces the constant directly in <code>x10</code>.</p>
    `,
    starterCode: `# Checkpoint 2: Load Immediate Value
# Goal: place decimal 42 into x10
# Constraint: use x0 as the source register
#
# Write one instruction below:
`,
    testCases: CP2_TESTS,
    relatedLessons: [1],
  },
  {
    id: "cp3",
    title: "Conditional Move",
    difficulty: "Easy",
    tags: ["Branches", "Comparison", "Control Flow"],
    unlocksAfterLessons: range(1, 10),
    requiredTier: "Free",
    estimatedMinutes: 15,
    description: `
      <p>If the value in <code>x10</code> is strictly greater than zero, copy it into <code>x12</code>. Otherwise, store zero in <code>x12</code>.</p>
      <p>This implements the C expression <code>x12 = (x10 &gt; 0) ? x10 : 0</code>.</p>
      <p>You will need a branch instruction to choose between two code paths.</p>
    `,
    constraints: [
      "x10 may be any signed 32-bit integer, including negative values.",
      "Do not use pseudo-instructions such as li or mv.",
      "x10 must not be modified.",
    ],
    examples: [
      {
        input: "x10 = 5",
        output: "x12 = 5",
        explanation: "5 > 0, so copy x10 to x12.",
      },
      {
        input: "x10 = 0",
        output: "x12 = 0",
        explanation: "0 is not greater than 0, so store 0.",
      },
      {
        input: "x10 = -3",
        output: "x12 = 0",
        explanation: "-3 is not greater than 0, so store 0.",
      },
    ],
    hints: [
      "Use a signed branch against zero to choose the correct code path.",
      "You need one path where x10 is copied and another path where x12 becomes zero.",
      "addi x12, x0, 0 stores zero without using li.",
      "Base RISC-V does not have bgt. A common pattern is bge x0, x10, zero_case.",
    ],
    approach: `
      <p>A clean solution branches to the zero case when <code>x10 &lt;= 0</code>, then copies the positive value otherwise:</p>
      <pre><code>bge x0, x10, zero_case
add x12, x10, x0
beq x0, x0, done
zero_case:
addi x12, x0, 0
done:</code></pre>
      <p>This preserves <code>x10</code> and uses a straight two-path control-flow pattern that generalizes to more complex branches later in the course.</p>
    `,
    starterCode: `# Checkpoint 3: Conditional Move
# If x10 > 0, copy it to x12.
# Otherwise store 0 in x12.
#
# Do not use pseudo-instructions.
`,
    testCases: CP3_TESTS,
    companies: ["ECE 2035", "Interview Prep"],
    relatedLessons: [3, 8],
  },
  {
    id: "cp4",
    title: "Memory Store and Load",
    difficulty: "Easy",
    tags: ["Memory", "Load", "Store", "LW", "SW"],
    unlocksAfterLessons: range(1, 10),
    requiredTier: "Free",
    estimatedMinutes: 15,
    description: `
      <p>A value is stored in memory at address <code>0x10000000</code>, the start of the data segment. Load it into <code>x11</code>, double it, and store the result back to <code>0x10000004</code>.</p>
      <p>This checkpoint tests your ability to use <code>LW</code> and <code>SW</code> with correct addressing.</p>
    `,
    constraints: [
      "Load from exactly 0x10000000.",
      "Store to exactly 0x10000004.",
      "The stored result must be exactly double the loaded value.",
      "Do not hardcode the input value.",
    ],
    examples: [
      {
        input: "mem[0x10000000] = 7",
        output: "mem[0x10000004] = 14, x11 = 7",
        explanation: "Load 7, double it to 14, and store at the next word.",
      },
    ],
    hints: [
      "Start by building the base address 0x10000000 in a register.",
      "Use lw to read the original word into x11.",
      "Doubling a register value can be done with add rd, rs, rs.",
      "Store the doubled value back with sw at offset 4.",
    ],
    approach: `
      <p>The standard pattern is:</p>
      <pre><code>lui t0, 65536
lw x11, 0(t0)
add t1, x11, x11
sw t1, 4(t0)</code></pre>
      <p><code>lui t0, 65536</code> produces <code>0x10000000</code>. From there, <code>lw</code>, <code>add</code>, and <code>sw</code> solve the problem cleanly.</p>
    `,
    starterCode: `# Checkpoint 4: Memory Store and Load
# Load the value at 0x10000000 into x11.
# Double it.
# Store the doubled value to 0x10000004.
`,
    testCases: CP4_TESTS,
    relatedLessons: [2],
  },
  {
    id: "cp5",
    title: "Sum an Array",
    difficulty: "Medium",
    tags: ["Arrays", "Loops", "Memory", "LW"],
    unlocksAfterLessons: range(1, 15),
    requiredTier: "Pro",
    estimatedMinutes: 25,
    description: `
      <p>Given a base address in <code>x10</code> and an element count in <code>x11</code>, sum all 32-bit word values in the array and store the result in <code>x12</code>.</p>
      <p>This is the assembly equivalent of <code>int sum = 0; for (int i = 0; i &lt; n; i++) sum += arr[i];</code></p>
    `,
    constraints: [
      "Array elements are signed 32-bit integers.",
      "x11 >= 0. If x11 = 0, store 0 in x12.",
      "Use LW for each element load.",
      "Elements are word-aligned and 4 bytes apart.",
      "Do not modify x10 or x11.",
    ],
    examples: [
      {
        input: "x10=0x10000000, x11=3, arr=[10,20,30]",
        output: "x12 = 60",
        explanation: "10 + 20 + 30 = 60.",
      },
    ],
    hints: [
      "Initialize x12 to 0 before the loop starts.",
      "Use a loop counter or decrement x11 into a temporary register instead of changing x11 itself.",
      "Each iteration should load one word, add it into the running sum, then advance the pointer by 4 bytes.",
      "Handle the n=0 case before entering the loop.",
    ],
    approach: `
      <p>A standard pointer-walk solution uses a temporary pointer and a temporary count:</p>
      <pre><code>addi x12, x0, 0
add t0, x10, x0
add t1, x11, x0
loop:
beq t1, x0, done
lw t2, 0(t0)
add x12, x12, t2
addi t0, t0, 4
addi t1, t1, -1
beq x0, x0, loop
done:</code></pre>
      <p>This preserves the input registers and mirrors the exact array-walk pattern used in later labs.</p>
    `,
    starterCode: `# Checkpoint 5: Sum an Array
# Input:  x10 = base address
#         x11 = element count
# Output: x12 = sum of all word values
#
# Do not modify x10 or x11.
`,
    testCases: CP5_TESTS,
    companies: ["ECE 2035 Labs"],
    relatedLessons: [2, 3],
    stepLimit: CP5_STEP_LIMIT,
  },
  {
    id: "cp6",
    title: "Call Convention: Return Max",
    difficulty: "Medium",
    tags: ["Functions", "Calling Convention", "Branches"],
    unlocksAfterLessons: range(1, 15),
    requiredTier: "Pro",
    estimatedMinutes: 30,
    description: `
      <p>Implement a function <code>max</code> that takes two arguments in <code>a0</code> and <code>a1</code> and returns the larger value in <code>a0</code>.</p>
      <p>Your code is called from a hidden test harness via <code>jal ra, max</code>. Your function must return with <code>ret</code> or <code>jalr x0, ra, 0</code>.</p>
      <p>This is exactly the calling-convention pattern used in ECE 2035 function labs.</p>
    `,
    constraints: [
      'The function label must be exactly "max:".',
      "Use RET or jalr x0, ra, 0 to return.",
      "Do not use the stack.",
      "Return the result in a0.",
      "Do not modify a1.",
    ],
    examples: [
      {
        input: "a0 = 3, a1 = 7",
        output: "a0 = 7",
        explanation: "7 is larger, so return a1.",
      },
      {
        input: "a0 = 10, a1 = 2",
        output: "a0 = 10",
        explanation: "The first argument is already the maximum.",
      },
      {
        input: "a0 = 5, a1 = 5",
        output: "a0 = 5",
        explanation: "Equal values can return either original value, which is still 5.",
      },
    ],
    hints: [
      "Compare a0 and a1 with a signed branch such as blt.",
      "If a0 < a1, copy a1 into a0 before returning.",
      "If a0 is already greater than or equal to a1, return immediately.",
      "You do not need the stack for this function.",
    ],
    approach: `
      <p>The canonical solution is a tiny branch-based function:</p>
      <pre><code>max:
blt a0, a1, take_a1
ret
take_a1:
add a0, a1, x0
ret</code></pre>
      <p><code>blt</code> handles the signed comparison, and using <code>add a0, a1, x0</code> avoids the <code>mv</code> pseudo-instruction.</p>
    `,
    starterCode: `# Return Max of Two Values
# Called as: jal ra, max
# a0 = first value, a1 = second value
# Return: a0 = max(a0, a1)
max:
    # Your code here

    ret
`,
    testCases: CP6_TESTS,
    companies: ["ECE 2035", "Interview Prep"],
    relatedLessons: [4, 9],
  },
  {
    id: "cp7",
    title: "Fibonacci (Iterative)",
    difficulty: "Hard",
    tags: ["Loops", "Fibonacci", "Registers"],
    unlocksAfterLessons: range(1, 20),
    requiredTier: "Pro",
    estimatedMinutes: 40,
    description: `
      <p>Compute the Nth Fibonacci number where <code>N</code> is in <code>x10</code>. Store the result in <code>x11</code>.</p>
      <p>The sequence is defined as <code>F(0)=0, F(1)=1, F(2)=1, F(3)=2, F(4)=3, F(5)=5...</code></p>
      <p>An <strong>iterative</strong> solution is expected. Recursive solutions will exceed the step limit on larger inputs.</p>
    `,
    constraints: [
      "0 <= N <= 20 and the result fits in 32 bits.",
      "Use an iterative solution only.",
      "Handle N=0 and N=1 as base cases.",
      "Store the result in x11 without destroying the input in x10.",
    ],
    examples: [
      {
        input: "x10 = 0",
        output: "x11 = 0",
        explanation: "The zeroth Fibonacci number is 0.",
      },
      {
        input: "x10 = 5",
        output: "x11 = 5",
        explanation: "The sequence up to F(5) is 0, 1, 1, 2, 3, 5.",
      },
    ],
    hints: [
      "Handle N=0 and N=1 before the loop.",
      "Track the previous two Fibonacci values in temporary registers.",
      "Each loop iteration computes next = prev + curr, then rotates the registers forward.",
      "A countdown loop is often simpler than recomputing an index comparison each time.",
    ],
    approach: `
      <p>The efficient solution keeps only two rolling values and updates them iteratively:</p>
      <pre><code>beq x10, x0, fib_zero
addi t0, x0, 0
addi t1, x0, 1
addi t2, x10, -1
loop:
beq t2, x0, done
add t3, t0, t1
add t0, t1, x0
add t1, t3, x0
addi t2, t2, -1
beq x0, x0, loop
done:
add x11, t1, x0</code></pre>
      <p>This runs in linear time and stays well under the step limit for every valid input.</p>
    `,
    starterCode: `# Checkpoint 7: Fibonacci (Iterative)
# Input:  x10 = N
# Output: x11 = F(N)
#
# Use an iterative solution.
`,
    testCases: CP7_TESTS,
    companies: ["ECE 2035", "Interview Prep"],
    relatedLessons: [3, 13],
    stepLimit: CP7_STEP_LIMIT,
  },
  {
    id: "cp8",
    title: "Bubble Sort (In Place)",
    difficulty: "Hard",
    tags: ["Sorting", "Arrays", "Memory", "Nested Loops"],
    unlocksAfterLessons: range(1, 20),
    requiredTier: "Pro",
    estimatedMinutes: 50,
    description: `
      <p>Given a base address in <code>x10</code> and a count in <code>x11</code>, sort the array of 32-bit integers in ascending order <strong>in place</strong>.</p>
      <p>This is the assembly version of bubble sort, the classic <code>O(n²)</code> sorting algorithm that shows up repeatedly in ECE 2035 labs.</p>
      <p>The classic bubble sort pattern is an outer loop over passes and an inner loop that swaps adjacent out-of-order elements.</p>
    `,
    constraints: [
      "Sort ascending, smallest value first.",
      "Sort the array in place.",
      "Array elements are signed 32-bit integers.",
      "Do not use any external memory beyond the array itself.",
      "n >= 1 always.",
    ],
    examples: [
      {
        input: "x10=0x10000000, x11=3, arr=[3,1,2]",
        output: "arr=[1,2,3]",
        explanation: "Bubble the largest value to the end on each pass.",
      },
    ],
    hints: [
      "Use two loops: one for the pass count and one for the adjacent comparisons.",
      "The inner loop compares arr[j] and arr[j+1], then swaps them when the left value is larger.",
      "Each pass shrinks the unsorted suffix by one element.",
      "For signed numbers, use a signed branch such as ble or bge with swapped operands to detect whether a swap is needed.",
    ],
    approach: `
      <p>A solid implementation uses two counters and walks adjacent word pairs in memory:</p>
      <pre><code>addi t0, x0, 0        # i
outer:
addi t1, x11, -1
sub t1, t1, t0        # inner bound = n - i - 1
beq t1, x0, done
add t2, x10, x0       # ptr
inner:
lw t3, 0(t2)
lw t4, 4(t2)
bge t4, t3, no_swap
sw t4, 0(t2)
sw t3, 4(t2)
no_swap:
addi t2, t2, 4
addi t1, t1, -1
bne t1, x0, inner
addi t0, t0, 1
beq x0, x0, outer
done:</code></pre>
      <p>The exact register choices can vary, but the core idea is always the same: two nested loops and an adjacent swap when the pair is out of order.</p>
    `,
    starterCode: `# Checkpoint 8: Bubble Sort (In Place)
# Input:  x10 = base address
#         x11 = element count
# Output: array sorted ascending in memory
#
# Sort in place.
`,
    testCases: CP8_TESTS,
    companies: ["ECE 2035 Labs", "Interview Prep"],
    relatedLessons: [5, 3, 2],
    stepLimit: CP8_STEP_LIMIT,
  },
];

export function getCheckpointProblems(): CheckpointProblem[] {
  return CHECKPOINT_PROBLEMS.slice();
}

export function getCheckpointProblem(problemId: CheckpointProblem["id"]): CheckpointProblem | undefined {
  return CHECKPOINT_PROBLEMS.find((problem) => problem.id === problemId);
}

export function getCheckpointNumber(problemId: CheckpointProblem["id"]): number {
  return Number.parseInt(problemId.replace("cp", ""), 10);
}

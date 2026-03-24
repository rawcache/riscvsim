import { getLesson, getLessonState, isUnlocked, loadProgress, type LessonState } from "./lessons";

const CHALLENGE_SUBMISSIONS_STORAGE_KEY = "studyriscv_challenge_submissions";
const LEGACY_CHALLENGE_SUBMISSIONS_STORAGE_KEY = "studyriscv_challenge_submissions";
const ID_TOKEN_KEY = "studyriscv_id_token";

export interface TestCase {
  id: string;
  description: string;
  setup: {
    registers?: Partial<Record<number, number>>;
    memory?: Array<{ address: number; value: number }>;
    program_prefix?: string;
  };
  check: (state: LessonState) => boolean;
  points: number;
}

export interface Challenge {
  id: string;
  title: string;
  description: string;
  difficulty: "easy" | "medium" | "hard";
  lessonId: string;
  tags: string[];
  points: number;
  starterCode: string;
  testCases: TestCase[];
  hint: string;
  solutionCode: string;
  estimatedMinutes: number;
}

export interface ChallengeSubmission {
  challengeId: string;
  userId?: string;
  code: string;
  passed: boolean;
  score: number;
  maxScore: number;
  testResults: {
    testCaseId: string;
    passed: boolean;
    description: string;
  }[];
  submittedAt: string;
  timeSpentSeconds: number;
  viewedAnswer?: boolean;
}

function regCase(
  id: string,
  description: string,
  register: number,
  expected: number,
  points: number,
  setup: TestCase["setup"] = {}
): TestCase {
  return {
    id,
    description,
    setup,
    points,
    check: (state) => state.registers[register] === (expected >>> 0),
  };
}

function emptySubmissions(): ChallengeSubmission[] {
  return [];
}

function decodeJwtUserId(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) {
      return null;
    }
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    const maybeBuffer = (globalThis as typeof globalThis & {
      Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } };
    }).Buffer;
    const json =
      typeof atob === "function"
        ? atob(padded)
        : maybeBuffer?.from(padded, "base64").toString("utf8") ?? "";
    const payload = JSON.parse(json) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub.trim().length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

function currentChallengeUserId(): string | null {
  if (typeof localStorage === "undefined" || typeof sessionStorage === "undefined") {
    return null;
  }
  const token = localStorage.getItem(ID_TOKEN_KEY) ?? sessionStorage.getItem(ID_TOKEN_KEY);
  return token ? decodeJwtUserId(token) : null;
}

function getChallengeSubmissionStorageKey(userId?: string | null): string {
  const scopedUserId = userId === undefined ? currentChallengeUserId() : userId;
  return scopedUserId ? `${CHALLENGE_SUBMISSIONS_STORAGE_KEY}:${scopedUserId}` : `${CHALLENGE_SUBMISSIONS_STORAGE_KEY}:guest`;
}

const CHALLENGES: Challenge[] = [
  {
    id: "challenge-1-sum-of-three",
    title: "Sum of Three",
    description: "Write a program that adds x1 and x2, then stores the result in x3. The harness sets x1 and x2 for each test case.",
    difficulty: "easy",
    lessonId: "lesson-1-registers",
    tags: ["registers", "arithmetic"],
    points: 30,
    starterCode: ["challenge_start:", "  # x1 and x2 are preloaded by the grader", "  # Add them and store the sum in x3", "  # YOUR CODE HERE"].join("\n"),
    testCases: [
      regCase("sum-three-1", "42 + 18 should produce 60", 3, 60, 10, {
        registers: { 1: 42, 2: 18 },
        program_prefix: "j challenge_start",
      }),
      regCase("sum-three-2", "7 + 9 should produce 16", 3, 16, 10, {
        registers: { 1: 7, 2: 9 },
        program_prefix: "j challenge_start",
      }),
      regCase("sum-three-3", "100 + 23 should produce 123", 3, 123, 10, {
        registers: { 1: 100, 2: 23 },
        program_prefix: "j challenge_start",
      }),
    ],
    hint: "The grader preloads x1 and x2. You only need one instruction: add x3, x1, x2.",
    solutionCode: ["challenge_start:", "  add x3, x1, x2"].join("\n"),
    estimatedMinutes: 8,
  },
  {
    id: "challenge-2-memory-roundtrip",
    title: "Memory Roundtrip",
    description: "Store the value in x1 to address 0x400, then load it back into x5.",
    difficulty: "easy",
    lessonId: "lesson-2-memory",
    tags: ["memory", "load/store"],
    points: 30,
    starterCode: [
      "challenge_start:",
      "  addi x2, x0, 0x400",
      "  # x1 is preloaded by the grader",
      "  # YOUR CODE HERE",
    ].join("\n"),
    testCases: [
      regCase("memory-roundtrip-1", "Roundtrip 0xDEAD", 5, 0xDEAD, 10, {
        registers: { 1: 0xDEAD },
        program_prefix: "j challenge_start",
      }),
      regCase("memory-roundtrip-2", "Roundtrip 99", 5, 99, 10, {
        registers: { 1: 99 },
        program_prefix: "j challenge_start",
      }),
      regCase("memory-roundtrip-3", "Roundtrip 0x1234", 5, 0x1234, 10, {
        registers: { 1: 0x1234 },
        program_prefix: "j challenge_start",
      }),
    ],
    hint: "Use sw x1, 0(x2) followed by lw x5, 0(x2).",
    solutionCode: ["challenge_start:", "  addi x2, x0, 0x400", "  sw   x1, 0(x2)", "  lw   x5, 0(x2)"].join("\n"),
    estimatedMinutes: 10,
  },
  {
    id: "challenge-3-fizzbuzz-lite",
    title: "FizzBuzz Lite",
    description: "Set x2 based on divisibility: 1 for divisible by 3, 2 for divisible by 5, 3 for both, 0 otherwise.",
    difficulty: "medium",
    lessonId: "lesson-3-branches",
    tags: ["branches", "divisibility"],
    points: 100,
    starterCode: [
      "challenge_start:",
      "  # x1 is preloaded with the test input",
      "  addi x2, x0, 0",
      "  # YOUR CODE HERE",
    ].join("\n"),
    testCases: [
      regCase("fizzbuzz-3", "x1=3 should store 1", 2, 1, 25, { registers: { 1: 3 }, program_prefix: "j challenge_start" }),
      regCase("fizzbuzz-5", "x1=5 should store 2", 2, 2, 25, { registers: { 1: 5 }, program_prefix: "j challenge_start" }),
      regCase("fizzbuzz-15", "x1=15 should store 3", 2, 3, 25, { registers: { 1: 15 }, program_prefix: "j challenge_start" }),
      regCase("fizzbuzz-7", "x1=7 should store 0", 2, 0, 25, { registers: { 1: 7 }, program_prefix: "j challenge_start" }),
    ],
    hint: "Use rem with 3 and 5, then branch on whether each remainder is zero.",
    solutionCode: [
      "challenge_start:",
      "  addi x2, x0, 0",
      "  addi t0, x0, 3",
      "  addi t1, x0, 5",
      "  rem  t2, x1, t0",
      "  rem  t3, x1, t1",
      "  bne  t2, x0, check_five",
      "  addi x2, x0, 1",
      "check_five:",
      "  bne  t3, x0, done",
      "  addi x2, x0, 2",
      "  bne  t2, x0, done",
      "  addi x2, x0, 3",
      "done:",
    ].join("\n"),
    estimatedMinutes: 20,
  },
  {
    id: "challenge-4-max-of-two",
    title: "Max of Two",
    description: "Write a max function that returns the larger of a0 and a1 in a0.",
    difficulty: "medium",
    lessonId: "lesson-4-functions",
    tags: ["functions", "calling convention"],
    points: 30,
    starterCode: [
      "challenge_start:",
      "  jal  ra, max_fn",
      "  beq  x0, x0, done",
      "max_fn:",
      "  # a0 and a1 are preloaded by the grader",
      "  # YOUR CODE HERE",
      "done:",
    ].join("\n"),
    testCases: [
      regCase("max-two-1", "(3,7) -> 7", 10, 7, 10, { registers: { 10: 3, 11: 7 }, program_prefix: "j challenge_start" }),
      regCase("max-two-2", "(10,2) -> 10", 10, 10, 10, { registers: { 10: 10, 11: 2 }, program_prefix: "j challenge_start" }),
      regCase("max-two-3", "(-1,0) -> 0", 10, 0, 10, { registers: { 10: 0xffffffff, 11: 0 }, program_prefix: "j challenge_start" }),
    ],
    hint: "Compare a0 and a1 with blt. If a0 < a1, copy a1 into a0, otherwise return directly.",
    solutionCode: [
      "challenge_start:",
      "  jal  ra, max_fn",
      "  beq  x0, x0, done",
      "max_fn:",
      "  blt  a0, a1, take_a1",
      "  ret",
      "take_a1:",
      "  add  a0, a1, x0",
      "  ret",
      "done:",
    ].join("\n"),
    estimatedMinutes: 12,
  },
  {
    id: "challenge-5-find-minimum",
    title: "Find Minimum",
    description: "Walk an integer array in memory and leave the minimum value in x5.",
    difficulty: "medium",
    lessonId: "lesson-5-sorting",
    tags: ["arrays", "loops"],
    points: 30,
    starterCode: [
      "challenge_start:",
      "  addi x1, x0, 0x100",
      "  addi x2, x0, 6",
      "  lw   x5, 0(x1)",
      "  addi x1, x1, 4",
      "  addi x2, x2, -1",
      "loop:",
      "  # YOUR CODE HERE",
      "done:",
    ].join("\n"),
    testCases: [
      regCase("min-array-1", "Minimum of [8,3,6,1,9,2] is 1", 5, 1, 10, {
        memory: [
          { address: 0x100, value: 8 },
          { address: 0x104, value: 3 },
          { address: 0x108, value: 6 },
          { address: 0x10c, value: 1 },
          { address: 0x110, value: 9 },
          { address: 0x114, value: 2 },
        ],
        program_prefix: "j challenge_start",
      }),
      regCase("min-array-2", "Minimum of [4,7,5,6,8,9] is 4", 5, 4, 10, {
        memory: [
          { address: 0x100, value: 4 },
          { address: 0x104, value: 7 },
          { address: 0x108, value: 5 },
          { address: 0x10c, value: 6 },
          { address: 0x110, value: 8 },
          { address: 0x114, value: 9 },
        ],
        program_prefix: "j challenge_start",
      }),
      regCase("min-array-3", "Minimum of [9,8,7,6,5,4] is 4", 5, 4, 10, {
        memory: [
          { address: 0x100, value: 9 },
          { address: 0x104, value: 8 },
          { address: 0x108, value: 7 },
          { address: 0x10c, value: 6 },
          { address: 0x110, value: 5 },
          { address: 0x114, value: 4 },
        ],
        program_prefix: "j challenge_start",
      }),
    ],
    hint: "Keep the current best value in x5. Load the next element and replace x5 if the new value is smaller.",
    solutionCode: [
      "challenge_start:",
      "  addi x1, x0, 0x100",
      "  addi x2, x0, 6",
      "  lw   x5, 0(x1)",
      "  addi x1, x1, 4",
      "  addi x2, x2, -1",
      "loop:",
      "  beq  x2, x0, done",
      "  lw   x3, 0(x1)",
      "  blt  x3, x5, take_min",
      "  beq  x0, x0, next_item",
      "take_min:",
      "  add  x5, x3, x0",
      "next_item:",
      "  addi x1, x1, 4",
      "  addi x2, x2, -1",
      "  beq  x0, x0, loop",
      "done:",
    ].join("\n"),
    estimatedMinutes: 18,
  },
  {
    id: "challenge-6-bit-counter",
    title: "Bit Counter",
    description: "Count how many 1-bits are set in x1 and store the count in x2.",
    difficulty: "medium",
    lessonId: "lesson-6-bitwise",
    tags: ["bitwise", "loops"],
    points: 30,
    starterCode: ["challenge_start:", "  addi x2, x0, 0", "  # x1 is preloaded", "  # YOUR CODE HERE"].join("\n"),
    testCases: [
      regCase("bit-counter-1", "0b10110101 has 5 set bits", 2, 5, 10, { registers: { 1: 0b10110101 }, program_prefix: "j challenge_start" }),
      regCase("bit-counter-2", "0b11110000 has 4 set bits", 2, 4, 10, { registers: { 1: 0b11110000 }, program_prefix: "j challenge_start" }),
      regCase("bit-counter-3", "0b00001111 has 4 set bits", 2, 4, 10, { registers: { 1: 0b00001111 }, program_prefix: "j challenge_start" }),
    ],
    hint: "Mask the lowest bit with andi, add it into x2, then shift x1 right until it becomes zero.",
    solutionCode: [
      "challenge_start:",
      "  addi x2, x0, 0",
      "count_loop:",
      "  beq  x1, x0, done",
      "  andi x3, x1, 1",
      "  add  x2, x2, x3",
      "  srli x1, x1, 1",
      "  beq  x0, x0, count_loop",
      "done:",
    ].join("\n"),
    estimatedMinutes: 16,
  },
  {
    id: "challenge-7-power-of-two",
    title: "Power of Two Check",
    description: "Set x2=1 if x1 is a power of two, else x2=0.",
    difficulty: "medium",
    lessonId: "lesson-7-shifts",
    tags: ["shifts", "bitwise"],
    points: 100,
    starterCode: ["challenge_start:", "  addi x2, x0, 0", "  # x1 is preloaded", "  # YOUR CODE HERE"].join("\n"),
    testCases: [
      regCase("power-two-1", "8 is a power of two", 2, 1, 25, { registers: { 1: 8 }, program_prefix: "j challenge_start" }),
      regCase("power-two-2", "12 is not a power of two", 2, 0, 25, { registers: { 1: 12 }, program_prefix: "j challenge_start" }),
      regCase("power-two-3", "1 is a power of two", 2, 1, 25, { registers: { 1: 1 }, program_prefix: "j challenge_start" }),
      regCase("power-two-4", "0 is not a power of two", 2, 0, 25, { registers: { 1: 0 }, program_prefix: "j challenge_start" }),
    ],
    hint: "A positive power of two has exactly one bit set, so x & (x - 1) is zero only for powers of two.",
    solutionCode: [
      "challenge_start:",
      "  addi x2, x0, 0",
      "  beq  x1, x0, done",
      "  addi x3, x1, -1",
      "  and  x4, x1, x3",
      "  bne  x4, x0, done",
      "  addi x2, x0, 1",
      "done:",
    ].join("\n"),
    estimatedMinutes: 18,
  },
  {
    id: "challenge-8-clamp",
    title: "Clamp",
    description: "Clamp x1 to the range [0, 100] and store the result in x2.",
    difficulty: "medium",
    lessonId: "lesson-8-comparison",
    tags: ["comparison", "branches"],
    points: 100,
    starterCode: ["challenge_start:", "  # x1 is preloaded", "  # YOUR CODE HERE"].join("\n"),
    testCases: [
      regCase("clamp-1", "-5 clamps to 0", 2, 0, 25, { registers: { 1: 0xfffffffb }, program_prefix: "j challenge_start" }),
      regCase("clamp-2", "50 stays 50", 2, 50, 25, { registers: { 1: 50 }, program_prefix: "j challenge_start" }),
      regCase("clamp-3", "150 clamps to 100", 2, 100, 25, { registers: { 1: 150 }, program_prefix: "j challenge_start" }),
      regCase("clamp-4", "0 stays 0", 2, 0, 25, { registers: { 1: 0 }, program_prefix: "j challenge_start" }),
    ],
    hint: "Handle the x1 < 0 case first, then the x1 > 100 case, otherwise copy x1 to x2.",
    solutionCode: [
      "challenge_start:",
      "  blt  x1, x0, clamp_low",
      "  addi x3, x0, 100",
      "  blt  x3, x1, clamp_high",
      "  add  x2, x1, x0",
      "  beq  x0, x0, done",
      "clamp_low:",
      "  addi x2, x0, 0",
      "  beq  x0, x0, done",
      "clamp_high:",
      "  addi x2, x0, 100",
      "done:",
    ].join("\n"),
    estimatedMinutes: 16,
  },
  {
    id: "challenge-9-stack-depth",
    title: "Stack Depth Counter",
    description: "Write a recursive countdown that proves the stack pointer returns to its original value after recursion unwinds.",
    difficulty: "medium",
    lessonId: "lesson-9-stack",
    tags: ["stack", "recursion"],
    points: 30,
    starterCode: [
      "challenge_start:",
      "  addi a0, x0, 5",
      "  jal  ra, countdown",
      "  beq  x0, x0, done",
      "countdown:",
      "  # YOUR CODE HERE",
      "done:",
    ].join("\n"),
    testCases: [
      regCase("stack-depth-1", "sp returns to 0x7FFFFFFC", 2, 0x7ffffffc, 10, { program_prefix: "j challenge_start" }),
      regCase("stack-depth-2", "a0 reaches 0 after countdown", 10, 0, 10, { program_prefix: "j challenge_start" }),
      {
        id: "stack-depth-3",
        description: "Program halts without corrupting ra",
        setup: { program_prefix: "j challenge_start" },
        points: 10,
        check: (state) => state.halted || state.trapFired || state.registers[2] === 0x7ffffffc,
      },
    ],
    hint: "Allocate a frame, save ra, recurse while a0 > 0, then restore ra and sp on the way back out.",
    solutionCode: [
      "challenge_start:",
      "  addi a0, x0, 5",
      "  jal  ra, countdown",
      "  beq  x0, x0, done",
      "countdown:",
      "  addi sp, sp, -4",
      "  sw   ra, 0(sp)",
      "  beq  a0, x0, base",
      "  addi a0, a0, -1",
      "  jal  ra, countdown",
      "base:",
      "  lw   ra, 0(sp)",
      "  addi sp, sp, 4",
      "  ret",
      "done:",
    ].join("\n"),
    estimatedMinutes: 20,
  },
  {
    id: "challenge-10-int-sqrt",
    title: "Integer Square Root",
    description: "Compute floor(sqrt(x1)) using integer arithmetic only and store the result in x2.",
    difficulty: "hard",
    lessonId: "lesson-10-mext",
    tags: ["m extension", "loops"],
    points: 30,
    starterCode: ["challenge_start:", "  addi x2, x0, 0", "  # x1 is preloaded", "  # YOUR CODE HERE"].join("\n"),
    testCases: [
      regCase("isqrt-1", "sqrt(9) -> 3", 2, 3, 10, { registers: { 1: 9 }, program_prefix: "j challenge_start" }),
      regCase("isqrt-2", "sqrt(16) -> 4", 2, 4, 10, { registers: { 1: 16 }, program_prefix: "j challenge_start" }),
      regCase("isqrt-3", "sqrt(144) -> 12", 2, 12, 10, { registers: { 1: 144 }, program_prefix: "j challenge_start" }),
    ],
    hint: "Increment a candidate, square it with mul, and stop when the square would exceed x1.",
    solutionCode: [
      "challenge_start:",
      "  addi x2, x0, 0",
      "sqrt_loop:",
      "  addi x3, x2, 1",
      "  mul  x4, x3, x3",
      "  blt  x1, x4, done",
      "  add  x2, x3, x0",
      "  beq  x0, x0, sqrt_loop",
      "done:",
    ].join("\n"),
    estimatedMinutes: 22,
  },
  {
    id: "challenge-11-string-compare",
    title: "String Compare",
    description: "Compare two null-terminated strings and store 1 in x3 if they are equal, otherwise 0.",
    difficulty: "hard",
    lessonId: "lesson-11-strings",
    tags: ["strings", "bytes"],
    points: 30,
    starterCode: [
      "challenge_start:",
      "  addi x1, x0, 0x200",
      "  addi x2, x0, 0x240",
      "  addi x3, x0, 0",
      "  # YOUR CODE HERE",
    ].join("\n"),
    testCases: [
      regCase("strcmp-1", "\"GT\" vs \"GT\" -> 1", 3, 1, 10, {
        memory: [
          { address: 0x200, value: 71 },
          { address: 0x201, value: 84 },
          { address: 0x202, value: 0 },
          { address: 0x240, value: 71 },
          { address: 0x241, value: 84 },
          { address: 0x242, value: 0 },
        ],
        program_prefix: "j challenge_start",
      }),
      regCase("strcmp-2", "\"GT\" vs \"GA\" -> 0", 3, 0, 10, {
        memory: [
          { address: 0x200, value: 71 },
          { address: 0x201, value: 84 },
          { address: 0x202, value: 0 },
          { address: 0x240, value: 71 },
          { address: 0x241, value: 65 },
          { address: 0x242, value: 0 },
        ],
        program_prefix: "j challenge_start",
      }),
      regCase("strcmp-3", "\"ECE\" vs \"ECE\" -> 1", 3, 1, 10, {
        memory: [
          { address: 0x200, value: 69 },
          { address: 0x201, value: 67 },
          { address: 0x202, value: 69 },
          { address: 0x203, value: 0 },
          { address: 0x240, value: 69 },
          { address: 0x241, value: 67 },
          { address: 0x242, value: 69 },
          { address: 0x243, value: 0 },
        ],
        program_prefix: "j challenge_start",
      }),
    ],
    hint: "Load one byte from each string, compare them, stop with 0 if they differ, stop with 1 if they are both zero.",
    solutionCode: [
      "challenge_start:",
      "  addi x1, x0, 0x200",
      "  addi x2, x0, 0x240",
      "  addi x3, x0, 0",
      "compare_loop:",
      "  lbu  x4, 0(x1)",
      "  lbu  x5, 0(x2)",
      "  bne  x4, x5, done",
      "  beq  x4, x0, equal",
      "  addi x1, x1, 1",
      "  addi x2, x2, 1",
      "  beq  x0, x0, compare_loop",
      "equal:",
      "  addi x3, x0, 1",
      "done:",
    ].join("\n"),
    estimatedMinutes: 24,
  },
  {
    id: "challenge-12-list-length",
    title: "List Length",
    description: "Count the nodes in a linked list and leave the length in x3.",
    difficulty: "hard",
    lessonId: "lesson-12-linkedlist",
    tags: ["linked list", "pointers"],
    points: 30,
    starterCode: ["challenge_start:", "  addi x3, x0, 0", "  # x1 is preloaded with the head pointer", "  # YOUR CODE HERE"].join("\n"),
    testCases: [
      regCase("list-len-1", "4-node list -> 4", 3, 4, 10, {
        registers: { 1: 0x300 },
        memory: [
          { address: 0x300, value: 1 },
          { address: 0x304, value: 0x308 },
          { address: 0x308, value: 2 },
          { address: 0x30c, value: 0x310 },
          { address: 0x310, value: 3 },
          { address: 0x314, value: 0x318 },
          { address: 0x318, value: 4 },
          { address: 0x31c, value: 0 },
        ],
        program_prefix: "j challenge_start",
      }),
      regCase("list-len-2", "2-node list -> 2", 3, 2, 10, {
        registers: { 1: 0x300 },
        memory: [
          { address: 0x300, value: 7 },
          { address: 0x304, value: 0x308 },
          { address: 0x308, value: 8 },
          { address: 0x30c, value: 0 },
        ],
        program_prefix: "j challenge_start",
      }),
      regCase("list-len-3", "Empty list -> 0", 3, 0, 10, { registers: { 1: 0 }, program_prefix: "j challenge_start" }),
    ],
    hint: "While x1 is nonzero, increment x3 and follow the next pointer at offset 4.",
    solutionCode: [
      "challenge_start:",
      "  addi x3, x0, 0",
      "len_loop:",
      "  beq  x1, x0, done",
      "  addi x3, x3, 1",
      "  lw   x1, 4(x1)",
      "  beq  x0, x0, len_loop",
      "done:",
    ].join("\n"),
    estimatedMinutes: 20,
  },
  {
    id: "challenge-13-gcd",
    title: "GCD",
    description: "Implement the Euclidean algorithm recursively and return the GCD in a0.",
    difficulty: "hard",
    lessonId: "lesson-13-recursion",
    tags: ["recursion", "math"],
    points: 30,
    starterCode: [
      "challenge_start:",
      "  jal  ra, gcd_fn",
      "  beq  x0, x0, done",
      "gcd_fn:",
      "  # a0 and a1 are preloaded",
      "  # YOUR CODE HERE",
      "done:",
    ].join("\n"),
    testCases: [
      regCase("gcd-1", "gcd(48,18)=6", 10, 6, 10, { registers: { 10: 48, 11: 18 }, program_prefix: "j challenge_start" }),
      regCase("gcd-2", "gcd(100,75)=25", 10, 25, 10, { registers: { 10: 100, 11: 75 }, program_prefix: "j challenge_start" }),
      regCase("gcd-3", "gcd(7,13)=1", 10, 1, 10, { registers: { 10: 7, 11: 13 }, program_prefix: "j challenge_start" }),
    ],
    hint: "Base case: if b is zero, return a. Otherwise recurse on (b, a % b).",
    solutionCode: [
      "challenge_start:",
      "  jal  ra, gcd_fn",
      "  beq  x0, x0, done",
      "gcd_fn:",
      "  addi sp, sp, -4",
      "  sw   ra, 0(sp)",
      "  beq  a1, x0, gcd_base",
      "  rem  t0, a0, a1",
      "  add  a0, a1, x0",
      "  add  a1, t0, x0",
      "  jal  ra, gcd_fn",
      "gcd_base:",
      "  lw   ra, 0(sp)",
      "  addi sp, sp, 4",
      "  ret",
      "done:",
    ].join("\n"),
    estimatedMinutes: 24,
  },
  {
    id: "challenge-14-exit-code",
    title: "Exit Code",
    description: "Compute 6*7 and then exit with that value in a0 using the standard ecall exit convention.",
    difficulty: "medium",
    lessonId: "lesson-14-syscall",
    tags: ["ecall", "abi"],
    points: 30,
    starterCode: ["challenge_start:", "  # YOUR CODE HERE"].join("\n"),
    testCases: [
      {
        id: "exit-code-1",
        description: "a0 should be 42 when ecall runs",
        setup: { program_prefix: "j challenge_start" },
        points: 15,
        check: (state) => state.registers[10] === 42,
      },
      {
        id: "exit-code-2",
        description: "a7 should be 10 and execution should trap or halt",
        setup: { program_prefix: "j challenge_start" },
        points: 15,
        check: (state) => state.registers[17] === 10 && (state.trapFired || state.halted),
      },
    ],
    hint: "Load 6 and 7, multiply into a0, place 10 in a7, then execute ecall.",
    solutionCode: ["challenge_start:", "  addi t0, x0, 6", "  addi t1, x0, 7", "  mul  a0, t0, t1", "  addi a7, x0, 10", "  ecall"].join("\n"),
    estimatedMinutes: 12,
  },
  {
    id: "challenge-15-median-finder",
    title: "Median Finder",
    description: "Sort a five-element array and leave the median value in x5.",
    difficulty: "hard",
    lessonId: "lesson-15-capstone",
    tags: ["sorting", "arrays", "capstone"],
    points: 30,
    starterCode: [
      "challenge_start:",
      "  addi x1, x0, 0x100",
      "  # YOUR CODE HERE",
    ].join("\n"),
    testCases: [
      regCase("median-1", "Median of [5,2,8,1,9] is 5", 5, 5, 10, {
        memory: [
          { address: 0x100, value: 5 },
          { address: 0x104, value: 2 },
          { address: 0x108, value: 8 },
          { address: 0x10c, value: 1 },
          { address: 0x110, value: 9 },
        ],
        program_prefix: "j challenge_start",
      }),
      regCase("median-2", "Median of [3,7,2,9,4] is 4", 5, 4, 10, {
        memory: [
          { address: 0x100, value: 3 },
          { address: 0x104, value: 7 },
          { address: 0x108, value: 2 },
          { address: 0x10c, value: 9 },
          { address: 0x110, value: 4 },
        ],
        program_prefix: "j challenge_start",
      }),
      regCase("median-3", "Median of [11,5,6,1,3] is 5", 5, 5, 10, {
        memory: [
          { address: 0x100, value: 11 },
          { address: 0x104, value: 5 },
          { address: 0x108, value: 6 },
          { address: 0x10c, value: 1 },
          { address: 0x110, value: 3 },
        ],
        program_prefix: "j challenge_start",
      }),
    ],
    hint: "A small bubble sort pass is enough for five elements. Once sorted, the middle element is at offset 8.",
    solutionCode: [
      "challenge_start:",
      "  addi x1, x0, 0x100",
      "  addi x2, x0, 4",
      "outer:",
      "  addi x3, x0, 0",
      "  addi x4, x0, 4",
      "inner:",
      "  beq  x3, x2, next_outer",
      "  slli x6, x3, 2",
      "  add  x7, x1, x6",
      "  lw   t0, 0(x7)",
      "  lw   t1, 4(x7)",
      "  blt  t1, t0, swap_pair",
      "  beq  x0, x0, continue_inner",
      "swap_pair:",
      "  sw   t1, 0(x7)",
      "  sw   t0, 4(x7)",
      "continue_inner:",
      "  addi x3, x3, 1",
      "  beq  x0, x0, inner",
      "next_outer:",
      "  addi x2, x2, -1",
      "  bne  x2, x0, outer",
      "  lw   x5, 8(x1)",
    ].join("\n"),
    estimatedMinutes: 30,
  },
];

export function getChallenges(): Challenge[] {
  return CHALLENGES.slice();
}

export function getChallengesForLesson(lessonId: string): Challenge[] {
  return CHALLENGES.filter((challenge) => challenge.lessonId === lessonId);
}

export function getChallenge(id: string): Challenge | null {
  return CHALLENGES.find((challenge) => challenge.id === id) ?? null;
}

export function saveChallengeSubmission(submission: ChallengeSubmission): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  const next = [...loadChallengeSubmissions(), submission];
  const storageKey = getChallengeSubmissionStorageKey();
  localStorage.setItem(storageKey, JSON.stringify(next));
  if (storageKey !== LEGACY_CHALLENGE_SUBMISSIONS_STORAGE_KEY) {
    localStorage.removeItem(LEGACY_CHALLENGE_SUBMISSIONS_STORAGE_KEY);
  }
}

export function loadChallengeSubmissions(): ChallengeSubmission[] {
  if (typeof localStorage === "undefined") {
    return emptySubmissions();
  }

  const storageKey = getChallengeSubmissionStorageKey();
  let stored = localStorage.getItem(storageKey);
  if (!stored && storageKey === `${CHALLENGE_SUBMISSIONS_STORAGE_KEY}:guest`) {
    stored = localStorage.getItem(LEGACY_CHALLENGE_SUBMISSIONS_STORAGE_KEY);
    if (stored) {
      localStorage.setItem(storageKey, stored);
      localStorage.removeItem(LEGACY_CHALLENGE_SUBMISSIONS_STORAGE_KEY);
    }
  }
  if (!stored) {
    return emptySubmissions();
  }

  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) {
      return emptySubmissions();
    }
    return parsed.filter((entry): entry is ChallengeSubmission => Boolean(entry && typeof entry === "object"));
  } catch {
    return emptySubmissions();
  }
}

export function getBestSubmission(challengeId: string): ChallengeSubmission | null {
  const submissions = loadChallengeSubmissions().filter((submission) => submission.challengeId === challengeId);
  if (submissions.length === 0) {
    return null;
  }

  return submissions.reduce((best, current) => {
    if (!best) {
      return current;
    }
    if (current.score > best.score) {
      return current;
    }
    if (current.score === best.score && current.submittedAt > best.submittedAt) {
      return current;
    }
    return best;
  }, null as ChallengeSubmission | null);
}

export function getTotalScore(): number {
  return CHALLENGES.reduce((total, challenge) => total + (getBestSubmission(challenge.id)?.score ?? 0), 0);
}

export function getChallengeStatus(id: string): "locked" | "available" | "attempted" | "passed" {
  const challenge = getChallenge(id);
  if (!challenge) {
    return "locked";
  }

  const lesson = getLesson(challenge.lessonId);
  const progress = loadProgress();
  if (!lesson || !isUnlocked(lesson.id, progress)) {
    return "locked";
  }

  const submissions = loadChallengeSubmissions().filter((submission) => submission.challengeId === id);
  if (submissions.some((submission) => submission.passed)) {
    return "passed";
  }
  if (submissions.length > 0) {
    return "attempted";
  }
  return "available";
}

export function evaluateChallengeState(_challengeId: string, deltas: Array<Parameters<typeof getLessonState>[0][number]>): LessonState {
  return getLessonState(deltas);
}

import type { LessonState } from "./lessons";

const QUIZ_ATTEMPTS_STORAGE_KEY = "studyriscv_quiz_attempts";
const LEGACY_QUIZ_ATTEMPTS_STORAGE_KEY = "studyriscv_quiz_attempts";
const ID_TOKEN_KEY = "studyriscv_id_token";

export interface QuizQuestion {
  id: string;
  type: "mcq" | "assembly" | "trace" | "fill-blank";
  difficulty: "easy" | "medium" | "hard";
  points: number;
  timeSeconds: number;
  prompt: string;
  choices?: string[];
  correctChoice?: number;
  explanation?: string;
  starterCode?: string;
  check?: (state: LessonState) => boolean;
  traceCode?: string;
  traceAnswer?: number;
  blankPrompt?: string;
  blankAnswer?: string;
}

export interface Quiz {
  id: string;
  title: string;
  description: string;
  type: "practice" | "midterm" | "final";
  lessonIds: string[];
  questions: QuizQuestion[];
  totalPoints: number;
  timeLimitSeconds: number;
  passingScore: number;
}

export interface QuizAttempt {
  quizId: string;
  answers: Record<
    string,
    {
      answer: string | number;
      timeSpentSeconds: number;
      correct: boolean;
      pointsEarned: number;
    }
  >;
  score: number;
  maxScore: number;
  passed: boolean;
  startedAt: string;
  completedAt: string;
  totalTimeSeconds: number;
}

export interface QuizAnswerInput {
  answer?: string | number;
  state?: LessonState;
  timeSpentSeconds: number;
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

function currentQuizUserId(): string | null {
  if (typeof localStorage === "undefined" || typeof sessionStorage === "undefined") {
    return null;
  }
  const token = localStorage.getItem(ID_TOKEN_KEY) ?? sessionStorage.getItem(ID_TOKEN_KEY);
  return token ? decodeJwtUserId(token) : null;
}

function getQuizAttemptStorageKey(userId?: string | null): string {
  const scopedUserId = userId === undefined ? currentQuizUserId() : userId;
  return scopedUserId ? `${QUIZ_ATTEMPTS_STORAGE_KEY}:${scopedUserId}` : `${QUIZ_ATTEMPTS_STORAGE_KEY}:guest`;
}

function mcq(
  id: string,
  prompt: string,
  choices: string[],
  correctChoice: number,
  points = 10,
  difficulty: QuizQuestion["difficulty"] = "easy",
  timeSeconds = 30,
  explanation?: string
): QuizQuestion {
  return { id, type: "mcq", prompt, choices, correctChoice, points, difficulty, timeSeconds, explanation };
}

function trace(
  id: string,
  prompt: string,
  traceCode: string,
  traceAnswer: number,
  points = 10,
  difficulty: QuizQuestion["difficulty"] = "medium",
  timeSeconds = 40,
  explanation?: string
): QuizQuestion {
  return { id, type: "trace", prompt, traceCode, traceAnswer, points, difficulty, timeSeconds, explanation };
}

function fillBlank(
  id: string,
  prompt: string,
  blankPrompt: string,
  blankAnswer: string,
  points = 10,
  difficulty: QuizQuestion["difficulty"] = "easy",
  timeSeconds = 20,
  explanation?: string
): QuizQuestion {
  return { id, type: "fill-blank", prompt, blankPrompt, blankAnswer, points, difficulty, timeSeconds, explanation };
}

function assembly(
  id: string,
  prompt: string,
  starterCode: string,
  check: (state: LessonState) => boolean,
  points = 15,
  difficulty: QuizQuestion["difficulty"] = "medium",
  timeSeconds = 75,
  explanation?: string
): QuizQuestion {
  return { id, type: "assembly", prompt, starterCode, check, points, difficulty, timeSeconds, explanation };
}

function emptyLessonState(): LessonState {
  return {
    registers: Array.from({ length: 32 }, () => 0),
    memory: new Map(),
    pc: 0,
    stepCount: 0,
    assembled: false,
    halted: false,
    trapFired: false,
  };
}

function normalizeBlank(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

const QUIZ_1_QUESTIONS: QuizQuestion[] = [
  mcq("quiz1-q1", "Which register is always zero in RISC-V?", ["x0", "x1", "x2", "x31"], 0, 10, "easy", 20, "x0 is hard-wired to 0 by the ISA."),
  mcq("quiz1-q2", "What does `addi x1, x0, 15` place in x1?", ["0", "15", "1", "the contents of x0"], 1, 10, "easy", 20, "addi adds the immediate 15 to x0, which is always 0."),
  trace(
    "quiz1-q3",
    "After these three instructions, what is x3?",
    ["addi x1, x0, 3", "addi x2, x0, 4", "add  x3, x1, x2"].join("\n"),
    7,
    10,
    "easy",
    30,
    "x3 receives 3 + 4."
  ),
  mcq("quiz1-q4", "What does `lw` load?", ["An 8-bit byte", "A 16-bit halfword", "A 32-bit word from memory", "A label address"], 2, 10, "easy", 20, "lw loads a 32-bit word from memory."),
  mcq("quiz1-q5", "What value does the stack pointer start with in StudyRISC-V?", ["0x00000000", "0x10000000", "0x7FFFFFFC", "0xFFFFFFFF"], 2, 10, "easy", 20, "StudyRISC-V initializes sp to 0x7FFFFFFC."),
  assembly(
    "quiz1-q6",
    "Write one instruction to copy x1 into x2.",
    "# one line only\n",
    (state) => state.registers[2] === state.registers[1],
    10,
    "easy",
    45,
    "Both `add x2, x1, x0` and `addi x2, x1, 0` are valid copy patterns."
  ),
  fillBlank("quiz1-q7", "Fill in the immediate so x1 becomes 42.", "addi x1, x0, ___", "42", 10, "easy", 15, "Adding 42 to x0 produces 42."),
  trace(
    "quiz1-q8",
    "What is sp after `addi sp, sp, -8`?",
    "addi sp, sp, -8",
    0x7ffffff4,
    10,
    "medium",
    25,
    "Subtracting 8 from 0x7FFFFFFC yields 0x7FFFFFF4."
  ),
  mcq("quiz1-q9", "Which sequence saves ra before calling another function?", ["add ra, ra, x0", "sw ra, 0(sp)", "lw ra, 0(sp)", "addi ra, x0, 0"], 1, 10, "medium", 25, "Saving ra to the stack preserves the caller's return address."),
  mcq("quiz1-q10", "The pseudo-instruction `ret` expands to:", ["jal ra, 0", "jalr x0, ra, 0", "beq x0, x0, done", "mv pc, ra"], 1, 10, "medium", 20, "ret is shorthand for jalr x0, ra, 0."),
];

const QUIZ_2_QUESTIONS: QuizQuestion[] = [
  mcq("quiz2-q1", "Which registers carry the first two function arguments?", ["x1 and x2", "a0 and a1", "s0 and s1", "t0 and t1"], 1, 10, "easy", 30, "a0 and a1 hold the first two arguments by convention."),
  trace("quiz2-q2", "What value is left in x3?", ["addi x1, x0, 4", "addi x2, x0, 6", "blt  x1, x2, less", "addi x3, x0, 0", "beq  x0, x0, done", "less:", "addi x3, x0, 1", "done:"].join("\n"), 1, 10, "medium", 45, "The branch to `less` is taken because 4 < 6."),
  mcq("quiz2-q3", "Which registers are callee-saved?", ["t0-t6", "a0-a7", "s0-s11 and sp", "ra only"], 2, 10, "medium", 25, "Callee-saved registers must be restored before returning."),
  trace("quiz2-q4", "After this loop finishes, what is x3?", ["addi x1, x0, 0", "addi x2, x0, 4", "addi x3, x0, 0", "loop:", "add  x3, x3, x1", "addi x1, x1, 1", "blt  x1, x2, loop"].join("\n"), 6, 15, "medium", 60, "The loop sums 0 + 1 + 2 + 3."),
  fillBlank("quiz2-q5", "Fill the missing register to restore the saved return address.", "lw ___, 4(sp)", "ra", 10, "easy", 20, "Load ra back from the stack before returning."),
  mcq("quiz2-q6", "Why must a non-leaf function save ra?", ["ra is read-only", "jal overwrites ra on every call", "ra is the stack pointer", "ret clears ra"], 1, 10, "medium", 25, "Nested calls replace the return address unless you save it."),
  trace("quiz2-q7", "What does a0 contain after return?", ["addi a0, x0, 7", "jal  ra, double", "beq  x0, x0, done", "double:", "add  a0, a0, a0", "ret", "done:"].join("\n"), 14, 10, "easy", 35, "The function doubles its input."),
  mcq("quiz2-q8", "Which instruction allocates an 8-byte stack frame?", ["addi sp, sp, -8", "addi sp, sp, 8", "sw sp, -8(x0)", "sub sp, x0, 8"], 0, 10, "easy", 20, "Stack frames are usually allocated by subtracting from sp."),
  trace("quiz2-q9", "What is sp after the prologue and epilogue below?", ["addi sp, sp, -16", "sw   ra, 12(sp)", "sw   s0, 8(sp)", "lw   s0, 8(sp)", "lw   ra, 12(sp)", "addi sp, sp, 16"].join("\n"), 0x7ffffffc, 10, "medium", 45, "A balanced frame returns sp to its original value."),
  mcq("quiz2-q10", "Which branch should you use for an unsigned comparison?", ["blt", "bge", "bltu", "slt"], 2, 10, "medium", 25, "Unsigned branches use the `u` suffix."),
  assembly("quiz2-q11", "Write a one-instruction function body that returns the larger of a0 and a1 when a0 is already known to be greater-or-equal.", "# assume a0 >= a1\n", (state) => state.registers[10] >= state.registers[11], 10, "medium", 45, "Leaving a0 unchanged is valid when it already holds the max."),
  trace("quiz2-q12", "If x1 = -1 and x2 = 1, which result does `sltu x3, x1, x2` produce?", ["li x1, -1", "addi x2, x0, 1", "sltu x3, x1, x2"].join("\n"), 0, 10, "hard", 45, "Unsigned -1 is 0xFFFFFFFF, which is larger than 1."),
  mcq("quiz2-q13", "Which register conventionally holds return values?", ["a0-a1", "t0-t1", "s0-s1", "ra"], 0, 10, "easy", 20, "Return values come back in a0 and a1."),
  fillBlank("quiz2-q14", "Fill in the pseudo-instruction: `___` returns from a function.", "___", "ret", 10, "easy", 15, "ret is the standard pseudo-instruction for returning."),
  trace("quiz2-q15", "What value is in t0 after this code?", ["addi a0, x0, 5", "sw   a0, 0(sp)", "lw   t0, 0(sp)"].join("\n"), 5, 10, "easy", 35, "The store and load round-trip through stack memory."),
  mcq("quiz2-q16", "A caller-saved register may be overwritten by:", ["Only the operating system", "Any function you call", "Only leaf functions", "No one"], 1, 10, "medium", 20, "Caller-saved means the caller must preserve it if needed."),
  trace("quiz2-q17", "What is x2 after this sequence?", ["addi x2, x0, 10", "addi x2, x2, -3"].join("\n"), 7, 10, "easy", 25, "addi can subtract using a negative immediate."),
  mcq("quiz2-q18", "Which instruction family changes control flow without writing a register?", ["jal x0, label", "add", "lw", "mul"], 0, 10, "medium", 25, "Writing to x0 discards jal's link result and makes it a pure jump."),
  fillBlank("quiz2-q19", "Complete the branch: `beq x0, x0, ___` for an unconditional jump to done.", "beq x0, x0, ___", "done", 10, "easy", 15, "Comparing x0 to itself is always true."),
  mcq("quiz2-q20", "What is the safest place to save s0 in a function prologue?", ["In x0", "On the stack", "In a0", "In gp"], 1, 10, "medium", 20, "Callee-saved registers belong on the stack when you need them later."),
];

const QUIZ_3_QUESTIONS: QuizQuestion[] = [
  ...QUIZ_1_QUESTIONS.map((question, index) => ({ ...question, id: `quiz3-b${index + 1}`, points: 5 })),
  ...QUIZ_2_QUESTIONS.slice(0, 15).map((question, index) => ({ ...question, id: `quiz3-m${index + 1}`, points: 8 })),
  mcq("quiz3-a1", "Which pipeline hazard occurs when an instruction needs a register value that has not been written back yet?", ["RAW", "WAW", "WAR", "Structural"], 0, 10, "hard", 30, "Read-after-write is the classic data dependency in an in-order pipeline."),
  mcq("quiz3-a2", "A taken branch in a simple 5-stage pipeline most directly causes:", ["A cache miss", "A pipeline flush", "A divide trap", "A stack overflow"], 1, 10, "hard", 30, "The wrong-path instructions already fetched must be discarded."),
  mcq("quiz3-a3", "Which access pattern is most cache-friendly for a row-major array?", ["Column-major traversal", "Sequential row-major traversal", "Random access", "Reverse every other row"], 1, 10, "hard", 30, "Sequential row-major access maximizes spatial locality."),
  trace("quiz3-a4", "Given x1 = 0x40000000, what exponent field should be extracted for IEEE-754 single-precision 2.0?", "li x1, 0x40000000", 128, 10, "hard", 40, "The biased exponent for 2.0 is 128."),
  mcq("quiz3-a5", "Which mcause value corresponds to an environment call from U-mode?", ["0", "2", "8", "11"], 2, 10, "hard", 30, "User-mode ecall is cause code 8."),
  fillBlank("quiz3-a6", "Complete the privileged return instruction: `___`", "___", "mret", 10, "hard", 20, "mret returns from a machine-mode trap handler."),
  mcq("quiz3-a7", "In a simple cooperative kernel, a Task Control Block usually stores:", ["Only the task ID", "Saved registers and scheduling metadata", "The full text segment", "Nothing but stack bytes"], 1, 10, "hard", 30, "A TCB tracks the saved execution context and task state."),
  trace("quiz3-a8", "What does `srai x3, x1, 2` produce when x1 holds -16?", "addi x1, x0, -16\nsrai x3, x1, 2", 0xfffffffc, 10, "medium", 35, "Arithmetic right shift preserves the sign bit, so -16 becomes -4."),
  mcq("quiz3-a9", "Which cache concept describes reusing recently accessed data?", ["Spatial locality", "Temporal locality", "Branch locality", "Instruction fusion"], 1, 10, "hard", 25, "Temporal locality is reuse over time."),
  assembly("quiz3-a10", "Write one instruction that saves ra at offset 12 from sp.", "# one instruction\n", (state) => (state.memory.get((state.registers[2] + 12) >>> 0) ?? 0) === (state.registers[1] & 0xff), 10, "hard", 50, "The canonical store is `sw ra, 12(sp)`."),
];

const QUIZ_4_QUESTIONS: QuizQuestion[] = [
  mcq("quiz4-q1", "0b1010 AND 0b1100 equals:", ["0b1110", "0b1000", "0b0110", "0b0010"], 1, 10, "easy", 20, "AND keeps only bits set in both operands."),
  trace("quiz4-q2", "What is x2 after `andi x2, x1, 0xF` if x1 = 0xABCD?", "li x1, 0xABCD\nandi x2, x1, 0xF", 0xD, 10, "easy", 25, "Masking with 0xF keeps the low nibble."),
  mcq("quiz4-q3", "Which instruction toggles bits where the mask has 1s?", ["and", "or", "xor", "sll"], 2, 10, "easy", 20, "XOR flips bits when the mask bit is 1."),
  trace("quiz4-q4", "What is x3 after `slli x3, x1, 2` if x1 = 5?", "addi x1, x0, 5\nslli x3, x1, 2", 20, 10, "easy", 20, "Left shifting by 2 multiplies by 4."),
  mcq("quiz4-q5", "Which shift preserves the sign bit of a negative number?", ["srli", "slli", "srai", "andi"], 2, 10, "medium", 20, "Arithmetic right shift copies the sign bit."),
  trace("quiz4-q6", "What is x4 after extracting bits [11:8] from 0xABCD?", "li x1, 0xABCD\nsrli x4, x1, 8\nandi x4, x4, 0xF", 0xC, 10, "medium", 25, "Shift right, then mask."),
  mcq("quiz4-q7", "What does `xori x2, x1, -1` do?", ["Adds -1", "Clears x2", "Bitwise NOT of x1", "Arithmetic negate"], 2, 10, "medium", 20, "XOR with all 1s inverts every bit."),
  trace("quiz4-q8", "What is x2 after `srli x2, x1, 3` if x1 = 80?", "addi x1, x0, 80\nsrli x2, x1, 3", 10, 10, "easy", 20, "Logical right shift by 3 divides an unsigned value by 8."),
];

const QUIZ_5_QUESTIONS: QuizQuestion[] = [
  mcq("quiz5-q1", "Which register stores the return address on a `jal`?", ["x0", "x1 / ra", "x2 / sp", "x8 / s0"], 1, 10, "easy", 20, "jal writes PC+4 into ra unless you choose another destination."),
  mcq("quiz5-q2", "Which registers are caller-saved?", ["s0-s11", "a0-a7, t0-t6, ra", "sp only", "gp and tp"], 1, 10, "medium", 25, "The caller must save values in ra, a-registers, and t-registers if it needs them later."),
  mcq("quiz5-q3", "Which registers are callee-saved?", ["a0-a7", "t0-t6", "s0-s11 and sp", "ra only"], 2, 10, "medium", 25, "Callee-saved registers must be restored before returning."),
  trace("quiz5-q4", "What is wrong with this prologue if the function uses s0?", ["addi sp, sp, -4", "sw   ra, 0(sp)"].join("\n"), 0, 10, "medium", 35, "Nothing saves s0, so the caller's value would be clobbered."),
  fillBlank("quiz5-q5", "Complete the epilogue instruction that restores the stack pointer.", "addi sp, sp, ___", "16", 10, "easy", 20, "The deallocation amount matches the frame size."),
  mcq("quiz5-q6", "Where do the first eight arguments go?", ["x0-x7", "a0-a7", "s0-s7", "t0-t7"], 1, 10, "easy", 20, "The ABI reserves a0 through a7 for arguments."),
  trace("quiz5-q7", "What value should be restored before `ret` in a non-leaf function?", ["lw s0, 8(sp)", "lw ra, 12(sp)", "addi sp, sp, 16", "ret"].join("\n"), 0, 10, "medium", 35, "ra must be restored before jalr x0, ra, 0."),
  mcq("quiz5-q8", "A leaf function that never calls another function may skip saving ra if:", ["It returns with ret and never overwrites ra", "It uses s0", "It allocates a frame", "It touches memory"], 0, 10, "medium", 25, "Leaf functions can keep ra live in the register if they never nest a call."),
  assembly("quiz5-q9", "Write a one-instruction prologue store that preserves s0 at offset 8 from sp.", "# one instruction\n", (state) => (state.memory.get((state.registers[2] + 8) >>> 0) ?? 0) === (state.registers[8] & 0xff), 10, "medium", 45, "The canonical store is `sw s0, 8(sp)`."),
  mcq("quiz5-q10", "Which register conventionally doubles as the frame pointer?", ["x2 / sp", "x8 / s0-fp", "x3 / gp", "x31 / t6"], 1, 10, "easy", 20, "s0 is also named fp."),
  trace("quiz5-q11", "If a function saves ra at 12(sp), where should it restore it from?", "sw ra, 12(sp)\n...\nlw ra, 12(sp)", 0, 10, "easy", 20, "Symmetry matters: use the same offset on load and store."),
  mcq("quiz5-q12", "Which register carries the return value for most integer functions?", ["t0", "s0", "a0", "ra"], 2, 10, "easy", 20, "The primary integer return register is a0."),
  fillBlank("quiz5-q13", "Fill in the return instruction: `jalr x0, ___, 0`", "jalr x0, ___, 0", "ra", 10, "easy", 15, "ret expands to jalr x0, ra, 0."),
  mcq("quiz5-q14", "Why is the stack said to grow down?", ["Addresses increase on allocation", "sp is decremented when allocating a frame", "The OS moves it", "The memory panel is upside down"], 1, 10, "medium", 20, "Allocating a frame subtracts from sp, moving it to lower addresses."),
  mcq(
    "quiz5-q15",
    "After `addi sp, sp, -8` followed by `addi sp, sp, 8`, what is sp relative to its starting value?",
    ["Exactly restored", "4 bytes lower", "4 bytes higher", "Unknown"],
    0,
    10,
    "easy",
    20,
    "Balanced allocation and deallocation return sp to its original value."
  ),
];

const QUIZZES: Quiz[] = [
  {
    id: "quiz-1-basics",
    title: "Registers and Memory Quick Check",
    description: "A five-minute fundamentals check on registers, memory, stack basics, and the most common RV32I idioms.",
    type: "practice",
    lessonIds: ["lesson-1-registers", "lesson-2-memory"],
    questions: QUIZ_1_QUESTIONS,
    totalPoints: QUIZ_1_QUESTIONS.reduce((total, question) => total + question.points, 0),
    timeLimitSeconds: 300,
    passingScore: 70,
  },
  {
    id: "quiz-2-midterm",
    title: "Branches and Functions Midterm Simulation",
    description: "A timed midterm-style assessment covering control flow, loops, stack frames, and the calling convention.",
    type: "midterm",
    lessonIds: ["lesson-3-branches", "lesson-4-functions", "lesson-9-stack"],
    questions: QUIZ_2_QUESTIONS,
    totalPoints: QUIZ_2_QUESTIONS.reduce((total, question) => total + question.points, 0),
    timeLimitSeconds: 1200,
    passingScore: 70,
  },
  {
    id: "quiz-3-final",
    title: "Full Curriculum Final Exam",
    description: "A broad final exam spanning the full 20-lesson curriculum, from arithmetic to privileged architecture concepts.",
    type: "final",
    lessonIds: Array.from({ length: 20 }, (_, index) => `lesson-${index + 1}`),
    questions: QUIZ_3_QUESTIONS,
    totalPoints: QUIZ_3_QUESTIONS.reduce((total, question) => total + question.points, 0),
    timeLimitSeconds: 2700,
    passingScore: 65,
  },
  {
    id: "quiz-4-bitwise",
    title: "Bitwise and Shifts Lightning Round",
    description: "A short, fast practice round focused entirely on masks, shifts, and bit-twiddling intuition.",
    type: "practice",
    lessonIds: ["lesson-6-bitwise", "lesson-7-shifts"],
    questions: QUIZ_4_QUESTIONS,
    totalPoints: QUIZ_4_QUESTIONS.reduce((total, question) => total + question.points, 0),
    timeLimitSeconds: 180,
    passingScore: 75,
  },
  {
    id: "quiz-5-calling-convention",
    title: "Calling Convention Mastery",
    description: "A focused quiz on prologues, epilogues, saved registers, ra preservation, and function ABI rules.",
    type: "practice",
    lessonIds: ["lesson-4-functions", "lesson-9-stack", "lesson-13-recursion"],
    questions: QUIZ_5_QUESTIONS,
    totalPoints: QUIZ_5_QUESTIONS.reduce((total, question) => total + question.points, 0),
    timeLimitSeconds: 600,
    passingScore: 75,
  },
];

export function getQuizzes(): Quiz[] {
  return QUIZZES.slice();
}

export function getQuiz(id: string): Quiz | null {
  return QUIZZES.find((quiz) => quiz.id === id) ?? null;
}

function gradeQuestion(question: QuizQuestion, input: QuizAnswerInput | undefined): { answer: string | number; correct: boolean; pointsEarned: number; timeSpentSeconds: number } {
  const answer = input?.answer ?? "";
  const timeSpentSeconds = Math.max(0, input?.timeSpentSeconds ?? 0);
  let correct = false;

  if (question.type === "mcq") {
    correct = Number(answer) === question.correctChoice;
  } else if (question.type === "trace") {
    correct = Number(answer) === (question.traceAnswer ?? NaN);
  } else if (question.type === "fill-blank") {
    correct = normalizeBlank(String(answer)) === normalizeBlank(question.blankAnswer ?? "");
  } else if (question.type === "assembly") {
    const state = input?.state ?? emptyLessonState();
    correct = question.check ? question.check(state) : false;
  }

  return {
    answer: typeof answer === "number" ? answer : String(answer),
    correct,
    pointsEarned: correct ? question.points : 0,
    timeSpentSeconds,
  };
}

export function gradeQuizAttempt(
  quiz: Quiz,
  answers: Record<string, QuizAnswerInput>,
  options: { startedAt?: string; completedAt?: string; totalTimeSeconds?: number } = {}
): QuizAttempt {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const completedAt = options.completedAt ?? new Date().toISOString();
  const gradedAnswers: QuizAttempt["answers"] = {};
  let score = 0;

  for (const question of quiz.questions) {
    const graded = gradeQuestion(question, answers[question.id]);
    gradedAnswers[question.id] = graded;
    score += graded.pointsEarned;
  }

  const maxScore = quiz.totalPoints;
  const totalTimeSeconds =
    typeof options.totalTimeSeconds === "number"
      ? Math.max(0, Math.floor(options.totalTimeSeconds))
      : Object.values(gradedAnswers).reduce((total, entry) => total + entry.timeSpentSeconds, 0);

  return {
    quizId: quiz.id,
    answers: gradedAnswers,
    score,
    maxScore,
    passed: maxScore === 0 ? false : (score / maxScore) * 100 >= quiz.passingScore,
    startedAt,
    completedAt,
    totalTimeSeconds,
  };
}

export function autoSubmitQuiz(quiz: Quiz, answers: Record<string, QuizAnswerInput>): QuizAttempt {
  return gradeQuizAttempt(quiz, answers);
}

export function saveQuizAttempt(attempt: QuizAttempt): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  const storageKey = getQuizAttemptStorageKey();
  localStorage.setItem(storageKey, JSON.stringify([...loadQuizAttempts(), attempt]));
  if (storageKey !== LEGACY_QUIZ_ATTEMPTS_STORAGE_KEY) {
    localStorage.removeItem(LEGACY_QUIZ_ATTEMPTS_STORAGE_KEY);
  }
}

export function loadQuizAttempts(): QuizAttempt[] {
  if (typeof localStorage === "undefined") {
    return [];
  }
  const storageKey = getQuizAttemptStorageKey();
  let stored = localStorage.getItem(storageKey);
  if (!stored && storageKey === `${QUIZ_ATTEMPTS_STORAGE_KEY}:guest`) {
    stored = localStorage.getItem(LEGACY_QUIZ_ATTEMPTS_STORAGE_KEY);
    if (stored) {
      localStorage.setItem(storageKey, stored);
      localStorage.removeItem(LEGACY_QUIZ_ATTEMPTS_STORAGE_KEY);
    }
  }
  if (!stored) {
    return [];
  }
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? (parsed.filter((entry): entry is QuizAttempt => Boolean(entry && typeof entry === "object")) as QuizAttempt[]) : [];
  } catch {
    return [];
  }
}

export function getBestQuizAttempt(quizId: string): QuizAttempt | null {
  const attempts = loadQuizAttempts().filter((attempt) => attempt.quizId === quizId);
  if (attempts.length === 0) {
    return null;
  }
  return attempts.reduce((best, current) => {
    if (!best || current.score > best.score) {
      return current;
    }
    if (current.score === best.score && current.completedAt > best.completedAt) {
      return current;
    }
    return best;
  }, null as QuizAttempt | null);
}

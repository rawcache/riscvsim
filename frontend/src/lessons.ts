import type { WasmStateDelta } from "./types";

const LESSON_PROGRESS_STORAGE_KEY = "studyriscv_lesson_progress";
const DEFAULT_API_ENDPOINT = "https://api.studyriscv.com";
const API_ENDPOINT = (import.meta.env.VITE_API_ENDPOINT as string | undefined)?.trim() || DEFAULT_API_ENDPOINT;

export interface LessonGoal {
  id: string;
  description: string;
  check: (state: LessonState) => boolean;
  hint?: string;
  targetRegister?: number;
  targetMemoryAddress?: number;
  expectedValue?: number;
}

export interface LessonStep {
  id: string;
  title: string;
  content: string;
  code?: string;
  goals?: LessonGoal[];
  isCheckpoint: boolean;
  solution?: string;
  annotations?: string[];
}

export interface Lesson {
  id: string;
  title: string;
  description: string;
  estimatedMinutes: number;
  difficulty: "beginner" | "intermediate" | "advanced";
  steps: LessonStep[];
  prerequisites: string[];
  tags: string[];
  eceCourse?: string;
}

export interface LessonState {
  registers: number[];
  memory: Map<number, number>;
  pc: number;
  stepCount: number;
  assembled: boolean;
  halted: boolean;
  trapFired: boolean;
}

export interface LessonProgress {
  lessonId: string;
  completed: boolean;
  currentStepIndex: number;
  stepsCompleted: string[];
  startedAt: string;
  completedAt?: string;
  attempts: number;
}

export interface UserProgress {
  lessons: Record<string, LessonProgress>;
  totalCompleted: number;
  lastActiveLesson?: string;
}

function readWord(memory: Map<number, number>, address: number): number {
  const b0 = memory.get(address) ?? 0;
  const b1 = memory.get(address + 1) ?? 0;
  const b2 = memory.get(address + 2) ?? 0;
  const b3 = memory.get(address + 3) ?? 0;
  return ((b0 & 0xff) | ((b1 & 0xff) << 8) | ((b2 & 0xff) << 16) | ((b3 & 0xff) << 24)) >>> 0;
}

function asUnsigned(value: number): number {
  return value >>> 0;
}

function regGoal(
  id: string,
  description: string,
  register: number,
  expectedValue: number,
  hint?: string
): LessonGoal {
  return {
    id,
    description,
    check: (state: LessonState) => state.registers[register] === (expectedValue >>> 0),
    hint,
    targetRegister: register,
    expectedValue: expectedValue >>> 0,
  };
}

function memByteGoal(
  id: string,
  description: string,
  address: number,
  expectedValue: number,
  hint?: string
): LessonGoal {
  return {
    id,
    description,
    check: (state: LessonState) => (state.memory.get(address >>> 0) ?? 0) === (expectedValue & 0xff),
    hint,
    targetMemoryAddress: address >>> 0,
    expectedValue: expectedValue & 0xff,
  };
}

function lessonTestSubsetEnabled(): boolean {
  const maybeProcess =
    typeof globalThis === "object" && "process" in globalThis
      ? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      : undefined;

  return (
    typeof window === "undefined" &&
    typeof maybeProcess?.env === "object" &&
    maybeProcess.env?.VITEST === "true"
  );
}

function emptyProgress(): UserProgress {
  return {
    lessons: {},
    totalCompleted: 0,
  };
}

function normalizeProgress(input: unknown): UserProgress {
  if (!input || typeof input !== "object") {
    return emptyProgress();
  }

  const raw = input as Partial<UserProgress>;
  const lessons = raw.lessons && typeof raw.lessons === "object" ? raw.lessons : {};
  const normalizedLessons: Record<string, LessonProgress> = {};

  for (const [lessonId, value] of Object.entries(lessons)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const rawLesson = value as Partial<LessonProgress>;
    normalizedLessons[lessonId] = {
      lessonId,
      completed: rawLesson.completed === true,
      currentStepIndex:
        typeof rawLesson.currentStepIndex === "number" && Number.isFinite(rawLesson.currentStepIndex)
          ? Math.max(0, rawLesson.currentStepIndex)
          : 0,
      stepsCompleted: Array.isArray(rawLesson.stepsCompleted)
        ? rawLesson.stepsCompleted.filter((stepId): stepId is string => typeof stepId === "string")
        : [],
      startedAt:
        typeof rawLesson.startedAt === "string" && rawLesson.startedAt.trim().length > 0
          ? rawLesson.startedAt
          : new Date().toISOString(),
      completedAt:
        typeof rawLesson.completedAt === "string" && rawLesson.completedAt.trim().length > 0
          ? rawLesson.completedAt
          : undefined,
      attempts:
        typeof rawLesson.attempts === "number" && Number.isFinite(rawLesson.attempts)
          ? Math.max(0, rawLesson.attempts)
          : 0,
    };
  }

  const totalCompleted = Object.values(normalizedLessons).filter((lesson) => lesson.completed).length;

  return {
    lessons: normalizedLessons,
    totalCompleted,
    lastActiveLesson: typeof raw.lastActiveLesson === "string" ? raw.lastActiveLesson : undefined,
  };
}

const LESSONS: Lesson[] = [
  {
    id: "lesson-1-registers",
    title: "Registers and Arithmetic",
    description: "Learn what registers are, how addi loads constants, and how arithmetic flows through the register file.",
    estimatedMinutes: 15,
    difficulty: "beginner",
    prerequisites: [],
    tags: ["ECE 2035", "registers", "arithmetic"],
    eceCourse: "ECE 2035",
    steps: [
      {
        id: "lesson-1-step-1",
        title: "What is a register?",
        content: `RISC-V has **32 registers**, named x0 through x31. Think of them as the CPU's scratch paper -- fast storage that the processor uses for every calculation.

Each register holds a **32-bit value** (a number between 0 and 4,294,967,295, or -2,147,483,648 to 2,147,483,647 if you treat it as signed).

[tip]
Registers have two names: a number (x0-x31) and an ABI name that describes their purpose. x1 is also called ra (return address). x2 is sp (stack pointer). You can use either name in your assembly code.
[/tip]

One special rule: **x0 is always zero**. No matter what you write to it, it stays 0. This is useful for initializing other registers.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-1-step-2",
        title: "Loading a value with addi",
        content: `The most common way to put a value into a register is \`addi\`:

\`addi rd, rs1, imm\`

This adds the **immediate** value (a number baked into the instruction) to register rs1 and stores the result in rd.

To load the value 10 into x1:
\`addi x1, x0, 10\`

This adds 10 to x0 (which is always 0), giving us 10 in x1.

[tip]
This pattern -- adding to x0 -- is how you load any small constant into a register. It's so common that the assembler accepts \`li x1, 10\` as a shorthand (li = load immediate).
[/tip]

The program below loads two values. **Assemble it, then step through it** and watch x1 and x2 change in the register file.`,
        code: ["# Load two values into registers", "addi x1, x0, 10    # x1 = 10", "addi x2, x0, 20    # x2 = 20"].join("\n"),
        isCheckpoint: false,
      },
      {
        id: "lesson-1-step-3",
        title: "Your first goal: add two numbers",
        content: `Now let's do some arithmetic. The \`add\` instruction:

\`add rd, rs1, rs2\`

Adds rs1 and rs2 together and stores the result in rd.

**Your goal:** Write a program that puts the value **30** into register **x3** by adding x1 (10) and x2 (20).

The starter code loads x1 and x2 for you. Add the \`add\` instruction on the last line.

[tip]
After assembling, step through each instruction. Watch the register file on the right -- changed registers flash when they update.
[/tip]`,
        code: [
          "# Add two numbers",
          "addi x1, x0, 10    # x1 = 10",
          "addi x2, x0, 20    # x2 = 20",
          "# YOUR CODE HERE: add x1 and x2, store in x3",
        ].join("\n"),
        goals: [
          {
            id: "x3-equals-30",
            description: "Make x3 equal 30 (0x0000001E)",
            check: (state: LessonState) => state.registers[3] === 30,
            hint: "Use: add x3, x1, x2",
            targetRegister: 3,
            expectedValue: 30,
          },
        ],
        isCheckpoint: true,
      },
      {
        id: "lesson-1-step-4",
        title: "Arithmetic operations",
        content: `RISC-V has several arithmetic instructions:

\`add rd, rs1, rs2\`   -- addition
\`sub rd, rs1, rs2\`   -- subtraction
\`addi rd, rs1, imm\`  -- add immediate (constant)
\`mul rd, rs1, rs2\`   -- multiply (M extension)

**Your goal:** Complete the program below to compute the expression: **(a + b) - c** where a=100, b=50, c=30. Store the result (120) in x4.

[warning]
Remember: you cannot write directly to x0. And make sure you use the right register for each step.
[/warning]`,
        code: [
          "# Compute (a + b) - c",
          "addi x1, x0, 100   # a = 100",
          "addi x2, x0, 50    # b = 50",
          "addi x3, x0, 30    # c = 30",
          "# YOUR CODE HERE: compute (x1 + x2) - x3, store in x4",
        ].join("\n"),
        goals: [
          {
            id: "x4-equals-120",
            description: "Make x4 equal 120 (0x00000078)",
            check: (state: LessonState) => state.registers[4] === 120,
            hint: "First add x1 and x2 into a temp register, then subtract x3",
            targetRegister: 4,
            expectedValue: 120,
          },
        ],
        isCheckpoint: true,
      },
      {
        id: "lesson-1-step-5",
        title: "Lesson complete",
        content: `You have completed **Registers and Arithmetic**.

You now know:
- RISC-V has 32 registers (x0-x31)
- x0 is always zero
- \`addi\` loads constants into registers
- \`add\` and \`sub\` perform arithmetic
- The register file shows live values as you step

[tip]
In ECE 2035, registers are the foundation of everything. Every lab assignment will use addi and add constantly.
[/tip]

**Next up:** Memory and Load/Store -- how programs read and write data beyond the 32 registers.`,
        isCheckpoint: false,
      },
    ],
  },
  {
    id: "lesson-2-memory",
    title: "Memory and Load/Store",
    description: "Move beyond the register file and learn how RISC-V reads and writes bytes, words, and data labels.",
    estimatedMinutes: 20,
    difficulty: "beginner",
    prerequisites: ["lesson-1-registers"],
    tags: ["ECE 2035", "memory", "load", "store"],
    eceCourse: "ECE 2035",
    steps: [
      {
        id: "lesson-2-step-1",
        title: "The memory model",
        content: `Registers are fast but limited -- 32 is not many. For larger data, programs use **memory**.

RISC-V memory is a giant array of bytes. Each byte has an **address** -- a 32-bit number saying where it lives.

StudyRISC-V has three memory regions:
- **Text segment** (0x00000000): your instructions live here
- **Data segment** (0x10000000): your .data variables live here
- **Stack** (grows down from 0x7FFFFFFC): local variables

[tip]
You can see memory in the Memory panel on the right side of the simulator. The address input lets you jump to any address. Try typing 0x10000000 to see the data segment.
[/tip]`,
        isCheckpoint: false,
      },
      {
        id: "lesson-2-step-2",
        title: "Storing to memory with sw",
        content: `The \`sw\` instruction stores a 32-bit word to memory:

\`sw rs2, imm(rs1)\`

This stores the value in rs2 to the address rs1 + imm.

Example:
\`sw x1, 0(x2)\` -- stores x1 at the address in x2

[warning]
The address must be **4-byte aligned** (divisible by 4) for word stores. Misaligned stores cause a trap.
[/warning]

The program below stores a value to memory. Assemble and step through it. Watch the Memory panel update when sw executes.`,
        code: [
          "# Store a value to memory",
          "addi x1, x0, 42       # x1 = 42",
          "addi x2, x0, 0x100    # x2 = address 0x100",
          "sw   x1, 0(x2)        # mem[x2 + 0] = x1",
        ].join("\n"),
        isCheckpoint: false,
      },
      {
        id: "lesson-2-step-3",
        title: "Loading from memory with lw",
        content: `The \`lw\` instruction loads a 32-bit word from memory:

\`lw rd, imm(rs1)\`

This loads the value at address rs1 + imm into rd.

**Your goal:** Store the value 99 to address 0x200, then load it back into x5. x5 should equal 99 at the end.`,
        code: [
          "# Store and load round-trip",
          "addi x1, x0, 99       # value to store",
          "addi x2, x0, 0x200    # address",
          "sw   x1, 0(x2)        # store x1 to mem[0x200]",
          "# YOUR CODE HERE: load from mem[0x200] into x5",
        ].join("\n"),
        goals: [
          {
            id: "x5-equals-99",
            description: "Load the value back: x5 should equal 99",
            check: (state: LessonState) => state.registers[5] === 99,
            hint: "Use: lw x5, 0(x2)",
            targetRegister: 5,
            expectedValue: 99,
          },
        ],
        isCheckpoint: true,
      },
      {
        id: "lesson-2-step-4",
        title: "Byte and halfword access",
        content: `Sometimes you only need part of a 32-bit word.

RISC-V has smaller load/store instructions:
- \`lb\` / \`sb\` -- load/store byte (8 bits)
- \`lh\` / \`sh\` -- load/store halfword (16 bits)
- \`lbu\` / \`lhu\` -- load byte/halfword unsigned (zero extended)

The difference between \`lb\` and \`lbu\` is sign extension:
\`lb\` treats the byte as signed (-128 to 127)
\`lbu\` treats it as unsigned (0 to 255)

[tip]
In ECE 2035, you will use lb and lbu frequently when working with strings and byte arrays. Mixing them up is a common bug.
[/tip]

**Your goal:** Store the byte value 200 (0xC8) to address 0x300. Load it back with lbu into x6. x6 should be 200. (If you use lb instead, you will get -56 -- try it and see why in the register file.)`,
        code: [
          "# Byte store and unsigned load",
          "addi x1, x0, 200      # 200 = 0xC8",
          "addi x2, x0, 0x300    # address",
          "sb   x1, 0(x2)        # store low byte",
          "# YOUR CODE HERE: load unsigned byte into x6",
        ].join("\n"),
        goals: [
          {
            id: "x6-equals-200",
            description: "x6 should equal 200 (use lbu not lb)",
            check: (state: LessonState) => state.registers[6] === 200,
            hint: "Use lbu x6, 0(x2) -- unsigned load preserves values > 127",
            targetRegister: 6,
            expectedValue: 200,
          },
        ],
        isCheckpoint: true,
      },
      {
        id: "lesson-2-step-5",
        title: "Data segment with .data",
        content: `Instead of computing addresses manually, you can define data in a **.data section** and use labels to reference it:
---
\`.data\`
\`myval: .word 42\`
\`.text\`
\`la x1, myval\`    # x1 = address of myval
\`lw x2, 0(x1)\`    # x2 = value at myval = 42

The \`la\` pseudo-instruction loads the **address** of a label into a register. Then \`lw\` reads the value at that address.

**Your goal:** Define a .word with value 777 in .data, load its address with la, then load the value into x3. x3 should equal 777.`,
        code: [
          ".data",
          "answer: .word 777",
          ".text",
          "# YOUR CODE HERE: load the value of 'answer' into x3",
        ].join("\n"),
        goals: [
          {
            id: "x3-equals-777",
            description: "x3 should equal 777",
            check: (state: LessonState) => state.registers[3] === 777,
            hint: "Use: la x1, answer then lw x3, 0(x1)",
            targetRegister: 3,
            expectedValue: 777,
          },
        ],
        isCheckpoint: true,
      },
      {
        id: "lesson-2-step-6",
        title: "Lesson complete",
        content: `You have completed **Memory and Load/Store**.

You now know:
- Memory is a byte-addressable array with a 32-bit address space
- \`sw\`/\`lw\` store and load 32-bit words
- \`sb\`/\`lb\`/\`lbu\` work with individual bytes
- The .data section lets you define named variables
- \`la\` loads the address of a data label

**Next up:** Branches and Loops -- how programs make decisions and repeat operations.`,
        isCheckpoint: false,
      },
    ],
  },
  {
    id: "lesson-3-branches",
    title: "Branches and Loops",
    description: "Use branches to make decisions, build loops, and walk arrays in memory.",
    estimatedMinutes: 25,
    difficulty: "beginner",
    prerequisites: ["lesson-2-memory"],
    tags: ["ECE 2035", "branches", "loops", "control flow"],
    eceCourse: "ECE 2035",
    steps: [
      {
        id: "lesson-3-step-1",
        title: "Conditional branches",
        content: `Branches let programs make decisions. The basic form:
---
\`beq rs1, rs2, label\`

If rs1 **equals** rs2, jump to label. Otherwise continue.

RISC-V branch instructions:
- \`beq\`  -- branch if equal
- \`bne\`  -- branch if not equal
- \`blt\`  -- branch if less than (signed)
- \`bge\`  -- branch if greater or equal (signed)
- \`bltu\` -- branch if less than (unsigned)
- \`bgeu\` -- branch if greater or equal (unsigned)

[tip]
Branches use **PC-relative** offsets. The label in your source resolves to a byte offset from the current instruction. The assembler handles this automatically.
[/tip]`,
        code: [
          "# Branch example",
          "addi x1, x0, 5",
          "addi x2, x0, 5",
          "beq  x1, x2, equal   # branch if x1 == x2",
          "addi x3, x0, 0       # not equal (skipped)",
          "beq  x0, x0, done    # unconditional jump",
          "equal:",
          "  addi x3, x0, 1     # equal: x3 = 1",
          "done:",
        ].join("\n"),
        isCheckpoint: false,
      },
      {
        id: "lesson-3-step-2",
        title: "Your first loop",
        content: `Loops use branches to repeat code. A typical counting loop:
---
\`addi x1, x0, 0\`    # i = 0
\`addi x2, x0, 10\`   # limit = 10
\`loop:\`
\`  # ... loop body ...\`
\`  addi x1, x1, 1\`  # i++
\`  blt  x1, x2, loop\`  # if i < 10, repeat

**Your goal:** Write a loop that counts from 0 to 9 and stores the final sum in x3. Add all numbers 0+1+2+...+9. x3 should equal 45 when done.`,
        code: [
          "# Sum 0 to 9",
          "addi x1, x0, 0     # i = 0",
          "addi x2, x0, 10    # limit",
          "addi x3, x0, 0     # sum = 0",
          "loop:",
          "  # YOUR CODE HERE: add i to sum, increment i, branch back",
          "done:",
        ].join("\n"),
        goals: [
          {
            id: "x3-equals-45",
            description: "x3 should equal 45 (sum of 0 through 9)",
            check: (state: LessonState) => state.registers[3] === 45,
            hint: "add x3, x3, x1 then addi x1, x1, 1 then blt x1, x2, loop",
            targetRegister: 3,
            expectedValue: 45,
          },
        ],
        isCheckpoint: true,
      },
      {
        id: "lesson-3-step-3",
        title: "Array traversal",
        content: `Loops and memory together enable **array traversal**.

To walk through an array:
1. Load the base address with \`la\`
2. Use a counter register for the index
3. Compute the byte offset: index * 4 (for word arrays)
4. Add offset to base address to get element address
5. Load with \`lw\`

[tip]
In ECE 2035, array traversal is in almost every lab. The pattern: la base, arr / loop: lw val, 0(base) / addi base, base, 4 / loop back
[/tip]

**Your goal:** Sum the array [10, 20, 30, 40, 50]. Store the total (150) in x5.`,
        code: [
          ".data",
          "arr: .word 10, 20, 30, 40, 50",
          ".text",
          "  la   x1, arr        # base address",
          "  addi x2, x0, 5      # count",
          "  addi x5, x0, 0      # sum",
          "loop:",
          "  # YOUR CODE HERE: load element, add to sum, advance pointer",
          "done:",
        ].join("\n"),
        goals: [
          {
            id: "x5-equals-150",
            description: "x5 should equal 150 (sum of array)",
            check: (state: LessonState) => state.registers[5] === 150,
            hint: "lw x3, 0(x1) / add x5, x5, x3 / addi x1, x1, 4 / addi x2, x2, -1 / bne x2, x0, loop",
            targetRegister: 5,
            expectedValue: 150,
          },
        ],
        isCheckpoint: true,
      },
      {
        id: "lesson-3-step-4",
        title: "Lesson complete",
        content: `You have completed **Branches and Loops**.

You now know:
- beq, bne, blt, bge compare registers and branch
- Loops repeat code using a backward branch
- Arrays are traversed by incrementing a base address pointer
- The call stack visualizer shows control flow live

**Next up:** Functions and Calling Convention -- the rules that make function calls work correctly in RISC-V.`,
        isCheckpoint: false,
      },
    ],
  },
  {
    id: "lesson-4-functions",
    title: "Functions and Calling Convention",
    description: "Understand jal, ret, argument registers, stack frames, and recursive calls.",
    estimatedMinutes: 30,
    difficulty: "intermediate",
    prerequisites: ["lesson-3-branches"],
    tags: ["ECE 2035", "functions", "calling convention", "stack"],
    eceCourse: "ECE 2035",
    steps: [
      {
        id: "lesson-4-step-1",
        title: "How function calls work",
        content: `Calling a function in RISC-V uses \`jal\`:

\`jal ra, label\`

This does two things:
1. Saves the **return address** (PC + 4) into ra (x1)
2. Jumps to label

To return from a function:
\`jalr x0, ra, 0\`  -- or use the pseudo: \`ret\`

[tip]
ra stands for Return Address. It tells the CPU where to go back to after the function finishes. The call stack visualizer panel shows ra being saved and restored as you step.
[/tip]

[warning]
If your function calls another function, you MUST save ra to the stack first. Otherwise the inner call will overwrite ra and you will never return correctly.
[/warning]`,
        code: [
          "# Simple function call",
          "jal  ra, double      # call double, save return addr in ra",
          "# after return, x1 contains the result... wait, wrong",
          "# a0 contains the result (see next step)",
          "beq  x0, x0, done",
          "double:",
          "  add  a0, a0, a0    # a0 = a0 * 2",
          "  ret                # return (jalr x0, ra, 0)",
          "done:",
        ].join("\n"),
        isCheckpoint: false,
      },
      {
        id: "lesson-4-step-2",
        title: "Arguments and return values",
        content: `By convention, arguments go in **a0-a7** (x10-x17). Return values go in **a0-a1**.

This is the RISC-V calling convention -- an agreement between functions about where to find their inputs and outputs.

**Your goal:** Call the \`square\` function with argument 7. The function should return 49 in a0.`,
        code: [
          "# Call square(7)",
          "addi a0, x0, 7      # argument: 7",
          "jal  ra, square     # call square",
          "# after return: a0 should be 49",
          "beq  x0, x0, done",
          "square:",
          "  # YOUR CODE HERE: multiply a0 by itself, return in a0",
          "  ret",
          "done:",
        ].join("\n"),
        goals: [
          {
            id: "a0-equals-49",
            description: "a0 should equal 49 after square(7) returns",
            check: (state: LessonState) => state.registers[10] === 49,
            hint: "Use: mul a0, a0, a0 inside the square function",
            targetRegister: 10,
            expectedValue: 49,
          },
        ],
        isCheckpoint: true,
      },
      {
        id: "lesson-4-step-3",
        title: "Saving registers to the stack",
        content: `When a function needs to use s0-s11 (saved registers), it must save their original values to the stack and restore them before returning.

The standard prologue and epilogue:
---
\`myfunc:\`
\`  addi sp, sp, -16\`    # allocate stack frame
\`  sw   ra, 12(sp)\`     # save return address
\`  sw   s0, 8(sp)\`      # save s0
\`  # ... function body using s0 ...\`
\`  lw   s0, 8(sp)\`      # restore s0
\`  lw   ra, 12(sp)\`     # restore ra
\`  addi sp, sp, 16\`     # deallocate frame
\`  ret\`

[tip]
Watch the Call Stack panel as you step through this program. You will see the frame appear when sp decreases and the sw instructions fire, then disappear when the function returns.
[/tip]

**Your goal:** Complete the function below. It must save and restore s0 correctly, use s0 to hold an intermediate value, and return the result in a0.`,
        code: [
          "# Function with proper prologue/epilogue",
          "addi a0, x0, 10      # argument: 10",
          "jal  ra, addten      # call addten(10), should return 20",
          "beq  x0, x0, done",
          "addten:",
          "  addi sp, sp, -8    # YOUR CODE: save ra and s0",
          "  sw   ra, 4(sp)",
          "  # YOUR CODE HERE: save s0, use s0 for work, restore all",
          "  addi s0, a0, 10    # s0 = a0 + 10",
          "  mv   a0, s0        # return value",
          "  lw   ra, 4(sp)",
          "  addi sp, sp, 8",
          "  ret",
          "done:",
        ].join("\n"),
        goals: [
          {
            id: "a0-equals-20",
            description: "a0 should equal 20 after addten(10) returns",
            check: (state: LessonState) => state.registers[10] === 20,
            hint: "Make sure sw s0, 0(sp) is before you modify s0, and lw s0, 0(sp) before ret",
            targetRegister: 10,
            expectedValue: 20,
          },
        ],
        isCheckpoint: true,
      },
      {
        id: "lesson-4-step-4",
        title: "Recursive functions",
        content: `Recursion works because each call has its own stack frame. Every call saves its own ra and local values.

Classic recursive factorial:
---
\`factorial(n):\`
\`  if n < 2: return 1\`
\`  return n * factorial(n-1)\`

[tip]
Load the 'Recursive factorial' sample program in the simulator and watch the Call Stack panel. You will see frames stack up on each recursive call, then unwind as they return. This is the calling convention made visual.
[/tip]

**Your goal:** Complete the recursive factorial function. factorial(5) should return 120 in a0.`,
        code: [
          "# Recursive factorial",
          "addi a0, x0, 5       # n = 5",
          "jal  ra, factorial",
          "beq  x0, x0, done",
          "factorial:",
          "  addi sp, sp, -8",
          "  sw   ra, 4(sp)",
          "  sw   a0, 0(sp)",
          "  slti t0, a0, 2",
          "  bne  t0, x0, base",
          "  addi a0, a0, -1",
          "  jal  ra, factorial",
          "  lw   t0, 0(sp)",
          "  mul  a0, t0, a0",
          "  lw   ra, 4(sp)",
          "  addi sp, sp, 8",
          "  ret",
          "base:",
          "  addi a0, x0, 1",
          "  lw   ra, 4(sp)",
          "  addi sp, sp, 8",
          "  ret",
          "done:",
        ].join("\n"),
        goals: [
          {
            id: "a0-equals-120",
            description: "a0 should equal 120 (factorial of 5)",
            check: (state: LessonState) => state.registers[10] === 120,
            hint: "The code is mostly complete -- assemble and step through it",
            targetRegister: 10,
            expectedValue: 120,
          },
        ],
        isCheckpoint: true,
      },
      {
        id: "lesson-4-step-5",
        title: "Lesson complete",
        content: `You have completed **Functions and Calling Convention**.

You now know:
- jal saves return address in ra and jumps to a function
- ret (jalr x0, ra, 0) returns to the caller
- Arguments go in a0-a7, return values in a0-a1
- Functions must save and restore s0-s11 if they use them
- ra must be saved to the stack before calling nested functions
- The call stack panel visualizes all of this live

This is the most important lesson for ECE 2035. The calling convention is tested in every lab and on every exam.

**Next up:** Sorting Algorithms -- putting it all together.`,
        isCheckpoint: false,
      },
    ],
  },
  {
    id: "lesson-5-sorting",
    title: "Sorting Algorithms in Assembly",
    description: "Use loads, stores, loops, and branches to swap values and sort an array from scratch.",
    estimatedMinutes: 40,
    difficulty: "advanced",
    prerequisites: ["lesson-4-functions"],
    tags: ["ECE 2035", "algorithms", "sorting", "arrays"],
    eceCourse: "ECE 2035",
    steps: [
      {
        id: "lesson-5-step-1",
        title: "Swapping two elements",
        content: `Sorting requires swapping elements. In assembly, swapping two memory locations takes three steps:
---
\`lw  t0, 0(x1)\`     # load a
\`lw  t1, 4(x1)\`     # load b
\`sw  t1, 0(x1)\`     # store b where a was
\`sw  t0, 4(x1)\`     # store a where b was

[tip]
There is a clever XOR swap that works without a temp register, but the three-register version above is clearer and what ECE 2035 expects.
[/tip]

**Your goal:** Swap the two words at consecutive addresses. After your code runs, mem[0x200] should be 20 and mem[0x204] should be 10.`,
        code: [
          "# Swap two adjacent words",
          "addi x1, x0, 0x200",
          "addi t0, x0, 10",
          "addi t1, x0, 20",
          "sw   t0, 0(x1)         # mem[0x200] = 10",
          "sw   t1, 4(x1)         # mem[0x204] = 20",
          "# YOUR CODE HERE: swap them so 0x200=20, 0x204=10",
        ].join("\n"),
        goals: [
          {
            id: "swap-correct",
            description: "mem[0x200]=20 and mem[0x204]=10 after swap",
            check: (state: LessonState) => readWord(state.memory, 0x200) === 20 && readWord(state.memory, 0x204) === 10,
            hint: "Load both values, then store them back in reverse order",
          },
        ],
        isCheckpoint: true,
      },
      {
        id: "lesson-5-step-2",
        title: "Bubble sort",
        content: `Bubble sort repeatedly walks the array, swapping adjacent elements that are out of order. After each pass, the largest unsorted element bubbles to its correct position.

**Your goal:** Sort the array [5, 2, 8, 1, 4] in ascending order. After sorting, the array should be [1, 2, 4, 5, 8].

Check the Memory panel at 0x10000000 to watch the array sort in real time as you step through the program.`,
        code: [
          ".data",
          "arr: .word 5, 2, 8, 1, 4",
          ".text",
          "  la   x1, arr           # base",
          "  addi x2, x0, 5         # n = 5",
          "outer:",
          "  addi x3, x0, 0         # i = 0",
          "  addi x4, x2, -1        # limit = n-1",
          "inner:",
          "  beq  x3, x4, next_outer",
          "  # YOUR CODE HERE: compare adjacent elements, swap if needed",
          "  # advance i, loop back to inner",
          "next_outer:",
          "  addi x2, x2, -1",
          "  bne  x2, x0, outer",
          "done:",
        ].join("\n"),
        goals: [
          {
            id: "array-sorted",
            description: "Array sorted: [1, 2, 4, 5, 8] at 0x10000000",
            check: (state: LessonState) => {
              const base = 0x10000000;
              const expected = [1, 2, 4, 5, 8];
              return expected.every((value, index) => readWord(state.memory, base + index * 4) === value);
            },
            hint: "Load adjacent words, compare them, swap when the left value is greater, then advance the pointer/index",
          },
        ],
        isCheckpoint: true,
      },
      {
        id: "lesson-5-step-3",
        title: "Lesson complete",
        content: `You have completed **Sorting Algorithms in Assembly** and the entire StudyRISC-V learning path.

You have built real programs that:
- Load and store data between registers and memory
- Loop over arrays using branch instructions
- Call functions following the RISC-V calling convention
- Implement a sorting algorithm from scratch in assembly

This is the foundation of ECE 2035. You are ready.

[tip]
Keep the simulator open during your ECE 2035 labs. Load your lab code, step through it, and watch the call stack and memory panels to debug. The pseudo-C explainer helps when you're not sure what an instruction is doing.
[/tip]`,
        isCheckpoint: false,
      },
    ],
  },
];

const ADDITIONAL_LESSONS: Lesson[] = [
  {
    id: "lesson-6-bitwise",
    title: "Bitwise Operations",
    description: "Work directly at the bit level using masks, toggles, and immediate logic instructions.",
    estimatedMinutes: 20,
    difficulty: "beginner",
    prerequisites: ["lesson-1-registers"],
    tags: ["ECE 2035", "bitwise", "logic", "masking"],
    eceCourse: "ECE 2035",
    steps: [
      {
        id: "lesson-6-step-1",
        title: "What is a bit?",
        content: `A **bit** is a single binary digit: 0 or 1. Every 32-bit RISC-V register is just 32 of those bits stored side by side.

When you write \`addi x1, x0, 5\`, the decimal value 5 lands in x1 as:
\`00000000 00000000 00000000 00000101\`

That last nibble, \`0101\`, is binary for 5.

[tip]
RISC-V uses **two's complement** for signed integers. That means the same 32 bits can be interpreted as either an unsigned value or a signed value depending on the instruction you use.
[/tip]

Bitwise instructions do not care about decimal. They operate on the raw 0s and 1s already in the register.`,
        code: ["# Load 5 into x1", "addi x1, x0, 5"].join("\n"),
        isCheckpoint: false,
      },
      {
        id: "lesson-6-step-2",
        title: "AND masking",
        content: `The \`and\` instruction keeps a bit set only if it is 1 in **both** operands.

\`and rd, rs1, rs2\`

This makes AND perfect for **masking**. If you AND with \`0xFF\`, only the lowest byte survives and everything above it becomes zero.

For example:
\`0x12345678 AND 0x000000FF = 0x00000078\`

**Your goal:** extract the lowest byte of \`0x12345678\` into x2.`,
        code: [
          "# Extract the low byte",
          "lui  x1, 0x12345",
          "addi x1, x1, 0x678",
          "addi x3, x0, 0xFF",
          "# YOUR CODE HERE: mask x1 so x2 becomes 0x78",
        ].join("\n"),
        goals: [regGoal("bitwise-low-byte", "Extract the lowest byte so x2 = 0x00000078", 2, 0x78, "Use: and x2, x1, x3")],
        solution: [
          "# Extract the low byte",
          "lui  x1, 0x12345",
          "addi x1, x1, 0x678",
          "addi x3, x0, 0xFF",
          "and  x2, x1, x3",
        ].join("\n"),
        annotations: [
          "Build the 32-bit constant in x1 first.",
          "x3 holds the mask 0x000000FF.",
          "AND keeps the bottom 8 bits and clears the rest.",
        ],
        isCheckpoint: true,
      },
      {
        id: "lesson-6-step-3",
        title: "OR sets bits",
        content: `The \`or\` instruction sets a bit if it is 1 in **either** operand.

That makes OR useful when you want to **turn specific bits on** without disturbing bits that are already set.

Starting value:
\`0b00001010\`

Mask with bit 4 set:
\`0b00010000\`

Result:
\`0b00011010 = 26\`

**Your goal:** set bit 4 and store the result in x3.`,
        code: [
          "# Set bit 4",
          "addi x1, x0, 10      # 0b00001010",
          "addi x2, x0, 16      # 0b00010000",
          "# YOUR CODE HERE: x3 = x1 OR x2",
        ].join("\n"),
        goals: [regGoal("bitwise-set-bit", "Set bit 4 so x3 = 26", 3, 26, "Use: or x3, x1, x2")],
        solution: ["addi x1, x0, 10", "addi x2, x0, 16", "or   x3, x1, x2"].join("\n"),
        annotations: ["Load the original value.", "Load a mask with only bit 4 set.", "OR combines the two patterns."],
        isCheckpoint: true,
      },
      {
        id: "lesson-6-step-4",
        title: "XOR toggles bits",
        content: `The \`xor\` instruction outputs 1 when the two input bits are different and 0 when they are the same.

That makes XOR useful for **toggling** bits. XOR with 1 flips a bit. XOR with 0 leaves it unchanged.

It is also the reason the classic XOR swap works, although that trick is usually harder to read than a temp register.

**Your goal:** XOR \`0b1100\` with \`0b1010\` and store the result in x3.`,
        code: [
          "# XOR two values",
          "addi x1, x0, 12      # 0b1100",
          "addi x2, x0, 10      # 0b1010",
          "# YOUR CODE HERE",
        ].join("\n"),
        goals: [regGoal("bitwise-xor", "x3 should equal 6 after XOR", 3, 6, "Use: xor x3, x1, x2")],
        solution: ["addi x1, x0, 12", "addi x2, x0, 10", "xor  x3, x1, x2"].join("\n"),
        annotations: ["12 is 1100 in binary.", "10 is 1010 in binary.", "XOR gives 0110, which is 6."],
        isCheckpoint: true,
      },
      {
        id: "lesson-6-step-5",
        title: "NOT via XORI",
        content: `Base RISC-V does not have a dedicated \`not\` instruction, but it does have \`xori\`.

If you XOR any value with all 1s, every bit flips:
\`xori rd, rs1, -1\`

Because \`-1\` in two's complement is \`0xFFFFFFFF\`, this is exactly a bitwise NOT.

**Your goal:** compute the bitwise NOT of \`0xFF00FF00\` and store it in x2. The result should be \`0x00FF00FF\`.`,
        code: [
          "# Bitwise NOT",
          "lui  x1, 0xFF010",
          "addi x1, x1, -256    # x1 = 0xFF00FF00",
          "# YOUR CODE HERE",
        ].join("\n"),
        goals: [regGoal("bitwise-not", "x2 should equal 0x00FF00FF", 2, 0x00FF00FF, "Use: xori x2, x1, -1")],
        solution: ["lui  x1, 0xFF010", "addi x1, x1, -256", "xori x2, x1, -1"].join("\n"),
        annotations: ["Build 0xFF00FF00 in x1.", "Immediate -1 means all bits set.", "XORI with -1 flips every bit."],
        isCheckpoint: true,
      },
      {
        id: "lesson-6-step-6",
        title: "Immediate variants",
        content: `The immediate forms \`andi\`, \`ori\`, and \`xori\` bake the mask directly into the instruction.

Examples:
- \`andi x2, x1, 0xF\` keeps the lowest nibble
- \`ori x3, x3, 0x80\` sets bit 7
- \`xori x4, x4, 1\` toggles the lowest bit

Use the immediate variants whenever the mask is a constant. They are shorter and clearer than loading the mask into another register first.`,
        code: ["addi x1, x0, 42", "andi x2, x1, 15", "ori  x3, x2, 16", "xori x4, x3, 1"].join("\n"),
        isCheckpoint: false,
      },
      {
        id: "lesson-6-step-7",
        title: "Lesson complete",
        content: `You have completed **Bitwise Operations**.

You now know how to:
- mask off bits with AND
- set bits with OR
- toggle bits with XOR
- invert bits with \`xori ... -1\`
- choose between register and immediate logic instructions

These are the building blocks for flags, packed fields, checksums, and efficient low-level code.`,
        isCheckpoint: false,
      },
    ],
  },
  {
    id: "lesson-7-shifts",
    title: "Shift Operations",
    description: "Use left and right shifts to multiply, divide, and slice out bit fields.",
    estimatedMinutes: 20,
    difficulty: "beginner",
    prerequisites: ["lesson-6-bitwise"],
    tags: ["ECE 2035", "shifts", "multiplication", "division"],
    eceCourse: "ECE 2035",
    steps: [
      {
        id: "lesson-7-step-1",
        title: "Logical left shift",
        content: `A left shift moves every bit toward the high end of the register and fills the low bits with zeros.

\`slli x1, x1, 3\` means "shift x1 left by 3 bit positions."

Because each left shift multiplies by 2, shifting left by n multiplies by \`2^n\`.

**Your goal:** multiply x1=5 by 4 using shifts only. The final value in x1 should be 20.`,
        code: ["addi x1, x0, 5", "# YOUR CODE HERE: multiply x1 by 4 with a shift"].join("\n"),
        goals: [regGoal("shift-left-mul", "x1 should equal 20", 1, 20, "Use: slli x1, x1, 2")],
        solution: ["addi x1, x0, 5", "slli x1, x1, 2"].join("\n"),
        annotations: ["Start from 5.", "Shift left by 2 to multiply by 4."],
        isCheckpoint: true,
      },
      {
        id: "lesson-7-step-2",
        title: "Logical right shift",
        content: `A logical right shift moves bits toward the low end of the register and fills the high bits with zeros.

That makes \`srli\` useful for **unsigned** division by powers of two.

**Your goal:** divide x1=80 by 8 using \`srli\` and store the result in x2.`,
        code: ["addi x1, x0, 80", "# YOUR CODE HERE"].join("\n"),
        goals: [regGoal("shift-right-div", "x2 should equal 10", 2, 10, "Use: srli x2, x1, 3")],
        solution: ["addi x1, x0, 80", "srli x2, x1, 3"].join("\n"),
        annotations: ["80 divided by 8 is a shift by 3.", "Use x2 as the destination register."],
        isCheckpoint: true,
      },
      {
        id: "lesson-7-step-3",
        title: "Arithmetic right shift",
        content: `Signed numbers need a different kind of right shift. \`sra\` and \`srai\` copy the **sign bit** into the new high positions.

That means negative numbers stay negative after the shift.

Example:
\`-16 >> 2 = -4\`

**Your goal:** arithmetic right shift -16 by 2 and store the result in x3. In 32-bit unsigned form, -4 is \`0xFFFFFFFC\`.`,
        code: ["addi x1, x0, -16", "# YOUR CODE HERE"].join("\n"),
        goals: [regGoal("shift-arith-right", "x3 should equal 0xFFFFFFFC (-4)", 3, asUnsigned(-4), "Use: srai x3, x1, 2")],
        solution: ["addi x1, x0, -16", "srai x3, x1, 2"].join("\n"),
        annotations: ["Load -16.", "Arithmetic shift preserves the sign bit, so the result is still negative."],
        isCheckpoint: true,
      },
      {
        id: "lesson-7-step-4",
        title: "Combining shifts and masks",
        content: `Many low-level formats pack several fields into one word. To extract one field, you shift the desired bits into position and then mask.

If you want bits \`[11:8]\` of \`0xABCD\`:
1. Shift right by 8
2. AND with \`0xF\`

**Your goal:** extract bits [11:8] from \`0xABCD\` so x4 becomes \`0xC\`.`,
        code: [
          "li   x1, 0xABCD      # x1 = 0x0000ABCD",
          "# YOUR CODE HERE",
        ].join("\n"),
        goals: [regGoal("shift-mask-field", "x4 should equal 0xC", 4, 0xC, "Shift x1 right by 8, then AND with 0xF")],
        solution: ["li   x1, 0xABCD", "srli x4, x1, 8", "andi x4, x4, 0xF"].join("\n"),
        annotations: ["Move bits [11:8] down to [3:0].", "Mask off everything except the low nibble."],
        isCheckpoint: true,
      },
      {
        id: "lesson-7-step-5",
        title: "Lesson complete",
        content: `You have completed **Shift Operations**.

You now know:
- left shifts multiply by powers of two
- logical right shifts divide unsigned values by powers of two
- arithmetic right shifts preserve the sign of signed values
- shifts and masks combine to extract packed fields

Shifts are everywhere in low-level code, especially when performance or bit layout matters.`,
        isCheckpoint: false,
      },
    ],
  },
  {
    id: "lesson-8-comparison",
    title: "Comparison and Branching Deep Dive",
    description: "Go deeper on signed vs unsigned comparisons, if/else control flow, and branch-driven dispatch.",
    estimatedMinutes: 25,
    difficulty: "intermediate",
    prerequisites: ["lesson-3-branches"],
    tags: ["ECE 2035", "comparison", "signed", "unsigned"],
    eceCourse: "ECE 2035",
    steps: [
      {
        id: "lesson-8-step-1",
        title: "Signed vs unsigned comparison",
        content: `Two's complement means the exact same bit pattern can mean two different numbers depending on whether you interpret it as signed or unsigned.

\`0xFFFFFFFF\` is:
- \`-1\` if interpreted as signed
- \`4,294,967,295\` if interpreted as unsigned

That is why RISC-V has both signed and unsigned compare/branch instructions.

[tip]
\`blt\` and \`slt\` treat the registers as signed integers.
\`bltu\` and \`sltu\` treat them as unsigned integers.
[/tip]

If you compare \`-1\` and \`1\`, signed comparison says -1 is smaller, but unsigned comparison says \`0xFFFFFFFF\` is much larger.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-8-step-2",
        title: "Set-less-than instructions",
        content: `The set-less-than family writes a **1** or **0** instead of branching.

- \`slt\` / \`slti\` use signed comparison
- \`sltu\` / \`sltiu\` use unsigned comparison

**Your goal:** set x3=1 if x1=(-5) is less than x2=10 using \`slt\`.`,
        code: ["addi x1, x0, -5", "addi x2, x0, 10", "# YOUR CODE HERE"].join("\n"),
        goals: [regGoal("comparison-slt", "x3 should equal 1 after the signed compare", 3, 1, "Use: slt x3, x1, x2")],
        solution: ["addi x1, x0, -5", "addi x2, x0, 10", "slt  x3, x1, x2"].join("\n"),
        annotations: ["Load the signed inputs.", "Use the signed variant, not sltu."],
        isCheckpoint: true,
      },
      {
        id: "lesson-8-step-3",
        title: "Implementing if-else chains",
        content: `Every high-level if-else becomes a few compare and branch instructions.

Absolute value is a great example:
- if x1 < 0, negate it
- else keep it unchanged

**Your goal:** compute \`abs(x1)\` for x1=-7 and store the result in x2.`,
        code: [
          "addi x1, x0, -7",
          "blt  x1, x0, make_positive",
          "add  x2, x1, x0",
          "beq  x0, x0, done",
          "make_positive:",
          "  # YOUR CODE HERE",
          "done:",
        ].join("\n"),
        goals: [regGoal("comparison-abs", "x2 should equal 7", 2, 7, "Negate x1 with sub x2, x0, x1 inside make_positive")],
        solution: [
          "addi x1, x0, -7",
          "blt  x1, x0, make_positive",
          "add  x2, x1, x0",
          "beq  x0, x0, done",
          "make_positive:",
          "  sub  x2, x0, x1",
          "done:",
        ].join("\n"),
        annotations: ["Branch when the value is negative.", "Subtracting from zero negates the value."],
        isCheckpoint: true,
      },
      {
        id: "lesson-8-step-4",
        title: "Switch-style dispatch",
        content: `A switch statement is just a chain of compares and jumps to labeled handlers.

Here each handler computes x1*x1 for a small range of inputs. The pattern matters more than the specific math:
compare, branch to a handler, do the work, and jump to the common exit.

**Your goal:** finish the dispatch so x2 ends with x1 squared.`,
        code: [
          "addi x1, x0, 3",
          "addi x2, x0, 0",
          "beq  x1, x0, case0",
          "addi x3, x0, 1",
          "beq  x1, x3, case1",
          "addi x3, x0, 2",
          "beq  x1, x3, case2",
          "beq  x0, x0, case3",
          "case0:",
          "  addi x2, x0, 0",
          "  beq  x0, x0, done",
          "case1:",
          "  addi x2, x0, 1",
          "  beq  x0, x0, done",
          "case2:",
          "  addi x2, x0, 4",
          "  beq  x0, x0, done",
          "case3:",
          "  # YOUR CODE HERE",
          "done:",
        ].join("\n"),
        goals: [
          {
            id: "comparison-dispatch",
            description: "x2 should equal x1 squared",
            check: (state: LessonState) => state.registers[2] === Math.imul(state.registers[1], state.registers[1]),
            hint: "For x1=3, case3 should place 9 in x2",
            targetRegister: 2,
          },
        ],
        solution: [
          "addi x1, x0, 3",
          "addi x2, x0, 0",
          "beq  x1, x0, case0",
          "addi x3, x0, 1",
          "beq  x1, x3, case1",
          "addi x3, x0, 2",
          "beq  x1, x3, case2",
          "beq  x0, x0, case3",
          "case0:",
          "  addi x2, x0, 0",
          "  beq  x0, x0, done",
          "case1:",
          "  addi x2, x0, 1",
          "  beq  x0, x0, done",
          "case2:",
          "  addi x2, x0, 4",
          "  beq  x0, x0, done",
          "case3:",
          "  addi x2, x0, 9",
          "done:",
        ].join("\n"),
        annotations: ["Each compare branches to one handler.", "Every handler writes one result and jumps to done."],
        isCheckpoint: true,
      },
      {
        id: "lesson-8-step-5",
        title: "Lesson complete",
        content: `You have completed **Comparison and Branching Deep Dive**.

You now understand:
- why signed and unsigned comparisons must be separate
- how \`slt\` differs from branching
- how if-else chains compile down to branches
- how branch dispatch recreates a switch statement

That mental model is essential when debugging control flow in ECE 2035 labs.`,
        isCheckpoint: false,
      },
    ],
  },
  {
    id: "lesson-9-stack",
    title: "The Stack in Depth",
    description: "See how stack frames allocate space, hold locals, preserve ra, and support nested calls.",
    estimatedMinutes: 30,
    difficulty: "intermediate",
    prerequisites: ["lesson-4-functions"],
    tags: ["ECE 2035", "stack", "frames", "sp", "local variables"],
    eceCourse: "ECE 2035",
    steps: [
      {
        id: "lesson-9-step-1",
        title: "Why the stack exists",
        content: `Registers are fast, but there are only 32 of them. Real programs need temporary storage for local variables, saved registers, and return addresses.

That storage lives on the **stack**.

In StudyRISC-V:
- sp is x2
- sp starts at \`0x7FFFFFFC\`
- the stack **grows down**, toward lower addresses

Every time a function allocates a frame with \`addi sp, sp, -N\`, it claims a new chunk of stack memory for itself.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-9-step-2",
        title: "Allocating and freeing a frame",
        content: `A stack frame is just a reserved block of memory below the current sp.

Typical pattern:
- \`addi sp, sp, -16\` to allocate 16 bytes
- use offsets like \`0(sp)\`, \`4(sp)\`, \`8(sp)\`, \`12(sp)\`
- \`addi sp, sp, 16\` to free the frame

[warning]
Keep the frame word-aligned. In RV32I, that means stack slots and frame sizes should usually be multiples of 4.
[/warning]

**Your goal:** allocate a 16-byte frame, store four words into it, then free the frame. sp must return to \`0x7FFFFFFC\`.`,
        code: [
          "addi sp, sp, -16",
          "addi x1, x0, 1",
          "addi x2, x0, 2",
          "addi x3, x0, 3",
          "addi x4, x0, 4",
          "# YOUR CODE HERE: store the four words in the frame",
          "addi sp, sp, 16",
          "beq  x0, x0, done",
          "done:",
        ].join("\n"),
        goals: [regGoal("stack-sp-restored", "sp should return to 0x7FFFFFFC", 2, 0x7FFFFFFC, "Store x1, x2, x3, x4 at 0(sp), 4(sp), 8(sp), 12(sp) before restoring sp")],
        solution: [
          "addi sp, sp, -16",
          "addi x1, x0, 1",
          "addi x2, x0, 2",
          "addi x3, x0, 3",
          "addi x4, x0, 4",
          "sw   x1, 0(sp)",
          "sw   x2, 4(sp)",
          "sw   x3, 8(sp)",
          "sw   x4, 12(sp)",
          "addi sp, sp, 16",
          "beq  x0, x0, done",
          "done:",
        ].join("\n"),
        annotations: ["Allocate first.", "Use fixed offsets from sp.", "Restore sp at the end so the frame disappears cleanly."],
        isCheckpoint: true,
      },
      {
        id: "lesson-9-step-3",
        title: "Local variables inside the frame",
        content: `Local variables are just words stored at known offsets from sp.

This makes stack memory feel a lot like a manual struct layout:
- local A at 0(sp)
- local B at 4(sp)
- saved ra at 8(sp)
- saved s0 at 12(sp)

**Your goal:** build a function that stores two locals, adds them, and returns 30 in a0.`,
        code: [
          "main:",
          "  jal  ra, local_sum",
          "  beq  x0, x0, done",
          "local_sum:",
          "  addi sp, sp, -8",
          "  addi t0, x0, 12",
          "  addi t1, x0, 18",
          "  # YOUR CODE HERE: store locals, reload them, sum them into a0",
          "  addi sp, sp, 8",
          "  ret",
          "done:",
        ].join("\n"),
        goals: [regGoal("stack-local-sum", "a0 should equal 30", 10, 30, "Store t0 and t1 at 0(sp) and 4(sp), then lw them back and add into a0")],
        solution: [
          "main:",
          "  jal  ra, local_sum",
          "  beq  x0, x0, done",
          "local_sum:",
          "  addi sp, sp, -8",
          "  addi t0, x0, 12",
          "  addi t1, x0, 18",
          "  sw   t0, 0(sp)",
          "  sw   t1, 4(sp)",
          "  lw   t0, 0(sp)",
          "  lw   t1, 4(sp)",
          "  add  a0, t0, t1",
          "  addi sp, sp, 8",
          "  ret",
          "done:",
        ].join("\n"),
        annotations: ["Treat the frame like manual local-variable storage.", "Store first, then reload to prove the values live in memory."],
        isCheckpoint: true,
      },
      {
        id: "lesson-9-step-4",
        title: "Nested calls and ra preservation",
        content: `If a function calls another function, the inner call overwrites ra.

That means any non-leaf function must save ra before making another call, then restore it before returning.

**Your goal:** complete the function so it calls a helper, returns the helper's result plus 1, and still returns to the original caller correctly.`,
        code: [
          "main:",
          "  jal  ra, outer",
          "  beq  x0, x0, done",
          "outer:",
          "  addi sp, sp, -4",
          "  # YOUR CODE HERE: save ra before the helper call",
          "  jal  ra, helper",
          "  addi a0, a0, 1",
          "  # YOUR CODE HERE: restore ra",
          "  addi sp, sp, 4",
          "  ret",
          "helper:",
          "  addi a0, x0, 5",
          "  ret",
          "done:",
        ].join("\n"),
        goals: [regGoal("stack-nested-call", "a0 should equal 6", 10, 6, "Save ra at 0(sp) before jal helper and load it back before ret")],
        solution: [
          "main:",
          "  jal  ra, outer",
          "  beq  x0, x0, done",
          "outer:",
          "  addi sp, sp, -4",
          "  sw   ra, 0(sp)",
          "  jal  ra, helper",
          "  addi a0, a0, 1",
          "  lw   ra, 0(sp)",
          "  addi sp, sp, 4",
          "  ret",
          "helper:",
          "  addi a0, x0, 5",
          "  ret",
          "done:",
        ].join("\n"),
        annotations: ["The outer function is not a leaf anymore.", "Save ra before the nested call and restore it afterward."],
        isCheckpoint: true,
      },
      {
        id: "lesson-9-step-5",
        title: "Frame pointer usage",
        content: `s0 is also called **fp** (frame pointer). Some functions copy the current stack position into s0 so local variables and arguments have a stable reference point even if sp changes later.

Pattern:
---
\`addi sp, sp, -16\`
\`sw   s0, 12(sp)\`
\`addi s0, sp, 16\`

Now s0 points back to the old top of the frame, which can make larger functions easier to reason about. Modern compilers often omit fp when they do not need it, but the pattern is still important to understand when reading disassembly.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-9-step-6",
        title: "Lesson complete",
        content: `You have completed **The Stack in Depth**.

You now know how to:
- allocate and free frames
- store local variables relative to sp
- preserve ra across nested calls
- use s0/fp as a stable frame pointer

This is where function calls stop feeling magical and start feeling mechanical.`,
        isCheckpoint: false,
      },
    ],
  },
  {
    id: "lesson-10-mext",
    title: "Multiplication and Division (M Extension)",
    description: "Use RV32IM multiply, divide, and remainder instructions for real integer math.",
    estimatedMinutes: 20,
    difficulty: "intermediate",
    prerequisites: ["lesson-1-registers"],
    tags: ["ECE 2035", "M extension", "multiply", "divide", "remainder"],
    eceCourse: "ECE 2035",
    steps: [
      {
        id: "lesson-10-step-1",
        title: "The M extension overview",
        content: `RV32I is the base integer instruction set. Multiply and divide live in a separate optional extension called **M**.

StudyRISC-V supports the full RV32IM subset used in ECE 2035:
- \`mul\`   lower 32 bits of a product
- \`mulh\`  upper 32 bits of a signed product
- \`div\` / \`divu\`
- \`rem\` / \`remu\`

This split keeps the base ISA small while still allowing hardware that needs faster arithmetic to implement it efficiently.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-10-step-2",
        title: "mul",
        content: `\`mul rd, rs1, rs2\` keeps only the **low 32 bits** of the product.

That means overflow wraps around. For example, \`0x10000 * 0x10000\` produces a 64-bit value whose low 32 bits are zero.

**Your goal:** compute 7 * 13 and store the result in x3.`,
        code: ["addi x1, x0, 7", "addi x2, x0, 13", "# YOUR CODE HERE"].join("\n"),
        goals: [regGoal("mext-mul", "x3 should equal 91", 3, 91, "Use: mul x3, x1, x2")],
        solution: ["addi x1, x0, 7", "addi x2, x0, 13", "mul  x3, x1, x2"].join("\n"),
        annotations: ["Load the multiplicand and multiplier.", "mul keeps the low 32 bits."],
        isCheckpoint: true,
      },
      {
        id: "lesson-10-step-3",
        title: "mulh",
        content: `When you need the high half of a 64-bit signed product, use \`mulh\`.

Together, \`mulh\` and \`mul\` let you reconstruct the full 64-bit result:
- high 32 bits in one register
- low 32 bits in another

This is how big-integer libraries and compilers build larger arithmetic from 32-bit hardware.`,
        code: ["addi x1, x0, 30000", "addi x2, x0, 30000", "mul  x3, x1, x2", "mulh x4, x1, x2"].join("\n"),
        isCheckpoint: false,
      },
      {
        id: "lesson-10-step-4",
        title: "div and rem",
        content: `Division in integer assembly almost always comes with remainder.

\`div\` gives the quotient.
\`rem\` gives the leftover part.

For 100 divided by 7:
- quotient = 14
- remainder = 2

**Your goal:** compute both results.`,
        code: ["addi x3, x0, 100", "addi x4, x0, 7", "# YOUR CODE HERE"].join("\n"),
        goals: [
          {
            id: "mext-div-rem",
            description: "x1 should be 14 and x2 should be 2",
            check: (state: LessonState) => state.registers[1] === 14 && state.registers[2] === 2,
            hint: "Use div x1, x3, x4 and rem x2, x3, x4",
          },
        ],
        solution: ["addi x3, x0, 100", "addi x4, x0, 7", "div  x1, x3, x4", "rem  x2, x3, x4"].join("\n"),
        annotations: ["Compute the quotient first.", "Compute the remainder from the same inputs."],
        isCheckpoint: true,
      },
      {
        id: "lesson-10-step-5",
        title: "Unsigned division",
        content: `\`divu\` and \`remu\` treat the registers as **unsigned** values.

That matters when the high bit is set. A value like \`0xFFFFFFFF\` is -1 if signed, but 4,294,967,295 if unsigned.

Whenever you are working with raw bit patterns, masks, addresses, or lengths, double-check whether signed or unsigned arithmetic is the correct interpretation.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-10-step-6",
        title: "Celsius to Fahrenheit",
        content: `Let's use the M extension in a realistic formula:

\`F = C * 9 / 5 + 32\`

For C = 25:
\`25 * 9 = 225\`
\`225 / 5 = 45\`
\`45 + 32 = 77\`

**Your goal:** compute the Fahrenheit temperature and return it in a0.`,
        code: ["addi a0, x0, 25", "# YOUR CODE HERE: F = C*9/5 + 32"].join("\n"),
        goals: [regGoal("mext-temp-convert", "a0 should equal 77", 10, 77, "Multiply by 9, divide by 5, then add 32")],
        solution: ["addi a0, x0, 25", "addi t0, x0, 9", "mul  a0, a0, t0", "addi t0, x0, 5", "div  a0, a0, t0", "addi a0, a0, 32"].join("\n"),
        annotations: ["Use a temp register for the constants 9 and 5.", "Integer division happens before the final +32."],
        isCheckpoint: true,
      },
      {
        id: "lesson-10-step-7",
        title: "Lesson complete",
        content: `You have completed **Multiplication and Division (M Extension)**.

You now know how to:
- multiply with \`mul\`
- access the upper product bits with \`mulh\`
- divide with \`div\` / \`divu\`
- compute remainders with \`rem\` / \`remu\`

That covers the arithmetic instructions that push RV32I into full RV32IM.`,
        isCheckpoint: false,
      },
    ],
  },
  {
    id: "lesson-11-strings",
    title: "Strings and Byte Arrays",
    description: "Work with ASCII text, null terminators, and byte-by-byte traversal in memory.",
    estimatedMinutes: 30,
    difficulty: "intermediate",
    prerequisites: ["lesson-2-memory"],
    tags: ["ECE 2035", "strings", "lb", "sb", "ascii", ".asciz"],
    eceCourse: "ECE 2035",
    steps: [
      {
        id: "lesson-11-step-1",
        title: "How strings work in assembly",
        content: `A string in assembly is usually a **null-terminated byte array**. Each character is one byte, and the final byte is 0.

Example:
\`.asciz "hello"\`

Memory holds:
\`68 65 6C 6C 6F 00\`

[tip]
ASCII makes many text tricks easy. Lowercase letters are 32 larger than uppercase letters, so \`'A' + 32 = 'a'\`.
[/tip]

When you work with strings in RISC-V, you almost always use \`lb\`, \`lbu\`, and \`sb\`.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-11-step-2",
        title: "Reading a string byte by byte",
        content: `To walk a string:
1. load the base address with \`la\`
2. read one byte with \`lbu\`
3. if it is zero, stop
4. otherwise advance the pointer and repeat

That is the core pattern behind \`strlen\`, \`strcmp\`, and every simple text parser.`,
        code: [".data", 'msg: .asciz "GT"', ".text", "la x1, msg", "lbu x2, 0(x1)", "lbu x3, 1(x1)", "lbu x4, 2(x1)"].join("\n"),
        isCheckpoint: false,
      },
      {
        id: "lesson-11-step-3",
        title: "String length",
        content: `\`strlen\` counts bytes until it reaches the null terminator.

**Your goal:** compute the length of the string "Georgia". x1 should equal 7 at the end.`,
        code: [
          ".data",
          'name: .asciz "Georgia"',
          ".text",
          "la   x2, name",
          "addi x1, x0, 0",
          "loop:",
          "  # YOUR CODE HERE: load a byte, stop on 0, else count and advance",
          "done:",
        ].join("\n"),
        goals: [regGoal("strings-strlen", "x1 should equal 7", 1, 7, "Use lbu to read a byte, bne/beq to detect 0, then increment x1 and x2")],
        solution: [
          ".data",
          'name: .asciz "Georgia"',
          ".text",
          "la   x2, name",
          "addi x1, x0, 0",
          "loop:",
          "  lbu  x3, 0(x2)",
          "  beq  x3, x0, done",
          "  addi x1, x1, 1",
          "  addi x2, x2, 1",
          "  beq  x0, x0, loop",
          "done:",
        ].join("\n"),
        annotations: ["Use x2 as the pointer.", "Each nonzero byte increments the count.", "The null terminator ends the loop."],
        isCheckpoint: true,
      },
      {
        id: "lesson-11-step-4",
        title: "Uppercase to lowercase",
        content: `ASCII has a convenient property:

\`'A' = 65\`
\`'a' = 97\`

The difference is 32. So converting uppercase to lowercase can be as simple as adding 32 to the byte, if you already know the character is uppercase.

**Your goal:** convert the first character of "Hello" to lowercase and leave its ASCII value in x2.`,
        code: [
          ".data",
          'msg: .asciz "Hello"',
          ".text",
          "la   x1, msg",
          "lbu  x2, 0(x1)",
          "# YOUR CODE HERE: convert 'H' to 'h'",
        ].join("\n"),
        goals: [regGoal("strings-lowercase", "x2 should equal 104 (ASCII 'h')", 2, 104, "Add 32 to the uppercase byte")],
        solution: [".data", 'msg: .asciz "Hello"', ".text", "la   x1, msg", "lbu  x2, 0(x1)", "addi x2, x2, 32"].join("\n"),
        annotations: ["Load the first byte.", "ASCII lowercase is uppercase + 32."],
        isCheckpoint: true,
      },
      {
        id: "lesson-11-step-5",
        title: "Copying a string",
        content: `String copy is just a loop that reads one byte from the source and writes it to the destination until the byte is zero.

**Your goal:** copy \`"GT"\` to address \`0x200\`. After the copy:
- mem[0x200] = 71 ('G')
- mem[0x201] = 84 ('T')
- mem[0x202] = 0`,
        code: [
          ".data",
          'src: .asciz "GT"',
          ".text",
          "la   x1, src",
          "addi x2, x0, 0x200",
          "copy_loop:",
          "  # YOUR CODE HERE",
          "done:",
        ].join("\n"),
        goals: [
          memByteGoal("strings-copy-g", "mem[0x200] should equal ASCII 'G' (71)", 0x200, 71, "Store the source byte into the destination before advancing"),
          memByteGoal("strings-copy-t", "mem[0x201] should equal ASCII 'T' (84)", 0x201, 84, "Advance source and destination pointers by 1 byte"),
          memByteGoal("strings-copy-null", "mem[0x202] should equal 0", 0x202, 0, "Make sure the terminating zero is copied too"),
        ],
        solution: [
          ".data",
          'src: .asciz "GT"',
          ".text",
          "la   x1, src",
          "addi x2, x0, 0x200",
          "copy_loop:",
          "  lbu  x3, 0(x1)",
          "  sb   x3, 0(x2)",
          "  beq  x3, x0, done",
          "  addi x1, x1, 1",
          "  addi x2, x2, 1",
          "  beq  x0, x0, copy_loop",
          "done:",
        ].join("\n"),
        annotations: ["Load one byte.", "Store one byte.", "Stop after copying the null terminator."],
        isCheckpoint: true,
      },
      {
        id: "lesson-11-step-6",
        title: "Lesson complete",
        content: `You have completed **Strings and Byte Arrays**.

You now know how to:
- represent strings with \`.asciz\`
- walk memory one byte at a time
- count string length
- exploit ASCII structure
- copy null-terminated strings correctly

Those same patterns show up in parsers, text utilities, and many systems programs.`,
        isCheckpoint: false,
      },
    ],
  },
  {
    id: "lesson-12-linkedlist",
    title: "Linked Lists in Assembly",
    description: "Represent pointer-based data structures explicitly in memory and traverse them node by node.",
    estimatedMinutes: 35,
    difficulty: "advanced",
    prerequisites: ["lesson-9-stack", "lesson-2-memory"],
    tags: ["data structures", "pointers", "memory", "linked list"],
    steps: [
      {
        id: "lesson-12-step-1",
        title: "What a linked list looks like in memory",
        content: `A linked list node is just a small struct stored in memory:

\`struct Node { int value; Node* next; }\`

That means each node is two words:
- value at offset 0
- next pointer at offset 4

A null pointer is just 0. Traversal means:
read the value, follow the next pointer, repeat until the pointer is zero.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-12-step-2",
        title: "Traversing a list",
        content: `Here is a three-node list laid out in \`.data\`. Your job is to walk it and sum the values.

**Your goal:** sum 10 + 20 + 30 and leave 60 in x3.`,
        code: [
          ".data",
          "node3: .word 30, 0",
          "node2: .word 20, node3",
          "node1: .word 10, node2",
          ".text",
          "la   x1, node1",
          "addi x3, x0, 0",
          "loop:",
          "  beq  x1, x0, done",
          "  # YOUR CODE HERE",
          "done:",
        ].join("\n"),
        goals: [regGoal("linkedlist-sum", "x3 should equal 60", 3, 60, "Load the node value at 0(x1), add it to x3, then load the next pointer from 4(x1)")],
        solution: [
          ".data",
          "node3: .word 30, 0",
          "node2: .word 20, node3",
          "node1: .word 10, node2",
          ".text",
          "la   x1, node1",
          "addi x3, x0, 0",
          "loop:",
          "  beq  x1, x0, done",
          "  lw   x2, 0(x1)",
          "  add  x3, x3, x2",
          "  lw   x1, 4(x1)",
          "  beq  x0, x0, loop",
          "done:",
        ].join("\n"),
        annotations: ["x1 holds the current node pointer.", "Offset 0 is the value.", "Offset 4 is the next pointer."],
        isCheckpoint: true,
      },
      {
        id: "lesson-12-step-3",
        title: "Finding a value",
        content: `Searching a linked list is another traversal pattern: inspect the current node, compare its value, and either stop or follow the next pointer.

**Your goal:** search the list for value 20 and store the address of that node in x5.`,
        code: [
          ".data",
          "node3: .word 30, 0",
          "node2: .word 20, node3",
          "node1: .word 10, node2",
          ".text",
          "la   x1, node1",
          "addi x4, x0, 20",
          "addi x5, x0, 0",
          "search:",
          "  beq  x1, x0, done",
          "  # YOUR CODE HERE",
          "done:",
        ].join("\n"),
        goals: [
          {
            id: "linkedlist-find-node",
            description: "x5 should point at the node whose value is 20",
            check: (state: LessonState) => state.registers[5] !== 0 && readWord(state.memory, state.registers[5]) === 20,
            hint: "Compare lw x2, 0(x1) against x4. When they match, copy x1 into x5 and stop.",
            targetRegister: 5,
          },
        ],
        solution: [
          ".data",
          "node3: .word 30, 0",
          "node2: .word 20, node3",
          "node1: .word 10, node2",
          ".text",
          "la   x1, node1",
          "addi x4, x0, 20",
          "addi x5, x0, 0",
          "search:",
          "  beq  x1, x0, done",
          "  lw   x2, 0(x1)",
          "  beq  x2, x4, found",
          "  lw   x1, 4(x1)",
          "  beq  x0, x0, search",
          "found:",
          "  add  x5, x1, x0",
          "done:",
        ].join("\n"),
        annotations: ["Compare the current node's value against the target.", "If it matches, preserve the current pointer in x5."],
        isCheckpoint: true,
      },
      {
        id: "lesson-12-step-4",
        title: "Inserting at the head",
        content: `To insert at the head, you create a new node and point its \`next\` field at the old head. Then the head pointer changes to the new node.

If you build the new node on the stack:
1. allocate 8 bytes
2. store the new value at 0(sp)
3. store the old head at 4(sp)
4. treat sp as the new head pointer

This is a good reminder that a pointer is just an address. A linked list works the same whether the node lives in \`.data\`, the heap, or a stack frame.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-12-step-5",
        title: "Lesson complete",
        content: `You have completed **Linked Lists in Assembly**.

You now know how to:
- interpret pointers as raw addresses
- traverse pointer chains in memory
- search nodes by value
- reason about linked data structures without any runtime support

That is exactly how higher-level data structures reduce down to memory.`,
        isCheckpoint: false,
      },
    ],
  },
  {
    id: "lesson-13-recursion",
    title: "Recursion Patterns",
    description: "Use stack frames to build recursive Fibonacci, powers, and summations safely.",
    estimatedMinutes: 35,
    difficulty: "advanced",
    prerequisites: ["lesson-4-functions", "lesson-9-stack"],
    tags: ["ECE 2035", "recursion", "stack frames", "base case"],
    eceCourse: "ECE 2035",
    steps: [
      {
        id: "lesson-13-step-1",
        title: "Why recursion works",
        content: `Recursion in assembly works for exactly the same reason it works in C: every call gets its own private frame.

Each recursive call saves:
- its return address
- any locals it needs later
- any saved registers it touches

That is why the stack visualizer becomes so useful. Recursive code is just repeated call/return symmetry.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-13-step-2",
        title: "Recursive Fibonacci",
        content: `Fibonacci uses two recursive calls:
\`fib(n) = fib(n-1) + fib(n-2)\`

That means you must preserve the original n and the first recursive result while making the second call.

**Your goal:** complete the combining step so fib(7) returns 13 in a0.`,
        code: [
          "addi a0, x0, 7",
          "jal  ra, fib",
          "beq  x0, x0, done",
          "fib:",
          "  addi sp, sp, -12",
          "  sw   ra, 8(sp)",
          "  sw   a0, 4(sp)",
          "  slti t0, a0, 2",
          "  bne  t0, x0, fib_base",
          "  addi a0, a0, -1",
          "  jal  ra, fib",
          "  sw   a0, 0(sp)",
          "  lw   a0, 4(sp)",
          "  addi a0, a0, -2",
          "  jal  ra, fib",
          "  # YOUR CODE HERE: combine fib(n-1) and fib(n-2)",
          "  lw   ra, 8(sp)",
          "  addi sp, sp, 12",
          "  ret",
          "fib_base:",
          "  lw   ra, 8(sp)",
          "  addi sp, sp, 12",
          "  ret",
          "done:",
        ].join("\n"),
        goals: [regGoal("recursion-fib", "a0 should equal 13", 10, 13, "Reload fib(n-1) from 0(sp) into t1, then add it to the current a0")],
        solution: [
          "addi a0, x0, 7",
          "jal  ra, fib",
          "beq  x0, x0, done",
          "fib:",
          "  addi sp, sp, -12",
          "  sw   ra, 8(sp)",
          "  sw   a0, 4(sp)",
          "  slti t0, a0, 2",
          "  bne  t0, x0, fib_base",
          "  addi a0, a0, -1",
          "  jal  ra, fib",
          "  sw   a0, 0(sp)",
          "  lw   a0, 4(sp)",
          "  addi a0, a0, -2",
          "  jal  ra, fib",
          "  lw   t1, 0(sp)",
          "  add  a0, t1, a0",
          "  lw   ra, 8(sp)",
          "  addi sp, sp, 12",
          "  ret",
          "fib_base:",
          "  lw   ra, 8(sp)",
          "  addi sp, sp, 12",
          "  ret",
          "done:",
        ].join("\n"),
        annotations: ["Save fib(n-1) before the second recursive call.", "After the second call, add the two partial results."],
        isCheckpoint: true,
      },
      {
        id: "lesson-13-step-3",
        title: "Power function",
        content: `A recursive power function is structurally simple:

\`pow(base, exp)\`
- if exp == 0, return 1
- else return base * pow(base, exp-1)

**Your goal:** compute 2^8 recursively and return 256 in a0.`,
        code: [
          "addi a0, x0, 2",
          "addi a1, x0, 8",
          "jal  ra, power",
          "beq  x0, x0, done",
          "power:",
          "  addi sp, sp, -8",
          "  sw   ra, 4(sp)",
          "  sw   a0, 0(sp)",
          "  beq  a1, x0, power_base",
          "  addi a1, a1, -1",
          "  jal  ra, power",
          "  lw   t0, 0(sp)",
          "  mul  a0, t0, a0",
          "  lw   ra, 4(sp)",
          "  addi sp, sp, 8",
          "  ret",
          "power_base:",
          "  addi a0, x0, 1",
          "  lw   ra, 4(sp)",
          "  addi sp, sp, 8",
          "  ret",
          "done:",
        ].join("\n"),
        goals: [regGoal("recursion-power", "a0 should equal 256", 10, 256, "Assemble and step the provided recursive structure")],
        solution: [
          "addi a0, x0, 2",
          "addi a1, x0, 8",
          "jal  ra, power",
          "beq  x0, x0, done",
          "power:",
          "  addi sp, sp, -8",
          "  sw   ra, 4(sp)",
          "  sw   a0, 0(sp)",
          "  beq  a1, x0, power_base",
          "  addi a1, a1, -1",
          "  jal  ra, power",
          "  lw   t0, 0(sp)",
          "  mul  a0, t0, a0",
          "  lw   ra, 4(sp)",
          "  addi sp, sp, 8",
          "  ret",
          "power_base:",
          "  addi a0, x0, 1",
          "  lw   ra, 4(sp)",
          "  addi sp, sp, 8",
          "  ret",
          "done:",
        ].join("\n"),
        annotations: ["Save the base before recurring.", "Multiply by the saved base on the way back up."],
        isCheckpoint: true,
      },
      {
        id: "lesson-13-step-4",
        title: "Counting down recursively",
        content: `Summing \`n + (n-1) + ... + 1\` is another classic recursive pattern.

Base case:
\`sum(0) = 0\`

Recursive case:
\`sum(n) = n + sum(n-1)\`

**Your goal:** complete the function so sum(5) returns 15 in a0.`,
        code: [
          "addi a0, x0, 5",
          "jal  ra, sumdown",
          "beq  x0, x0, done",
          "sumdown:",
          "  addi sp, sp, -8",
          "  sw   ra, 4(sp)",
          "  sw   a0, 0(sp)",
          "  beq  a0, x0, sum_base",
          "  addi a0, a0, -1",
          "  jal  ra, sumdown",
          "  lw   t0, 0(sp)",
          "  # YOUR CODE HERE",
          "  lw   ra, 4(sp)",
          "  addi sp, sp, 8",
          "  ret",
          "sum_base:",
          "  addi a0, x0, 0",
          "  lw   ra, 4(sp)",
          "  addi sp, sp, 8",
          "  ret",
          "done:",
        ].join("\n"),
        goals: [regGoal("recursion-sumdown", "a0 should equal 15", 10, 15, "After reloading t0, add it into a0")],
        solution: [
          "addi a0, x0, 5",
          "jal  ra, sumdown",
          "beq  x0, x0, done",
          "sumdown:",
          "  addi sp, sp, -8",
          "  sw   ra, 4(sp)",
          "  sw   a0, 0(sp)",
          "  beq  a0, x0, sum_base",
          "  addi a0, a0, -1",
          "  jal  ra, sumdown",
          "  lw   t0, 0(sp)",
          "  add  a0, t0, a0",
          "  lw   ra, 4(sp)",
          "  addi sp, sp, 8",
          "  ret",
          "sum_base:",
          "  addi a0, x0, 0",
          "  lw   ra, 4(sp)",
          "  addi sp, sp, 8",
          "  ret",
          "done:",
        ].join("\n"),
        annotations: ["The base case returns 0.", "Each stack frame adds its own n to the recursive result."],
        isCheckpoint: true,
      },
      {
        id: "lesson-13-step-5",
        title: "Tail recursion",
        content: `A tail-recursive function passes an **accumulator** down the recursion so the recursive call is the final action.

That form is important because compilers can often optimize it into a loop and reuse a single frame.

In hand-written assembly, the lesson is conceptual: if all the useful work happens before the recursive call, the function has a much cleaner stack discipline.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-13-step-6",
        title: "Lesson complete",
        content: `You have completed **Recursion Patterns**.

You now know how to:
- structure recursive base cases in assembly
- preserve locals across multiple recursive calls
- combine recursive return values safely
- recognize when a recursive formulation can become tail-recursive

At this point, the stack should feel like a tool rather than a mystery.`,
        isCheckpoint: false,
      },
    ],
  },
  {
    id: "lesson-14-syscall",
    title: "System Calls (ecall)",
    description: "Understand what ecall means, how the ABI passes syscall information, and why traps stop execution.",
    estimatedMinutes: 20,
    difficulty: "intermediate",
    prerequisites: ["lesson-4-functions"],
    tags: ["ECE 2035", "ecall", "syscall", "OS interface"],
    eceCourse: "ECE 2035",
    steps: [
      {
        id: "lesson-14-step-1",
        title: "What is a system call?",
        content: `A system call is how a user program asks the operating system to do something privileged on its behalf.

In real hardware, \`ecall\` transitions into supervisor or machine software. In StudyRISC-V, \`ecall\` appears as a trap and halts the current simulation so you can inspect what happened.

That is still useful for learning because you can see the exact register state at the boundary between your program and the OS interface.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-14-step-2",
        title: "The syscall ABI",
        content: `By convention:
- a7 holds the syscall number
- a0-a5 hold arguments
- a0 also carries the return value

Common educational syscall numbers include:
- 1 = print int
- 4 = print string
- 10 = exit

The exact services depend on the simulator environment, but the register convention is the key idea.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-14-step-3",
        title: "The standard exit pattern",
        content: `A minimal exit sequence looks like this:
---
\`addi a7, x0, 10\`
\`ecall\`

That says "place syscall number 10 in a7, then invoke the environment call."

This is the idiomatic way to terminate a small RISC-V program in teaching environments.`,
        code: ["addi a7, x0, 10", "ecall"].join("\n"),
        isCheckpoint: false,
      },
      {
        id: "lesson-14-step-4",
        title: "From C library call to OS service",
        content: `A C call like \`printf("x=%d\\n", value)\` eventually becomes:
1. load arguments into registers
2. branch/call into a runtime wrapper
3. place a syscall number in a7
4. execute \`ecall\`

Assembly is where that high-level abstraction chain becomes concrete. The OS is not magic; it is a convention plus a trap instruction.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-14-step-5",
        title: "Lesson complete",
        content: `You have completed **System Calls (ecall)**.

You now know:
- what an environment call represents
- which registers carry syscall numbers and arguments
- why \`ecall\` is the canonical exit path
- how high-level library calls eventually map to trap-based OS services

That closes the loop between pure compute instructions and the outside world.`,
        isCheckpoint: false,
      },
    ],
  },
  {
    id: "lesson-15-capstone",
    title: "Putting It All Together: Writing a Complete Program",
    description: "Combine arrays, loops, comparisons, and RV32IM arithmetic into a complete data-processing program.",
    estimatedMinutes: 45,
    difficulty: "advanced",
    prerequisites: ["lesson-5-sorting", "lesson-11-strings", "lesson-10-mext"],
    tags: ["ECE 2035", "capstone", "integration"],
    eceCourse: "ECE 2035",
    steps: [
      {
        id: "lesson-15-step-1",
        title: "Capstone overview",
        content: `This capstone combines everything you have learned.

You will write a program that:
- loads an integer array from \`.data\`
- computes the sum
- divides by the count to get the mean
- finds the maximum value
- stores or returns those results cleanly

This is the moment where registers, memory, loops, and the M extension all work together.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-15-step-2",
        title: "Step 1: compute the sum",
        content: `Start by traversing the array and accumulating its total.

Array:
\`[3, 7, 2, 9, 4]\`

**Your goal:** leave the sum, 25, in x5.`,
        code: [
          ".data",
          "arr: .word 3, 7, 2, 9, 4",
          ".text",
          "la   x1, arr",
          "addi x2, x0, 5",
          "addi x5, x0, 0",
          "sum_loop:",
          "  # YOUR CODE HERE",
          "done:",
        ].join("\n"),
        goals: [regGoal("capstone-sum", "x5 should equal 25", 5, 25, "Load each word, add into x5, advance the pointer, and count down x2")],
        solution: [
          ".data",
          "arr: .word 3, 7, 2, 9, 4",
          ".text",
          "la   x1, arr",
          "addi x2, x0, 5",
          "addi x5, x0, 0",
          "sum_loop:",
          "  lw   x3, 0(x1)",
          "  add  x5, x5, x3",
          "  addi x1, x1, 4",
          "  addi x2, x2, -1",
          "  bne  x2, x0, sum_loop",
          "done:",
        ].join("\n"),
        annotations: ["Use x1 as the pointer, x2 as the remaining count, and x5 as the accumulator."],
        isCheckpoint: true,
      },
      {
        id: "lesson-15-step-3",
        title: "Step 2: compute the mean",
        content: `Mean is just:
\`sum / count\`

With a sum of 25 and count of 5, the mean should be 5.

**Your goal:** divide the sum by the count and store the mean in x6.`,
        code: [
          "addi x5, x0, 25",
          "addi x2, x0, 5",
          "# YOUR CODE HERE",
        ].join("\n"),
        goals: [regGoal("capstone-mean", "x6 should equal 5", 6, 5, "Use: div x6, x5, x2")],
        solution: ["addi x5, x0, 25", "addi x2, x0, 5", "div  x6, x5, x2"].join("\n"),
        annotations: ["The M extension gives you integer division directly."],
        isCheckpoint: true,
      },
      {
        id: "lesson-15-step-4",
        title: "Step 3: find the maximum",
        content: `Finding the maximum is a compare-and-update loop:
1. keep a current best value
2. inspect each new element
3. replace the best value when the new element is larger

**Your goal:** find the maximum of \`[3, 7, 2, 9, 4]\` and store it in x7.`,
        code: [
          ".data",
          "arr: .word 3, 7, 2, 9, 4",
          ".text",
          "la   x1, arr",
          "addi x2, x0, 5",
          "lw   x7, 0(x1)",
          "addi x1, x1, 4",
          "addi x2, x2, -1",
          "max_loop:",
          "  # YOUR CODE HERE",
          "done:",
        ].join("\n"),
        goals: [regGoal("capstone-max", "x7 should equal 9", 7, 9, "Load each next element, compare against x7, update when the element is larger")],
        solution: [
          ".data",
          "arr: .word 3, 7, 2, 9, 4",
          ".text",
          "la   x1, arr",
          "addi x2, x0, 5",
          "lw   x7, 0(x1)",
          "addi x1, x1, 4",
          "addi x2, x2, -1",
          "max_loop:",
          "  beq  x2, x0, done",
          "  lw   x3, 0(x1)",
          "  blt  x7, x3, take_new_max",
          "  beq  x0, x0, keep_max",
          "take_new_max:",
          "  add  x7, x3, x0",
          "keep_max:",
          "  addi x1, x1, 4",
          "  addi x2, x2, -1",
          "  beq  x0, x0, max_loop",
          "done:",
        ].join("\n"),
        annotations: ["Seed x7 with the first element, then scan the rest."],
        isCheckpoint: true,
      },
      {
        id: "lesson-15-step-5",
        title: "Step 4: the complete program",
        content: `Now combine the three subproblems into one coherent program.

**Your goal:** by the end of the run:
- x5 = 25 (sum)
- x6 = 5 (mean)
- x7 = 9 (max)

This is a realistic assembly task: multiple passes over data, multiple outputs, and enough state to require discipline.`,
        code: [
          ".data",
          "arr: .word 3, 7, 2, 9, 4",
          ".text",
          "# YOUR CODE HERE: compute sum, mean, and max",
        ].join("\n"),
        goals: [
          {
            id: "capstone-full",
            description: "x5=25, x6=5, and x7=9 all at once",
            check: (state: LessonState) => state.registers[5] === 25 && state.registers[6] === 5 && state.registers[7] === 9,
            hint: "Do the sum pass first, divide by 5 for the mean, then run a separate max pass or track max during the sum pass.",
          },
        ],
        solution: [
          ".data",
          "arr: .word 3, 7, 2, 9, 4",
          ".text",
          "la   x1, arr",
          "addi x2, x0, 5",
          "addi x5, x0, 0",
          "lw   x7, 0(x1)",
          "sum_and_max:",
          "  lw   x3, 0(x1)",
          "  add  x5, x5, x3",
          "  blt  x7, x3, update_max",
          "  beq  x0, x0, keep_scanning",
          "update_max:",
          "  add  x7, x3, x0",
          "keep_scanning:",
          "  addi x1, x1, 4",
          "  addi x2, x2, -1",
          "  bne  x2, x0, sum_and_max",
          "addi x2, x0, 5",
          "div  x6, x5, x2",
        ].join("\n"),
        annotations: ["One pass can compute both sum and max. The mean comes after the loop by dividing the total by 5."],
        isCheckpoint: true,
      },
      {
        id: "lesson-15-step-6",
        title: "Graduation message",
        content: `Congratulations. You have completed all 15 lessons in the StudyRISC-V curriculum.

At this point you have written real assembly programs involving:
- arithmetic and register flow
- memory and arrays
- branches and loops
- function calls and stack frames
- recursion
- multiply/divide
- strings and data structures

The platform tracks your total steps, completed goals, challenge solves, XP, and streaks so you can see how far you have come.`,
        isCheckpoint: false,
      },
      {
        id: "lesson-15-step-7",
        title: "Lesson complete",
        content: `You have completed **Putting It All Together** and the full platform curriculum.

The next move is practice:
- replay earlier lessons faster
- solve the challenge set
- use the simulator on ECE 2035 labs and exam prep

You now have the mental model to read assembly, not just type it.`,
        isCheckpoint: false,
      },
    ],
  },
];

const ALL_LESSONS = [...LESSONS, ...ADDITIONAL_LESSONS];

export function getLessons(): Lesson[] {
  return (lessonTestSubsetEnabled() ? LESSONS : ALL_LESSONS).slice();
}

export function getLesson(id: string): Lesson | null {
  return ALL_LESSONS.find((lesson) => lesson.id === id) ?? null;
}

export function isUnlocked(lessonId: string, progress: UserProgress): boolean {
  const lesson = getLesson(lessonId);
  if (!lesson) {
    return false;
  }
  if (lesson.prerequisites.length === 0) {
    return true;
  }
  return lesson.prerequisites.every((prerequisiteId) => progress.lessons[prerequisiteId]?.completed === true);
}

export function checkGoals(goals: LessonGoal[], state: LessonState): {
  passed: boolean;
  results: { goalId: string; passed: boolean }[];
} {
  const results = goals.map((goal) => ({
    goalId: goal.id,
    passed: goal.check(state),
  }));

  return {
    passed: results.every((result) => result.passed),
    results,
  };
}

export function getLessonState(deltas: WasmStateDelta[]): LessonState {
  const registers = Array.from({ length: 32 }, () => 0);
  const memory = new Map<number, number>();
  let pc = 0;
  let trapFired = false;

  for (const delta of deltas) {
    for (const effect of delta.effects ?? []) {
      if (effect.kind === "reg") {
        if (effect.reg !== 0) {
          registers[effect.reg] = effect.after >>> 0;
        }
      } else if (effect.kind === "mem") {
        memory.set(effect.addr >>> 0, effect.after & 0xff);
      } else if (effect.kind === "pc") {
        pc = effect.after >>> 0;
      }
    }

    registers[0] = 0;
    if (typeof delta.pc === "number") {
      pc = delta.pc >>> 0;
    }
    if (delta.trap) {
      trapFired = true;
    }
  }

  const lastDelta = deltas[deltas.length - 1];
  const lastPcEffect = lastDelta?.effects.find(
    (effect): effect is Extract<WasmStateDelta["effects"][number], { kind: "pc" }> => effect.kind === "pc"
  );
  const ecallTrap = lastDelta?.trap?.cause === "environment_call" || lastDelta?.trap?.cause === "ecall";
  const halted =
    Boolean(lastDelta?.halted) ||
    Boolean(ecallTrap) ||
    Boolean(lastDelta && lastDelta.effects.length === 0 && (!lastPcEffect || lastPcEffect.before === lastPcEffect.after));

  return {
    registers,
    memory,
    pc,
    stepCount: deltas.length,
    assembled: deltas.length > 0,
    halted,
    trapFired,
  };
}

export function saveProgress(progress: UserProgress): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  const normalized = normalizeProgress(progress);
  localStorage.setItem(LESSON_PROGRESS_STORAGE_KEY, JSON.stringify(normalized));
}

export function loadProgress(): UserProgress {
  if (typeof localStorage === "undefined") {
    return emptyProgress();
  }

  const stored = localStorage.getItem(LESSON_PROGRESS_STORAGE_KEY);
  if (!stored) {
    return emptyProgress();
  }

  try {
    return normalizeProgress(JSON.parse(stored) as unknown);
  } catch {
    return emptyProgress();
  }
}

export async function syncProgressToApi(progress: UserProgress, idToken: string): Promise<void> {
  if (!idToken || !API_ENDPOINT) {
    return;
  }

  try {
    await fetch(`${API_ENDPOINT}/progress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(normalizeProgress(progress)),
    });
  } catch {
    // Do not block the UI on sync failures.
  }
}

export async function loadProgressFromApi(idToken: string): Promise<UserProgress | null> {
  if (!idToken || !API_ENDPOINT) {
    return null;
  }

  try {
    const response = await fetch(`${API_ENDPOINT}/progress`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    return normalizeProgress((await response.json()) as unknown);
  } catch {
    return null;
  }
}

import type { WasmStateDelta } from "./types";

const LESSON_PROGRESS_STORAGE_KEY = "studyriscv_lesson_progress";
const DEFAULT_API_ENDPOINT = "https://api.studyriscv.com";
const API_ENDPOINT = (import.meta.env.VITE_API_ENDPOINT as string | undefined)?.trim() || DEFAULT_API_ENDPOINT;

export interface LessonGoal {
  id: string;
  description: string;
  check: (state: LessonState) => boolean;
  hint?: string;
}

export interface LessonStep {
  id: string;
  title: string;
  content: string;
  code?: string;
  goals?: LessonGoal[];
  isCheckpoint: boolean;
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

export function getLessons(): Lesson[] {
  return LESSONS.slice();
}

export function getLesson(id: string): Lesson | null {
  return LESSONS.find((lesson) => lesson.id === id) ?? null;
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

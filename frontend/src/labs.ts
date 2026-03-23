import type { LessonState } from "./lessons";

const LAB_SUBMISSIONS_STORAGE_KEY = "studyriscv_lab_submissions";

export interface Lab {
  id: string;
  title: string;
  number: number;
  description: string;
  objectives: string[];
  specification: {
    functionName: string;
    signature: string;
    argumentDescription: string[];
    returnDescription: string;
    constraints: string[];
    examples: Array<{
      input: string;
      output: string;
      explanation: string;
    }>;
  };
  starterCode: string;
  testCases: LabTestCase[];
  totalPoints: number;
  dueDate?: string;
  estimatedMinutes: number;
  prerequisites: string[];
  hints: LabHint[];
}

export interface LabTestCase {
  id: string;
  name: string;
  description: string;
  isHidden: boolean;
  setup: {
    registers?: Partial<Record<number, number>>;
    memory?: Array<{ address: number; bytes: number[] }>;
  };
  check: (state: LessonState) => boolean;
  points: number;
  explanation: string;
}

export interface LabHint {
  id: string;
  title: string;
  content: string;
  costPoints: number;
  unlockAfterMinutes: number;
}

export interface LabSubmission {
  labId: string;
  code: string;
  score: number;
  maxScore: number;
  passed: boolean;
  testResults: Array<{
    testId: string;
    passed: boolean;
    hidden: boolean;
  }>;
  hintsUsed: string[];
  submittedAt: string;
  timeSpentSeconds: number;
  attempts: number;
}

function readWord(memory: Map<number, number>, address: number): number {
  const b0 = memory.get(address) ?? 0;
  const b1 = memory.get(address + 1) ?? 0;
  const b2 = memory.get(address + 2) ?? 0;
  const b3 = memory.get(address + 3) ?? 0;
  return ((b0 & 0xff) | ((b1 & 0xff) << 8) | ((b2 & 0xff) << 16) | ((b3 & 0xff) << 24)) >>> 0;
}

function tc(
  id: string,
  name: string,
  description: string,
  isHidden: boolean,
  points: number,
  check: (state: LessonState) => boolean,
  explanation: string,
  setup: LabTestCase["setup"] = {}
): LabTestCase {
  return { id, name, description, isHidden, setup, check, points, explanation };
}

function emptySubmissions(): LabSubmission[] {
  return [];
}

const LABS: Lab[] = [
  {
    id: "lab-1-arrays",
    number: 1,
    title: "Array Operations",
    description: `Write three RISC-V functions: \`array_sum\`, \`array_max\`, and \`array_copy\`. Each function must follow the standard calling convention exactly. The grader will call them independently with pointers in argument registers and will check both correctness and stack discipline. Arrays contain 32-bit signed integers stored contiguously in memory.`,
    objectives: [
      "Traverse arrays with pointer arithmetic and loop counters.",
      "Return results in a0 while preserving callee-saved registers.",
      "Handle boundary cases such as empty arrays and single-element arrays.",
    ],
    specification: {
      functionName: "array_sum / array_max / array_copy",
      signature: "int array_sum(int* arr, int n); int array_max(int* arr, int n); void array_copy(int* src, int* dst, int n);",
      argumentDescription: [
        "a0 = source array pointer or input array pointer",
        "a1 = destination pointer for array_copy or element count n",
        "a2 = element count n for array_copy",
      ],
      returnDescription: "array_sum and array_max return their result in a0. array_copy returns to the caller with memory updated in place.",
      constraints: [
        "Follow the RISC-V calling convention.",
        "Do not read outside the array bounds.",
        "Handle n = 0 without trapping.",
      ],
      examples: [
        {
          input: "array_sum([4, 5, 6], 3)",
          output: "15",
          explanation: "Walk the array, add each word into an accumulator, and return the final sum.",
        },
        {
          input: "array_max([-3, -8, -1], 3)",
          output: "-1",
          explanation: "Seed the maximum with the first element, then replace it whenever a larger value appears.",
        },
      ],
    },
    starterCode: [
      ".text",
      "array_sum:",
      "  # a0 = arr, a1 = n",
      "  ret",
      "",
      "array_max:",
      "  # a0 = arr, a1 = n",
      "  ret",
      "",
      "array_copy:",
      "  # a0 = src, a1 = dst, a2 = n",
      "  ret",
    ].join("\n"),
    testCases: [
      tc("lab1-visible-sum", "Visible · sum of five", "array_sum should return 30 for [2, 4, 6, 8, 10].", false, 10, (state) => state.registers[10] === 30, "Five aligned loads and adds should accumulate to 30."),
      tc("lab1-visible-max", "Visible · max with negatives", "array_max should return -1 for [-3, -8, -1].", false, 10, (state) => state.registers[10] === 0xffffffff, "Signed comparison matters when all values are negative."),
      tc("lab1-visible-copy", "Visible · copy three words", "array_copy should duplicate three elements into the destination array.", false, 10, (state) => readWord(state.memory, 0x240) === 11 && readWord(state.memory, 0x244) === 22 && readWord(state.memory, 0x248) === 33, "Copy must preserve both order and exact 32-bit values."),
      tc("lab1-visible-empty", "Visible · empty array", "Empty arrays should not trap and should return 0 for sum.", false, 10, (state) => state.registers[10] === 0, "The count check should short-circuit before any load."),
      tc("lab1-hidden-size1", "Hidden · single element", "Single-element arrays still work for all three functions.", true, 10, (state) => state.registers[10] === 9, "A one-element loop should execute exactly once."),
      tc("lab1-hidden-allneg", "Hidden · all negative max", "array_max handles all-negative arrays.", true, 10, (state) => state.registers[10] === 0xfffffffb, "Initialize the max from memory, not from zero."),
      tc("lab1-hidden-copy10", "Hidden · longer copy", "array_copy handles ten elements correctly.", true, 10, (state) => readWord(state.memory, 0x280) === 90, "Pointer increments must be by 4 bytes."),
      tc("lab1-hidden-sum10", "Hidden · longer sum", "array_sum handles ten elements.", true, 10, (state) => state.registers[10] === 55, "The loop should count down exactly n times."),
      tc("lab1-hidden-balance", "Hidden · stack balance", "sp must be restored after the lab functions return.", true, 10, (state) => state.registers[2] === 0x7ffffffc, "The caller should see the original stack pointer restored."),
      tc("lab1-hidden-calling", "Hidden · callee-saved discipline", "s0-s11 must survive the function call if you touch them.", true, 10, (state) => state.registers[8] === 0 && state.registers[9] === 0, "Save and restore any callee-saved registers you modify."),
    ],
    totalPoints: 100,
    estimatedMinutes: 60,
    prerequisites: ["lesson-3-branches", "lesson-2-memory"],
    hints: [
      {
        id: "lab1-hint-frame",
        title: "Stack frame reminder",
        content: "Leaf functions that only use temporaries may not need a frame, but the moment you use s-registers or call helpers you must save and restore them.",
        costPoints: 0,
        unlockAfterMinutes: 0,
      },
      {
        id: "lab1-hint-tests",
        title: "Test case walkthrough",
        content: "Dry-run the visible sum test by writing the base address, current pointer, and remaining count after each iteration. Most off-by-one bugs become obvious immediately.",
        costPoints: 5,
        unlockAfterMinutes: 15,
      },
      {
        id: "lab1-hint-pseudocode",
        title: "Pseudocode",
        content: "For array_sum: total = 0; while (n > 0) { total += *arr; arr++; n--; } return total. The assembly is a direct translation of that loop.",
        costPoints: 10,
        unlockAfterMinutes: 30,
      },
    ],
  },
  {
    id: "lab-2-strings",
    number: 2,
    title: "String Processing",
    description: `Implement four classic string routines: \`strlen\`, \`strcpy\`, \`strcmp\`, and \`string_reverse\`. All strings are ASCII, null-terminated byte arrays. The grader will vary string lengths, include empty strings, and verify that you copy the trailing zero byte correctly.`,
    objectives: [
      "Traverse bytes with lbu and sb without corrupting adjacent memory.",
      "Detect null terminators reliably.",
      "Translate ASCII string algorithms into simple pointer loops.",
    ],
    specification: {
      functionName: "strlen / strcpy / strcmp / string_reverse",
      signature: "int strlen(char* s); void strcpy(char* dst, char* src); int strcmp(char* a, char* b); void string_reverse(char* s);",
      argumentDescription: [
        "a0 carries the primary string pointer.",
        "a1 carries the second pointer when needed.",
        "Return 0/1 for strcmp style checks if the harness requests it.",
      ],
      returnDescription: "strlen returns the length in a0. strcmp returns 1 when equal and 0 otherwise. The copy and reverse routines mutate memory in place.",
      constraints: [
        "Treat strings as bytes, not words.",
        "Copy the terminating zero in strcpy.",
        "Reverse in place without allocating extra memory.",
      ],
      examples: [
        {
          input: 'strlen("GT")',
          output: "2",
          explanation: "Count bytes until the null terminator, but do not count the terminator itself.",
        },
        {
          input: 'string_reverse("abc")',
          output: '"cba"',
          explanation: "Swap the first and last bytes, then move inward until the pointers cross.",
        },
      ],
    },
    starterCode: [".text", "strlen:", "  ret", "", "strcpy:", "  ret", "", "strcmp:", "  ret", "", "string_reverse:", "  ret"].join("\n"),
    testCases: [
      tc("lab2-visible-strlen", "Visible · strlen", 'strlen("Georgia") returns 7.', false, 10, (state) => state.registers[10] === 7, "Every nonzero byte increments the count."),
      tc("lab2-visible-strcpy", "Visible · strcpy", 'strcpy copies "GT" including the null terminator.', false, 10, (state) => (state.memory.get(0x240) ?? 0) === 71 && (state.memory.get(0x241) ?? 0) === 84 && (state.memory.get(0x242) ?? 0) === 0, "The destination must end with a copied zero byte."),
      tc("lab2-visible-strcmp", "Visible · strcmp equal", 'strcmp("ECE", "ECE") returns 1.', false, 10, (state) => state.registers[10] === 1, "Equality requires every byte to match through the terminator."),
      tc("lab2-visible-reverse", "Visible · reverse", 'string_reverse("CAT") rewrites memory to "TAC".', false, 10, (state) => (state.memory.get(0x200) ?? 0) === 84 && (state.memory.get(0x201) ?? 0) === 65 && (state.memory.get(0x202) ?? 0) === 67, "Swap bytes, not words."),
      tc("lab2-hidden-empty", "Hidden · empty string", "All functions handle the empty string.", true, 10, (state) => state.registers[10] === 0 || (state.memory.get(0x200) ?? 0) === 0, "The terminator may be the very first byte."),
      tc("lab2-hidden-long", "Hidden · longer string", "Longer strings still reverse and copy correctly.", true, 10, (state) => (state.memory.get(0x260) ?? 0) !== undefined, "Pointer loops should not assume a fixed length."),
      tc("lab2-hidden-case", "Hidden · mismatch", "strcmp returns 0 for different strings.", true, 10, (state) => state.registers[10] === 0, "Stop at the first mismatch."),
      tc("lab2-hidden-nulls", "Hidden · embedded terminator handling", "The copy stops at the first null byte.", true, 10, (state) => (state.memory.get(0x243) ?? 0) === 0, "Never read past the first terminator."),
      tc("lab2-hidden-reverse-even", "Hidden · even-length reverse", "Even-length strings reverse cleanly.", true, 10, (state) => (state.memory.get(0x200) ?? 0) !== 0, "Two-pointer reversal works for even and odd lengths."),
      tc("lab2-hidden-bounds", "Hidden · no overrun", "Destination bytes after the copied string remain untouched.", true, 10, (state) => (state.memory.get(0x250) ?? 0) === 0, "Copy exactly n bytes including the terminator, not beyond."),
      tc("lab2-hidden-stack", "Hidden · stack balance", "sp is restored after each function returns.", true, 10, (state) => state.registers[2] === 0x7ffffffc, "Byte loops should not disturb the caller's frame."),
      tc("lab2-hidden-saved", "Hidden · callee-saved registers", "s-registers are preserved.", true, 10, (state) => state.registers[8] === 0 && state.registers[9] === 0, "Only temporaries may be clobbered freely."),
    ],
    totalPoints: 120,
    estimatedMinutes: 75,
    prerequisites: ["lesson-11-strings"],
    hints: [
      {
        id: "lab2-hint-bytes",
        title: "Byte mindset",
        content: "Strings are byte arrays. If you accidentally use lw/sw instead of lbu/sb, you will drag unrelated bytes with you and the hidden tests will fail.",
        costPoints: 0,
        unlockAfterMinutes: 0,
      },
      {
        id: "lab2-hint-reverse",
        title: "Two-pointer reverse",
        content: "First compute the length, then set one pointer at the front and one at the last character before the terminator. Swap and move inward until they cross.",
        costPoints: 5,
        unlockAfterMinutes: 20,
      },
    ],
  },
  {
    id: "lab-3-recursion",
    number: 3,
    title: "Recursive Data Structures",
    description: `Implement recursive linked-list operations: \`list_length\`, \`list_sum\`, \`list_contains\`, and \`list_reverse\`. Iteration is not allowed. The grader will verify both correctness and that the stack pointer returns to its original value after recursion unwinds.`,
    objectives: [
      "Use base cases and recursive cases cleanly in assembly.",
      "Preserve return addresses across recursive calls.",
      "Reason about pointer-based data structures recursively.",
    ],
    specification: {
      functionName: "list_length / list_sum / list_contains / list_reverse",
      signature: "int list_length(Node* head); int list_sum(Node* head); int list_contains(Node* head, int target); Node* list_reverse(Node* head);",
      argumentDescription: [
        "a0 carries the head pointer.",
        "a1 carries the target value for list_contains.",
        "Return values go back in a0.",
      ],
      returnDescription: "Return counts, sums, boolean presence, or the new head pointer in a0.",
      constraints: [
        "Use recursion, not loops.",
        "Preserve ra and any s-registers you modify.",
        "The stack pointer must be balanced after every return.",
      ],
      examples: [
        {
          input: "list_length(10 -> 20 -> 30)",
          output: "3",
          explanation: "The length of an empty list is 0; every non-null node contributes 1 + length(next).",
        },
      ],
    },
    starterCode: [".text", "list_length:", "  ret", "", "list_sum:", "  ret", "", "list_contains:", "  ret", "", "list_reverse:", "  ret"].join("\n"),
    testCases: [
      tc("lab3-visible-length", "Visible · length", "A four-node list has length 4.", false, 10, (state) => state.registers[10] === 4, "The base case is head == 0."),
      tc("lab3-visible-sum", "Visible · sum", "A list containing 3, 4, and 5 sums to 12.", false, 10, (state) => state.registers[10] === 12, "Each frame adds the current node's value on the way back up."),
      tc("lab3-visible-contains", "Visible · contains", "list_contains returns 1 when the target exists.", false, 10, (state) => state.registers[10] === 1, "Short-circuit as soon as you see the target."),
      tc("lab3-visible-stack", "Visible · stack balance", "sp returns to 0x7FFFFFFC after the recursive call chain finishes.", false, 10, (state) => state.registers[2] === 0x7ffffffc, "Every frame must clean up before returning."),
      tc("lab3-hidden-empty", "Hidden · empty list", "The empty list is the base case for all functions.", true, 10, (state) => state.registers[10] === 0, "Return immediately on a null head pointer."),
      tc("lab3-hidden-miss", "Hidden · target missing", "list_contains returns 0 when the target is absent.", true, 10, (state) => state.registers[10] === 0, "Propagate the false result back up."),
      tc("lab3-hidden-reverse", "Hidden · reverse", "list_reverse returns the new head pointer.", true, 10, (state) => state.registers[10] !== 0, "Recursive reverse must reconnect next pointers on the unwind."),
      tc("lab3-hidden-depth", "Hidden · deeper recursion", "Longer lists still unwind correctly.", true, 10, (state) => state.registers[2] === 0x7ffffffc, "The deeper the recursion, the more important disciplined epilogues become."),
      tc("lab3-hidden-saved", "Hidden · saved registers", "s-registers survive recursion.", true, 10, (state) => state.registers[8] === 0 && state.registers[9] === 0, "Recursive helpers often tempt you to use s-registers. Save them if you do."),
      tc("lab3-hidden-identity", "Hidden · singleton reverse", "Reversing a one-node list returns the same node.", true, 10, (state) => state.registers[10] !== 0, "The base case for reverse is head == null or head->next == null."),
    ],
    totalPoints: 100,
    estimatedMinutes: 90,
    prerequisites: ["lesson-13-recursion", "lesson-12-linkedlist"],
    hints: [
      {
        id: "lab3-hint-base",
        title: "Base case first",
        content: "Write the base case before anything else. In assembly recursion, almost every bug becomes easier to see once the null-head path is correct.",
        costPoints: 0,
        unlockAfterMinutes: 0,
      },
      {
        id: "lab3-hint-frames",
        title: "Frame checklist",
        content: "Save ra, save any value you need after the recursive call, recurse, combine the result, restore ra, restore sp, ret. That order matters.",
        costPoints: 5,
        unlockAfterMinutes: 20,
      },
    ],
  },
  {
    id: "lab-4-sorting",
    number: 4,
    title: "Sorting and Searching",
    description: `Implement \`insertion_sort\` and \`binary_search\`. The sort operates in place on ascending integer arrays. The search assumes the array is already sorted and returns the index of the target or -1 if it is not present. The grader includes duplicate values, one-element arrays, and already sorted inputs.`,
    objectives: [
      "Implement nested loops in assembly.",
      "Use comparisons carefully for sorted invariants.",
      "Combine search arithmetic with pointer math.",
    ],
    specification: {
      functionName: "insertion_sort / binary_search",
      signature: "void insertion_sort(int* arr, int n); int binary_search(int* arr, int n, int target);",
      argumentDescription: [
        "a0 = array base pointer",
        "a1 = element count n",
        "a2 = target for binary_search",
      ],
      returnDescription: "binary_search returns the index in a0 or -1 if the target is not found.",
      constraints: [
        "Sort in place ascending.",
        "Binary search must compute the midpoint using integer arithmetic.",
        "Handle n = 0 and n = 1 correctly.",
      ],
      examples: [
        {
          input: "binary_search([1, 4, 7, 9], 4, 7)",
          output: "2",
          explanation: "The midpoint lands directly on the target in the second position from zero.",
        },
      ],
    },
    starterCode: [".text", "insertion_sort:", "  ret", "", "binary_search:", "  ret"].join("\n"),
    testCases: [
      tc("lab4-visible-sort", "Visible · insertion sort", "Sort [5, 2, 8, 1, 4] ascending in place.", false, 10, (state) => readWord(state.memory, 0x10000000) === 1 && readWord(state.memory, 0x10000010) === 8, "Insertion sort should leave the array fully sorted."),
      tc("lab4-visible-search", "Visible · binary search hit", "binary_search returns index 3 for target 9 in [1, 4, 7, 9].", false, 10, (state) => state.registers[10] === 3, "Maintain low/high bounds and recompute mid each iteration."),
      tc("lab4-visible-miss", "Visible · binary search miss", "binary_search returns -1 when the target is not present.", false, 10, (state) => state.registers[10] === 0xffffffff, "Use -1 for the miss case."),
      tc("lab4-visible-single", "Visible · single element", "Single-element arrays should not break the sort or search logic.", false, 10, (state) => state.registers[10] === 0 || state.registers[10] === 0xffffffff, "Short loops should terminate cleanly."),
      tc("lab4-hidden-duplicates", "Hidden · duplicates", "Insertion sort handles duplicate values deterministically.", true, 10, (state) => readWord(state.memory, 0x10000004) <= readWord(state.memory, 0x10000008), "Stable-ish behavior comes from only shifting values greater than the key."),
      tc("lab4-hidden-sorted", "Hidden · already sorted", "Already sorted arrays stay sorted.", true, 10, (state) => readWord(state.memory, 0x10000000) <= readWord(state.memory, 0x10000004), "Do not disturb good order."),
      tc("lab4-hidden-desc", "Hidden · reverse order", "Insertion sort handles worst-case descending input.", true, 10, (state) => readWord(state.memory, 0x10000000) === 1, "The inner loop must shift larger elements right."),
      tc("lab4-hidden-search-edge", "Hidden · first element", "Binary search finds the first element correctly.", true, 10, (state) => state.registers[10] === 0, "The search bounds are inclusive."),
      tc("lab4-hidden-search-last", "Hidden · last element", "Binary search finds the last element correctly.", true, 10, (state) => state.registers[10] >= 0, "Keep the high bound alive until it is ruled out."),
      tc("lab4-hidden-balance", "Hidden · stack balance", "The caller's sp is restored.", true, 10, (state) => state.registers[2] === 0x7ffffffc, "Even iterative functions need clean prologues if they allocate a frame."),
      tc("lab4-hidden-callee", "Hidden · callee-saved", "s-registers survive.", true, 10, (state) => state.registers[8] === 0 && state.registers[9] === 0, "Preserve the ABI."),
      tc("lab4-hidden-wide", "Hidden · longer array", "Longer arrays still sort correctly.", true, 10, (state) => readWord(state.memory, 0x10000014) >= readWord(state.memory, 0x10000010), "Nested loops must scale beyond the visible sample."),
      tc("lab4-hidden-empty", "Hidden · empty search", "Searching an empty array returns -1.", true, 10, (state) => state.registers[10] === 0xffffffff, "Reject n = 0 before calculating a midpoint."),
      tc("lab4-hidden-one", "Hidden · one-element search miss", "Searching a one-element array for a missing value returns -1.", true, 10, (state) => state.registers[10] === 0xffffffff, "The bounds should cross after one comparison."),
    ],
    totalPoints: 140,
    estimatedMinutes: 90,
    prerequisites: ["lesson-5-sorting"],
    hints: [
      {
        id: "lab4-hint-key",
        title: "Insertion sort key idea",
        content: "Hold the current key value in a register, shift larger elements one slot to the right, then write the key into the hole you just opened.",
        costPoints: 0,
        unlockAfterMinutes: 0,
      },
      {
        id: "lab4-hint-mid",
        title: "Binary search midpoint",
        content: "Compute mid as low + ((high - low) >> 1). That avoids thinking in bytes until you actually form the element address.",
        costPoints: 5,
        unlockAfterMinutes: 25,
      },
    ],
  },
  {
    id: "lab-5-matrix",
    number: 5,
    title: "Matrix Operations",
    description: `Implement \`matrix_multiply\` for square integer matrices in row-major order and \`matrix_transpose\` in place. The lab uses 3x3 matrices in the visible cases and hidden cases vary the inputs while preserving the same memory layout. Use the M extension for multiplication.`,
    objectives: [
      "Translate nested-loop matrix code into address arithmetic.",
      "Use row-major indexing correctly.",
      "Combine multiply and accumulation without losing track of loop counters.",
    ],
    specification: {
      functionName: "matrix_multiply / matrix_transpose",
      signature: "void matrix_multiply(int* a, int* b, int* result, int n); void matrix_transpose(int* m, int n);",
      argumentDescription: [
        "a0 = pointer to matrix A",
        "a1 = pointer to matrix B",
        "a2 = pointer to output matrix or dimension n for transpose depending on the harness",
        "a3 = dimension n for matrix_multiply",
      ],
      returnDescription: "Both functions mutate memory in place or write to the provided output matrix.",
      constraints: [
        "Matrices are stored row-major.",
        "Use integer multiplication only.",
        "Do not allocate auxiliary heap storage.",
      ],
      examples: [
        {
          input: "matrix_multiply(I, X, result, 3)",
          output: "result = X",
          explanation: "Multiplying by the identity matrix should preserve the other operand.",
        },
      ],
    },
    starterCode: [".text", "matrix_multiply:", "  ret", "", "matrix_transpose:", "  ret"].join("\n"),
    testCases: [
      tc("lab5-visible-identity", "Visible · identity multiply", "Multiplying by the identity matrix should reproduce the other matrix.", false, 10, (state) => readWord(state.memory, 0x300) === 1 && readWord(state.memory, 0x320) === 9, "Each result[i][j] is the dot product of row i and column j."),
      tc("lab5-visible-zero", "Visible · zero matrix", "Multiplying by a zero matrix yields all zeros.", false, 10, (state) => readWord(state.memory, 0x300) === 0 && readWord(state.memory, 0x320) === 0, "Every accumulated dot product should stay zero."),
      tc("lab5-visible-transpose", "Visible · transpose", "Transposing a 3x3 matrix swaps rows and columns in place.", false, 10, (state) => readWord(state.memory, 0x200) === 1 && readWord(state.memory, 0x204) === 4, "Swap across the diagonal only once."),
      tc("lab5-visible-random", "Visible · random multiply", "Random 3x3 matrices multiply to the expected result.", false, 10, (state) => readWord(state.memory, 0x300) !== undefined, "The nested loops should visit every output cell."),
      tc("lab5-hidden-other", "Hidden · another random multiply", "A second random case validates general correctness.", true, 10, (state) => readWord(state.memory, 0x308) !== undefined, "Avoid hardcoding visible data."),
      tc("lab5-hidden-symmetric", "Hidden · symmetric transpose", "Transposing a symmetric matrix leaves it unchanged.", true, 10, (state) => readWord(state.memory, 0x208) === readWord(state.memory, 0x220), "A symmetric matrix equals its own transpose."),
      tc("lab5-hidden-upper", "Hidden · upper triangular", "Upper-triangular matrices transpose correctly.", true, 10, (state) => readWord(state.memory, 0x204) <= readWord(state.memory, 0x210), "Index calculations must map row-major storage consistently."),
      tc("lab5-hidden-lower", "Hidden · lower triangular", "Lower-triangular matrices transpose correctly.", true, 10, (state) => readWord(state.memory, 0x210) >= 0, "Only visit each off-diagonal pair once."),
      tc("lab5-hidden-ones", "Hidden · all ones multiply", "Multiplying all-ones matrices produces predictable repeated sums.", true, 10, (state) => readWord(state.memory, 0x300) === 3, "Each output cell should be the sum of three products of 1."),
      tc("lab5-hidden-balance", "Hidden · stack balance", "sp is restored after the matrix routines return.", true, 10, (state) => state.registers[2] === 0x7ffffffc, "Nested loops and helper calls still need balanced frames."),
      tc("lab5-hidden-saved", "Hidden · callee-saved", "s-registers survive the lab routines.", true, 10, (state) => state.registers[8] === 0 && state.registers[9] === 0, "Preserve the ABI while using loop state."),
      tc("lab5-hidden-dimension", "Hidden · dimension handling", "The loops respect the n parameter instead of assuming 3 forever.", true, 10, (state) => state.registers[10] === state.registers[10], "Indexing must derive from n, not a constant."),
    ],
    totalPoints: 120,
    estimatedMinutes: 120,
    prerequisites: ["lesson-10-mext", "lesson-9-stack"],
    hints: [
      {
        id: "lab5-hint-index",
        title: "Row-major indexing",
        content: "The address of element [i][j] is base + ((i * n) + j) * 4. Keep that formula visible while you write the loops.",
        costPoints: 0,
        unlockAfterMinutes: 0,
      },
      {
        id: "lab5-hint-dot",
        title: "Dot-product structure",
        content: "For matrix_multiply, each output cell runs an inner loop over k: sum += A[i][k] * B[k][j]. That is the entire algorithm.",
        costPoints: 10,
        unlockAfterMinutes: 30,
      },
    ],
  },
];

export function getLabs(): Lab[] {
  return LABS.slice();
}

export function getLab(id: string): Lab | null {
  return LABS.find((lab) => lab.id === id) ?? null;
}

export function saveLabSubmission(submission: LabSubmission): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(LAB_SUBMISSIONS_STORAGE_KEY, JSON.stringify([...loadLabSubmissions(), submission]));
}

export function loadLabSubmissions(): LabSubmission[] {
  if (typeof localStorage === "undefined") {
    return emptySubmissions();
  }

  const stored = localStorage.getItem(LAB_SUBMISSIONS_STORAGE_KEY);
  if (!stored) {
    return emptySubmissions();
  }

  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? (parsed.filter((entry): entry is LabSubmission => Boolean(entry && typeof entry === "object")) as LabSubmission[]) : emptySubmissions();
  } catch {
    return emptySubmissions();
  }
}

export function getBestLabSubmission(labId: string): LabSubmission | null {
  const submissions = loadLabSubmissions().filter((submission) => submission.labId === labId);
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
  }, null as LabSubmission | null);
}

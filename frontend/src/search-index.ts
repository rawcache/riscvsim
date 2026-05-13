import { getChallenges } from "./challenges";
import { getLabs } from "./labs";
import { getLessons } from "./lessons";
import { getProblems } from "./problem-data";
import { getQuizzes } from "./quiz";

export type SearchCategory =
  | "problem"
  | "lesson"
  | "challenge"
  | "lab"
  | "quiz"
  | "instruction"
  | "register"
  | "concept"
  | "page";

export interface SearchEntry {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  url: string;
  category: SearchCategory;
  categoryLabel: string;
  icon: string;
}

type StaticEntrySeed = Omit<SearchEntry, "keywords"> & {
  keywords: Array<string | undefined>;
};

function firstSentence(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = normalized.match(/^.+?[.!?](?:\s|$)/);
  return match ? match[0].trim() : normalized;
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, " ");
}

function splitKeywords(text: string): string[] {
  const normalized = text.replace(/[`"'()[\]{}]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }
  return normalized
    .split(/[,:;/]|(?:\s+-\s+)|(?:\s+·\s+)/)
    .flatMap((part) => {
      const trimmed = part.trim();
      if (!trimmed) {
        return [];
      }
      return [trimmed];
    });
}

function uniqueKeywords(values: Array<string | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .flatMap((value) => (value ? [value, ...splitKeywords(value)] : []))
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

const INSTRUCTION_METADATA: Array<{
  mnemonic: string;
  title: string;
  description: string;
  keywords: string[];
}> = [
  { mnemonic: "add", title: "Add", description: "rd = rs1 + rs2. Adds two integer registers.", keywords: ["add", "arithmetic", "R-type", "integer add"] },
  { mnemonic: "addi", title: "Add Immediate", description: "rd = rs1 + sign_extend(imm12). Adds a 12-bit signed immediate to rs1.", keywords: ["addi", "add immediate", "I-type", "load constant", "initialize register"] },
  { mnemonic: "sub", title: "Subtract", description: "rd = rs1 - rs2. Subtracts rs2 from rs1.", keywords: ["sub", "subtract", "arithmetic", "R-type"] },
  { mnemonic: "lui", title: "Load Upper Immediate", description: "rd = imm20 << 12. Loads an immediate into the upper 20 bits.", keywords: ["lui", "upper immediate", "constant", "U-type"] },
  { mnemonic: "auipc", title: "Add Upper Immediate to PC", description: "rd = pc + (imm20 << 12). Builds PC-relative addresses.", keywords: ["auipc", "pc relative", "addressing", "U-type"] },
  { mnemonic: "and", title: "Bitwise AND", description: "rd = rs1 & rs2. Clears bits using a mask.", keywords: ["and", "bitwise", "mask", "logic"] },
  { mnemonic: "andi", title: "Bitwise AND Immediate", description: "rd = rs1 & imm12. Applies an immediate bit mask.", keywords: ["andi", "bitwise", "mask", "logic"] },
  { mnemonic: "or", title: "Bitwise OR", description: "rd = rs1 | rs2. Sets bits without clearing others.", keywords: ["or", "bitwise", "logic", "set bits"] },
  { mnemonic: "ori", title: "Bitwise OR Immediate", description: "rd = rs1 | imm12. Sets selected bits with an immediate.", keywords: ["ori", "bitwise", "logic", "set bits"] },
  { mnemonic: "xor", title: "Bitwise XOR", description: "rd = rs1 ^ rs2. Toggles bits that differ.", keywords: ["xor", "bitwise", "toggle", "logic"] },
  { mnemonic: "xori", title: "Bitwise XOR Immediate", description: "rd = rs1 ^ imm12. Often used for bit toggles and bitwise not.", keywords: ["xori", "bitwise not", "toggle", "logic"] },
  { mnemonic: "sll", title: "Shift Left Logical", description: "rd = rs1 << rs2[4:0]. Shifts bits left, filling with zeros.", keywords: ["sll", "shift left", "multiply by powers of two", "bitwise"] },
  { mnemonic: "slli", title: "Shift Left Logical Immediate", description: "rd = rs1 << shamt. Immediate left shift.", keywords: ["slli", "shift left", "multiply by powers of two", "bitwise"] },
  { mnemonic: "srl", title: "Shift Right Logical", description: "rd = rs1 >> rs2[4:0] using zero fill.", keywords: ["srl", "logical shift right", "unsigned divide", "bitwise"] },
  { mnemonic: "srli", title: "Shift Right Logical Immediate", description: "rd = rs1 >> shamt using zero fill.", keywords: ["srli", "logical shift right", "unsigned divide", "bitwise"] },
  { mnemonic: "sra", title: "Shift Right Arithmetic", description: "rd = rs1 >> rs2[4:0] preserving the sign bit.", keywords: ["sra", "arithmetic shift right", "signed divide", "bitwise"] },
  { mnemonic: "srai", title: "Shift Right Arithmetic Immediate", description: "rd = rs1 >> shamt preserving the sign bit.", keywords: ["srai", "arithmetic shift right", "signed divide", "bitwise"] },
  { mnemonic: "slt", title: "Set Less Than", description: "rd = 1 if rs1 < rs2 as signed integers, else 0.", keywords: ["slt", "comparison", "signed", "set less than"] },
  { mnemonic: "slti", title: "Set Less Than Immediate", description: "rd = 1 if rs1 < imm12 as signed integers, else 0.", keywords: ["slti", "comparison", "signed", "set less than"] },
  { mnemonic: "sltu", title: "Set Less Than Unsigned", description: "rd = 1 if rs1 < rs2 as unsigned integers, else 0.", keywords: ["sltu", "comparison", "unsigned", "set less than"] },
  { mnemonic: "sltiu", title: "Set Less Than Immediate Unsigned", description: "rd = 1 if rs1 < imm12 as unsigned integers, else 0.", keywords: ["sltiu", "comparison", "unsigned", "set less than"] },
  { mnemonic: "lw", title: "Load Word", description: "rd = *(u32*)(rs1 + imm12). Loads a 32-bit word from memory.", keywords: ["lw", "load word", "memory", "load store", "I-type"] },
  { mnemonic: "lh", title: "Load Halfword", description: "rd = sign_extend(*(i16*)(rs1 + imm12)). Loads 16 bits and sign extends.", keywords: ["lh", "load halfword", "memory", "sign extend"] },
  { mnemonic: "lb", title: "Load Byte", description: "rd = sign_extend(*(i8*)(rs1 + imm12)). Loads 8 bits and sign extends.", keywords: ["lb", "load byte", "memory", "sign extend"] },
  { mnemonic: "lhu", title: "Load Halfword Unsigned", description: "rd = zero_extend(*(u16*)(rs1 + imm12)). Loads 16 bits without sign extension.", keywords: ["lhu", "load halfword unsigned", "memory", "zero extend"] },
  { mnemonic: "lbu", title: "Load Byte Unsigned", description: "rd = zero_extend(*(u8*)(rs1 + imm12)). Loads 8 bits without sign extension.", keywords: ["lbu", "load byte unsigned", "memory", "zero extend"] },
  { mnemonic: "sw", title: "Store Word", description: "*(u32*)(rs1 + imm12) = rs2. Stores a 32-bit word to memory.", keywords: ["sw", "store word", "memory", "load store", "S-type"] },
  { mnemonic: "sh", title: "Store Halfword", description: "*(u16*)(rs1 + imm12) = rs2[15:0]. Stores 16 bits to memory.", keywords: ["sh", "store halfword", "memory"] },
  { mnemonic: "sb", title: "Store Byte", description: "*(u8*)(rs1 + imm12) = rs2[7:0]. Stores 8 bits to memory.", keywords: ["sb", "store byte", "memory"] },
  { mnemonic: "beq", title: "Branch if Equal", description: "If rs1 == rs2, control jumps to the target label.", keywords: ["beq", "branch if equal", "control flow", "B-type"] },
  { mnemonic: "bne", title: "Branch if Not Equal", description: "If rs1 != rs2, control jumps to the target label.", keywords: ["bne", "branch if not equal", "control flow", "B-type"] },
  { mnemonic: "blt", title: "Branch if Less Than", description: "If rs1 < rs2 as signed integers, control jumps to the target label.", keywords: ["blt", "branch if less than", "signed comparison", "B-type"] },
  { mnemonic: "bge", title: "Branch if Greater or Equal", description: "If rs1 >= rs2 as signed integers, control jumps to the target label.", keywords: ["bge", "branch if greater or equal", "signed comparison", "B-type"] },
  { mnemonic: "bltu", title: "Branch if Less Than Unsigned", description: "If rs1 < rs2 as unsigned integers, control jumps to the target label.", keywords: ["bltu", "branch if less than unsigned", "unsigned comparison", "B-type"] },
  { mnemonic: "bgeu", title: "Branch if Greater or Equal Unsigned", description: "If rs1 >= rs2 as unsigned integers, control jumps to the target label.", keywords: ["bgeu", "branch if greater or equal unsigned", "unsigned comparison", "B-type"] },
  { mnemonic: "jal", title: "Jump and Link", description: "rd = pc + 4, then pc jumps to the target. Used for function calls.", keywords: ["jal", "jump and link", "call", "return address", "J-type"] },
  { mnemonic: "jalr", title: "Jump and Link Register", description: "rd = pc + 4, then pc = (rs1 + imm) & ~1. Used for indirect calls and returns.", keywords: ["jalr", "jump and link register", "return", "indirect jump", "I-type"] },
  { mnemonic: "mul", title: "Multiply", description: "rd = low32(rs1 * rs2). Returns the low 32 bits of the product.", keywords: ["mul", "multiply", "M extension", "RV32IM"] },
  { mnemonic: "mulh", title: "Multiply High Signed", description: "rd = high32((int64)rs1 * (int64)rs2). Returns the signed high half.", keywords: ["mulh", "multiply high", "M extension", "signed"] },
  { mnemonic: "mulhu", title: "Multiply High Unsigned", description: "rd = high32((uint64)rs1 * (uint64)rs2). Returns the unsigned high half.", keywords: ["mulhu", "multiply high unsigned", "M extension", "unsigned"] },
  { mnemonic: "mulhsu", title: "Multiply High Signed-Unsigned", description: "rd = high32((int64)rs1 * (uint64)rs2). Mixed signedness multiply-high.", keywords: ["mulhsu", "multiply high mixed", "M extension"] },
  { mnemonic: "div", title: "Divide Signed", description: "rd = rs1 / rs2 using signed division.", keywords: ["div", "divide", "signed", "M extension"] },
  { mnemonic: "divu", title: "Divide Unsigned", description: "rd = rs1 / rs2 using unsigned division.", keywords: ["divu", "divide unsigned", "M extension"] },
  { mnemonic: "rem", title: "Remainder Signed", description: "rd = rs1 % rs2 using signed remainder.", keywords: ["rem", "remainder", "modulo", "M extension"] },
  { mnemonic: "remu", title: "Remainder Unsigned", description: "rd = rs1 % rs2 using unsigned remainder.", keywords: ["remu", "remainder unsigned", "modulo", "M extension"] },
  { mnemonic: "ecall", title: "Environment Call", description: "Raises a system call trap. The OS or runtime handles the request.", keywords: ["ecall", "system call", "trap", "ABI"] },
  { mnemonic: "ebreak", title: "Environment Break", description: "Raises a breakpoint trap, typically for debugging.", keywords: ["ebreak", "breakpoint", "trap", "debug"] },
  { mnemonic: "li", title: "Load Immediate (Pseudo)", description: "Loads a constant into a register. Expands to addi or lui+addi depending on size.", keywords: ["li", "pseudo instruction", "constant", "load immediate"] },
  { mnemonic: "mv", title: "Move Register (Pseudo)", description: "Copies one register into another. Expands to addi rd, rs, 0.", keywords: ["mv", "move", "pseudo instruction", "copy register"] },
  { mnemonic: "la", title: "Load Address (Pseudo)", description: "Loads the address of a label, usually via auipc plus addi.", keywords: ["la", "load address", "pseudo instruction", "data label"] },
  { mnemonic: "nop", title: "No Operation (Pseudo)", description: "Does nothing. Expands to addi x0, x0, 0.", keywords: ["nop", "no operation", "pseudo instruction"] },
  { mnemonic: "j", title: "Jump (Pseudo)", description: "Unconditional jump to a label. Expands to jal x0, label.", keywords: ["j", "jump", "pseudo instruction", "branch"] },
  { mnemonic: "ret", title: "Return (Pseudo)", description: "Returns from a function. Expands to jalr x0, ra, 0.", keywords: ["ret", "return", "pseudo instruction", "jalr", "ra"] },
  { mnemonic: "call", title: "Call (Pseudo)", description: "Calls a function label using auipc and jalr when needed.", keywords: ["call", "function call", "pseudo instruction", "jal", "jalr"] },
];

const REGISTER_METADATA = [
  { abi: "zero", x: 0, title: "Zero", description: "Always reads as 0. Writes are discarded.", keywords: ["zero", "x0", "always 0", "hardwired zero"] },
  { abi: "ra", x: 1, title: "Return Address", description: "Holds the return address after jal. Save it before nested calls.", keywords: ["ra", "x1", "return address", "jal", "caller saved"] },
  { abi: "sp", x: 2, title: "Stack Pointer", description: "Points to the top of the call stack. Decrements for frame allocation.", keywords: ["sp", "x2", "stack pointer", "stack", "frame"] },
  { abi: "gp", x: 3, title: "Global Pointer", description: "Points into small global data regions used by some toolchains.", keywords: ["gp", "x3", "global pointer", "small data"] },
  { abi: "tp", x: 4, title: "Thread Pointer", description: "Points to thread-local storage in multi-threaded environments.", keywords: ["tp", "x4", "thread pointer", "tls"] },
  { abi: "t0", x: 5, title: "Temporary 0", description: "Caller-saved temporary register.", keywords: ["t0", "x5", "temporary", "caller saved"] },
  { abi: "t1", x: 6, title: "Temporary 1", description: "Caller-saved temporary register.", keywords: ["t1", "x6", "temporary", "caller saved"] },
  { abi: "t2", x: 7, title: "Temporary 2", description: "Caller-saved temporary register.", keywords: ["t2", "x7", "temporary", "caller saved"] },
  { abi: "s0/fp", x: 8, title: "Saved Register 0 / Frame Pointer", description: "Callee-saved register. Often used as fp for stable frame offsets.", keywords: ["s0", "fp", "x8", "frame pointer", "callee saved"] },
  { abi: "s1", x: 9, title: "Saved Register 1", description: "Callee-saved general-purpose register.", keywords: ["s1", "x9", "saved register", "callee saved"] },
  { abi: "a0", x: 10, title: "Argument / Return 0", description: "First argument register and primary return value.", keywords: ["a0", "x10", "argument", "return value"] },
  { abi: "a1", x: 11, title: "Argument / Return 1", description: "Second argument register and secondary return value.", keywords: ["a1", "x11", "argument", "return value"] },
  { abi: "a2", x: 12, title: "Argument 2", description: "Third argument register.", keywords: ["a2", "x12", "argument"] },
  { abi: "a3", x: 13, title: "Argument 3", description: "Fourth argument register.", keywords: ["a3", "x13", "argument"] },
  { abi: "a4", x: 14, title: "Argument 4", description: "Fifth argument register.", keywords: ["a4", "x14", "argument"] },
  { abi: "a5", x: 15, title: "Argument 5", description: "Sixth argument register.", keywords: ["a5", "x15", "argument"] },
  { abi: "a6", x: 16, title: "Argument 6", description: "Seventh argument register.", keywords: ["a6", "x16", "argument"] },
  { abi: "a7", x: 17, title: "Argument 7 / Syscall ID", description: "Eighth argument register. Also carries the syscall number for ecall.", keywords: ["a7", "x17", "syscall id", "ecall", "argument"] },
  { abi: "s2", x: 18, title: "Saved Register 2", description: "Callee-saved register.", keywords: ["s2", "x18", "saved register", "callee saved"] },
  { abi: "s3", x: 19, title: "Saved Register 3", description: "Callee-saved register.", keywords: ["s3", "x19", "saved register", "callee saved"] },
  { abi: "s4", x: 20, title: "Saved Register 4", description: "Callee-saved register.", keywords: ["s4", "x20", "saved register", "callee saved"] },
  { abi: "s5", x: 21, title: "Saved Register 5", description: "Callee-saved register.", keywords: ["s5", "x21", "saved register", "callee saved"] },
  { abi: "s6", x: 22, title: "Saved Register 6", description: "Callee-saved register.", keywords: ["s6", "x22", "saved register", "callee saved"] },
  { abi: "s7", x: 23, title: "Saved Register 7", description: "Callee-saved register.", keywords: ["s7", "x23", "saved register", "callee saved"] },
  { abi: "s8", x: 24, title: "Saved Register 8", description: "Callee-saved register.", keywords: ["s8", "x24", "saved register", "callee saved"] },
  { abi: "s9", x: 25, title: "Saved Register 9", description: "Callee-saved register.", keywords: ["s9", "x25", "saved register", "callee saved"] },
  { abi: "s10", x: 26, title: "Saved Register 10", description: "Callee-saved register.", keywords: ["s10", "x26", "saved register", "callee saved"] },
  { abi: "s11", x: 27, title: "Saved Register 11", description: "Callee-saved register.", keywords: ["s11", "x27", "saved register", "callee saved"] },
  { abi: "t3", x: 28, title: "Temporary 3", description: "Caller-saved temporary register.", keywords: ["t3", "x28", "temporary", "caller saved"] },
  { abi: "t4", x: 29, title: "Temporary 4", description: "Caller-saved temporary register.", keywords: ["t4", "x29", "temporary", "caller saved"] },
  { abi: "t5", x: 30, title: "Temporary 5", description: "Caller-saved temporary register.", keywords: ["t5", "x30", "temporary", "caller saved"] },
  { abi: "t6", x: 31, title: "Temporary 6", description: "Caller-saved temporary register.", keywords: ["t6", "x31", "temporary", "caller saved"] },
] as const;

const CONCEPT_ENTRIES: StaticEntrySeed[] = [
  { id: "concept-stack-pointer", title: "Stack Pointer (sp)", description: "x2. Points to the top of the call stack. Decrements on function entry and increments on return.", keywords: ["sp", "stack pointer", "x2", "stack", "frame", "push", "pop"], url: "/docs/#calling-convention", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-frame-pointer", title: "Frame Pointer (fp / s0)", description: "x8. A stable reference point for stack-frame locals even when sp changes.", keywords: ["fp", "frame pointer", "s0", "x8", "stack frame", "base pointer"], url: "/docs/#calling-convention", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-calling-convention", title: "RISC-V Calling Convention", description: "Defines how arguments, return values, saved registers, and stack frames work across function calls.", keywords: ["calling convention", "caller saved", "callee saved", "abi", "function call", "arguments", "return value", "a0", "a7"], url: "/docs/#calling-convention", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-pipeline", title: "Instruction Pipeline", description: "The classic IF, ID, EX, MEM, WB execution stages and the hazards between them.", keywords: ["pipeline", "stages", "if", "id", "ex", "mem", "wb", "hazard", "stall", "forwarding"], url: "/docs/#pipeline", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-twos-complement", title: "Two's Complement", description: "The signed integer encoding used by RV32I for negative values and arithmetic comparisons.", keywords: ["two's complement", "signed", "negative", "overflow", "sign bit", "msb"], url: "/docs/#arithmetic", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-mmio", title: "Memory-Mapped I/O", description: "Peripheral registers occupy memory addresses so CPU loads and stores can communicate with devices.", keywords: ["mmio", "memory mapped", "peripheral", "io", "address space"], url: "/docs/#memory", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-load-store", title: "Load-Store Architecture", description: "Arithmetic operates only on registers. Memory is accessed explicitly with load and store instructions.", keywords: ["load store", "risc", "lw", "sw", "memory access", "register only alu"], url: "/docs/#memory", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-riscv", title: "What is RISC-V?", description: "An open standard instruction set architecture based on RISC principles. StudyRISC-V focuses on RV32IM.", keywords: ["risc-v", "riscv", "what is risc", "isa", "instruction set", "open standard", "rv32im", "rv32i"], url: "/docs/#overview", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-pseudo", title: "Pseudo-Instructions", description: "Assembler conveniences like li, mv, la, j, and ret that expand into real hardware instructions.", keywords: ["pseudo", "pseudo instruction", "li", "mv", "la", "nop", "j", "ret", "assembler"], url: "/docs/#pseudo", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-ece2035", title: "Assembly Courses", description: "StudyRISC-V covers the RISC-V and processor concepts used in university assembly language courses (ECE 2035, CS 61C, ECE 3058, and others).", keywords: ["ece 2035", "ece2035", "georgia tech", "gatech", "cs 61c", "berkeley", "processor design", "assembly course", "university"], url: "/docs/#ece-2035", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-cache", title: "Cache Behavior", description: "Locality, cache lines, and access patterns determine whether memory feels fast or slow.", keywords: ["cache", "cache line", "locality", "l1", "l2", "memory hierarchy"], url: "/docs/#cache", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-recursion", title: "Recursion", description: "A function calling itself with smaller subproblems. Correct stack discipline is non-negotiable.", keywords: ["recursion", "recursive call", "base case", "stack frame", "factorial", "fibonacci"], url: "/docs/#recursion", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-linked-lists", title: "Linked Lists", description: "Pointer-based nodes stored in memory, each holding data and the address of the next node.", keywords: ["linked list", "node", "pointer", "next field", "pointer chasing"], url: "/docs/#data-structures", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-float", title: "IEEE 754 Floating Point", description: "Single-precision values use sign, exponent, and mantissa fields packed into 32 bits.", keywords: ["floating point", "ieee 754", "float", "mantissa", "exponent", "sign bit"], url: "/docs/#floating-point", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-interrupts", title: "Interrupts and Traps", description: "Exceptions and interrupts redirect control flow to privileged trap handlers via CSRs.", keywords: ["interrupt", "exception", "trap", "mepc", "mcause", "mtvec", "csr"], url: "/docs/#interrupts", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-branch-prediction", title: "Branch Prediction", description: "Processors guess branch direction to keep the pipeline busy and reduce control stalls.", keywords: ["branch prediction", "predictor", "control hazard", "branch penalty"], url: "/docs/#pipeline", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-syscall", title: "System Calls", description: "User code requests operating-system services by placing arguments in a-registers and executing ecall.", keywords: ["syscall", "system call", "ecall", "a7", "trap"], url: "/docs/#syscalls", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-fixed-point", title: "Fixed-Point Arithmetic", description: "Represents fractional values with an implicit scale factor, often simpler than full floating point.", keywords: ["fixed point", "q16.16", "software float", "fractional integer"], url: "/docs/#floating-point", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-stack-frame", title: "Stack Frame", description: "A block of stack space used by one function call for saved registers, locals, and outgoing arguments.", keywords: ["stack frame", "frame", "prologue", "epilogue", "local variables"], url: "/docs/#calling-convention", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-caller-saved", title: "Caller-Saved Registers", description: "Registers the caller must preserve if it needs their values after a function call.", keywords: ["caller saved", "temporary registers", "ra", "t0", "a0"], url: "/docs/#calling-convention", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-callee-saved", title: "Callee-Saved Registers", description: "Registers a function must restore before it returns if it chooses to use them.", keywords: ["callee saved", "saved registers", "s0", "s1", "s11"], url: "/docs/#calling-convention", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-alignment", title: "Memory Alignment", description: "Words and halfwords are expected at aligned addresses to avoid traps or slower accesses.", keywords: ["alignment", "misaligned", "word aligned", "halfword aligned"], url: "/docs/#memory", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-endianness", title: "Little-Endian Memory", description: "RISC-V stores the least-significant byte of a word at the lowest address.", keywords: ["little endian", "endianness", "byte order"], url: "/docs/#memory", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-data-segment", title: "Data Segment", description: "The portion of memory used for static data such as words, bytes, strings, and buffers.", keywords: [".data", "data segment", "static data", "asciz", "space"], url: "/docs/#memory", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-text-segment", title: "Text Segment", description: "The executable instruction region loaded by the assembler and fetched by the CPU.", keywords: [".text", "text segment", "instructions", "program memory"], url: "/docs/#overview", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-signed-vs-unsigned", title: "Signed vs Unsigned", description: "The same 32 bits can mean different values depending on whether comparisons treat them as signed or unsigned.", keywords: ["signed", "unsigned", "slt", "sltu", "blt", "bltu"], url: "/docs/#arithmetic", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-context-switch", title: "Context Switch", description: "Saving one execution context and restoring another so a scheduler can switch tasks.", keywords: ["context switch", "scheduler", "task", "save registers", "restore registers"], url: "/docs/#interrupts", category: "concept", categoryLabel: "Concept", icon: "📚" },
  { id: "concept-locality", title: "Spatial and Temporal Locality", description: "Programs run faster when they access nearby data repeatedly because caches exploit locality.", keywords: ["spatial locality", "temporal locality", "cache friendly", "working set"], url: "/docs/#cache", category: "concept", categoryLabel: "Concept", icon: "📚" },
];

const PAGE_ENTRIES: StaticEntrySeed[] = [
  { id: "page-riscv-simulator-guide", title: "RISC-V Simulator", description: "What a RISC-V simulator does, why it matters, and how StudyRISC-V helps you inspect execution step by step.", keywords: ["risc-v simulator", "riscv simulator", "browser simulator", "step execution"], url: "/riscv-simulator/", category: "page", categoryLabel: "Page", icon: "🧭" },
  { id: "page-learn-riscv-guide", title: "Learn RISC-V", description: "A beginner-friendly guide to registers, instructions, memory, and control flow with StudyRISC-V links.", keywords: ["learn risc-v", "learn riscv", "beginner guide", "architecture"], url: "/learn-riscv/", category: "page", categoryLabel: "Page", icon: "🧭" },
  { id: "page-riscv-assembly-tutorial", title: "RISC-V Assembly Tutorial", description: "Practical RISC-V assembly examples tied directly to the browser simulator and problem workflow.", keywords: ["risc-v assembly tutorial", "riscv assembly tutorial", "assembly examples", "practice"], url: "/riscv-assembly-tutorial/", category: "page", categoryLabel: "Page", icon: "🧭" },
  { id: "page-riscv-instructions", title: "RISC-V Instructions", description: "Instruction explanations for arithmetic, memory, branches, jumps, and stack-oriented assembly patterns.", keywords: ["risc-v instructions", "riscv instructions", "opcode reference", "instruction set"], url: "/riscv-instructions/", category: "page", categoryLabel: "Page", icon: "🧭" },
  { id: "page-simulator", title: "Simulator", description: "Run, step, rewind, and inspect RV32IM assembly directly in the browser.", keywords: ["simulator", "step", "run", "registers", "memory"], url: "/simulator/", category: "page", categoryLabel: "Page", icon: "🧭" },
  { id: "page-problems", title: "Problems", description: "Standalone RISC-V assembly problems with a LeetCode-style two-panel IDE and no account required.", keywords: ["problems", "leetcode", "practice", "assembly"], url: "/problems/", category: "page", categoryLabel: "Page", icon: "🧭" },
  { id: "page-learn", title: "Learn", description: "The guided StudyRISC-V curriculum with lessons, progress tracking, and challenge links.", keywords: ["learn", "lessons", "curriculum", "guided"], url: "/learn/", category: "page", categoryLabel: "Page", icon: "🧭" },
  { id: "page-checkpoints", title: "Checkpoints", description: "LeetCode-style RISC-V programming checkpoints with visible and hidden grader cases.", keywords: ["checkpoints", "challenges", "practice", "graded"], url: "/checkpoints/", category: "page", categoryLabel: "Page", icon: "🧭" },
  { id: "page-labs", title: "Labs", description: "Longer assignment-style exercises modeled after course lab work.", keywords: ["labs", "assignments", "grader"], url: "/labs/", category: "page", categoryLabel: "Page", icon: "🧭" },
  { id: "page-quizzes", title: "Quizzes", description: "Timed practice, midterm, and final-style assessments.", keywords: ["quiz", "quizzes", "midterm", "final", "practice"], url: "/quiz/", category: "page", categoryLabel: "Page", icon: "🧭" },
  { id: "page-leaderboard", title: "Leaderboard", description: "See weekly and all-time XP rankings across the platform.", keywords: ["leaderboard", "xp", "rank", "weekly"], url: "/leaderboard/", category: "page", categoryLabel: "Page", icon: "🧭" },
  { id: "page-about", title: "About", description: "Why StudyRISC-V exists and who it is built for.", keywords: ["about", "mission", "studyriscv"], url: "/about/", category: "page", categoryLabel: "Page", icon: "🧭" },
  { id: "page-docs", title: "Docs", description: "Reference material for instructions, registers, calling convention, and architecture concepts.", keywords: ["docs", "documentation", "instruction reference", "register reference"], url: "/docs/", category: "page", categoryLabel: "Page", icon: "🧭" },
];

const lessonEntries: SearchEntry[] = getLessons().map((lesson) => ({
  id: lesson.id,
  title: lesson.title,
  description: firstSentence(lesson.description),
  keywords: uniqueKeywords([
    ...lesson.tags,
    lesson.title,
    lesson.description,
    lesson.eceCourse,
    ...lesson.steps.flatMap((step) => [step.title, step.content]),
  ]),
  url: `/simulator/?lesson=${encodeURIComponent(lesson.id)}`,
  category: "lesson",
  categoryLabel: "Lesson",
  icon: "📖",
}));

const problemEntries: SearchEntry[] = getProblems().map((problem) => ({
  id: `problem-${problem.id}`,
  title: `${problem.number}. ${problem.title}`,
  description: firstSentence(stripHtml(problem.description)),
  keywords: uniqueKeywords([
    problem.title,
    problem.difficulty,
    ...problem.tags,
    ...(problem.companies ?? []),
    ...(problem.relatedProblems ?? []),
  ]),
  url: `/problems/?id=${encodeURIComponent(problem.id)}`,
  category: "problem",
  categoryLabel: "Problem",
  icon: "⚡",
}));

const challengeEntries: SearchEntry[] = getChallenges().map((challenge) => ({
  id: challenge.id,
  title: challenge.title,
  description: firstSentence(challenge.description),
  keywords: uniqueKeywords([
    ...challenge.tags,
    challenge.title,
    challenge.description,
    challenge.lessonId,
    challenge.hint,
  ]),
  url: `/simulator/?challenge=${encodeURIComponent(challenge.id)}`,
  category: "challenge",
  categoryLabel: "Challenge",
  icon: "⚡",
}));

const labEntries: SearchEntry[] = getLabs().map((lab) => ({
  id: lab.id,
  title: `Lab ${lab.number} — ${lab.title}`,
  description: firstSentence(lab.description),
  keywords: uniqueKeywords([
    lab.title,
    lab.description,
    lab.specification.functionName,
    lab.specification.signature,
    ...lab.prerequisites,
    ...lab.objectives,
  ]),
  url: `/simulator/?lab=${encodeURIComponent(lab.id)}`,
  category: "lab",
  categoryLabel: "Lab",
  icon: "🔬",
}));

const quizEntries: SearchEntry[] = getQuizzes().map((quiz) => ({
  id: quiz.id,
  title: quiz.title,
  description: firstSentence(quiz.description),
  keywords: uniqueKeywords([
    quiz.title,
    quiz.description,
    quiz.type,
    ...quiz.lessonIds,
    ...quiz.questions.map((question) => question.prompt),
  ]),
  url: "/quiz/",
  category: "quiz",
  categoryLabel: "Quiz",
  icon: "📝",
}));

const instructionEntries: SearchEntry[] = INSTRUCTION_METADATA.map((instruction) => ({
  id: `inst-${instruction.mnemonic}`,
  title: `${instruction.mnemonic} — ${instruction.title}`,
  description: instruction.description,
  keywords: uniqueKeywords([instruction.mnemonic, instruction.title, instruction.description, ...instruction.keywords]),
  url: `/docs/#instruction-${instruction.mnemonic}`,
  category: "instruction",
  categoryLabel: "Instruction",
  icon: "⚙️",
}));

const registerEntries: SearchEntry[] = REGISTER_METADATA.map((register) => ({
  id: `reg-x${register.x}-${register.abi.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  title: `${register.abi} (x${register.x}) — ${register.title}`,
  description: register.description,
  keywords: uniqueKeywords([register.abi, `x${register.x}`, register.title, register.description, ...register.keywords]),
  url: "/docs/#registers",
  category: "register",
  categoryLabel: "Register",
  icon: "🗂️",
}));

const conceptEntries: SearchEntry[] = CONCEPT_ENTRIES.map((entry) => ({
  ...entry,
  keywords: uniqueKeywords(entry.keywords),
}));

const pageEntries: SearchEntry[] = PAGE_ENTRIES.map((entry) => ({
  ...entry,
  keywords: uniqueKeywords(entry.keywords),
}));

export const SEARCH_INDEX: SearchEntry[] = [
  ...problemEntries,
  ...lessonEntries,
  ...challengeEntries,
  ...labEntries,
  ...quizEntries,
  ...instructionEntries,
  ...registerEntries,
  ...conceptEntries,
  ...pageEntries,
];

export const SEARCH_INDEX_BY_ID: Record<string, SearchEntry> = Object.fromEntries(
  SEARCH_INDEX.map((entry) => [entry.id, entry])
);

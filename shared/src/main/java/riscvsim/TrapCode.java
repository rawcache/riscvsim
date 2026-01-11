package riscvsim;

/**
 * Enumeration of execution traps/faults.
 */
public enum TrapCode {
    /** Instruction could not be decoded or executed. */ TRAP_ILLEGAL_INSTRUCTION,
    /** Misaligned access or PC. */ TRAP_BAD_ALIGNMENT,
    /** Memory access outside configured bounds. */ TRAP_OOB_MEMORY,
    /** Program counter outside current program range. */ TRAP_PC_OOB,
    /** Step budget exceeded. */ TRAP_STEP_LIMIT
}

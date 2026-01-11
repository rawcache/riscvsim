package riscvsim;

import java.util.List;

/**
 * High-level façade for the RISC-V simulator.
 *
 * <p>
 * The {@code Simulator} coordinates parsing, CPU execution, memory,
 * and derived views such as C-like explanations and RV-to-C mappings.
 * It is the primary entry point used by the HTTP server.
 * </p>
 */
public final class Simulator {

    /**
     * Size of simulated memory in bytes.
     */
    public static final int MEM_SIZE = 64 * 1024;

    /** Maximum input source size in bytes. */
    public static final int MAX_SOURCE_BYTES = 20 * 1024;

    /** Maximum steps allowed in a single multi-step request. */
    public static final int MAX_STEPS_PER_REQUEST = 5000;

    /**
     * Currently assembled program.
     */
    private Program program;

    /**
     * CPU instance holding registers, memory, and program counter.
     */
    private final Cpu cpu;

    /**
     * Constructs a new simulator with empty memory and no program loaded.
     */
    public Simulator() {
        this.cpu = new Cpu(MEM_SIZE);
        this.program = Parser.parseProgram(""); // empty program
    }

    /**
     * Parses and assembles the given RISC-V source code into a program.
     *
     * <p>
     * This resets the CPU state after successful assembly.
     * </p>
     *
     * @param source RISC-V assembly source code
     * @throws RuntimeException if parsing fails
     */
    public void assemble(String source) {
        if (source != null && source.getBytes().length > MAX_SOURCE_BYTES) {
            throw new RuntimeException("Source too large (limit " + MAX_SOURCE_BYTES + " bytes)");
        }
        this.program = Parser.parseProgram(source);
        this.cpu.reset();
    }

    /**
     * Resets the CPU state while keeping the current program loaded.
     */
    public void reset() {
        this.cpu.reset();
    }

    /**
     * Executes a single instruction step.
     *
     * @return result of the step, including effects and halt status
     */
    public StepResult step() {
        return cpu.step(program);
    }

    /**
     * Executes up to {@code maxSteps} instructions or until halt/trap.
     *
     * @param maxSteps maximum steps allowed
     * @return final step result (last executed or trap)
     */
    public StepResult stepMany(int maxSteps) {
        int steps = 0;
        StepResult last = null;
        while (steps < maxSteps) {
            last = step();
            steps++;
            if (last.isHalted()) {
                return last;
            }
        }
        return new StepResult(last == null ? null : last.getInst(), last == null ? List.of() : last.getEffects(),
                true, new Trap(TrapCode.TRAP_STEP_LIMIT, "Step limit hit"));
    }

    /**
     * Returns the currently loaded program.
     *
     * @return current program
     */
    public Program program() {
        return program;
    }

    /**
     * Returns the CPU instance backing this simulator.
     *
     * @return CPU instance
     */
    public Cpu cpu() {
        return cpu;
    }

    /**
     * Generates a C-like explanation of the currently loaded program.
     *
     * <p>
     * This is a semantic explanation intended for learning and debugging,
     * not a full decompilation.
     * </p>
     *
     * @return C-like explanation string
     */
    public String cLike() {
        return CLikeExplainer.explain(program);
    }

    /**
     * Generates a low-level RV32-to-C mapping of the currently loaded program.
     *
     * <p>
     * This mapping preserves instruction semantics and execution order.
     * </p>
     *
     * @return RV-to-C mapping string
     */
    public String rv2c() {
        return Rv2CMapper.map(program, MEM_SIZE);
    }
}

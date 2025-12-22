package riscvsim;

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

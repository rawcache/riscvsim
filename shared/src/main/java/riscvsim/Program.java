package riscvsim;

import java.util.List;
import java.util.Map;

/**
 * Represents a parsed RISC-V program.
 *
 * A {@code Program} consists of:
 * <ul>
 *   <li>A list of decoded instructions in program order</li>
 *   <li>The original source lines (used for diagnostics and mapping)</li>
 *   <li>A symbol table mapping symbol names to memory addresses</li>
 *   <li>A label table mapping label names to program counters (PC)</li>
 * </ul>
 *
 * <p>This class is immutable after construction.
 */
public final class Program {

    private final List<Instruction> instructions;
    private final List<String> sourceLines;
    private final Map<String, Integer> symbols;
    private final Map<String, Integer> labels;

    /**
     * Constructs a {@code Program} from parsed assembly input.
     *
     * @param instructions the decoded instruction list in execution order
     * @param sourceLines the original source lines
     * @param symbols a map of symbol names to absolute memory addresses
     * @param labels a map of label names to instruction PC addresses
     */
    public Program(
            List<Instruction> instructions,
            List<String> sourceLines,
            Map<String, Integer> symbols,
            Map<String, Integer> labels) {
        this.instructions = instructions;
        this.sourceLines = sourceLines;
        this.symbols = symbols;
        this.labels = labels;
    }

    /**
     * Returns the list of decoded instructions.
     *
     * @return the instruction list
     */
    public List<Instruction> getInstructions() {
        return instructions;
    }

    /**
     * Returns the original source lines.
     *
     * @return the source lines
     */
    public List<String> getSourceLines() {
        return sourceLines;
    }

    /**
     * Returns the symbol table.
     *
     * @return a map of symbol names to memory addresses
     */
    public Map<String, Integer> getSymbols() {
        return symbols;
    }

    /**
     * Returns the label table.
     *
     * @return a map of label names to PC addresses
     */
    public Map<String, Integer> getLabels() {
        return labels;
    }
}

package riscvsim;

import java.util.Arrays;

/**
 * Represents a single observable side effect produced by executing
 * one RISC-V instruction.
 *
 * <p>
 * Effects are immutable event records used for visualization and
 * debugging (register writes, memory writes, and PC updates).
 * </p>
 */
public final class Effect {

    /**
     * Effect type identifier.
     * Expected values: {@code "reg"}, {@code "mem"}, {@code "pc"}.
     */
    private String kind;

    /* ---------- Register effect fields ---------- */

    /** Register index affected by the instruction. */
    private Integer reg;

    /** Register value before execution. */
    private Integer before;

    /** Register value after execution. */
    private Integer after;

    /* ---------- Memory effect fields ---------- */

    /** Base memory address affected. */
    private Integer addr;

    /** Size of the memory write in bytes. */
    private Integer size;

    /** Memory bytes before the write. */
    private int[] beforeBytes;

    /** Memory bytes after the write. */
    private int[] afterBytes;

    /**
     * Private constructor.
     *
     * <p>
     * Use one of the static factory methods to create an Effect.
     * </p>
     */
    private Effect() {
        // Use static factory methods
    }

    /**
     * Creates a register write effect.
     *
     * @param reg register index written
     * @param before previous register value
     * @param after new register value
     * @return register effect instance
     */
    public static Effect reg(int reg, int before, int after) {
        Effect e = new Effect();
        e.kind = "reg";
        e.reg = reg;
        e.before = before;
        e.after = after;
        return e;
    }

    /**
     * Creates a program counter update effect.
     *
     * @param before previous PC value
     * @param after new PC value
     * @return PC effect instance
     */
    public static Effect pc(int before, int after) {
        Effect e = new Effect();
        e.kind = "pc";
        e.before = before;
        e.after = after;
        return e;
    }

    /**
     * Creates a memory write effect.
     *
     * @param addr base memory address written
     * @param size number of bytes written
     * @param beforeBytes memory contents before write
     * @param afterBytes memory contents after write
     * @return memory effect instance
     */
    public static Effect mem(int addr, int size, int[] beforeBytes, int[] afterBytes) {
        Effect e = new Effect();
        e.kind = "mem";
        e.addr = addr;
        e.size = size;
        e.beforeBytes = beforeBytes;
        e.afterBytes = afterBytes;
        return e;
    }

    /** @return effect type identifier */
    public String getKind() {
        return kind;
    }

    /** @return affected register index, or {@code null} if not a register effect */
    public Integer getReg() {
        return reg;
    }

    /** @return value before execution */
    public Integer getBefore() {
        return before;
    }

    /** @return value after execution */
    public Integer getAfter() {
        return after;
    }

    /** @return base memory address */
    public Integer getAddr() {
        return addr;
    }

    /** @return number of bytes written */
    public Integer getSize() {
        return size;
    }

    /** @return memory bytes before write */
    public int[] getBeforeBytes() {
        return beforeBytes;
    }

    /** @return memory bytes after write */
    public int[] getAfterBytes() {
        return afterBytes;
    }

    /**
     * Returns a concise human-readable representation of the effect.
     *
     * @return formatted effect description
     */
    @Override
    public String toString() {
        return switch (kind) {
        case "reg" -> "REG x" + reg + " " + before + " -> " + after;
        case "pc" -> "PC " + before + " -> " + after;
        case "mem" -> "MEM [" + addr + "] "
                + Arrays.toString(beforeBytes)
                + " -> "
                + Arrays.toString(afterBytes);
        default -> "Effect(" + kind + ")";
        };
    }
}

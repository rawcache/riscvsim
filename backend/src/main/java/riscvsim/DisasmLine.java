package riscvsim;

/**
 * Represents a single line in the disassembly listing.
 */
public final class DisasmLine {

    private final int pc;
    private final String text;
    private final boolean label;

    /**
     * Creates a new disassembly line.
     *
     * @param pc program counter for the line
     * @param text display text for the line
     * @param label true if this line is a label marker
     */
    public DisasmLine(int pc, String text, boolean label) {
        this.pc = pc;
        this.text = text;
        this.label = label;
    }

    /**
     * Returns the program counter for this line.
     *
     * @return program counter
     */
    public int getPc() {
        return pc;
    }

    /**
     * Returns the display text.
     *
     * @return line text
     */
    public String getText() {
        return text;
    }

    /**
     * Returns whether this line is a label marker.
     *
     * @return true if label, false if instruction
     */
    public boolean isLabel() {
        return label;
    }
}

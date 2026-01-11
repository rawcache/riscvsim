package riscvsim;

/**
 * Exception thrown to signal a CPU trap during execution.
 *
 * <p>A trap represents an exceptional condition detected by the simulator,
 * such as an illegal instruction, misaligned memory access, or other
 * architectural fault. This exception carries a {@link TrapCode} that
 * identifies the specific cause of the trap.</p>
 *
 * <p>This is an unchecked exception because traps represent fatal execution
 * conditions that immediately stop normal instruction flow.</p>
 */
public final class TrapException extends RuntimeException {

    /** The architectural reason for the trap. */
    private final TrapCode code;

    /**
     * Constructs a new {@code TrapException}.
     *
     * @param code the trap code identifying the reason for the trap
     * @param message human-readable description of the trap
     */
    public TrapException(TrapCode code, String message) {
        super(message);
        this.code = code;
    }

    /**
     * Returns the trap code associated with this exception.
     *
     * @return the trap code
     */
    public TrapCode getCode() {
        return code;
    }
}

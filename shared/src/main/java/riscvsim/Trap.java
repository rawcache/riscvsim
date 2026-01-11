package riscvsim;

/**
 * Represents a trap (fault) that stops execution.
 */
public final class Trap {

    /** Trap code identifier. */
    private final TrapCode code;

    /** Human-readable description. */
    private final String message;

    /**
     * Constructs a Trap with the specified code and message.
     *
     * @param code the trap code identifier
     * @param message the human-readable description
     */
    public Trap(TrapCode code, String message) {
        this.code = code;
        this.message = message;
    }

    /**
     * Returns the trap code identifier.
     *
     * @return the trap code identifier
     */
    public TrapCode getCode() {
        return code;
    }

    /**
     * Returns the human-readable description of the trap.
     *
     * @return the human-readable description
     */
    public String getMessage() {
        return message;
    }
}

package riscvsim;

/**
 * Represents a trap (fault) that stops execution.
 */
public final class Trap {

    /** Trap code identifier. */
    private final TrapCode code;

    /** Human-readable description. */
    private final String message;

    public Trap(TrapCode code, String message) {
        this.code = code;
        this.message = message;
    }

    public TrapCode getCode() {
        return code;
    }

    public String getMessage() {
        return message;
    }
}

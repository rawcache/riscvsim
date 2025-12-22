package riscvsim;

/**
 * Application entry point for the RISC-V simulator backend.
 */
public final class Main {

    /**
     * Starts the HTTP server.
     *
     * @param args command-line arguments (unused)
     * @throws Exception if startup fails
     */
    public static void main(String[] args) throws Exception {
        Server.start();
    }

    /**
     * Private constructor to prevent instantiation.
     */
    private Main() {
        // no-op
    }
}

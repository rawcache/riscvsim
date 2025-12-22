package riscvsim;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

/**
 * Lightweight HTTP server exposing a RISC-V simulator backend.
 *
 * <p>This server manages simulation sessions and provides endpoints to:
 * <ul>
 *   <li>Create a new simulation session</li>
 *   <li>Assemble RISC-V source code</li>
 *   <li>Step execution</li>
 *   <li>Reset the simulator state</li>
 * </ul>
 *
 * <p>The server is intentionally minimal and uses the built-in
 * {@link HttpServer} for clarity and educational value.
 */
public final class Server {

    /** JSON serializer used for all API responses. */
    private static final Gson GSON =
        new GsonBuilder().serializeNulls().create();

    /** TCP port the backend listens on. */
    private static final int PORT = 8080;

    /**
     * Data Transfer Object representing a simulator snapshot
     * returned to the frontend.
     */
    /**
     * Data Transfer Object representing a snapshot of the simulator state
     * returned to the frontend.
     */
    static final class ApiResponse {

        private String sessionId;
        private int pc;
        private int[] regs;
        private boolean halted;
        private List<Effect> effects;
        private String clike;
        private String rv2c;
        private String error;

        /**
         * Returns the unique identifier for the simulator session.
         *
         * @return session ID
         */
        public String getSessionId() {
            return sessionId;
        }

        /**
         * Returns the current program counter value.
         *
         * @return program counter
         */
        public int getPc() {
            return pc;
        }

        /**
         * Returns a snapshot of all 32 general-purpose registers.
         *
         * @return register array
         */
        public int[] getRegs() {
            return regs;
        }

        /**
         * Indicates whether the simulator has halted execution.
         *
         * @return true if halted, false otherwise
         */
        public boolean isHalted() {
            return halted;
        }

        /**
         * Returns the list of side effects produced by the last step.
         *
         * @return list of effects
         */
        public List<Effect> getEffects() {
            return effects;
        }

        /**
         * Returns the C-like explanation of the program.
         *
         * @return C-like explanation string
         */
        public String getClike() {
            return clike;
        }

        /**
         * Returns the low-level RISC-V to C mapping.
         *
         * @return RV-to-C mapping string
         */
        public String getRv2c() {
            return rv2c;
        }

        /**
         * Returns an error message, if an error occurred.
         *
         * @return error message or null
         */
        public String getError() {
            return error;
        }

        /**
         * Adds permissive CORS headers to an HTTP response.
         *
         * @param headers response headers
         */
        private static void addCors(Headers headers) {
            headers.add("Access-Control-Allow-Origin", "*");
            headers.add("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
            headers.add("Access-Control-Allow-Headers", "Content-Type");
        }

        /**
         * Reads the full request body as a UTF-8 string.
         *
         * @param is input stream
         * @return request body text
         * @throws IOException if reading fails
         */
        private static String readBody(InputStream is) throws IOException {
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }

        /**
         * Sends a JSON response with the given HTTP status.
         *
         * @param ex HTTP exchange
         * @param status HTTP status code
         * @param body object to serialize as JSON
         * @throws IOException if writing fails
         */
        private static void sendJson(HttpExchange ex, int status, Object body)
            throws IOException {

            byte[] bytes = GSON.toJson(body)
                .getBytes(StandardCharsets.UTF_8);

            Headers headers = ex.getResponseHeaders();
            addCors(headers);
            headers.add("Content-Type", "application/json; charset=utf-8");

            ex.sendResponseHeaders(status, bytes.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(bytes);
            }
        }

        /**
         * Sends a plain-text HTTP response.
         *
         * @param ex HTTP exchange
         * @param status HTTP status code
         * @param text response text
         * @throws IOException if writing fails
         */
        private static void sendText(HttpExchange ex, int status, String text)
            throws IOException {

            byte[] bytes = text.getBytes(StandardCharsets.UTF_8);

            Headers headers = ex.getResponseHeaders();
            addCors(headers);
            headers.add("Content-Type", "text/plain; charset=utf-8");

            ex.sendResponseHeaders(status, bytes.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(bytes);
            }
        }

        /**
         * Handles CORS preflight OPTIONS requests.
         *
         * @param ex HTTP exchange
         * @return true if request was handled
         * @throws IOException if writing fails
         */
        private static boolean handleOptions(HttpExchange ex)
            throws IOException {

            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                addCors(ex.getResponseHeaders());
                ex.sendResponseHeaders(204, -1);
                try (ex) {
                    return true;
                }
            }
            return false;
        }

        /**
         * Builds a response snapshot from the current simulator state.
         *
         * @param sessionId session identifier
         * @param sim simulator instance
         * @param halted whether execution has halted
         * @param effects list of execution effects
         * @return populated API response
         */
        private static ApiResponse snapshot(
            String sessionId,
            Simulator sim,
            boolean halted,
            List<Effect> effects) {

            ApiResponse r = new ApiResponse();
            r.sessionId = sessionId;
            r.pc = sim.cpu().getPc();
            r.regs = sim.cpu().getRegs();
            r.halted = halted;
            r.effects = effects;
            r.clike = sim.cLike();
            r.rv2c = sim.rv2c();
            return r;
        }

        /**
         * Entry point for the backend server.
         *
         * @param args ignored
         * @throws Exception if server startup fails
         */
        public static void main(String[] args) throws Exception {

            HttpServer server =
                HttpServer.create(new InetSocketAddress(PORT), 0);

            // Health check
            server.createContext("/health", ex -> {
                if (handleOptions(ex)) {
                    return;
                }
                sendText(ex, 200, "ok");
            });

            // Create session
            server.createContext("/api/session", ex -> {
                if (handleOptions(ex)) {
                    return;
                }
                if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                    sendText(ex, 405, "Method Not Allowed");
                    return;
                }

                String source = "";
                String body;
                try (InputStream req = ex.getRequestBody()) {
                    body = readBody(req);
                }
                if (!body.isBlank()) {
                    JsonObject obj =
                        JsonParser.parseString(body).getAsJsonObject();
                    if (obj.has("source")) {
                        source = obj.get("source").getAsString();
                    }
                }

                String id = UUID.randomUUID().toString();
                Simulator sim = new Simulator();

                try {
                    if (!source.isBlank()) {
                        sim.assemble(source);
                    }
                    sendJson(ex, 200, snapshot(id, sim, false, List.of()));
                } catch (IOException | RuntimeException e) {
                    ApiResponse r = new ApiResponse();
                    r.sessionId = id;
                    r.error = e.getMessage();
                    sendJson(ex, 400, r);
                }
            });

            // Thread pool
            ExecutorService pool = Executors.newFixedThreadPool(8);
            server.setExecutor(pool);

            System.out.println(
                "Backend listening on http://localhost:" + PORT);
            server.start();
        }
    
    }
}

package riscvsim;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
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
 * <p>This server manages simulation sessions and provides endpoints to create a
 * session, assemble code, step execution, and reset state.</p>
 */
public final class Server {

    /** JSON serializer used for all API responses. */
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();

    /** TCP port the backend listens on. */
    private static final int PORT = 8080;

    /** In-memory session store mapping session IDs to simulator instances. */
    private static final Map<String, Simulator> SESSIONS = new ConcurrentHashMap<>();

    /** Private constructor to prevent instantiation. */
    private Server() {
        // no-op
    }

    /**
     * Starts the HTTP server.
     *
     * @throws IOException if the server cannot be created
     */
    public static void start() throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);

        server.createContext("/health", ex -> {
            if (handleOptions(ex)) {
                return;
            }
            sendText(ex, 200, "ok");
        });

        server.createContext("/api/session", ex -> {
            if (handleOptions(ex)) {
                return;
            }
            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                sendText(ex, 405, "Method Not Allowed");
                return;
            }

            String body = readBody(ex.getRequestBody());
            String source = "";

            if (!body.isBlank()) {
                JsonObject obj = JsonParser.parseString(body).getAsJsonObject();
                if (obj.has("source") && !obj.get("source").isJsonNull()) {
                    source = obj.get("source").getAsString();
                }
            }

            String id = UUID.randomUUID().toString();
            Simulator sim = new Simulator();

            try {
                if (!source.isBlank()) {
                    sim.assemble(source);
                }
                SESSIONS.put(id, sim);
                sendJson(ex, 200, snapshot(id, sim, false, List.of(), null));
            } catch (IOException | RuntimeException e) {
                ApiResponse r = new ApiResponse();
                r.sessionId = id;
                r.error = e.getMessage();
                sendJson(ex, 400, r);
            }
        });

        server.createContext("/api/assemble", ex -> {
            if (handleOptions(ex)) {
                return;
            }
            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                sendText(ex, 405, "Method Not Allowed");
                return;
            }

            try {
                JsonObject obj = JsonParser.parseString(readBody(ex.getRequestBody())).getAsJsonObject();
                String id = obj.get("sessionId").getAsString();
                String source = obj.get("source").getAsString();

                Simulator sim = SESSIONS.get(id);
                if (sim == null) {
                    sendText(ex, 404, "Unknown session");
                    return;
                }

                sim.assemble(source);
                sendJson(ex, 200, snapshot(id, sim, false, List.of(), null));
            } catch (IOException | RuntimeException e) {
                ApiResponse r = new ApiResponse();
                r.error = e.getMessage();
                sendJson(ex, 400, r);
            }
        });

        server.createContext("/api/reset", ex -> {
            if (handleOptions(ex)) {
                return;
            }
            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                sendText(ex, 405, "Method Not Allowed");
                return;
            }

            try {
                JsonObject obj = JsonParser.parseString(readBody(ex.getRequestBody())).getAsJsonObject();
                String id = obj.get("sessionId").getAsString();

                Simulator sim = SESSIONS.get(id);
                if (sim == null) {
                    sendText(ex, 404, "Unknown session");
                    return;
                }

                sim.reset();
                sendJson(ex, 200, snapshot(id, sim, false, List.of(), null));
            } catch (IOException | RuntimeException e) {
                ApiResponse r = new ApiResponse();
                r.error = e.getMessage();
                sendJson(ex, 400, r);
            }
        });

        server.createContext("/api/step", ex -> {
            if (handleOptions(ex)) {
                return;
            }
            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                sendText(ex, 405, "Method Not Allowed");
                return;
            }

            try {
                JsonObject obj = JsonParser.parseString(readBody(ex.getRequestBody())).getAsJsonObject();
                String id = obj.get("sessionId").getAsString();

                Simulator sim = SESSIONS.get(id);
                if (sim == null) {
                    sendText(ex, 404, "Unknown session");
                    return;
                }

                int steps = obj.has("steps") && obj.get("steps").isJsonPrimitive()
                        ? obj.get("steps").getAsInt()
                        : 1;
                if (steps < 1 || steps > Simulator.MAX_STEPS_PER_REQUEST) {
                    ApiResponse r = new ApiResponse();
                    r.error = "steps must be between 1 and " + Simulator.MAX_STEPS_PER_REQUEST;
                    sendJson(ex, 400, r);
                    return;
                }

                StepResult sr = steps == 1 ? sim.step() : sim.stepMany(steps);
                boolean halted = sr.isHalted();
                List<Effect> effects = sr.getEffects();

                sendJson(ex, 200, snapshot(id, sim, halted, effects, sr.getTrap()));
            } catch (IOException | RuntimeException e) {
                ApiResponse r = new ApiResponse();
                r.error = e.getMessage();
                sendJson(ex, 400, r);
            }
        });

        ExecutorService pool = Executors.newFixedThreadPool(8);
        server.setExecutor(pool);

        System.out.println("Backend listening on http://localhost:" + PORT);
        server.start();
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
     * Handles CORS preflight OPTIONS requests.
     *
     * @param ex HTTP exchange
     * @return true if request was handled
     * @throws IOException if writing fails
     */
    private static boolean handleOptions(HttpExchange ex) throws IOException {
        if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
            addCors(ex.getResponseHeaders());
            try (ex) {
                ex.sendResponseHeaders(204, -1);
            }
            return true;
        }
        return false;
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
    private static void sendJson(HttpExchange ex, int status, Object body) throws IOException {
        byte[] bytes = GSON.toJson(body).getBytes(StandardCharsets.UTF_8);

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
    private static void sendText(HttpExchange ex, int status, String text) throws IOException {
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
     * Builds a response snapshot from the current simulator state.
     *
     * @param sessionId session identifier
     * @param sim simulator instance
     * @param halted whether execution has halted
     * @param effects list of execution effects
     * @return populated API response
     */
    private static ApiResponse snapshot(String sessionId, Simulator sim, boolean halted, List<Effect> effects,
            Trap trap) {
        ApiResponse r = new ApiResponse();
        r.sessionId = sessionId;
        r.pc = sim.cpu().getPc();
        r.regs = sim.cpu().getRegs();
        r.halted = halted;
        r.effects = effects;
        r.trap = trap;
        r.clike = sim.cLike();
        r.rv2c = sim.rv2c();
        return r;
    }

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
        private Trap trap;
        private String error;

        /**
         * Returns the unique identifier associated with this simulator session.
         *
         * @return session identifier string
         */
        public String getSessionId() {
            return sessionId;
        }

        /**
         * Returns the current value of the program counter.
         *
         * @return program counter value
         */
        public int getPc() {
            return pc;
        }

        /**
         * Returns a snapshot of the CPU register file.
         *
         * <p>The returned array contains 32 integers corresponding
         * to the RISC-V general-purpose registers.
         *
         * @return register array
         */
        public int[] getRegs() {
            return regs;
        }

        /**
         * Indicates whether execution has halted.
         *
         * @return true if the simulator has halted, false otherwise
         */
        public boolean isHalted() {
            return halted;
        }

        /**
         * Returns the list of side effects produced by the last execution step.
         *
         * <p>If no effects were produced, an empty list is returned.
         *
         * @return list of execution effects
         */
        public List<Effect> getEffects() {
            return effects == null ? List.of() : effects;
        }

        /**
         * Returns the C-like explanation of the assembled program.
         *
         * @return C-like explanation string
         */
        public String getClike() {
            return clike;
        }

        /**
         * Returns the low-level RISC-V to C mapping of the program.
         *
         * @return RV-to-C mapping string
         */
        public String getRv2c() {
            return rv2c;
        }

        /**
         * Returns an error message if an error occurred.
         *
         * @return error message, or null if no error occurred
         */
        public String getError() {
            return error;
        }

        /**
         * Returns trap information if execution halted due to a fault.
         *
         * @return trap or null
         */
        public Trap getTrap() {
            return trap;
        }

    }
}

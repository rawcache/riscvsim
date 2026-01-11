package riscvsim;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyRequestEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyResponseEvent;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * AWS Lambda handler that mirrors Server's HTTP endpoints for API Gateway proxy.
 *
 * Handler string: riscvsim.LambdaHandler::handleRequest
 */
public final class LambdaHandler implements RequestHandler<APIGatewayProxyRequestEvent, APIGatewayProxyResponseEvent> {

    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final Map<String, Simulator> SESSIONS = new ConcurrentHashMap<>();

    /**
     * Handles incoming API Gateway proxy requests and routes them to the corresponding
     * simulator endpoint logic.
     *
     * @param event request event payload
     * @param context Lambda execution context
     * @return API Gateway response
     */
    @Override
    public APIGatewayProxyResponseEvent handleRequest(APIGatewayProxyRequestEvent event, Context context) {
        String rawPath = event.getPath() == null ? "" : event.getPath();
        String path = normalizePath(rawPath);
        String method = event.getHttpMethod() == null ? "GET" : event.getHttpMethod().toUpperCase();

        // CORS preflight
        if ("OPTIONS".equals(method)) {
            return cors(new APIGatewayProxyResponseEvent().withStatusCode(204));
        }

        try {
            return switch (path) {
            case "/api/session" -> handleSession(event);
            case "/api/assemble" -> handleAssemble(event);
            case "/api/reset" -> handleReset(event);
            case "/api/step" -> handleStep(event);
            case "/health" -> text(200, "ok");
            case "/simulate" -> handleSimulate(event); // legacy
            default -> text(404, "Not Found");
            };
        } catch (IOException | RuntimeException e) {
            ApiError err = new ApiError();
            err.error = e.getMessage();
            return json(500, err);
        }
    }

    /**
     * Normalizes the request path, stripping stage prefixes for API routes.
     *
     * @param rawPath raw path from the event
     * @return normalized path (e.g., /api/session)
     */
    private static String normalizePath(String rawPath) {
        // Strip stage prefix if present (e.g., /dev/api/session -> /api/session)
        int apiIdx = rawPath.indexOf("/api/");
        if (apiIdx >= 0) {
            return rawPath.substring(apiIdx);
        }
        if (rawPath.endsWith("/health")) {
            return "/health";
        }
        if (rawPath.endsWith("/simulate")) {
            return "/simulate";
        }
        return rawPath;
    }

    /**
     * Creates a new simulator session and optionally assembles provided source.
     *
     * @param event API Gateway request event
     * @return response containing session snapshot
     * @throws IOException if assembly fails
     */
    private static APIGatewayProxyResponseEvent handleSession(APIGatewayProxyRequestEvent event) throws IOException {
        JsonObject obj = parseJson(event.getBody());
        String source = getString(obj, "source", "");

        String id = UUID.randomUUID().toString();
        Simulator sim = new Simulator();
        if (!source.isBlank()) {
            sim.assemble(source);
        }
        SESSIONS.put(id, sim);
        return json(200, snapshot(id, sim, false, List.of(), null));
    }

    /**
     * Assembles program source into an existing simulator session.
     *
     * @param event API Gateway request event
     * @return response containing updated session snapshot
     * @throws IOException if assembly fails
     */
    private static APIGatewayProxyResponseEvent handleAssemble(APIGatewayProxyRequestEvent event) throws IOException {
        JsonObject obj = parseJson(event.getBody());
        String id = getString(obj, "sessionId", null);
        String source = getString(obj, "source", null);
        if (id == null || source == null) {
            return text(400, "Missing sessionId or source");
        }
        Simulator sim = SESSIONS.get(id);
        if (sim == null) {
            return text(404, "Unknown session");
        }
        sim.assemble(source);
        return json(200, snapshot(id, sim, false, List.of(), null));
    }

    /**
     * Resets simulator state for a session.
     *
     * @param event API Gateway request event
     * @return response containing reset session snapshot
     * @throws IOException if reset fails
     */
    private static APIGatewayProxyResponseEvent handleReset(APIGatewayProxyRequestEvent event) throws IOException {
        JsonObject obj = parseJson(event.getBody());
        String id = getString(obj, "sessionId", null);
        if (id == null) {
            return text(400, "Missing sessionId");
        }
        Simulator sim = SESSIONS.get(id);
        if (sim == null) {
            return text(404, "Unknown session");
        }
        sim.reset();
        return json(200, snapshot(id, sim, false, List.of(), null));
    }

    /**
     * Steps program execution within a session.
     *
     * @param event API Gateway request event
     * @return response containing step results
     * @throws IOException if stepping fails
     */
    private static APIGatewayProxyResponseEvent handleStep(APIGatewayProxyRequestEvent event) throws IOException {
        JsonObject obj = parseJson(event.getBody());
        String id = getString(obj, "sessionId", null);
        int steps = obj.has("steps") ? obj.get("steps").getAsInt() : 1;
        if (steps < 1 || steps > Simulator.MAX_STEPS_PER_REQUEST) {
            return text(400, "steps must be between 1 and " + Simulator.MAX_STEPS_PER_REQUEST);
        }
        if (id == null) {
            return text(400, "Missing sessionId");
        }
        Simulator sim = SESSIONS.get(id);
        if (sim == null) {
            return text(404, "Unknown session");
        }
        StepResult sr = steps == 1 ? sim.step() : sim.stepMany(steps);
        return json(200, snapshot(id, sim, sr.isHalted(), sr.getEffects(), sr.getTrap()));
    }

    /**
     * Legacy compatibility handler mirroring session creation at /simulate.
     *
     * @param event API Gateway request event
     * @return response containing simulator snapshot
     * @throws IOException if assembly fails
     */
    private static APIGatewayProxyResponseEvent handleSimulate(APIGatewayProxyRequestEvent event) throws IOException {
        JsonObject obj = parseJson(event.getBody());
        String source = getString(obj, "source", "");
        Simulator sim = new Simulator();
        if (!source.isBlank()) {
            sim.assemble(source);
        }
        return json(200, snapshot("legacy", sim, false, List.of(), null));
    }

    /**
     * Parses the JSON body of a request into a JsonObject.
     *
     * @param body request body string
     * @return parsed JSON object (empty if body is blank)
     * @throws IOException if parsing fails
     */
    private static JsonObject parseJson(String body) throws IOException {
        if (body == null || body.isBlank()) {
            return new JsonObject();
        }
        return JsonParser.parseString(body).getAsJsonObject();
    }

    /**
     * Safely retrieves a string from a JSON object.
     *
     * @param obj JSON payload
     * @param key property name
     * @param def default value if absent
     * @return string value or default
     */
    private static String getString(JsonObject obj, String key, String def) {
        if (obj.has(key) && !obj.get(key).isJsonNull()) {
            return obj.get(key).getAsString();
        }
        return def;
    }

    /**
     * Builds a response snapshot from simulator state.
     *
     * @param sessionId session identifier
     * @param sim simulator instance
     * @param halted whether execution has halted
     * @param effects execution effects
     * @param trap trap details if halted due to fault
     * @return populated API response DTO
     */
    private static Server.ApiResponse snapshot(String sessionId, Simulator sim, boolean halted,
            List<Effect> effects, Trap trap) {
        return new Server.ApiResponse()
                .setSessionId(sessionId)
                .setPc(sim.cpu().getPc())
                .setRegs(sim.cpu().getRegs())
                .setHalted(halted)
                .setEffects(effects)
                .setTrap(trap)
                .setClike(sim.cLike())
                .setRv2c(sim.rv2c())
                .setDisasm(Disassembler.disassemble(sim.program()));
    }

    /**
     * Produces a JSON API Gateway response with CORS headers.
     *
     * @param status HTTP status code
     * @param body response payload
     * @return API Gateway response
     */
    private static APIGatewayProxyResponseEvent json(int status, Object body) {
        String payload = GSON.toJson(body);
        return cors(new APIGatewayProxyResponseEvent()
                .withStatusCode(status)
                .withHeaders(Map.of("Content-Type", "application/json"))
                .withBody(payload));
    }

    /**
     * Produces a text API Gateway response with CORS headers.
     *
     * @param status HTTP status code
     * @param text response body
     * @return API Gateway response
     */
    private static APIGatewayProxyResponseEvent text(int status, String text) {
        return cors(new APIGatewayProxyResponseEvent()
                .withStatusCode(status)
                .withHeaders(Map.of("Content-Type", "text/plain; charset=utf-8"))
                .withBody(text));
    }

    /**
     * Adds permissive CORS headers to a response event.
     *
     * @param res response event to decorate
     * @return response event with CORS headers applied
     */
    private static APIGatewayProxyResponseEvent cors(APIGatewayProxyResponseEvent res) {
        Map<String, String> headers = res.getHeaders();
        if (headers == null) {
            headers = new java.util.HashMap<>();
        } else {
            headers = new java.util.HashMap<>(headers);
        }
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        headers.put("Access-Control-Allow-Headers", "Content-Type");
        res.setHeaders(headers);
        return res;
    }

    /**
     * Minimal DTO to return errors in JSON.
     */
    private static final class ApiError {
        @SuppressWarnings("unused")
        private String error;
    }
}

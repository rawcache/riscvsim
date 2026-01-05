package example;

import java.util.HashMap;
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

import riscvsim.Effect;
import riscvsim.Simulator;
import riscvsim.StepResult;

/**
 * Lambda entrypoint for the /simulate API.
 *
 * <p>Accepts a JSON payload {@code {"code":"...assembly..."}} and returns
 * simulator state after executing one step.</p>
 */
public class Handler implements RequestHandler<APIGatewayProxyRequestEvent, APIGatewayProxyResponseEvent> {

    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final Map<String, Simulator> SESSIONS = new ConcurrentHashMap<>();

    @Override
    public APIGatewayProxyResponseEvent handleRequest(APIGatewayProxyRequestEvent event, Context context) {
        String path = event.getPath();
        if (path == null) {
            path = "";
        }
        String method = event.getHttpMethod();

        if ("OPTIONS".equalsIgnoreCase(method)) {
            return corsResponse(200, "");
        }

        return switch (path) {
        case "/api/session" -> handleSession(event);
        case "/api/assemble" -> handleAssemble(event);
        case "/api/step" -> handleStep(event);
        case "/api/reset" -> handleReset(event);
        default -> corsResponse(404, "{\"error\":\"Unknown route: " + path + "\"}");
        };
    }

    /**
     * Handles the session initialization request.
     *
     * @param event API Gateway proxy event
     * @return response containing a session identifier
     */
    private APIGatewayProxyResponseEvent handleSession(APIGatewayProxyRequestEvent event) {
        try {
            String source = "";
            String body = event.getBody();
            if (body != null && !body.isEmpty()) {
                JsonObject obj = JsonParser.parseString(body).getAsJsonObject();
                if (obj.has("source") && !obj.get("source").isJsonNull()) {
                    source = obj.get("source").getAsString();
                }
            }

            String sessionId = UUID.randomUUID().toString();
            Simulator sim = new Simulator();
            if (!source.isBlank()) {
                sim.assemble(source);
            }
            SESSIONS.put(sessionId, sim);

            return corsResponse(200, GSON.toJson(snapshot(sessionId, sim, false, List.of())));
        } catch (RuntimeException ex) {
            return corsResponse(400, "{\"error\":\"" + ex.getMessage() + "\"}");
        }
    }

    /**
     * Processes a single step of the RISC-V simulation.
     *
     * @param event API Gateway proxy event containing assembly code
     * @return response containing the CPU state, registers, and execution results
     */
    private APIGatewayProxyResponseEvent handleStep(APIGatewayProxyRequestEvent event) {
        try {
            String body = event.getBody();
            if (body == null || body.isEmpty()) {
                return corsResponse(400, "{\"error\":\"missing request body\"}");
            }
            JsonObject obj = JsonParser.parseString(body).getAsJsonObject();
            String sessionId = obj.get("sessionId").getAsString();

            Simulator sim = SESSIONS.get(sessionId);
            if (sim == null) {
                return corsResponse(404, "{\"error\":\"Unknown session\"}");
            }

            StepResult step = sim.step();
            boolean halted = step.isHalted();
            List<Effect> effects = step.getEffects();

            return corsResponse(200, GSON.toJson(snapshot(sessionId, sim, halted, effects)));
        } catch (RuntimeException ex) {
            JsonObject err = new JsonObject();
            err.addProperty("error", ex.getMessage());
            return corsResponse(400, GSON.toJson(err));
        }
    }

    /**
     * Resets the simulator state.
     *
     * @param event API Gateway proxy event
     * @return response indicating the reset status
     */
    private APIGatewayProxyResponseEvent handleReset(APIGatewayProxyRequestEvent event) {
        try {
            String body = event.getBody();
            if (body == null || body.isEmpty()) {
                return corsResponse(400, "{\"error\":\"missing request body\"}");
            }
            JsonObject obj = JsonParser.parseString(body).getAsJsonObject();
            String sessionId = obj.get("sessionId").getAsString();

            Simulator sim = SESSIONS.get(sessionId);
            if (sim == null) {
                return corsResponse(404, "{\"error\":\"Unknown session\"}");
            }

            sim.reset();
            return corsResponse(200, GSON.toJson(snapshot(sessionId, sim, false, List.of())));
        } catch (RuntimeException ex) {
            JsonObject err = new JsonObject();
            err.addProperty("error", ex.getMessage());
            return corsResponse(400, GSON.toJson(err));
        }
    }

    private APIGatewayProxyResponseEvent handleAssemble(APIGatewayProxyRequestEvent event) {
        try {
            String body = event.getBody();
            if (body == null || body.isEmpty()) {
                return corsResponse(400, "{\"error\":\"missing request body\"}");
            }
            JsonObject obj = JsonParser.parseString(body).getAsJsonObject();
            String sessionId = obj.get("sessionId").getAsString();
            String source = obj.get("source").getAsString();

            Simulator sim = SESSIONS.get(sessionId);
            if (sim == null) {
                return corsResponse(404, "{\"error\":\"Unknown session\"}");
            }

            sim.assemble(source);
            return corsResponse(200, GSON.toJson(snapshot(sessionId, sim, false, List.of())));
        } catch (RuntimeException ex) {
            JsonObject err = new JsonObject();
            err.addProperty("error", ex.getMessage());
            return corsResponse(400, GSON.toJson(err));
        }
    }

    private static Map<String, Object> snapshot(String sessionId, Simulator sim, boolean halted, List<Effect> effects) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("sessionId", sessionId);
        payload.put("regs", sim.cpu().getRegs());
        payload.put("pc", sim.cpu().getPc());
        payload.put("halted", halted);
        payload.put("effects", effects);
        payload.put("clike", sim.cLike());
        payload.put("rv2c", sim.rv2c());
        payload.put("error", null);
        return payload;
    }

    /**
     * Builds an API Gateway style response with CORS headers.
     *
     * @param statusCode HTTP status code
     * @param body JSON string body
     * @return response map
     */
    private static APIGatewayProxyResponseEvent corsResponse(int statusCode, String body) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Access-Control-Allow-Methods", "POST,OPTIONS");
        headers.put("Access-Control-Allow-Headers", "Content-Type");

        return new APIGatewayProxyResponseEvent()
                .withStatusCode(statusCode)
                .withHeaders(headers)
                .withBody(body);
    }
}

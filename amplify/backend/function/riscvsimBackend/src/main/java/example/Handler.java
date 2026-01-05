package example;

import java.util.HashMap;
import java.util.Map;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyRequestEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyResponseEvent;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;

import riscvsim.Simulator;
import riscvsim.StepResult;

/**
 * Lambda entrypoint for the /simulate API.
 *
 * <p>Accepts a JSON payload {@code {"code":"...assembly..."}} and returns
 * simulator state after executing one step.</p>
 */
public class Handler implements RequestHandler<APIGatewayProxyRequestEvent, APIGatewayProxyResponseEvent> {

    private static final Gson GSON = new Gson();

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

        switch (path) {
        case "/api/session":
            return handleSession(event);
        case "/api/step":
            return handleStep(event);
        case "/api/reset":
            return handleReset(event);
        default:
            return corsResponse(404, "{\"error\":\"Unknown route: " + path + "\"}");
        }
    }

    private APIGatewayProxyResponseEvent handleSession(APIGatewayProxyRequestEvent event) {
        String body = "{\"sessionId\":\"abc123\"}";
        return corsResponse(200, body);
    }

    private APIGatewayProxyResponseEvent handleStep(APIGatewayProxyRequestEvent event) {
        String code = extractCode(event);
        if (code == null || code.isEmpty()) {
            return corsResponse(400, "{\"error\":\"missing code\"}");
        }

        try {
            Simulator sim = new Simulator();
            sim.assemble(code);

            StepResult step = sim.step();

            Map<String, Object> payload = new HashMap<>();
            payload.put("regs", sim.cpu().getRegs());
            payload.put("pc", sim.cpu().getPc());
            payload.put("halted", step.isHalted());
            payload.put("effects", step.getEffects());
            payload.put("clike", sim.cLike());
            payload.put("rv2c", sim.rv2c());
            payload.put("error", null);
            payload.put("pcAfter", sim.cpu().getPc());
            payload.put("stepExecuted", true);


            return corsResponse(200, GSON.toJson(payload));
        } catch (RuntimeException ex) {
            JsonObject err = new JsonObject();
            err.addProperty("error", ex.getMessage());
            return corsResponse(400, GSON.toJson(err));
        }
    }

    private APIGatewayProxyResponseEvent handleReset(APIGatewayProxyRequestEvent event) {
        String body = "{\"status\":\"reset\"}";
        return corsResponse(200, body);
    }

    /**
     * Extracts the assembly source from the event payload.
     *
     * @param event API Gateway proxy event
     * @return assembly source text or null if missing
     */
    private static String extractCode(APIGatewayProxyRequestEvent event) {
        String bodyStr = event.getBody();
        if (bodyStr != null && !bodyStr.isEmpty()) {
            try {
                Map<?, ?> bodyMap = GSON.fromJson(bodyStr, Map.class);
                Object code = bodyMap.get("code");
                if (code instanceof String s) {
                    return s;
                }
            } catch (JsonParseException | ClassCastException ignored) {
                // fall back to raw body if it is plain text
                return bodyStr;
            }
        }

        Map<String, String> queryParams = event.getQueryStringParameters();
        if (queryParams != null) {
            String code = queryParams.get("code");
            if (code != null) {
                return code;
            }
        }
        return null;
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

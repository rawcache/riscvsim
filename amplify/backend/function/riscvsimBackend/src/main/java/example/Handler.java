package example;

import java.util.HashMap;
import java.util.Map;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import riscvsim.Simulator;
import riscvsim.StepResult;

/**
 * Lambda entrypoint for the /simulate API.
 *
 * <p>Accepts a JSON payload {@code {"code":"...assembly..."}} and returns
 * simulator state after executing one step.</p>
 */
public class Handler implements RequestHandler<Map<String, Object>, Map<String, Object>> {

    private static final Gson GSON = new Gson();

    @Override
    public Map<String, Object> handleRequest(Map<String, Object> event, Context context) {
        String code = extractCode(event);
        if (code == null || code.isEmpty()) {
            return response(400, "{\"error\":\"missing code\"}");
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


            return response(200, GSON.toJson(payload));
        } catch (RuntimeException ex) {
            JsonObject err = new JsonObject();
            err.addProperty("error", ex.getMessage());
            return response(400, GSON.toJson(err));
        }
    }

    /**
     * Extracts the assembly source from the event payload.
     *
     * @param event API Gateway proxy event
     * @return assembly source text or null if missing
     */
    private static String extractCode(Map<String, Object> event) {
        Object bodyObj = event.get("body");
        if (bodyObj instanceof String bodyStr && !bodyStr.isEmpty()) {
            try {
                Map<?, ?> bodyMap = GSON.fromJson(bodyStr, Map.class);
                Object code = bodyMap.get("code");
                if (code instanceof String s) {
                    return s;
                }
            } catch (Exception ignored) {
                // fall back to raw body if it is plain text
                return bodyStr;
            }
        }
        Object direct = event.get("code");
        if (direct instanceof String s) {
            return s;
        }
        return null;
    }

    /**
     * Builds an API Gateway style response with CORS headers.
     *
     * @param status HTTP status code
     * @param body JSON string body
     * @return response map
     */
    private static Map<String, Object> response(int status, String body) {
        Map<String, Object> resp = new HashMap<>();
        resp.put("statusCode", status);

        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Access-Control-Allow-Methods", "POST,OPTIONS");
        headers.put("Access-Control-Allow-Headers", "Content-Type");
        resp.put("headers", headers);

        resp.put("body", body);
        return resp;
    }
}

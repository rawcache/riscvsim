// package example;

import java.util.HashMap;
import java.util.Map;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;

public class Handler implements RequestHandler<Map<String, Object>, Map<String, Object>> {

    @Override
    public Map<String, Object> handleRequest(Map<String, Object> input, Context context) {

        Map<String, Object> response = new HashMap<>();
        response.put("status", "ok");
        response.put("message", "RISC-V backend is live");
        response.put("input", input);

        return response;
    }
}

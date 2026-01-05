package example;

import com.amazonaws.services.lambda.runtime.Context; 
import com.amazonaws.services.lambda.runtime.RequestHandler;

/**
 * Lambda handler implementation for processing greeting requests.
 * <p>
 * This class implements the {@link RequestHandler} interface to provide
 * a standardized entry point for AWS Lambda execution. It takes a user's
 * name and returns a formatted greeting string.
 * </p>
 */
public class LambdaRequestHandler implements RequestHandler<RequestClass, ResponseClass> {   

    /**
     * Handles the incoming Lambda invocation.
     * @param request The POJO containing the input data (firstName and lastName).
     * @param context The execution context object providing methods to access 
     * information about the invocation, function, and environment.
     * @return A {@link ResponseClass} containing the generated greeting message.
     */
    @Override
    public ResponseClass handleRequest(RequestClass request, Context context) {
        String greetingString = String.format("Hello %s %s!", request.getFirstName(), request.getLastName());
        return new ResponseClass(greetingString);
    }
}
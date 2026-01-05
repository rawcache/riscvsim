package example;

/**
 * Represents the output data returned by the Lambda function.
 * <p>
 * This class contains the final greeting message that will be serialized 
 * into a JSON response for the caller.
 * </p>
 */
public class ResponseClass {

    /** The formatted greeting message. */
    private String greetings;

    /**
     * Gets the greeting message.
     * @return The formatted greeting string.
     */
    public String getGreetings() {
        return this.greetings;
    }

    /**
     * Sets the greeting message.
     * @param greetings The greeting string to be returned.
     */
    public void setGreetings(String greetings) {
        this.greetings = greetings;
    }

    /**
     * Constructs a new ResponseClass with a specific greeting.
     * @param greetings The formatted string to send back to the user.
     */
    public ResponseClass(String greetings) {
        this.greetings = greetings;
    }

    /**
     * Default constructor.
     * <p>
     * Necessary for serialization frameworks to instantiate the object 
     * before population.
     * </p>
     */
    public ResponseClass() {
    }
}
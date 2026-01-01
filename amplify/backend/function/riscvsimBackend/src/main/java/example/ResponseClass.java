package example;

/**
 * Simple response payload wrapping a greeting string.
 */
public class ResponseClass {
    private String greetings;

    /**
     * Returns the greeting text.
     *
     * @return greeting value
     */
    public String getGreetings() {
        return this.greetings;
    }

    /**
     * Sets the greeting text.
     *
     * @param greetings greeting value
     */
    public void setGreetings(String greetings) {
        this.greetings = greetings;
    }

    /**
     * Constructs a populated response.
     *
     * @param greetings greeting value
     */
    public ResponseClass(String greetings) {
        this.greetings = greetings;
    }
}
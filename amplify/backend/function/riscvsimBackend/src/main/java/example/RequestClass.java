package example;

/**
 * Simple request payload carrying a first and last name.
 */
public class RequestClass {
    private String firstName;
    private String lastName;

    /**
     * Returns the first name from the request.
     *
     * @return first name value
     */
    public String getFirstName() {
        return firstName;
    }

    /**
     * Sets the first name for the request.
     *
     * @param firstName first name value
     */
    public void setFirstName(String firstName) {
        this.firstName = firstName;
    }

    /**
     * Returns the last name from the request.
     *
     * @return last name value
     */
    public String getLastName() {
        return lastName;
    }

    /**
     * Sets the last name for the request.
     *
     * @param lastName last name value
     */
    public void setLastName(String lastName) {
        this.lastName = lastName;
    }

    /**
     * Constructs a populated request.
     *
     * @param firstName first name value
     * @param lastName last name value
     */
    public RequestClass(String firstName, String lastName) {
        this.firstName = firstName;
        this.lastName = lastName;
    }

    /**
     * Constructs an empty request.
     */
    public RequestClass() {
    }
}
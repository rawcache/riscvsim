package example;

/**
 * Represents the input data for a greeting request.
 * <p>
 * This POJO (Plain Old Java Object) is used by the AWS Lambda runtime 
 * to deserialize the incoming JSON event into a Java object.
 * </p>
 */
public class RequestClass {
    
    private String firstName;
    private String lastName;

    /**
     * Gets the first name of the user.
     * @return The first name string.
     */
    public String getFirstName() {
        return firstName;
    }

    /**
     * Sets the first name of the user.
     * @param firstName The first name to assign.
     */
    public void setFirstName(String firstName) {
        this.firstName = firstName;
    }

    /**
     * Gets the last name of the user.
     * @return The last name string.
     */
    public String getLastName() {
        return lastName;
    }

    /**
     * Sets the last name of the user.
     * @param lastName The last name to assign.
     */
    public void setLastName(String lastName) {
        this.lastName = lastName;
    }

    /**
     * Constructs a new RequestClass with specified names.
     * @param firstName The first name of the user.
     * @param lastName The last name of the user.
     */
    public RequestClass(String firstName, String lastName) {
        this.firstName = firstName;
        this.lastName = lastName;
    }

    /**
     * Default constructor.
     * <p>
     * Required by frameworks for 
     * instantiation during JSON deserialization.
     * </p>
     */
    public RequestClass() {
    }
}
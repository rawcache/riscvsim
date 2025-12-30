package riscvsim;

/**
 * Represents a byte-addressable memory used by the RISC-V simulator.
 *
 * <p>
 * This memory supports aligned 32-bit word loads and stores only.
 * All accesses are bounds-checked and alignment-checked.
 * </p>
 */
public final class Memory {

    /** Backing byte array for memory storage. */
    private final byte[] memory;

    /**
     * Constructs a memory instance with the given size.
     *
     * @param size total number of bytes
     */
    public Memory(int size) {
        this.memory = new byte[size];
    }

    /**
     * Returns the total size of memory in bytes.
     *
     * @return memory size
     */
    public int size() {
        return memory.length;
    }

    /**
     * Loads a 32-bit word from memory.
     *
     * @param address byte address (must be 4-byte aligned)
     * @return loaded word value
     * @throws IllegalStateException if unaligned or out of bounds
     */
    public int loadWord(int address) {
        checkAlignment(address);
        checkBounds(address, 4);

        return (memory[address] & 0xff)
             | ((memory[address + 1] & 0xff) << 8)
             | ((memory[address + 2] & 0xff) << 16)
             | (memory[address + 3] << 24);
    }

    /**
     * Stores a 32-bit word into memory.
     *
     * <p>
     * Returns the byte values before and after the store to support
     * visualization of memory effects.
     * </p>
     *
     * @param address byte address (must be 4-byte aligned)
     * @param value value to store
     * @return store result containing before/after bytes
     * @throws IllegalStateException if unaligned or out of bounds
     */
    public StoreResult storeWord(int address, int value) {
        checkAlignment(address);
        checkBounds(address, 4);

        int[] before = readBytes(address, 4);

        memory[address]     = (byte) (value & 0xff);
        memory[address + 1] = (byte) ((value >>> 8) & 0xff);
        memory[address + 2] = (byte) ((value >>> 16) & 0xff);
        memory[address + 3] = (byte) ((value >>> 24) & 0xff);

        int[] after = readBytes(address, 4);
        return new StoreResult(before, after);
    }

    /**
     * Ensures address is aligned to a 4-byte boundary.
     *
     * @param address byte address
     * @throws IllegalStateException if unaligned
     */
    private static void checkAlignment(int address) {
        if ((address & 3) != 0) {
            throw new IllegalStateException("Unaligned memory access");
        }
    }

    /**
     * Ensures memory access stays within bounds.
     *
     * @param address start address
     * @param size number of bytes
     * @throws IllegalStateException if out of bounds
     */
    private void checkBounds(int address, int size) {
        if (address < 0 || address + size > memory.length) {
            throw new IllegalStateException("Memory access out of bounds");
        }
    }

    /**
     * Reads raw bytes as unsigned integers.
     *
     * @param address start address
     * @param count number of bytes
     * @return array of unsigned byte values
     */
    private int[] readBytes(int address, int count) {
        int[] out = new int[count];
        for (int i = 0; i < count; i++) {
            out[i] = memory[address + i] & 0xff;
        }
        return out;
    }

    /**
     * Represents the result of a memory store operation.
     *
     * <p>
     * Used for visualization and effect tracking.
     * </p>
     */
    public static final class StoreResult {

        /** Bytes before the store. */
        private final int[] before;

        /** Bytes after the store. */
        private final int[] after;

        /**
         * Constructs a store result.
         *
         * @param before byte values before the write
         * @param after byte values after the write
         */
        public StoreResult(int[] before, int[] after) {
            this.before = before.clone();
            this.after = after.clone();
        }

        /**
         * Returns the bytes before the store.
         *
         * @return byte array
         */
        public int[] getBefore() {
            return before.clone();
        }

        /**
         * Returns the bytes after the store.
         *
         * @return byte array
         */
        public int[] getAfter() {
            return after.clone();
        }
    }
}

package riscvsim;

/**
 * Represents a byte-addressable memory used by the RISC-V simulator.
 *
 * <p>
 * This memory supports 8/16/32-bit little-endian loads and stores.
 * All accesses are bounds-checked, and alignment checking can be toggled.
 * </p>
 */
public final class Memory {

    /** Backing byte array for memory storage. */
    private final byte[] memory;

    /** Whether to enforce alignment checks on loads/stores. */
    private boolean alignmentChecksEnabled;

    /**
     * Constructs a memory instance with the given size.
     *
     * @param size total number of bytes
     */
    public Memory(int size) {
        this(size, true);
    }

    /**
     * Constructs a memory instance with the given size and alignment behavior.
     *
     * @param size total number of bytes
     * @param alignmentChecksEnabled whether to enforce alignment checks
     */
    public Memory(int size, boolean alignmentChecksEnabled) {
        this.memory = new byte[size];
        this.alignmentChecksEnabled = alignmentChecksEnabled;
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
     * Loads an 8-bit value from memory.
     *
     * @param address byte address
     * @return loaded byte value (0-255)
     * @throws TrapException if out of bounds
     */
    public int loadByte(int address) {
        checkAlignment(address, 1);
        checkBounds(address, 1);
        return memory[address] & 0xff;
    }

    /**
     * Loads a 16-bit halfword from memory.
     *
     * @param address byte address (must be 2-byte aligned)
     * @return loaded halfword value (0-65535)
     * @throws TrapException if unaligned or out of bounds
     */
    public int loadHalf(int address) {
        checkAlignment(address, 2);
        checkBounds(address, 2);
        return (memory[address] & 0xff)
             | ((memory[address + 1] & 0xff) << 8);
    }

    /**
     * Loads a 32-bit word from memory.
     *
     * @param address byte address (must be 4-byte aligned)
     * @return loaded word value
     * @throws TrapException if unaligned or out of bounds
     */
    public int loadWord(int address) {
        checkAlignment(address, 4);
        checkBounds(address, 4);

        return (memory[address] & 0xff)
             | ((memory[address + 1] & 0xff) << 8)
             | ((memory[address + 2] & 0xff) << 16)
             | (memory[address + 3] << 24);
    }

    /**
     * Stores an 8-bit value into memory.
     *
     * <p>
     * Returns the byte values before and after the store to support
     * visualization of memory effects.
     * </p>
     *
     * @param address byte address
     * @param value value to store
     * @return store result containing before/after bytes
     * @throws TrapException if out of bounds
     */
    public StoreResult storeByte(int address, int value) {
        checkAlignment(address, 1);
        checkBounds(address, 1);

        int[] before = readBytes(address, 1);
        memory[address] = (byte) (value & 0xff);
        int[] after = readBytes(address, 1);
        return new StoreResult(before, after);
    }

    /**
     * Stores a 16-bit halfword into memory.
     *
     * <p>
     * Returns the byte values before and after the store to support
     * visualization of memory effects.
     * </p>
     *
     * @param address byte address (must be 2-byte aligned)
     * @param value value to store
     * @return store result containing before/after bytes
     * @throws TrapException if unaligned or out of bounds
     */
    public StoreResult storeHalf(int address, int value) {
        checkAlignment(address, 2);
        checkBounds(address, 2);

        int[] before = readBytes(address, 2);
        memory[address] = (byte) (value & 0xff);
        memory[address + 1] = (byte) ((value >>> 8) & 0xff);
        int[] after = readBytes(address, 2);
        return new StoreResult(before, after);
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
     * @throws TrapException if unaligned or out of bounds
     */
    public StoreResult storeWord(int address, int value) {
        checkAlignment(address, 4);
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
     * Ensures address is aligned to the access size.
     *
     * @param address byte address
     * @param size access size in bytes
     * @throws TrapException if unaligned
     */
    private void checkAlignment(int address, int size) {
        if (!alignmentChecksEnabled) {
            return;
        }
        int mask = size - 1;
        if (mask != 0 && (address & mask) != 0) {
            throw new TrapException(TrapCode.TRAP_BAD_ALIGNMENT, "Unaligned memory access at " + address);
        }
    }

    /**
     * Ensures memory access stays within bounds.
     *
     * @param address start address
     * @param size number of bytes
     * @throws TrapException if out of bounds
     */
    private void checkBounds(int address, int size) {
        if (address < 0 || address + size > memory.length) {
            throw new TrapException(TrapCode.TRAP_OOB_MEMORY, "Memory access out of bounds at " + address);
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
     * Enables or disables alignment checks for subsequent accesses.
     *
     * @param enabled {@code true} to enforce alignment, {@code false} to allow unaligned accesses
     */
    public void setAlignmentChecksEnabled(boolean enabled) {
        this.alignmentChecksEnabled = enabled;
    }

    /**
     * Indicates whether alignment checks are enabled.
     *
     * @return {@code true} if alignment checks are enforced
     */
    public boolean isAlignmentChecksEnabled() {
        return alignmentChecksEnabled;
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

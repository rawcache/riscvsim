package riscvsim;

/**
 * Represents a single decoded RISC-V instruction.
 *
 * <p>
 * Instructions are immutable after construction and are created using
 * static factory methods corresponding to each opcode.
 * </p>
 */
public final class Instruction {

    /**
     * Supported instruction opcodes.
     */
    public enum Op {
        /** Add immediate. */ ADDI,
        /** Load word. */ LW,
        /** Store word. */ SW,
        /** Branch if equal (signed). */ BEQ,
        /** Branch if not equal (signed). */ BNE,
        /** Branch if less than (signed). */ BLT,
        /** Branch if greater or equal (signed). */ BGE,
        /** Branch if less than (unsigned). */ BLTU,
        /** Branch if greater or equal (unsigned). */ BGEU
    }

    private Op op;
    private int srcLine;

    // Common fields (some unused depending on opcode)
    private int rd;
    private int rs1;
    private int rs2;
    private int imm;
    private int targetPC;

    /**
     * Private constructor.
     *
     * <p>
     * Instances must be created using the static factory methods
     * corresponding to each instruction type.
     * </p>
     */
    private Instruction() {
        // default
    }

    /**
     * Creates an ADDI instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param imm immediate value
     * @param srcLine source line number
     * @return ADDI instruction
     */
    public static Instruction addi(int rd, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.ADDI;
        i.rd = rd;
        i.rs1 = rs1;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a LW instruction.
     *
     * @param rd destination register
     * @param rs1 base register
     * @param imm byte offset
     * @param srcLine source line number
     * @return LW instruction
     */
    public static Instruction lw(int rd, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.LW;
        i.rd = rd;
        i.rs1 = rs1;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a SW instruction.
     *
     * @param rs2 value register
     * @param rs1 base register
     * @param imm byte offset
     * @param srcLine source line number
     * @return SW instruction
     */
    public static Instruction sw(int rs2, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.SW;
        i.rs2 = rs2;
        i.rs1 = rs1;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a BEQ instruction.
     *
     * @param rs1 first register to compare
     * @param rs2 second register to compare
     * @param targetPC branch target PC
     * @param srcLine source line number
     * @return BEQ instruction
     */
    public static Instruction beq(int rs1, int rs2, int targetPC, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.BEQ;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.targetPC = targetPC;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a BNE instruction.
     *
     * @param rs1 first register to compare
     * @param rs2 second register to compare
     * @param targetPC branch target PC
     * @param srcLine source line number
     * @return BNE instruction
     */
    public static Instruction bne(int rs1, int rs2, int targetPC, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.BNE;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.targetPC = targetPC;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a BLT instruction.
     *
     * @param rs1 first register to compare
     * @param rs2 second register to compare
     * @param targetPC branch target PC
     * @param srcLine source line number
     * @return BLT instruction
     */
    public static Instruction blt(int rs1, int rs2, int targetPC, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.BLT;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.targetPC = targetPC;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a BGE instruction.
     *
     * @param rs1 first register to compare
     * @param rs2 second register to compare
     * @param targetPC branch target PC
     * @param srcLine source line number
     * @return BGE instruction
     */
    public static Instruction bge(int rs1, int rs2, int targetPC, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.BGE;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.targetPC = targetPC;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a BLTU instruction.
     *
     * @param rs1 first register to compare
     * @param rs2 second register to compare
     * @param targetPC branch target PC
     * @param srcLine source line number
     * @return BLTU instruction
     */
    public static Instruction bltu(int rs1, int rs2, int targetPC, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.BLTU;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.targetPC = targetPC;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a BGEU instruction.
     *
     * @param rs1 first register to compare
     * @param rs2 second register to compare
     * @param targetPC branch target PC
     * @param srcLine source line number
     * @return BGEU instruction
     */
    public static Instruction bgeu(int rs1, int rs2, int targetPC, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.BGEU;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.targetPC = targetPC;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Returns the opcode.
     *
     * @return instruction opcode
     */
    public Op getOp() {
        return op;
    }

    /**
     * Returns the source line number.
     *
     * @return source line index
     */
    public int getSrcLine() {
        return srcLine;
    }

    /**
     * Returns the destination register.
     *
     * @return destination register index
     */
    public int getRd() {
        return rd;
    }

    /**
     * Returns the first source register.
     *
     * @return source register index
     */
    public int getRs1() {
        return rs1;
    }

    /**
     * Returns the second source register.
     *
     * @return source register index
     */
    public int getRs2() {
        return rs2;
    }

    /**
     * Returns the immediate value.
     *
     * @return immediate value
     */
    public int getImm() {
        return imm;
    }

    /**
     * Returns the branch target PC.
     *
     * @return target program counter
     */
    public int getTargetPC() {
        return targetPC;
    }
}

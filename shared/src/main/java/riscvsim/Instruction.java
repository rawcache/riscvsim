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
        /** Load upper immediate. */ LUI,
        /** Add upper immediate to PC. */ AUIPC,
        /** Add registers. */ ADD,
        /** Subtract registers. */ SUB,
        /** Set less than (signed). */ SLT,
        /** Set less than immediate (signed). */ SLTI,
        /** Set less than (unsigned). */ SLTU,
        /** Set less than immediate (unsigned). */ SLTIU,
        /** Multiply low 32 bits. */ MUL,
        /** Multiply high 32 bits (signed). */ MULH,
        /** Multiply high 32 bits (signed x unsigned). */ MULHSU,
        /** Multiply high 32 bits (unsigned). */ MULHU,
        /** Divide (signed). */ DIV,
        /** Divide (unsigned). */ DIVU,
        /** Remainder (signed). */ REM,
        /** Remainder (unsigned). */ REMU,
        /** Shift left logical immediate. */ SLLI,
        /** Shift right logical immediate. */ SRLI,
        /** Shift right arithmetic immediate. */ SRAI,
        /** Shift left logical. */ SLL,
        /** Shift right logical. */ SRL,
        /** Shift right arithmetic. */ SRA,
        /** Bitwise AND. */ AND,
        /** Bitwise OR. */ OR,
        /** Bitwise XOR. */ XOR,
        /** Bitwise AND immediate. */ ANDI,
        /** Bitwise OR immediate. */ ORI,
        /** Bitwise XOR immediate. */ XORI,
        /** Load byte (signed). */ LB,
        /** Load byte (unsigned). */ LBU,
        /** Load halfword (signed). */ LH,
        /** Load halfword (unsigned). */ LHU,
        /** Load word. */ LW,
        /** Store byte. */ SB,
        /** Store halfword. */ SH,
        /** Store word. */ SW,
        /** Jump and link. */ JAL,
        /** Jump and link register. */ JALR,
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
     * Creates a LUI instruction.
     *
     * @param rd destination register
     * @param imm upper immediate value
     * @param srcLine source line number
     * @return LUI instruction
     */
    public static Instruction lui(int rd, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.LUI;
        i.rd = rd;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates an AUIPC instruction.
     *
     * @param rd destination register
     * @param imm upper immediate value
     * @param srcLine source line number
     * @return AUIPC instruction
     */
    public static Instruction auipc(int rd, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.AUIPC;
        i.rd = rd;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates an ADD instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 second source register
     * @param srcLine source line number
     * @return ADD instruction
     */
    public static Instruction add(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.ADD;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a SUB instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 second source register
     * @param srcLine source line number
     * @return SUB instruction
     */
    public static Instruction sub(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.SUB;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates an SLT instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 second source register
     * @param srcLine source line number
     * @return SLT instruction
     */
    public static Instruction slt(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.SLT;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates an SLTI instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param imm immediate value
     * @param srcLine source line number
     * @return SLTI instruction
     */
    public static Instruction slti(int rd, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.SLTI;
        i.rd = rd;
        i.rs1 = rs1;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates an SLTU instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 second source register
     * @param srcLine source line number
     * @return SLTU instruction
     */
    public static Instruction sltu(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.SLTU;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates an SLTIU instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param imm immediate value
     * @param srcLine source line number
     * @return SLTIU instruction
     */
    public static Instruction sltiu(int rd, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.SLTIU;
        i.rd = rd;
        i.rs1 = rs1;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a MUL instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 second source register
     * @param srcLine source line number
     * @return MUL instruction
     */
    public static Instruction mul(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.MUL;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a MULH instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 second source register
     * @param srcLine source line number
     * @return MULH instruction
     */
    public static Instruction mulh(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.MULH;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a MULHSU instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 second source register
     * @param srcLine source line number
     * @return MULHSU instruction
     */
    public static Instruction mulhsu(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.MULHSU;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a MULHU instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 second source register
     * @param srcLine source line number
     * @return MULHU instruction
     */
    public static Instruction mulhu(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.MULHU;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a DIV instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 second source register
     * @param srcLine source line number
     * @return DIV instruction
     */
    public static Instruction div(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.DIV;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a DIVU instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 second source register
     * @param srcLine source line number
     * @return DIVU instruction
     */
    public static Instruction divu(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.DIVU;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a REM instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 second source register
     * @param srcLine source line number
     * @return REM instruction
     */
    public static Instruction rem(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.REM;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a REMU instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 second source register
     * @param srcLine source line number
     * @return REMU instruction
     */
    public static Instruction remu(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.REMU;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a SLLI instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param imm shift amount
     * @param srcLine source line number
     * @return SLLI instruction
     */
    public static Instruction slli(int rd, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.SLLI;
        i.rd = rd;
        i.rs1 = rs1;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a SRLI instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param imm shift amount
     * @param srcLine source line number
     * @return SRLI instruction
     */
    public static Instruction srli(int rd, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.SRLI;
        i.rd = rd;
        i.rs1 = rs1;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a SRAI instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param imm shift amount
     * @param srcLine source line number
     * @return SRAI instruction
     */
    public static Instruction srai(int rd, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.SRAI;
        i.rd = rd;
        i.rs1 = rs1;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a SLL instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 shift amount register
     * @param srcLine source line number
     * @return SLL instruction
     */
    public static Instruction sll(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.SLL;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a SRL instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 shift amount register
     * @param srcLine source line number
     * @return SRL instruction
     */
    public static Instruction srl(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.SRL;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a SRA instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 shift amount register
     * @param srcLine source line number
     * @return SRA instruction
     */
    public static Instruction sra(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.SRA;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates an AND instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 second source register
     * @param srcLine source line number
     * @return AND instruction
     */
    public static Instruction and(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.AND;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates an OR instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 second source register
     * @param srcLine source line number
     * @return OR instruction
     */
    public static Instruction or(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.OR;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a XOR instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param rs2 second source register
     * @param srcLine source line number
     * @return XOR instruction
     */
    public static Instruction xor(int rd, int rs1, int rs2, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.XOR;
        i.rd = rd;
        i.rs1 = rs1;
        i.rs2 = rs2;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates an ANDI instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param imm immediate value
     * @param srcLine source line number
     * @return ANDI instruction
     */
    public static Instruction andi(int rd, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.ANDI;
        i.rd = rd;
        i.rs1 = rs1;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates an ORI instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param imm immediate value
     * @param srcLine source line number
     * @return ORI instruction
     */
    public static Instruction ori(int rd, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.ORI;
        i.rd = rd;
        i.rs1 = rs1;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a XORI instruction.
     *
     * @param rd destination register
     * @param rs1 source register
     * @param imm immediate value
     * @param srcLine source line number
     * @return XORI instruction
     */
    public static Instruction xori(int rd, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.XORI;
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
     * Creates a LB instruction.
     *
     * @param rd destination register
     * @param rs1 base register
     * @param imm byte offset
     * @param srcLine source line number
     * @return LB instruction
     */
    public static Instruction lb(int rd, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.LB;
        i.rd = rd;
        i.rs1 = rs1;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a LBU instruction.
     *
     * @param rd destination register
     * @param rs1 base register
     * @param imm byte offset
     * @param srcLine source line number
     * @return LBU instruction
     */
    public static Instruction lbu(int rd, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.LBU;
        i.rd = rd;
        i.rs1 = rs1;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a LH instruction.
     *
     * @param rd destination register
     * @param rs1 base register
     * @param imm byte offset
     * @param srcLine source line number
     * @return LH instruction
     */
    public static Instruction lh(int rd, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.LH;
        i.rd = rd;
        i.rs1 = rs1;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a LHU instruction.
     *
     * @param rd destination register
     * @param rs1 base register
     * @param imm byte offset
     * @param srcLine source line number
     * @return LHU instruction
     */
    public static Instruction lhu(int rd, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.LHU;
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
     * Creates a SB instruction.
     *
     * @param rs2 value register
     * @param rs1 base register
     * @param imm byte offset
     * @param srcLine source line number
     * @return SB instruction
     */
    public static Instruction sb(int rs2, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.SB;
        i.rs2 = rs2;
        i.rs1 = rs1;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a SH instruction.
     *
     * @param rs2 value register
     * @param rs1 base register
     * @param imm byte offset
     * @param srcLine source line number
     * @return SH instruction
     */
    public static Instruction sh(int rs2, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.SH;
        i.rs2 = rs2;
        i.rs1 = rs1;
        i.imm = imm;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a JAL instruction.
     *
     * @param rd destination register for return address
     * @param targetPC absolute jump target PC
     * @param srcLine source line number
     * @return JAL instruction
     */
    public static Instruction jal(int rd, int targetPC, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.JAL;
        i.rd = rd;
        i.targetPC = targetPC;
        i.srcLine = srcLine;
        return i;
    }

    /**
     * Creates a JALR instruction.
     *
     * @param rd destination register for return address
     * @param rs1 base register for target address
     * @param imm byte offset added to {@code rs1}
     * @param srcLine source line number
     * @return JALR instruction
     */
    public static Instruction jalr(int rd, int rs1, int imm, int srcLine) {
        Instruction i = new Instruction();
        i.op = Op.JALR;
        i.rd = rd;
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

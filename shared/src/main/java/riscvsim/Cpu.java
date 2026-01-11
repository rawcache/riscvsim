package riscvsim;

import java.util.ArrayList;
import java.util.List;
import java.util.function.BiConsumer;

/**
 * RISC-V CPU execution engine.
 *
 * <p>
 * This class models a minimal RV32 CPU with:
 * </p>
 * <ul>
 *   <li>32 integer registers</li>
 *   <li>Program counter (PC)</li>
 *   <li>Flat byte-addressable memory</li>
 * </ul>
 *
 * <p>
 * The CPU executes instructions one at a time and emits a list of
 * {@link Effect} objects describing all observable state changes.
 * </p>
 */
public final class Cpu {

    /** Program counter (byte address). */
    private int pc;

    /** Integer register file (x0–x31). */
    private final int[] regs;

    /** Main memory. */
    private final Memory mem;

    /**
     * Creates a new CPU instance with the given memory size.
     *
     * @param memSize size of memory in bytes
     */
    public Cpu(int memSize) {
        this.mem = new Memory(memSize);
        this.regs = new int[32];
        reset();
    }

    /**
     * Resets the CPU to its initial state.
     *
     * <p>
     * This sets:
     * </p>
     * <ul>
     *   <li>PC to 0</li>
     *   <li>All registers to 0</li>
     *   <li>Stack pointer (x2) near top of memory</li>
     * </ul>
     */
    public void reset() {
        pc = 0;
        for (int i = 0; i < 32; i++) {
            regs[i] = 0;
        }
        regs[2] = mem.size() - 4; // sp
        regs[0] = 0;
    }

    /**
     * Executes a single instruction from the given program.
     *
     * <p>
     * The CPU reads the instruction at {@code pc}, executes it,
     * updates architectural state, and returns all side effects.
     * </p>
     *
     * @param program assembled program to execute
     * @return result of executing one instruction
     */
    public StepResult step(Program program) {
        List<Effect> effects = new ArrayList<>();
        int pc0 = pc;
        Instruction inst = null;

        try {
            if ((pc & 3) != 0) {
                throw new TrapException(TrapCode.TRAP_BAD_ALIGNMENT, "PC is not word-aligned: " + pc);
            }

            int idx = pc >>> 2;
            if (idx < 0 || idx >= program.getInstructions().size()) {
                throw new TrapException(TrapCode.TRAP_PC_OOB, "PC outside program: " + pc);
            }

            inst = program.getInstructions().get(idx);

            /*
             * Helper for register writes.
             * Ensures x0 is immutable and records effects only on change.
             */
            BiConsumer<Integer, Integer> writeReg = (reg, value) -> {
                if (reg == 0) {
                    return;
                }
                int before = regs[reg];
                int after = value;
                if (before != after) {
                    regs[reg] = after;
                    effects.add(Effect.reg(reg, before, after));
                }
            };

            switch (inst.getOp()) {
            case ADDI -> {
                int v = regs[inst.getRs1()] + inst.getImm();
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case LUI -> {
                int v = inst.getImm() << 12;
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case AUIPC -> {
                int v = (int) ((pc0 + ((long) inst.getImm() << 12)) & 0xffffffffL);
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case ADD -> {
                int v = regs[inst.getRs1()] + regs[inst.getRs2()];
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case SUB -> {
                int v = regs[inst.getRs1()] - regs[inst.getRs2()];
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case SLT -> {
                int v = regs[inst.getRs1()] < regs[inst.getRs2()] ? 1 : 0;
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case SLTU -> {
                long a = regs[inst.getRs1()] & 0xffffffffL;
                long b = regs[inst.getRs2()] & 0xffffffffL;
                int v = a < b ? 1 : 0;
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case SLTI -> {
                int v = regs[inst.getRs1()] < inst.getImm() ? 1 : 0;
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case SLTIU -> {
                long a = regs[inst.getRs1()] & 0xffffffffL;
                long b = inst.getImm() & 0xffffffffL;
                int v = a < b ? 1 : 0;
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case SLLI -> {
                int shamt = inst.getImm() & 31;
                int v = regs[inst.getRs1()] << shamt;
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case SRLI -> {
                int shamt = inst.getImm() & 31;
                int v = regs[inst.getRs1()] >>> shamt;
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case SRAI -> {
                int shamt = inst.getImm() & 31;
                int v = regs[inst.getRs1()] >> shamt;
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case SLL -> {
                int shamt = regs[inst.getRs2()] & 31;
                int v = regs[inst.getRs1()] << shamt;
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case SRL -> {
                int shamt = regs[inst.getRs2()] & 31;
                int v = regs[inst.getRs1()] >>> shamt;
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case SRA -> {
                int shamt = regs[inst.getRs2()] & 31;
                int v = regs[inst.getRs1()] >> shamt;
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case MUL -> {
                int v = (int) ((long) regs[inst.getRs1()] * (long) regs[inst.getRs2()]);
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case MULH -> {
                long prod = (long) regs[inst.getRs1()] * (long) regs[inst.getRs2()];
                int v = (int) (prod >> 32);
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case MULHSU -> {
                long a = regs[inst.getRs1()];
                long b = regs[inst.getRs2()] & 0xffffffffL;
                long prod = a * b;
                int v = (int) (prod >> 32);
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case MULHU -> {
                long a = regs[inst.getRs1()] & 0xffffffffL;
                long b = regs[inst.getRs2()] & 0xffffffffL;
                long prod = a * b;
                int v = (int) (prod >>> 32);
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case DIV -> {
                int rs2 = regs[inst.getRs2()];
                int rs1 = regs[inst.getRs1()];
                int v;
                if (rs2 == 0) {
                    v = -1;
                } else if (rs1 == Integer.MIN_VALUE && rs2 == -1) {
                    v = Integer.MIN_VALUE;
                } else {
                    v = rs1 / rs2;
                }
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case DIVU -> {
                int rs2 = regs[inst.getRs2()];
                long b = rs2 & 0xffffffffL;
                int v;
                if (b == 0) {
                    v = -1;
                } else {
                    long a = regs[inst.getRs1()] & 0xffffffffL;
                    v = (int) (a / b);
                }
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case REM -> {
                int rs2 = regs[inst.getRs2()];
                int rs1 = regs[inst.getRs1()];
                int v;
                if (rs2 == 0) {
                    v = rs1;
                } else if (rs1 == Integer.MIN_VALUE && rs2 == -1) {
                    v = 0;
                } else {
                    v = rs1 % rs2;
                }
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case REMU -> {
                int rs2 = regs[inst.getRs2()];
                long b = rs2 & 0xffffffffL;
                int v;
                if (b == 0) {
                    v = regs[inst.getRs1()];
                } else {
                    long a = regs[inst.getRs1()] & 0xffffffffL;
                    v = (int) (a % b);
                }
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case AND -> {
                int v = regs[inst.getRs1()] & regs[inst.getRs2()];
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case OR -> {
                int v = regs[inst.getRs1()] | regs[inst.getRs2()];
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case XOR -> {
                int v = regs[inst.getRs1()] ^ regs[inst.getRs2()];
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case ANDI -> {
                int v = regs[inst.getRs1()] & inst.getImm();
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case ORI -> {
                int v = regs[inst.getRs1()] | inst.getImm();
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case XORI -> {
                int v = regs[inst.getRs1()] ^ inst.getImm();
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case LB -> {
                int addr = (int) (((regs[inst.getRs1()] & 0xffffffffL)
                        + (inst.getImm() & 0xffffffffL)) & 0xffffffffL);
                int v = (byte) mem.loadByte(addr);
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case LBU -> {
                int addr = (int) (((regs[inst.getRs1()] & 0xffffffffL)
                        + (inst.getImm() & 0xffffffffL)) & 0xffffffffL);
                int v = mem.loadByte(addr);
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case LH -> {
                int addr = (int) (((regs[inst.getRs1()] & 0xffffffffL)
                        + (inst.getImm() & 0xffffffffL)) & 0xffffffffL);
                int v = (short) mem.loadHalf(addr);
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case LHU -> {
                int addr = (int) (((regs[inst.getRs1()] & 0xffffffffL)
                        + (inst.getImm() & 0xffffffffL)) & 0xffffffffL);
                int v = mem.loadHalf(addr);
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case LW -> {
                int addr = (int) (((regs[inst.getRs1()] & 0xffffffffL)
                        + (inst.getImm() & 0xffffffffL)) & 0xffffffffL);
                int v = mem.loadWord(addr);
                writeReg.accept(inst.getRd(), v);
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case SB -> {
                int addr = (int) (((regs[inst.getRs1()] & 0xffffffffL)
                        + (inst.getImm() & 0xffffffffL)) & 0xffffffffL);
                Memory.StoreResult sr = mem.storeByte(addr, regs[inst.getRs2()]);
                effects.add(Effect.mem(addr, 1, sr.getBefore(), sr.getAfter()));
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case SH -> {
                int addr = (int) (((regs[inst.getRs1()] & 0xffffffffL)
                        + (inst.getImm() & 0xffffffffL)) & 0xffffffffL);
                Memory.StoreResult sr = mem.storeHalf(addr, regs[inst.getRs2()]);
                effects.add(Effect.mem(addr, 2, sr.getBefore(), sr.getAfter()));
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case SW -> {
                int addr = (int) (((regs[inst.getRs1()] & 0xffffffffL)
                        + (inst.getImm() & 0xffffffffL)) & 0xffffffffL);
                Memory.StoreResult sr =
                        mem.storeWord(addr, regs[inst.getRs2()]);
                effects.add(Effect.mem(addr, 4, sr.getBefore(), sr.getAfter()));
                pc = (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case JAL -> {
                writeReg.accept(inst.getRd(), pc0 + 4);
                pc = inst.getTargetPC();
            }

            case JALR -> {
                writeReg.accept(inst.getRd(), pc0 + 4);
                int target = (int) (((regs[inst.getRs1()] & 0xffffffffL)
                        + (inst.getImm() & 0xffffffffL)) & 0xffffffffL);
                target &= ~1;
                pc = target;
            }

            case BEQ -> {
                boolean taken =
                        regs[inst.getRs1()] == regs[inst.getRs2()];
                pc = taken ? inst.getTargetPC() : (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case BNE -> {
                boolean taken = 
                        regs[inst.getRs1()] != regs[inst.getRs2()];
                pc = taken ? inst.getTargetPC() : (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case BLT -> {
                boolean taken = 
                        regs[inst.getRs1()] < regs[inst.getRs2()];
                pc = taken ? inst.getTargetPC() : (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case BGE -> {
                boolean taken = 
                        regs[inst.getRs1()] >= regs[inst.getRs2()];
                pc = taken ? inst.getTargetPC() : (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case BLTU -> {
                long a = regs[inst.getRs1()] & 0xffffffffL;
                long b = regs[inst.getRs2()] & 0xffffffffL;
                boolean taken = a < b;
                pc = taken ? inst.getTargetPC() : (int) ((pc0 + 4L) & 0xffffffffL);
            }

            case BGEU -> {
                long a = regs[inst.getRs1()] & 0xffffffffL;
                long b = regs[inst.getRs2()] & 0xffffffffL;
                boolean taken = a >= b;
                pc = taken ? inst.getTargetPC() : (int) ((pc0 + 4L) & 0xffffffffL);
            }

            default -> throw new TrapException(TrapCode.TRAP_ILLEGAL_INSTRUCTION,
                    "Unsupported opcode: " + inst.getOp());
            }

            if ((pc & 3) != 0) {
                throw new TrapException(TrapCode.TRAP_BAD_ALIGNMENT, "PC became unaligned: " + pc);
            }

            effects.add(Effect.pc(pc0, pc));
            return new StepResult(inst, effects, false, null);
        } catch (TrapException te) {
            return new StepResult(inst, effects, true, new Trap(te.getCode(), te.getMessage()));
        } finally {
            regs[0] = 0;
        }
    }

    /**
     * Returns the current program counter (byte address).
     *
     * @return program counter
     */
    public int getPc() {
        return pc;
    }

    /**
     * Returns a copy of the register file.
     *
     * @return array of 32 integer registers
     */
    public int[] getRegs() {
        return regs.clone();
    }

    /**
     * Returns the backing memory instance.
     *
     * @return memory
     */
    public Memory getMemory() {
        return mem;
    }
}

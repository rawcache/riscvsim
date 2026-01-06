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

            case LW -> {
                int addr = (int) (((regs[inst.getRs1()] & 0xffffffffL)
                        + (inst.getImm() & 0xffffffffL)) & 0xffffffffL);
                int v = mem.loadWord(addr);
                writeReg.accept(inst.getRd(), v);
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

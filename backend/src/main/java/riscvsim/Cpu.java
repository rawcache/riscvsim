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
        int idx = pc >>> 2;

        if (idx < 0 || idx >= program.getInstructions().size()) {
            return new StepResult(null, List.of(), true);
        }

        Instruction inst = program.getInstructions().get(idx);
        List<Effect> effects = new ArrayList<>();
        int pc0 = pc;

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
            pc = pc0 + 4;
        }

        case LW -> {
            int addr = regs[inst.getRs1()] + inst.getImm();
            int v = mem.loadWord(addr);
            writeReg.accept(inst.getRd(), v);
            pc = pc0 + 4;
        }

        case SW -> {
            int addr = regs[inst.getRs1()] + inst.getImm();
            Memory.StoreResult sr =
                    mem.storeWord(addr, regs[inst.getRs2()]);
            effects.add(Effect.mem(addr, 4, sr.getBefore(), sr.getAfter()));
            pc = pc0 + 4;
        }

        case BEQ -> {
            boolean taken =
                    regs[inst.getRs1()] == regs[inst.getRs2()];
            pc = taken ? inst.getTargetPC() : (pc0 + 4);
        }

        default -> {
            // Defensive: should never happen
            pc = pc0 + 4;
        }
        }

        effects.add(Effect.pc(pc0, pc));
        regs[0] = 0;

        return new StepResult(inst, effects, false);
    }

    /** @return current program counter */
    public int getPc() {
        return pc;
    }

    /** @return copy of the register file */
    public int[] getRegs() {
        return regs.clone();
    }

    /** @return memory instance */
    public Memory getMemory() {
        return mem;
    }
}

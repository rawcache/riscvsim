package riscvsim;

import java.util.List;

/**
 * Result of executing a single instruction step in the simulator.
 *
 * <p>
 * A {@code StepResult} captures which instruction was executed,
 * the side effects produced by that instruction, and whether
 * execution has halted.
 * </p>
 */
public final class StepResult {

    /**
     * Instruction that was executed during this step.
     */
    private final Instruction inst;

    /**
     * Side effects produced by the instruction execution.
     */
    private final List<Effect> effects;

    /**
     * Indicates whether execution has halted after this step.
     */
    private final boolean halted;

    /**
     * Trap information if execution stopped due to a fault.
     */
    private final Trap trap;

    /**
     * Constructs a new step result.
     *
     * @param inst executed instruction
     * @param effects list of side effects
     * @param halted whether execution halted
     * @param trap trap information if halted due to a fault
     */
    public StepResult(Instruction inst, List<Effect> effects, boolean halted, Trap trap) {
        this.inst = inst;
        this.effects = effects;
        this.halted = halted;
        this.trap = trap;
    }

    /**
     * Returns the instruction executed during this step.
     *
     * @return executed instruction
     */
    public Instruction getInst() {
        return inst;
    }

    /**
     * Returns the list of side effects produced by the instruction.
     *
     * @return list of effects
     */
    public List<Effect> getEffects() {
        return effects;
    }

    /**
     * Indicates whether execution has halted.
     *
     * @return {@code true} if halted, {@code false} otherwise
     */
    public boolean isHalted() {
        return halted;
    }

    /**
     * Returns trap information if execution halted due to a fault.
     *
     * @return trap info or {@code null} if no trap occurred
     */
    public Trap getTrap() {
        return trap;
    }
}

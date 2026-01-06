package riscvsim;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Traps and safety limits.
 */
final class RobustnessTest {

    @Test
    void misalignedAccessTriggersBadAlignmentTrap() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, 1
                lw x2, 0(x1)
                """);

        sim.step(); // addi
        StepResult r = sim.step(); // lw traps

        assertTrue(r.isHalted());
        assertNotNull(r.getTrap());
        assertEquals(TrapCode.TRAP_BAD_ALIGNMENT, r.getTrap().getCode());
    }

    @Test
    void outOfBoundsMemoryTriggersTrap() {
        Simulator sim = new Simulator();
        int base = Simulator.MEM_SIZE - 8;
        sim.assemble("""
                addi x1, x0, %d
                lw x2, 12(x1)   # address = mem_size + 4 (aligned) -> OOB
                """.formatted(base));

        sim.step(); // addi
        StepResult r = sim.step(); // lw traps

        assertTrue(r.isHalted());
        assertNotNull(r.getTrap());
        assertEquals(TrapCode.TRAP_OOB_MEMORY, r.getTrap().getCode());
    }

    @Test
    void pcOutsideProgramTriggersPcOobTrap() {
        Simulator sim = new Simulator();
        sim.assemble("""
                beq x0, x0, 32   # jump past end of program
                """);

        StepResult r1 = sim.step(); // branch to PC=32
        assertNotNull(r1);
        StepResult r2 = sim.step(); // PC outside program triggers trap
        assertTrue(r2.isHalted());
        assertNotNull(r2.getTrap());
        assertEquals(TrapCode.TRAP_PC_OOB, r2.getTrap().getCode());
    }
}

package riscvsim;

import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;

class SimulatorTest {

    /**
     * Steps the simulator until it reports halted or a step budget is exceeded.
     *
     * @param sim simulator instance to drive
     * @param maxSteps safety cap to avoid infinite loops
     */
    private static void runUntilHalt(Simulator sim, int maxSteps) {
        for (int i = 0; i < maxSteps; i++) {
            StepResult r = sim.step();
            if (r.isHalted()) {
                return;
            }
        }
        throw new IllegalStateException("Program did not halt within " + maxSteps + " steps");
    }

    /**
     * Regression for the README sample showing unsigned branches behave as documented.
     */
    @Test
    void sampleProgramFromReadmeBranchesAsDocumented() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, -1
                addi x2, x0, 1
                bltu x1, x2, not_taken
                addi x3, x0, 123
            not_taken:
                bgeu x1, x2, done
                addi x3, x0, 999
            done:
                """);

        runUntilHalt(sim, 20);

        int[] regs = sim.cpu().getRegs();
        assertEquals(-1, regs[1], "x1 should hold -1");
        assertEquals(1, regs[2], "x2 should hold 1");
        assertEquals(123, regs[3], "x3 should keep the first write and skip the second");
        assertEquals(24, sim.cpu().getPc(), "PC should end at the done label");
    }

    /**
     * Verifies #sym binds an absolute PC target that branches can jump to.
     */
    @Test
    void symAllowsBranchingToAbsoluteAddresses() {
        Simulator sim = new Simulator();
        sim.assemble("""
                #sym far = 16
                addi x1, x0, 1
                bne x1, x0, far
                addi x2, x0, 9
                """);

        runUntilHalt(sim, 10);

        int[] regs = sim.cpu().getRegs();
        assertEquals(1, regs[1], "branch condition uses x1 = 1");
        assertEquals(Simulator.MEM_SIZE - 4, regs[2], "x2 should stay at the initial stack pointer");
        assertEquals(16, sim.cpu().getPc(), "PC should jump to the absolute #sym address");
    }

    /**
     * Ensures ADDI writes an immediate when the base register is x0.
     */
    @Test
    void addiWritesImmediateWhenBaseIsZero() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x5, x0, 42
                """);

        runUntilHalt(sim, 5);

        assertEquals(42, sim.cpu().getRegs()[5]);
    }

    /**
     * Ensures ADDI adds a register and immediate when the base is non-zero.
     */
    @Test
    void addiAccumulatesRegisterAndImmediate() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, 5
                addi x2, x1, -2
                """);

        runUntilHalt(sim, 5);

        int[] regs = sim.cpu().getRegs();
        assertEquals(5, regs[1]);
        assertEquals(3, regs[2]);
    }

    /**
     * Ensures SW stores a word to memory at base+offset.
     */
    @Test
    void swStoresWordToMemory() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, 20
                addi x2, x0, 0x11223344
                sw x2, 0(x1)
                """);

        runUntilHalt(sim, 5);

        assertEquals(0x11223344, sim.cpu().getMemory().loadWord(20));
    }

    /**
     * Ensures LW loads a word from memory at base+offset.
     */
    @Test
    void lwLoadsWordFromMemory() {
        Simulator sim = new Simulator();
        sim.cpu().getMemory().storeWord(16, 0xdeadbeef);
        sim.assemble("""
                addi x1, x0, 12
                lw x2, 4(x1)
                """);

        runUntilHalt(sim, 5);

        assertEquals(0xdeadbeef, sim.cpu().getRegs()[2]);
    }

    /**
     * Ensures BEQ branches when operands are equal.
     */
    @Test
    void beqTakesBranchOnEquality() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, 7
                addi x2, x0, 7
                beq x1, x2, target
                addi x3, x0, 1
            target:
                addi x3, x0, 9
                """);

        runUntilHalt(sim, 10);

        assertEquals(9, sim.cpu().getRegs()[3]);
    }

    /**
     * Ensures BNE branches when operands differ.
     */
    @Test
    void bneTakesBranchWhenNotEqual() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, 5
                addi x2, x0, 3
                bne x1, x2, target
                addi x3, x0, 1
            target:
                addi x3, x0, 2
                """);

        runUntilHalt(sim, 10);

        assertEquals(2, sim.cpu().getRegs()[3]);
    }

    /**
     * Ensures BLT performs signed comparison (negative is less than positive).
     */
    @Test
    void bltUsesSignedComparison() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, -1
                addi x2, x0, 1
                blt x1, x2, target
                addi x3, x0, 11
            target:
                addi x3, x0, 22
                """);

        runUntilHalt(sim, 10);

        assertEquals(22, sim.cpu().getRegs()[3]);
    }

    /**
     * Ensures BGE performs signed comparison and takes the branch when greater-or-equal.
     */
    @Test
    void bgeBranchesOnSignedGreaterOrEqual() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, 4
                addi x2, x0, 4
                bge x1, x2, target
                addi x3, x0, 1
            target:
                addi x3, x0, 9
                """);

        runUntilHalt(sim, 10);

        assertEquals(9, sim.cpu().getRegs()[3]);
    }

    /**
     * Ensures BLTU uses unsigned comparison so 0xffffffff is greater than 1.
     */
    @Test
    void bltuComparesUnsignedAndFallsThroughWhenLarger() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, -1        # 0xffffffff unsigned
                addi x2, x0, 1
                addi x3, x0, 0
                bltu x1, x2, taken
                addi x3, x0, 55
                beq x0, x0, done
            taken:
                addi x3, x0, 77
            done:
                """);

        runUntilHalt(sim, 15);

        assertEquals(55, sim.cpu().getRegs()[3]);
    }

    /**
     * Ensures BGEU uses unsigned comparison and branches when the unsigned value is greater.
     */
    @Test
    void bgeuComparesUnsignedAndTakesBranchWhenLarger() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, -1        # 0xffffffff unsigned
                addi x2, x0, 1
                addi x3, x0, 0
                bgeu x1, x2, taken
                addi x3, x0, 55
                beq x0, x0, done
            taken:
                addi x3, x0, 77
            done:
                """);

        runUntilHalt(sim, 15);

        assertEquals(77, sim.cpu().getRegs()[3]);
    }
}

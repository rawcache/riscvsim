package riscvsim;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import org.junit.jupiter.api.Test;

/**
 * Core execution semantics for the supported RV32 subset and pseudos.
 */
final class CoreExecutionTest {

    /**
     * Steps until the simulator reports halted or the budget is exceeded.
     *
     * @param sim the simulator instance to execute
     * @param maxSteps the maximum number of steps to execute
     * @return the result of the last step executed
     */
    private static StepResult runUntilHalt(Simulator sim, int maxSteps) {
        StepResult r;
        for (int i = 0; i < maxSteps; i++) {
            r = sim.step();
            if (r.isHalted()) {
                return r;
            }
        }
        throw new IllegalStateException("Program did not halt within " + maxSteps + " steps");
    }

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
        assertEquals(-1, regs[1]);
        assertEquals(1, regs[2]);
        assertEquals(123, regs[3]);
        assertEquals(24, sim.cpu().getPc());
    }

    @Test
    void symAllowsBranchingToAbsoluteAddresses() {
        Simulator sim = new Simulator();
        sim.assemble("""
                #sym far = 16
                addi x1, x0, 1
                bne x1, x0, far
                addi x2, x0, 9
                """);

        StepResult r = runUntilHalt(sim, 10);
        assertTrue(r.isHalted());
        assertEquals(1, sim.cpu().getRegs()[1]);
        assertEquals(Simulator.MEM_SIZE - 4, sim.cpu().getRegs()[2]);
        assertEquals(16, sim.cpu().getPc());
    }

    @Test
    void addiImmediatesWorkWithZeroAndRegisterBases() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x5, x0, 42
                addi x6, x5, -2
                """);

        runUntilHalt(sim, 5);

        int[] regs = sim.cpu().getRegs();
        assertEquals(42, regs[5]);
        assertEquals(40, regs[6]);
    }

    @Test
    void lwAndSwRoundTripLittleEndian() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, 20
                addi x2, x0, 0x11223344
                sw x2, 0(x1)
                lw x3, 0(x1)
                """);

        runUntilHalt(sim, 10);
        int[] regs = sim.cpu().getRegs();
        assertEquals(0x11223344, regs[3]);
    }

    @Test
    void lwLoadsFromMemory() {
        Simulator sim = new Simulator();
        sim.cpu().getMemory().storeWord(16, 0xdeadbeef);
        sim.assemble("""
                addi x1, x0, 12
                lw x2, 4(x1)
                """);

        runUntilHalt(sim, 5);
        assertEquals(0xdeadbeef, sim.cpu().getRegs()[2]);
    }

    @Test
    void branchFamiliesBehave() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, 7
                addi x2, x0, 7
                beq x1, x2, t1
                addi x3, x0, 1
            t1:
                addi x3, x0, 9
                addi x4, x0, 5
                addi x5, x0, 3
                bne x4, x5, t2
                addi x6, x0, 99
            t2:
                addi x6, x0, 77
                addi x7, x0, -1
                addi x8, x0, 1
                bltu x7, x8, t3
                addi x9, x0, 55
            t3:
                bgeu x7, x8, t4
                addi x10, x0, 1
            t4:
                addi x10, x0, 2
                """);

        runUntilHalt(sim, 40);
        int[] regs = sim.cpu().getRegs();
        assertEquals(9, regs[3]);
        assertEquals(77, regs[6]);
        assertEquals(55, regs[9]);
        assertEquals(2, regs[10]);
    }

    @Test
    void luiWritesUpper20BitsAndZeroesLowerBits() {
        Simulator sim = new Simulator();
        sim.assemble("lui x5, 0x12345");

        StepResult r = sim.step();
        assertNull(r.getTrap());
        assertEquals(0x12345000, sim.cpu().getRegs()[5]);
        assertEquals(4, sim.cpu().getPc());
    }

    @Test
    void jalrWritesReturnAddressAndClearsBitZero() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, 11      # rs1 = 11 (odd)
                addi x9, x0, 0       # filler so there is an instruction at pc=4
                jalr x2, 1(x1)       # target = (11+1)&~1 = 12
                addi x3, x0, 0xdead  # executes at pc=12 after jalr
                """);

        sim.step(); // addi base
        sim.step(); // filler
        StepResult jalr = sim.step();
        assertNull(jalr.getTrap());
        assertEquals(12, sim.cpu().getRegs()[2]); // pc0=8 -> ra=12
        assertEquals(12, sim.cpu().getPc());

        StepResult after = sim.step();
        assertNull(after.getTrap());
        assertEquals(0xdead, sim.cpu().getRegs()[3]);
    }

    @Test
    void pseudosLiMvJRetExpandCorrectly() {
        Simulator sim = new Simulator();
        sim.assemble("""
            // comment line
            start:
              li   a0, -0x10     # negative hex immediate
              mv   a1, a0
              j    done
              addi a2, x0, 99    # skipped
            done:
              nop
              ret
            """);

        for (int i = 0; i < 8; i++) {
            sim.step();
        }
        int[] regs = sim.cpu().getRegs();
        assertEquals(-0x10, regs[10], "li should load negative hex immediate into a0");
        assertEquals(regs[10], regs[11], "mv should copy a0 into a1");
    }

    @Test
    void x0IsForcedToZero() {
        Simulator sim = new Simulator();
        sim.assemble("addi x0, x0, 123");

        StepResult r = sim.step();
        assertNull(r.getTrap());
        assertEquals(0, sim.cpu().getRegs()[0]);
    }
}

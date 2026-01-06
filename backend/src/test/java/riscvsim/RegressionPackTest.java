package riscvsim;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

/**
 * Regression pack covering core semantics, traps, and assembler robustness.
 */
class RegressionPackTest {

    @Test
    void luiWritesUpper20BitsAndZeroesLowerBits() {
        Simulator sim = new Simulator();
        sim.assemble("""
                lui x5, 0x12345
                """);

        StepResult r = sim.step(); // execute only LUI
        assertNull(r.getTrap());
        assertEquals(0x12345000, sim.cpu().getRegs()[5]);
        assertEquals(4, sim.cpu().getPc());
    }

    @Test
    void jalAndJalrWriteReturnAddressAndClearBitZero() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, 11      // rs1 = 11 (odd)
                addi x9, x0, 0       // filler so there is an instruction at pc=4
                jalr x2, 1(x1)       // target = (11+1)&~1 = 12
                addi x3, x0, 0xdead  // should execute at pc=12 after jalr
                """);

        sim.step(); // addi base
        sim.step(); // filler
        StepResult s2 = sim.step(); // jalr
        assertNull(s2.getTrap());
        assertEquals(12, sim.cpu().getRegs()[2], "rd should get pc+4 from jalr (pc0=8 -> 12)");
        assertEquals(12, sim.cpu().getPc(), "jalr target clears bit 0 and jumps to aligned pc");

        StepResult s3 = sim.step(); // addi at pc=12
        assertNull(s3.getTrap());
        assertEquals(0xdead, sim.cpu().getRegs()[3]);
    }

    @Test
    void swAndLwAreLittleEndianAndBoundsChecked() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, 0x100     // base
                addi x2, x0, 0x11223344
                sw x2, 0(x1)
                lw x3, 0(x1)
                """);

        sim.step(); // addi base
        sim.step(); // addi value
        StepResult sw = sim.step();
        assertNull(sw.getTrap());
        StepResult lw = sim.step();
        assertNull(lw.getTrap());

        assertEquals(0x11223344, sim.cpu().getRegs()[3], "load/store should round-trip little-endian word");

        // Bounds check: attempt to load past end
        Simulator sim2 = new Simulator();
        int base = Simulator.MEM_SIZE - 8;
        sim2.assemble("""
                addi x1, x0, %d
                lw x2, 12(x1)   # address = mem_size + 4 (aligned) -> OOB
                """.formatted(base));
        sim2.step(); // addi
        StepResult trap = sim2.step(); // lw
        assertNotNull(trap.getTrap());
        assertEquals(TrapCode.TRAP_OOB_MEMORY, trap.getTrap().getCode());
    }

    @Test
    void unalignedAccessTrapsWithBadAlignment() {
        Simulator sim = new Simulator();
        sim.assemble("""
                addi x1, x0, 1
                sw x0, 0(x1)
                """);

        sim.step(); // addi
        StepResult r = sim.step(); // sw traps
        assertNotNull(r.getTrap());
        assertEquals(TrapCode.TRAP_BAD_ALIGNMENT, r.getTrap().getCode());
    }

    @Test
    void x0IsForcedToZeroAfterWrites() {
        Simulator sim = new Simulator();
        sim.assemble("addi x0, x0, 123");

        StepResult r = sim.step();
        assertNull(r.getTrap());
        assertEquals(0, sim.cpu().getRegs()[0], "x0 must remain hard-wired to zero");
    }

    @Test
    void assemblerParsesLabelsCommentsAndPseudos() {
        Simulator sim = new Simulator();
        sim.assemble("""
            // comment line
            start: li a0, -0x10     # negative hex immediate
            mv a1, a0               // pseudo mv
            j done                  // pseudo j
            done: nop               # should be reachable
            """);

        // step through the short program
        sim.step(); // li expands to lui/addi or addi
        sim.step(); // (possible addi part of li)
        sim.step(); // mv
        sim.step(); // j -> sets pc to done
        sim.step(); // nop at done

        int[] regs = sim.cpu().getRegs();
        assertEquals(-0x10, regs[10], "li should load negative hex immediate into a0");
        assertEquals(regs[10], regs[11], "mv should copy a0 into a1");
    }

}

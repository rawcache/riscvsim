package riscvsim;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Produces a C-like explanation of a RISC-V program.
 *
 * <p>
 * This class performs lightweight symbolic tracking to reconstruct
 * higher-level semantics such as constant propagation, pointer loads,
 * and simple control flow.
 * </p>
 *
 * <p>
 * The output is intended for human understanding and visualization,
 * not for recompilation.
 * </p>
 */
public final class CLikeExplainer {

    /** ABI register names indexed by register number. */
    private static final String[] ABI = {
        "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2",
        "s0/fp", "s1",
        "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7",
        "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9",
        "s10", "s11",
        "t3", "t4", "t5", "t6"
    };

    /** Utility class. */
    private CLikeExplainer() {
    }

    /**
     * Converts a register index to its ABI name.
     *
     * @param index register number
     * @return ABI name or xN fallback
     */
    private static String regName(int index) {
        if (index >= 0 && index < ABI.length) {
            return ABI[index];
        }
        return "x" + index;
    }

    /**
     * Formats a 32-bit value as unsigned hexadecimal.
     *
     * @param value integer value
     * @return hexadecimal string
     */
    private static String hex32(int value) {
        long u = value & 0xffffffffL;
        return String.format("0x%08x", u);
    }

    /**
     * Builds a reverse symbol lookup table.
     *
     * @param program program containing symbols
     * @return address to symbol name map
     */
    private static Map<Integer, String> invertSymbols(Program program) {
        Map<Integer, String> inv = new HashMap<>();
        for (Map.Entry<String, Integer> e : program.getSymbols().entrySet()) {
            inv.put(e.getValue(), e.getKey());
        }
        return inv;
    }

    /**
     * Groups labels by program counter.
     *
     * @param program program containing labels
     * @return PC to label list map
     */
    private static Map<Integer, List<String>> labelsByPc(Program program) {
        Map<Integer, List<String>> m = new HashMap<>();
        for (Map.Entry<String, Integer> e : program.getLabels().entrySet()) {
            m.computeIfAbsent(e.getValue(), k -> new ArrayList<>())
                .add(e.getKey());
        }
        return m;
    }

    /**
     * Formats an address using symbols if available.
     *
     * @param inv reverse symbol map
     * @param addr address value
     * @return formatted address
     */
    private static String formatAddress(Map<Integer, String> inv, int addr) {
        String s = inv.get(addr);
        return (s != null) ? s : hex32(addr);
    }

    /**
     * Formats a branch target label.
     *
     * @param labelMap PC to label map
     * @param pc program counter
     * @return label name or hexadecimal PC
     */
    private static String formatLabel(Map<Integer, List<String>> labelMap, int pc) {
        List<String> names = labelMap.get(pc);
        if (names != null && !names.isEmpty()) {
            return names.get(0);
        }
        return hex32(pc);
    }

    /**
     * Explains a program using a C-like representation.
     *
     * @param program parsed program to explain
     * @return multi-line C-like explanation
     */
    public static String explain(Program program) {
        Map<Integer, String> inv = invertSymbols(program);
        Map<Integer, List<String>> labelMap = labelsByPc(program);

        Map<Integer, Integer> regConst = new HashMap<>();
        Map<Integer, Integer> regPtrFromVar = new HashMap<>();

        List<String> lines = new ArrayList<>();
        List<Instruction> insts = program.getInstructions();

        for (int i = 0; i < insts.size(); i++) {
            Instruction ins = insts.get(i);
            int pc = i * 4;

            addLabels(labelMap.get(pc), lines);
            emitInstruction(lines, ins, inv, labelMap, regConst, regPtrFromVar);
        }

        return String.join("\n", lines);
    }

    /**
     * Appends any labels present at the current PC to the output lines.
     *
     * @param labelsHere labels associated with the current PC
     * @param lines accumulated output lines
     */
    private static void addLabels(List<String> labelsHere, List<String> lines) {
        if (labelsHere == null) {
            return;
        }
        for (String name : labelsHere) {
            lines.add(name + ":");
        }
    }

    /**
     * Emits C-like text for the given instruction and updates simple tracking maps.
     *
     * @param lines output accumulator
     * @param ins instruction to explain
     * @param inv reverse symbol map for addresses
     * @param labelMap labels grouped by PC
     * @param regConst known constant registers
     * @param regPtrFromVar registers known to point at variables
     */
    private static void emitInstruction(
            List<String> lines,
            Instruction ins,
            Map<Integer, String> inv,
            Map<Integer, List<String>> labelMap,
            Map<Integer, Integer> regConst,
            Map<Integer, Integer> regPtrFromVar) {

        switch (ins.getOp()) {
        case ADDI -> handleAddi(lines, ins, regConst, regPtrFromVar);
        case LW -> handleLw(lines, ins, inv, regConst, regPtrFromVar);
        case SW -> handleSw(lines, ins, inv, regConst, regPtrFromVar);
        case BEQ -> handleBeq(lines, ins, labelMap);
        case BNE -> handleBranch(lines, ins, labelMap, "!=", null);
        case BLT -> handleBranch(lines, ins, labelMap, "<", null);
        case BGE -> handleBranch(lines, ins, labelMap, ">=", null);
        case BLTU -> handleBranch(lines, ins, labelMap, "<", "uint32_t");
        case BGEU -> handleBranch(lines, ins, labelMap, ">=", "uint32_t");
        default -> throw new IllegalStateException("Unhandled op: " + ins.getOp());
        }
    }

    /**
     * Handles ADDI, including constant propagation shortcuts.
     *
     * @param lines output accumulator
     * @param ins instruction to explain
     * @param regConst known constant registers
     * @param regPtrFromVar registers known to point at variables
     */
    private static void handleAddi(
            List<String> lines,
            Instruction ins,
            Map<Integer, Integer> regConst,
            Map<Integer, Integer> regPtrFromVar) {
        if (ins.getRs1() == 0) {
            regConst.put(ins.getRd(), ins.getImm());
            lines.add(regName(ins.getRd()) + " = " + ins.getImm() + ";");
            return;
        }
        regConst.remove(ins.getRd());
        regPtrFromVar.remove(ins.getRd());
        lines.add(
            regName(ins.getRd()) + " = "
            + regName(ins.getRs1()) + " + "
            + ins.getImm() + ";"
        );
    }

    /**
     * Handles LW, emitting pointers when the base is a known constant.
     *
     * @param lines output accumulator
     * @param ins instruction to explain
     * @param inv reverse symbol map
     * @param regConst known constant registers
     * @param regPtrFromVar registers known to point at variables
     */
    private static void handleLw(
            List<String> lines,
            Instruction ins,
            Map<Integer, String> inv,
            Map<Integer, Integer> regConst,
            Map<Integer, Integer> regPtrFromVar) {
        Integer baseConst = regConst.get(ins.getRs1());
        regConst.remove(ins.getRd());

        if (baseConst != null && ins.getImm() == 0) {
            lines.add(
                regName(ins.getRd()) + " = *(int32_t*)"
                + formatAddress(inv, baseConst) + ";"
            );
            regPtrFromVar.put(ins.getRd(), baseConst);
            return;
        }

        regPtrFromVar.remove(ins.getRd());
        lines.add(
            regName(ins.getRd()) + " = *(int32_t*)("
            + regName(ins.getRs1()) + " + "
            + ins.getImm() + ");"
        );
    }

    /**
     * Handles SW, including cases where the address or value are known constants.
     *
     * @param lines output accumulator
     * @param ins instruction to explain
     * @param inv reverse symbol map
     * @param regConst known constant registers
     * @param regPtrFromVar registers known to point at variables
     */
    private static void handleSw(
            List<String> lines,
            Instruction ins,
            Map<Integer, String> inv,
            Map<Integer, Integer> regConst,
            Map<Integer, Integer> regPtrFromVar) {
        Integer baseConst = regConst.get(ins.getRs1());
        Integer valConst = regConst.get(ins.getRs2());

        Integer ptrVarAddr = regPtrFromVar.get(ins.getRs1());
        if (ptrVarAddr != null && ins.getImm() == 0) {
            String rhs = (valConst != null)
                    ? String.valueOf(valConst)
                    : regName(ins.getRs2());
            lines.add("*" + formatAddress(inv, ptrVarAddr) + " = " + rhs + ";");
            return;
        }

        if (baseConst != null && ins.getImm() == 0) {
            String baseName = formatAddress(inv, baseConst);
            String rhs = (valConst != null)
                    ? "(int32_t)" + formatAddress(inv, valConst)
                    : regName(ins.getRs2());
            lines.add("*(int32_t*)" + baseName + " = " + rhs + ";");
            return;
        }

        lines.add(
            "*(int32_t*)("
            + regName(ins.getRs1()) + " + "
            + ins.getImm() + ") = "
            + regName(ins.getRs2()) + ";"
        );
    }

    /**
     * Handles BEQ, including the unconditional jump shortcut when comparing the same register.
     *
     * @param lines output accumulator
     * @param ins instruction to explain
     * @param labelMap labels grouped by PC
     */
    private static void handleBeq(
            List<String> lines,
            Instruction ins,
            Map<Integer, List<String>> labelMap) {
        String target = formatLabel(labelMap, ins.getTargetPC());
        if (ins.getRs1() == ins.getRs2()) {
            lines.add("goto " + target + ";");
            return;
        }
        lines.add(
            "if (" + regName(ins.getRs1())
            + " == " + regName(ins.getRs2())
            + ") goto " + target + ";"
        );
    }

    /**
     * Handles generic branch emission with optional casting for unsigned comparisons.
     *
     * @param lines output accumulator
     * @param ins instruction to explain
     * @param labelMap labels grouped by PC
     * @param op comparison operator string
     * @param cast optional cast type (e.g., {@code uint32_t}) or {@code null}
     */
    private static void handleBranch(
            List<String> lines,
            Instruction ins,
            Map<Integer, List<String>> labelMap,
            String op,
            String cast) {
        String target = formatLabel(labelMap, ins.getTargetPC());
        String lhs = cast == null ? regName(ins.getRs1()) : "(" + cast + ")" + regName(ins.getRs1());
        String rhs = cast == null ? regName(ins.getRs2()) : "(" + cast + ")" + regName(ins.getRs2());
        lines.add("if (" + lhs + " " + op + " " + rhs + ") goto " + target + ";");
    }
}

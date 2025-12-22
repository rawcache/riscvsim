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

            List<String> labelsHere = labelMap.get(pc);
            if (labelsHere != null) {
                for (String name : labelsHere) {
                    lines.add(name + ":");
                }
            }

            switch (ins.getOp()) {
            case ADDI -> {
                if (ins.getRs1() == 0) {
                    regConst.put(ins.getRd(), ins.getImm());
                    lines.add(regName(ins.getRd()) + " = " + ins.getImm() + ";");
                } else {
                    regConst.remove(ins.getRd());
                    regPtrFromVar.remove(ins.getRd());
                    lines.add(
                        regName(ins.getRd()) + " = "
                        + regName(ins.getRs1()) + " + "
                        + ins.getImm() + ";"
                    );
                }
            }

            case LW -> {
                Integer baseConst = regConst.get(ins.getRs1());
                regConst.remove(ins.getRd());

                if (baseConst != null && ins.getImm() == 0) {
                    lines.add(
                        regName(ins.getRd()) + " = *(int32_t*)"
                        + formatAddress(inv, baseConst) + ";"
                    );
                    regPtrFromVar.put(ins.getRd(), baseConst);
                } else {
                    regPtrFromVar.remove(ins.getRd());
                    lines.add(
                        regName(ins.getRd()) + " = *(int32_t*)("
                        + regName(ins.getRs1()) + " + "
                        + ins.getImm() + ");"
                    );
                }
            }

            case SW -> {
                Integer baseConst = regConst.get(ins.getRs1());
                Integer valConst = regConst.get(ins.getRs2());

                Integer ptrVarAddr = regPtrFromVar.get(ins.getRs1());
                if (ptrVarAddr != null && ins.getImm() == 0) {
                    String rhs = (valConst != null)
                            ? String.valueOf(valConst)
                            : regName(ins.getRs2());
                    lines.add("*" + formatAddress(inv, ptrVarAddr) + " = " + rhs + ";");
                    break;
                }

                if (baseConst != null && ins.getImm() == 0) {
                    String baseName = formatAddress(inv, baseConst);
                    String rhs = (valConst != null)
                            ? "(int32_t)" + formatAddress(inv, valConst)
                            : regName(ins.getRs2());
                    lines.add("*(int32_t*)" + baseName + " = " + rhs + ";");
                    break;
                }

                lines.add(
                    "*(int32_t*)("
                    + regName(ins.getRs1()) + " + "
                    + ins.getImm() + ") = "
                    + regName(ins.getRs2()) + ";"
                );
            }

            case BEQ -> {
                String target = formatLabel(labelMap, ins.getTargetPC());
                if (ins.getRs1() == ins.getRs2()) {
                    lines.add("goto " + target + ";");
                } else {
                    lines.add(
                        "if (" + regName(ins.getRs1())
                        + " == " + regName(ins.getRs2())
                        + ") goto " + target + ";"
                    );
                }
            }

            default -> throw new IllegalStateException(
                        "Unhandled op: " + ins.getOp());
            }
        }

        return String.join("\n", lines);
    }
}

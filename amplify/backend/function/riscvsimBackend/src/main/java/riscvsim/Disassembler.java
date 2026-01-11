package riscvsim;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Generates a basic disassembly listing from a parsed program.
 */
public final class Disassembler {

    private Disassembler() {
        // utility
    }

    /**
     * Returns disassembly lines with labels and instruction text.
     *
     * @param program parsed program
     * @return list of disassembly lines
     */
    public static List<DisasmLine> disassemble(Program program) {
        List<DisasmLine> lines = new ArrayList<>();
        Map<Integer, List<String>> labelsByPc = labelsByPc(program);
        List<Instruction> insts = program.getInstructions();

        for (int i = 0; i < insts.size(); i++) {
            int pc = i * 4;
            List<String> labelsHere = labelsByPc.get(pc);
            if (labelsHere != null) {
                for (String label : labelsHere) {
                    lines.add(new DisasmLine(pc, label + ":", true));
                }
            }
            lines.add(new DisasmLine(pc, formatInst(insts.get(i), pc, labelsByPc), false));
        }
        return lines;
    }

    private static Map<Integer, List<String>> labelsByPc(Program program) {
        Map<Integer, List<String>> out = new LinkedHashMap<>();
        for (Map.Entry<String, Integer> entry : program.getLabels().entrySet()) {
            out.computeIfAbsent(entry.getValue(), k -> new ArrayList<>()).add(entry.getKey());
        }
        return out;
    }

    private static String formatInst(Instruction ins, int pc, Map<Integer, List<String>> labelsByPc) {
        String op = ins.getOp().name().toLowerCase();
        switch (ins.getOp()) {
        case ADDI:
            return formatPc(pc) + op + " x" + ins.getRd() + ", x" + ins.getRs1() + ", " + ins.getImm();
        case LW:
            return formatPc(pc) + op + " x" + ins.getRd() + ", " + ins.getImm() + "(x" + ins.getRs1() + ")";
        case SW:
            return formatPc(pc) + op + " x" + ins.getRs2() + ", " + ins.getImm() + "(x" + ins.getRs1() + ")";
        case BEQ:
            return formatPc(pc) + op + " x" + ins.getRs1() + ", x" + ins.getRs2() + ", "
                    + formatTarget(labelsByPc, ins.getTargetPC());
        case BNE:
            return formatPc(pc) + op + " x" + ins.getRs1() + ", x" + ins.getRs2() + ", "
                    + formatTarget(labelsByPc, ins.getTargetPC());
        case BLT:
            return formatPc(pc) + op + " x" + ins.getRs1() + ", x" + ins.getRs2() + ", "
                    + formatTarget(labelsByPc, ins.getTargetPC());
        case BGE:
            return formatPc(pc) + op + " x" + ins.getRs1() + ", x" + ins.getRs2() + ", "
                    + formatTarget(labelsByPc, ins.getTargetPC());
        case BLTU:
            return formatPc(pc) + op + " x" + ins.getRs1() + ", x" + ins.getRs2() + ", "
                    + formatTarget(labelsByPc, ins.getTargetPC());
        case BGEU:
            return formatPc(pc) + op + " x" + ins.getRs1() + ", x" + ins.getRs2() + ", "
                    + formatTarget(labelsByPc, ins.getTargetPC());
        default:
            throw new IllegalStateException("Unhandled op: " + ins.getOp());
        }
    }

    private static String formatTarget(Map<Integer, List<String>> labelsByPc, int pc) {
        List<String> labels = labelsByPc.get(pc);
        if (labels != null && !labels.isEmpty()) {
            return labels.get(0);
        }
        return String.format("0x%08x", pc);
    }

    private static String formatPc(int pc) {
        return String.format("0x%08x: ", pc);
    }
}

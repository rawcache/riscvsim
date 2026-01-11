package riscvsim;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Generates a basic disassembly listing from a parsed program.
 */
public final class Disassembler {

    /**
     * Utility constructor.
     */
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

    /**
     * Creates a mapping of program counters to their associated labels.
     *
     * @param program the parsed program containing labels and instructions
     * @return a map where keys are program counters and values are lists of labels
     */
    private static Map<Integer, List<String>> labelsByPc(Program program) {
        Map<Integer, List<String>> out = new LinkedHashMap<>();
        for (Map.Entry<String, Integer> entry : program.getLabels().entrySet()) {
            out.computeIfAbsent(entry.getValue(), k -> new ArrayList<>()).add(entry.getKey());
        }
        return out;
    }

    /**
     * Formats a single instruction into a disassembly line.
     *
     * @param ins instruction to format
     * @param pc program counter for the instruction
     * @param labelsByPc label lookup table
     * @return formatted disassembly string
     */
    private static String formatInst(Instruction ins, int pc, Map<Integer, List<String>> labelsByPc) {
        String op = ins.getOp().name().toLowerCase();
        return switch (ins.getOp()) {
        case ADDI -> formatPc(pc) + op + " x" + ins.getRd() + ", x" + ins.getRs1() + ", " + ins.getImm();
        case LUI -> formatPc(pc) + op + " x" + ins.getRd() + ", " + ins.getImm();
        case LW -> formatPc(pc) + op + " x" + ins.getRd() + ", " + ins.getImm() + "(x" + ins.getRs1() + ")";
        case SW -> formatPc(pc) + op + " x" + ins.getRs2() + ", " + ins.getImm() + "(x" + ins.getRs1() + ")";
        case JAL -> formatPc(pc) + op + " x" + ins.getRd() + ", " + formatTarget(labelsByPc, ins.getTargetPC());
        case JALR -> formatPc(pc) + op + " x" + ins.getRd() + ", " + ins.getImm() + "(x" + ins.getRs1() + ")";
        case BEQ -> formatPc(pc) + op + " x" + ins.getRs1() + ", x" + ins.getRs2() + ", "
                + formatTarget(labelsByPc, ins.getTargetPC());
        case BNE -> formatPc(pc) + op + " x" + ins.getRs1() + ", x" + ins.getRs2() + ", "
                + formatTarget(labelsByPc, ins.getTargetPC());
        case BLT -> formatPc(pc) + op + " x" + ins.getRs1() + ", x" + ins.getRs2() + ", "
                + formatTarget(labelsByPc, ins.getTargetPC());
        case BGE -> formatPc(pc) + op + " x" + ins.getRs1() + ", x" + ins.getRs2() + ", "
                + formatTarget(labelsByPc, ins.getTargetPC());
        case BLTU -> formatPc(pc) + op + " x" + ins.getRs1() + ", x" + ins.getRs2() + ", "
                + formatTarget(labelsByPc, ins.getTargetPC());
        case BGEU -> formatPc(pc) + op + " x" + ins.getRs1() + ", x" + ins.getRs2() + ", "
                + formatTarget(labelsByPc, ins.getTargetPC());
        default -> throw new IllegalStateException("Unhandled op: " + ins.getOp());
        };
    }

    /**
     * Resolves a target PC to a label name when available.
     *
     * @param labelsByPc label lookup table
     * @param pc target program counter
     * @return label name or hex address
     */
    private static String formatTarget(Map<Integer, List<String>> labelsByPc, int pc) {
        List<String> labels = labelsByPc.get(pc);
        if (labels != null && !labels.isEmpty()) {
            return labels.get(0);
        }
        return String.format("0x%08x", pc);
    }

    /**
     * Formats a PC prefix for a disassembly line.
     *
     * @param pc program counter
     * @return formatted prefix string
     */
    private static String formatPc(int pc) {
        return String.format("0x%08x: ", pc);
    }
}

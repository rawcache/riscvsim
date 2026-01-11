package riscvsim;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Produces a C program that semantically mirrors execution of a small RV32 subset.
 *
 * <p>
 * This is not a decompiler. It emits a low-level, step-by-step C "switch(pc)" that
 * matches the simulator's behavior, mainly for debugging and understanding control flow.
 * </p>
 */
public final class Rv2CMapper {

    /**
     * Utility class.
     */
    private Rv2CMapper() {
        // Utility class
    }

    /**
     * Formats a signed 32-bit integer as an unsigned hex literal.
     *
     * @param n signed 32-bit value
     * @return hex string like 0x1234abcd
     */
    private static String hex(int n) {
        long u = n & 0xffffffffL;
        return "0x" + Long.toHexString(u);
    }

    /**
     * Builds a map from program counter to label names.
     *
     * @param program input program
     * @return map pc -> list of labels at that pc
     */
    private static Map<Integer, List<String>> labelsByPc(Program program) {
        Map<Integer, List<String>> map = new HashMap<>();
        for (Map.Entry<String, Integer> e : program.getLabels().entrySet()) {
            map.computeIfAbsent(e.getValue(), k -> new ArrayList<>()).add(e.getKey());
        }
        return map;
    }

    /**
     * Returns the first label name for a pc, if any.
     *
     * @param labelMap map pc -> labels
     * @param pc program counter
     * @return first label name or null
     */
    private static String firstLabel(Map<Integer, List<String>> labelMap, int pc) {
        List<String> v = labelMap.get(pc);
        return (v == null || v.isEmpty()) ? null : v.get(0);
    }

    /**
     * Emits C lines that model a JAL instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param labelMap map from pc to labels for human-readable comments
     * @param inst JAL instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void jal(List<String> lines, Map<Integer, List<String>> labelMap,
            Instruction inst, int pcVal) {
        String targetLabel = firstLabel(labelMap, inst.getTargetPC());
        String targetComment = " // goto " + (targetLabel != null ? targetLabel : hex(inst.getTargetPC()));
        if (inst.getRd() != 0) {
            lines.add("        x[" + inst.getRd() + "] = " + (pcVal + 4) + ";");
        }
        lines.add("        pc = " + inst.getTargetPC() + ";" + targetComment);
    }

    /**
     * Emits C lines that model a JALR instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst JALR instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void jalr(List<String> lines, Instruction inst, int pcVal) {
        if (inst.getRd() != 0) {
            lines.add("        x[" + inst.getRd() + "] = " + (pcVal + 4) + ";");
        }
        lines.add("        pc = (uint32_t)((x[" + inst.getRs1() + "] + " + inst.getImm() + ") & ~1);");
    }

    /**
     * Emits C lines that model a BEQ instruction.
     *
     * @param lines    accumulator for generated C source lines
     * @param labelMap map from pc to labels for human-readable comments
     * @param inst     BEQ instruction being translated
     * @param pcVal    byte-addressed pc value for this instruction
     */
    private static void beq(List<String> lines, Map<Integer, List<String>> labelMap,
            Instruction inst, int pcVal) {
        String targetLabel = firstLabel(labelMap, inst.getTargetPC());
        String targetComment = " // goto " + (targetLabel != null ? targetLabel : hex(inst.getTargetPC()));
        lines.add("        if (x[" + inst.getRs1() + "] == x[" + inst.getRs2() + "]) {");
        lines.add("          pc = " + inst.getTargetPC() + ";" + targetComment);
        lines.add("        } else {");
        lines.add("          pc = " + (pcVal + 4) + ";");
        lines.add("        }");
    }

    /**
     * Emits C lines that model a BNE instruction.
     *
     * @param lines    accumulator for generated C source lines
     * @param labelMap map from pc to labels for human-readable comments
     * @param inst     BNE instruction being translated
     * @param pcVal    byte-addressed pc value for this instruction
     */
    private static void bne(List<String> lines, Map<Integer, List<String>> labelMap,
            Instruction inst, int pcVal) {
        String targetLabel = firstLabel(labelMap, inst.getTargetPC());
        String targetComment = " // goto " + (targetLabel != null ? targetLabel : hex(inst.getTargetPC()));
        lines.add("        if (x[" + inst.getRs1() + "] != x[" + inst.getRs2() + "]) {");
        lines.add("          pc = " + inst.getTargetPC() + ";" + targetComment);
        lines.add("        } else {");
        lines.add("          pc = " + (pcVal + 4) + ";");
        lines.add("        }");
    }


    /**
     * Emits C lines that model a BLT instruction.
     *
     * @param lines    accumulator for generated C source lines
     * @param labelMap map from pc to labels for human-readable comments
     * @param inst     BLT instruction being translated
     * @param pcVal    byte-addressed pc value for this instruction
     */
    private static void blt(List<String> lines, Map<Integer, List<String>> labelMap,
            Instruction inst, int pcVal) {
        String targetLabel = firstLabel(labelMap, inst.getTargetPC());
        String targetComment = " // goto " + (targetLabel != null ? targetLabel : hex(inst.getTargetPC()));
        lines.add("        if (x[" + inst.getRs1() + "] < x[" + inst.getRs2() + "]) {");
        lines.add("          pc = " + inst.getTargetPC() + ";" + targetComment);
        lines.add("        } else {");
        lines.add("          pc = " + (pcVal + 4) + ";");
        lines.add("        }");
    }

    /**
     * Emits C lines that model a BGE instruction.
     *
     * @param lines    accumulator for generated C source lines
     * @param labelMap map from pc to labels for human-readable comments
     * @param inst     BGE instruction being translated
     * @param pcVal    byte-addressed pc value for this instruction
     */
    private static void bge(List<String> lines, Map<Integer, List<String>> labelMap,
        Instruction inst, int pcVal) {
        String targetLabel = firstLabel(labelMap, inst.getTargetPC());
        String targetComment = " // goto " + (targetLabel != null ? targetLabel : hex(inst.getTargetPC()));
        lines.add("        if (x[" + inst.getRs1() + "] >= x[" + inst.getRs2() + "]) {");
        lines.add("          pc = " + inst.getTargetPC() + ";" + targetComment);
        lines.add("        } else {");
        lines.add("          pc = " + (pcVal + 4) + ";");
        lines.add("        }");
    }

    /**
     * Emits C lines that model a BLTU instruction.
     *
     * @param lines    accumulator for generated C source lines
     * @param labelMap map from pc to labels for human-readable comments
     * @param inst     BLTU instruction being translated
     * @param pcVal    byte-addressed pc value for this instruction
     */
    private static void bltu(List<String> lines, Map<Integer, List<String>> labelMap,
        Instruction inst, int pcVal) {
        String targetLabel = firstLabel(labelMap, inst.getTargetPC());
        String targetComment = " // goto " + (targetLabel != null ? targetLabel : hex(inst.getTargetPC()));
        lines.add("        uint32_t a = (uint32_t)x[" + inst.getRs1() + "];");
        lines.add("        uint32_t b = (uint32_t)x[" + inst.getRs2() + "];");
        lines.add("        if (a < b) {");
        lines.add("          pc = " + inst.getTargetPC() + ";" + targetComment);
        lines.add("        } else {");
        lines.add("          pc = " + (pcVal + 4) + ";");
        lines.add("        }");
    }

    /**
     * Emits C lines that model a BGEU instruction.
     *
     * @param lines    accumulator for generated C source lines
     * @param labelMap map from pc to labels for human-readable comments
     * @param inst     BGEU instruction being translated
     * @param pcVal    byte-addressed pc value for this instruction
     */
    private static void bgeu(List<String> lines, Map<Integer, List<String>> labelMap,
        Instruction inst, int pcVal) {
        String targetLabel = firstLabel(labelMap, inst.getTargetPC());
        String targetComment = " // goto " + (targetLabel != null ? targetLabel : hex(inst.getTargetPC()));
        lines.add("        uint32_t a = (uint32_t)x[" + inst.getRs1() + "];");
        lines.add("        uint32_t b = (uint32_t)x[" + inst.getRs2() + "];");
        lines.add("        if (a >= b) {");
        lines.add("          pc = " + inst.getTargetPC() + ";" + targetComment);
        lines.add("        } else {");
        lines.add("          pc = " + (pcVal + 4) + ";");
        lines.add("        }");
    }

    /**
     * Generates a C program that simulates the given program by switching on pc.
     *
     * @param program parsed program
     * @param memSize simulated memory size (bytes)
     * @return C source code as a string
     */
    public static String map(Program program, int memSize) {
        List<String> lines = new ArrayList<>();
        Map<Integer, List<String>> labelMap = labelsByPc(program);

        lines.add("#include <stdint.h>");
        lines.add("#include <string.h>");
        lines.add("");
        lines.add("// Auto-generated \"C mapping\" of a small RV32 subset.");
        lines.add("// This is not high-level decompilation. It is a semantic translation.");
        lines.add("");
        lines.add("static inline int32_t load32(uint8_t *mem, uint32_t addr) {");
        lines.add("  int32_t v;");
        lines.add("  memcpy(&v, mem + addr, 4);");
        lines.add("  return v;");
        lines.add("}");
        lines.add("");
        lines.add("static inline void store32(uint8_t *mem, uint32_t addr, int32_t v) {");
        lines.add("  memcpy(mem + addr, &v, 4);");
        lines.add("}");
        lines.add("");
        lines.add("int main(void) {");
        lines.add("  static uint8_t mem[" + memSize + "];");
        lines.add("  static int32_t x[32];");
        lines.add("  uint32_t pc = 0;");
        lines.add("");
        lines.add("  // Initialize SP near top of memory (like our simulator)");
        lines.add("  x[2] = " + (memSize - 4) + ";");
        lines.add("");
        lines.add("  // Step-by-step execution modeled as a PC switch");
        lines.add("  while (1) {");
        lines.add("    x[0] = 0;");
        lines.add("    switch (pc) {");

        List<Instruction> insts = program.getInstructions();
        List<String> srcLines = program.getSourceLines();

        for (int i = 0; i < insts.size(); i++) {
            Instruction inst = insts.get(i);
            int pcVal = i * 4;

            String asm = "";
            int srcLine = inst.getSrcLine();
            if (srcLine >= 0 && srcLine < srcLines.size()) {
                asm = srcLines.get(srcLine);
            }

            lines.add("      case " + pcVal + ": {");

            List<String> labelHere = labelMap.get(pcVal);
            if (labelHere != null && !labelHere.isEmpty()) {
                lines.add("        // label: " + String.join(", ", labelHere));
            }

            if (!asm.isBlank()) {
                lines.add("        // " + asm.trim());
            }

            Instruction.Op op = inst.getOp();
            switch (op) {
            case ADDI -> {
                lines.add("        x[" + inst.getRd() + "] = (int32_t)(x[" + inst.getRs1()
                        + "] + " + inst.getImm() + ");");
                lines.add("        pc = " + (pcVal + 4) + ";");
            }
            case LW -> {
                lines.add("        x[" + inst.getRd() + "] = load32(mem, (uint32_t)(x["
                        + inst.getRs1() + "] + " + inst.getImm() + "));");
                lines.add("        pc = " + (pcVal + 4) + ";");
            }
            case SW -> {
                lines.add("        store32(mem, (uint32_t)(x[" + inst.getRs1() + "] + "
                        + inst.getImm() + "), x[" + inst.getRs2() + "]);");
                lines.add("        pc = " + (pcVal + 4) + ";");
            }
            case JAL -> jal(lines, labelMap, inst, pcVal);
            case JALR -> jalr(lines, inst, pcVal);
            case BEQ -> beq(lines, labelMap, inst, pcVal);
            case BNE -> bne(lines, labelMap, inst, pcVal);
            case BLT -> blt(lines, labelMap, inst, pcVal);
            case BGE -> bge(lines, labelMap, inst, pcVal);
            case BLTU -> bltu(lines, labelMap, inst, pcVal);
            case BGEU -> bgeu(lines, labelMap, inst, pcVal);

            default -> {
                lines.add("        // unsupported op");
                lines.add("        return 0;");
            }
            }

            lines.add("        break;");
            lines.add("      }");
        }

        lines.add("      default:");
        lines.add("        return 0;");
        lines.add("    }");
        lines.add("  }");
        lines.add("}");
        lines.add("");

        return String.join("\n", lines);
    }
}

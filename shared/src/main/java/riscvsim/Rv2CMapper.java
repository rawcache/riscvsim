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
     * Emits C lines that model an ADDI instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst ADDI instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void addi(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (int32_t)(x[" + inst.getRs1()
                + "] + " + inst.getImm() + ");");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a LUI instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst LUI instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void lui(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (int32_t)(" + inst.getImm() + " << 12);");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model an AUIPC instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst AUIPC instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void auipc(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (int32_t)(pc + (" + inst.getImm() + " << 12));");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model an ADD instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst ADD instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void add(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (int32_t)(x[" + inst.getRs1()
                + "] + x[" + inst.getRs2() + "]);");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a SUB instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst SUB instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void sub(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (int32_t)(x[" + inst.getRs1()
                + "] - x[" + inst.getRs2() + "]);");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model an SLT instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst SLT instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void slt(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (x[" + inst.getRs1()
                + "] < x[" + inst.getRs2() + "]) ? 1 : 0;");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model an SLTU instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst SLTU instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void sltu(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = ((uint32_t)x[" + inst.getRs1()
                + "] < (uint32_t)x[" + inst.getRs2() + "]) ? 1 : 0;");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model an SLTI instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst SLTI instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void slti(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (x[" + inst.getRs1()
                + "] < " + inst.getImm() + ") ? 1 : 0;");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model an SLTIU instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst SLTIU instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void sltiu(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = ((uint32_t)x[" + inst.getRs1()
                + "] < (uint32_t)" + inst.getImm() + ") ? 1 : 0;");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a MUL instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst MUL instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void mul(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (int32_t)((int64_t)x[" + inst.getRs1()
                + "] * (int64_t)x[" + inst.getRs2() + "]);");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a MULH instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst MULH instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void mulh(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (int32_t)(((int64_t)x[" + inst.getRs1()
                + "] * (int64_t)x[" + inst.getRs2() + "]) >> 32);");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a MULHSU instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst MULHSU instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void mulhsu(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (int32_t)(((int64_t)x[" + inst.getRs1()
                + "] * (uint64_t)(uint32_t)x[" + inst.getRs2() + "]) >> 32);");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a MULHU instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst MULHU instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void mulhu(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (int32_t)(((uint64_t)(uint32_t)x[" + inst.getRs1()
                + "] * (uint64_t)(uint32_t)x[" + inst.getRs2() + "]) >> 32);");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a DIV instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst DIV instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void div(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        if (x[" + inst.getRs2() + "] == 0) {");
        lines.add("          x[" + inst.getRd() + "] = -1;");
        lines.add("        } else if (x[" + inst.getRs1() + "] == (int32_t)0x80000000"
                + " && x[" + inst.getRs2() + "] == -1) {");
        lines.add("          x[" + inst.getRd() + "] = (int32_t)0x80000000;");
        lines.add("        } else {");
        lines.add("          x[" + inst.getRd() + "] = x[" + inst.getRs1() + "] / x[" + inst.getRs2() + "];");
        lines.add("        }");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a DIVU instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst DIVU instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void divu(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        if ((uint32_t)x[" + inst.getRs2() + "] == 0) {");
        lines.add("          x[" + inst.getRd() + "] = -1;");
        lines.add("        } else {");
        lines.add("          x[" + inst.getRd() + "] = (uint32_t)x[" + inst.getRs1()
                + "] / (uint32_t)x[" + inst.getRs2() + "];");
        lines.add("        }");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a REM instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst REM instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void rem(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        if (x[" + inst.getRs2() + "] == 0) {");
        lines.add("          x[" + inst.getRd() + "] = x[" + inst.getRs1() + "];");
        lines.add("        } else if (x[" + inst.getRs1() + "] == (int32_t)0x80000000"
                + " && x[" + inst.getRs2() + "] == -1) {");
        lines.add("          x[" + inst.getRd() + "] = 0;");
        lines.add("        } else {");
        lines.add("          x[" + inst.getRd() + "] = x[" + inst.getRs1() + "] % x[" + inst.getRs2() + "];");
        lines.add("        }");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a REMU instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst REMU instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void remu(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        if ((uint32_t)x[" + inst.getRs2() + "] == 0) {");
        lines.add("          x[" + inst.getRd() + "] = x[" + inst.getRs1() + "];");
        lines.add("        } else {");
        lines.add("          x[" + inst.getRd() + "] = (uint32_t)x[" + inst.getRs1()
                + "] % (uint32_t)x[" + inst.getRs2() + "];");
        lines.add("        }");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a SLLI instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void slli(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (int32_t)(x[" + inst.getRs1() + "] << ("
                + inst.getImm() + " & 31));");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a SRLI instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void srli(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (int32_t)((uint32_t)x[" + inst.getRs1()
                + "] >> (" + inst.getImm() + " & 31));");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a SRAI instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void srai(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (int32_t)(x[" + inst.getRs1() + "] >> ("
                + inst.getImm() + " & 31));");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a SLL instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void sll(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (int32_t)(x[" + inst.getRs1()
                + "] << (x[" + inst.getRs2() + "] & 31));");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a SRL instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void srl(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (int32_t)((uint32_t)x[" + inst.getRs1()
                + "] >> (x[" + inst.getRs2() + "] & 31));");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a SRA instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void sra(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = (int32_t)(x[" + inst.getRs1()
                + "] >> (x[" + inst.getRs2() + "] & 31));");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model an AND instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void andOp(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = x[" + inst.getRs1() + "] & x[" + inst.getRs2() + "];");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model an OR instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void orOp(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = x[" + inst.getRs1() + "] | x[" + inst.getRs2() + "];");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a XOR instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void xorOp(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = x[" + inst.getRs1() + "] ^ x[" + inst.getRs2() + "];");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model an ANDI instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void andi(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = x[" + inst.getRs1() + "] & " + inst.getImm() + ";");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model an ORI instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void ori(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = x[" + inst.getRs1() + "] | " + inst.getImm() + ";");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a XORI instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void xori(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = x[" + inst.getRs1() + "] ^ " + inst.getImm() + ";");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model an LB/LBU instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst load-byte instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     * @param signed true for LB, false for LBU
     */
    private static void lb(List<String> lines, Instruction inst, int pcVal, boolean signed) {
        String cast = signed ? "(int8_t)" : "(uint8_t)";
        lines.add("        x[" + inst.getRd() + "] = " + cast + "load8(mem, (uint32_t)(x["
                + inst.getRs1() + "] + " + inst.getImm() + "));");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model an LH/LHU instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst load-halfword instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     * @param signed true for LH, false for LHU
     */
    private static void lh(List<String> lines, Instruction inst, int pcVal, boolean signed) {
        String cast = signed ? "(int16_t)" : "(uint16_t)";
        lines.add("        x[" + inst.getRd() + "] = " + cast + "load16(mem, (uint32_t)(x["
                + inst.getRs1() + "] + " + inst.getImm() + "));");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a LW instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst LW instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void lw(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        x[" + inst.getRd() + "] = load32(mem, (uint32_t)(x["
                + inst.getRs1() + "] + " + inst.getImm() + "));");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a SB instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst SB instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void sb(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        store8(mem, (uint32_t)(x[" + inst.getRs1() + "] + "
                + inst.getImm() + "), (uint8_t)x[" + inst.getRs2() + "]);");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a SH instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst SH instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void sh(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        store16(mem, (uint32_t)(x[" + inst.getRs1() + "] + "
                + inst.getImm() + "), (uint16_t)x[" + inst.getRs2() + "]);");
        lines.add("        pc = " + (pcVal + 4) + ";");
    }

    /**
     * Emits C lines that model a SW instruction.
     *
     * @param lines accumulator for generated C source lines
     * @param inst SW instruction being translated
     * @param pcVal byte-addressed pc value for this instruction
     */
    private static void sw(List<String> lines, Instruction inst, int pcVal) {
        lines.add("        store32(mem, (uint32_t)(x[" + inst.getRs1() + "] + "
                + inst.getImm() + "), x[" + inst.getRs2() + "]);");
        lines.add("        pc = " + (pcVal + 4) + ";");
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
        lines.add("static inline uint8_t load8(uint8_t *mem, uint32_t addr) {");
        lines.add("  return mem[addr];");
        lines.add("}");
        lines.add("");
        lines.add("static inline uint16_t load16(uint8_t *mem, uint32_t addr) {");
        lines.add("  uint16_t v;");
        lines.add("  memcpy(&v, mem + addr, 2);");
        lines.add("  return v;");
        lines.add("}");
        lines.add("");
        lines.add("static inline void store32(uint8_t *mem, uint32_t addr, int32_t v) {");
        lines.add("  memcpy(mem + addr, &v, 4);");
        lines.add("}");
        lines.add("");
        lines.add("static inline void store8(uint8_t *mem, uint32_t addr, uint8_t v) {");
        lines.add("  mem[addr] = v;");
        lines.add("}");
        lines.add("");
        lines.add("static inline void store16(uint8_t *mem, uint32_t addr, uint16_t v) {");
        lines.add("  memcpy(mem + addr, &v, 2);");
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
            case ADDI -> addi(lines, inst, pcVal);
            case LUI -> lui(lines, inst, pcVal);
            case AUIPC -> auipc(lines, inst, pcVal);
            case ADD -> add(lines, inst, pcVal);
            case SUB -> sub(lines, inst, pcVal);
            case SLT -> slt(lines, inst, pcVal);
            case SLTU -> sltu(lines, inst, pcVal);
            case SLTI -> slti(lines, inst, pcVal);
            case SLTIU -> sltiu(lines, inst, pcVal);
            case MUL -> mul(lines, inst, pcVal);
            case MULH -> mulh(lines, inst, pcVal);
            case MULHSU -> mulhsu(lines, inst, pcVal);
            case MULHU -> mulhu(lines, inst, pcVal);
            case DIV -> div(lines, inst, pcVal);
            case DIVU -> divu(lines, inst, pcVal);
            case REM -> rem(lines, inst, pcVal);
            case REMU -> remu(lines, inst, pcVal);
            case SLLI -> slli(lines, inst, pcVal);
            case SRLI -> srli(lines, inst, pcVal);
            case SRAI -> srai(lines, inst, pcVal);
            case SLL -> sll(lines, inst, pcVal);
            case SRL -> srl(lines, inst, pcVal);
            case SRA -> sra(lines, inst, pcVal);
            case AND -> andOp(lines, inst, pcVal);
            case OR -> orOp(lines, inst, pcVal);
            case XOR -> xorOp(lines, inst, pcVal);
            case ANDI -> andi(lines, inst, pcVal);
            case ORI -> ori(lines, inst, pcVal);
            case XORI -> xori(lines, inst, pcVal);
            case LB -> lb(lines, inst, pcVal, true);
            case LBU -> lb(lines, inst, pcVal, false);
            case LH -> lh(lines, inst, pcVal, true);
            case LHU -> lh(lines, inst, pcVal, false);
            case LW -> lw(lines, inst, pcVal);
            case SB -> sb(lines, inst, pcVal);
            case SH -> sh(lines, inst, pcVal);
            case SW -> sw(lines, inst, pcVal);
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

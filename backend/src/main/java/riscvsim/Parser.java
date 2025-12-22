package riscvsim;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class Parser {

    private static final Map<String, Integer> REG_ALIASES = Map.ofEntries(
        Map.entry("zero", 0), Map.entry("ra", 1), Map.entry("sp", 2), Map.entry("gp", 3), Map.entry("tp", 4),
        Map.entry("t0", 5), Map.entry("t1", 6), Map.entry("t2", 7),
        Map.entry("s0", 8), Map.entry("fp", 8), Map.entry("s1", 9),
        Map.entry("a0", 10), Map.entry("a1", 11), Map.entry("a2", 12), Map.entry("a3", 13),
        Map.entry("a4", 14), Map.entry("a5", 15), Map.entry("a6", 16), Map.entry("a7", 17),
        Map.entry("s2", 18), Map.entry("s3", 19), Map.entry("s4", 20), Map.entry("s5", 21),
        Map.entry("s6", 22), Map.entry("s7", 23), Map.entry("s8", 24), Map.entry("s9", 25),
        Map.entry("s10", 26), Map.entry("s11", 27),
        Map.entry("t3", 28), Map.entry("t4", 29), Map.entry("t5", 30), Map.entry("t6", 31)
    );

    /**
     * Parses a register token, accepting both xN and ABI aliases.
     *
     * @param tok register token such as {@code x5} or {@code a0}
     * @return register index 0-31
     */
    private static int parseReg(String tok) {
        String t = tok.trim().toLowerCase();
        if (t.startsWith("x")) {
            int n = Integer.parseInt(t.substring(1));
            if (n >= 0 && n <= 31) {
                return n;
            }
        }
        Integer ali = REG_ALIASES.get(t);
        if (ali != null) {
            return ali;
        }
        throw new RuntimeException("Bad register: " + tok);
    }

    /**
     * Parses an immediate value from decimal or hex text.
     *
     * @param tok numeric token
     * @return parsed integer value
     */
    private static int parseImm(String tok) {
        String t = tok.trim().toLowerCase();
        int v = t.startsWith("0x") ? (int) Long.parseLong(t.substring(2), 16) : Integer.parseInt(t, 10);
        return v;
    }

    /**
     * Removes trailing comments (starting with '#') and trims whitespace.
     *
     * @param line source line
     * @return line without comment text
     */
    private static String stripComment(String line) {
        int i = line.indexOf('#');
        String s = (i >= 0) ? line.substring(0, i) : line;
        return s.trim();
    }

    private static final Pattern OFF_BASE = Pattern.compile("^(-?(?:0x[0-9a-fA-F]+|\\d+))\\(([^)]+)\\)$");

    /**
     * Parses an offset(base) expression like {@code 8(x1)}.
     *
     * @param expr    memory operand text
     * @param srcLine zero-based source line index for error reporting
     * @return parsed offset/base pair
     */
    private static OffsetBase parseOffsetBase(String expr, int srcLine) {
        Matcher m = OFF_BASE.matcher(expr.trim());
        if (!m.matches()) {
            throw new RuntimeException("Bad mem operand on line " + (srcLine + 1) + ": " + expr);
        }
        int imm = parseImm(m.group(1));
        int rs1 = parseReg(m.group(2));
        return new OffsetBase(imm, rs1);
    }

    /**
     * Parses assembly source into a {@link Program} with instructions, labels, and symbols.
     *
     * @param src full assembly source text
     * @return parsed program
     */
    public static Program parseProgram(String src) {
        List<String> sourceLines = Arrays.asList(src.split("\\R", -1));
        List<Instruction> instructions = new ArrayList<>();
        Map<String, Integer> symbols = new LinkedHashMap<>();
        Map<String, Integer> labels = new LinkedHashMap<>();
        List<Pending> pending = new ArrayList<>();

        int pc = 0;

        for (int i = 0; i < sourceLines.size(); i++) {
            String raw = sourceLines.get(i);
            String rawTrim = raw.trim();

            // #sym name=1000 OR #sym name 1000
            if (rawTrim.startsWith("#sym")) {
                String rest = rawTrim.substring(4).trim();
                Matcher m1 = Pattern.compile("^([A-Za-z_]\\w*)\\s*=\\s*(0x[0-9a-fA-F]+|\\d+)$").matcher(rest);
                Matcher m2 = Pattern.compile("^([A-Za-z_]\\w*)\\s+(0x[0-9a-fA-F]+|\\d+)$").matcher(rest);
                Matcher m = m1.matches() ? m1 : (m2.matches() ? m2 : null);
                if (m == null) {
                    throw new RuntimeException("Bad #sym format on line " + (i + 1));
                }
                String name = m.group(1);
                String val = m.group(2);
                int addr = val.toLowerCase().startsWith("0x") ? (int) Long.parseLong(val.substring(2), 16)
                    : Integer.parseInt(val, 10);
                symbols.put(name, addr);
                continue;
            }

            String line = stripComment(raw);
            if (line.isEmpty()) {
                continue;
            }

            String rest = line;

            // allow multiple labels on same line: label1: label2: addi ...
            while (true) {
                Matcher lm = Pattern.compile("^([A-Za-z_]\\w*):\\s*(.*)$").matcher(rest);
                if (!lm.matches()) { 
                    break;
                }
                String label = lm.group(1);
                String after = lm.group(2);
                if (labels.containsKey(label)) {
                    throw new RuntimeException("Duplicate label \"" + label + "\" on line " + (i + 1));
                }
                labels.put(label, pc);
                rest = after;
            }

            if (rest.trim().isEmpty()) {
                continue;
            }

            pending.add(new Pending(rest.trim(), i));
            pc += 4;
        }

        // helper to resolve beq target
        java.util.function.BiFunction<String, Integer, Integer> parseTargetPC = (tok, srcLine) -> {
            if (labels.containsKey(tok)) {
                return labels.get(tok);
            }
            if (symbols.containsKey(tok)) {
                return symbols.get(tok);
            }
            if (tok.matches("^[A-Za-z_]\\w*$")) {
                throw new RuntimeException("Unknown label \"" + tok + "\" on line " + (srcLine + 1));
            }
            int pcVal = parseImm(tok);
            if ((pcVal & 3) != 0) {
                throw new RuntimeException("Branch target must be word-aligned on line " + (srcLine + 1));
            }
            return pcVal;
        };

        for (Pending p : pending) {
            String[] tokens = p.line.replace(",", " ").trim().replaceAll("\\s+", " ").split(" ");
            String op = tokens[0].toLowerCase();

            if (op.equals("addi")) {
                if (tokens.length != 4) {
                    throw new RuntimeException("Bad addi on line " + (p.srcLine + 1));
                }
                instructions.add(Instruction.addi(
                    parseReg(tokens[1]), parseReg(tokens[2]), parseImm(tokens[3]), p.srcLine));
                continue;
            }

            if (op.equals("lw")) {
                if (tokens.length != 3) {
                    throw new RuntimeException("Bad lw on line " + (p.srcLine + 1));
                }
                OffsetBase ob = parseOffsetBase(tokens[2], p.srcLine);
                instructions.add(Instruction.lw(parseReg(tokens[1]), ob.rs1(), ob.imm(), p.srcLine));
                continue;
            }

            if (op.equals("sw")) {
                if (tokens.length != 3) {
                    throw new RuntimeException("Bad sw on line " + (p.srcLine + 1));
                }
                OffsetBase ob = parseOffsetBase(tokens[2], p.srcLine);
                instructions.add(Instruction.sw(parseReg(tokens[1]), ob.rs1(), ob.imm(), p.srcLine));
                continue;
            }

            if (op.equals("beq")) {
                if (tokens.length != 4) {
                    throw new RuntimeException("Bad beq on line " + (p.srcLine + 1));
                }
                int rs1 = parseReg(tokens[1]);
                int rs2 = parseReg(tokens[2]);
                int target = parseTargetPC.apply(tokens[3], p.srcLine);
                instructions.add(Instruction.beq(rs1, rs2, target, p.srcLine));
                continue;
            }

            throw new RuntimeException("Unsupported instruction \"" + op + "\" on line " + (p.srcLine + 1));
        }

        return new Program(instructions, sourceLines, symbols, labels);
    }

    private record OffsetBase(int imm, int rs1) { }

    private record Pending(String line, int srcLine) { }
}

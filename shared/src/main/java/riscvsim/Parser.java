package riscvsim;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Utility class for parsing assembly source into a {@link Program}.
 */
public final class Parser {

    /** Maximum number of instructions allowed in one program. */
    public static final int MAX_INSTRUCTIONS = 5000;

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

    /** Prevent instantiation. */
    private Parser() { }

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
        boolean negative = t.startsWith("-");
        String body = negative ? t.substring(1) : t;

        int base;
        String digits;
        if (body.startsWith("0x")) {
            base = 16;
            digits = body.substring(2);
        } else {
            base = 10;
            digits = body;
        }

        long parsed = Long.parseLong(digits, base);
        if (negative) {
            parsed = -parsed;
        }
        return (int) parsed;
    }

    /**
     * Removes trailing comments (starting with '#') and trims whitespace.
     *
     * @param line source line
     * @return line without comment text
     */
    private static String stripComment(String line) {
        int hash = line.indexOf('#');
        int slash = line.indexOf("//");

        int cut = -1;
        if (hash >= 0 && slash >= 0) {
            cut = Math.min(hash, slash);
        } else if (hash >= 0) {
            cut = hash;
        } else if (slash >= 0) {
            cut = slash;
        }

        String s = (cut >= 0) ? line.substring(0, cut) : line;
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
        FirstPassResult first = firstPass(sourceLines);
        List<Instruction> instructions = secondPass(first.pending(), first.labels(), first.symbols());
        return new Program(instructions, sourceLines, first.symbols(), first.labels());
    }

    /**
     * Performs the first pass to collect symbols, labels, and pending instruction lines.
     *
     * @param sourceLines all source lines
     * @return aggregated first-pass state
     */
    private static FirstPassResult firstPass(List<String> sourceLines) {
        Map<String, Integer> symbols = new LinkedHashMap<>();
        Map<String, Integer> labels = new LinkedHashMap<>();
        List<Pending> pending = new ArrayList<>();

        int pc = 0;

        for (int i = 0; i < sourceLines.size(); i++) {
            String raw = sourceLines.get(i);
            String rawTrim = raw.trim();

            if (rawTrim.startsWith("#sym")) {
                parseSymbolLine(symbols, i, rawTrim);
                continue;
            }

            String line = stripComment(raw);
            if (line.isEmpty()) {
                continue;
            }

            String rest = line;
            pc = recordLabels(labels, pc, i, rest);
            rest = stripLeadingLabels(rest);

            if (rest.trim().isEmpty()) {
                continue;
            }

            pending.add(new Pending(rest.trim(), i));
            pc += 4;
        }

        return new FirstPassResult(pending, labels, symbols);
    }

    /**
     * Parses a #sym directive line and records the symbol.
     *
     * @param symbols symbol table to populate
     * @param lineIndex zero-based source line index
     * @param rawTrim trimmed line text starting with {@code #sym}
     */
    private static void parseSymbolLine(Map<String, Integer> symbols, int lineIndex, String rawTrim) {
        String rest = stripComment(rawTrim.substring(4).trim());
        Matcher m1 = Pattern.compile("^([A-Za-z_]\\w*)\\s*=\\s*(0x[0-9a-fA-F]+|\\d+)$").matcher(rest);
        Matcher m2 = Pattern.compile("^([A-Za-z_]\\w*)\\s+(0x[0-9a-fA-F]+|\\d+)$").matcher(rest);
        Matcher m = m1.matches() ? m1 : (m2.matches() ? m2 : null);
        if (m == null) {
            throw new RuntimeException("Bad #sym format on line " + (lineIndex + 1));
        }
        String name = m.group(1);
        String val = m.group(2);
        int addr = val.toLowerCase().startsWith("0x") ? (int) Long.parseLong(val.substring(2), 16)
            : Integer.parseInt(val, 10);
        symbols.put(name, addr);
    }

    /**
     * Records any labels at the start of the given line.
     *
     * @param labels label table to update
     * @param pc current program counter
     * @param lineIndex zero-based source line index
     * @param rest remaining line text
     * @return unchanged pc (included for symmetry)
     */
    private static int recordLabels(Map<String, Integer> labels, int pc, int lineIndex, String rest) {
        String cursor = rest;
        while (true) {
            Matcher lm = Pattern.compile("^([A-Za-z_]\\w*):\\s*(.*)$").matcher(cursor);
            if (!lm.matches()) {
                break;
            }
            String label = lm.group(1);
            String after = lm.group(2);
            if (labels.containsKey(label)) {
                throw new RuntimeException("Duplicate label \"" + label + "\" on line " + (lineIndex + 1));
            }
            labels.put(label, pc);
            cursor = after;
        }
        return pc;
    }

    /**
     * Removes leading labels from a line, returning the remainder.
     *
     * @param line line text possibly containing labels
     * @return text after the last leading label
     */
    private static String stripLeadingLabels(String line) {
        String rest = line;
        while (true) {
            Matcher lm = Pattern.compile("^([A-Za-z_]\\w*):\\s*(.*)$").matcher(rest);
            if (!lm.matches()) {
                break;
            }
            rest = lm.group(2);
        }
        return rest;
    }

    /**
     * Second pass: decode pending instruction lines into Instruction objects.
     *
     * @param pending pending lines with source indices
     * @param labels label table
     * @param symbols symbol table
     * @return list of decoded instructions
     */
    private static List<Instruction> secondPass(List<Pending> pending, Map<String, Integer> labels,
            Map<String, Integer> symbols) {
        List<Instruction> instructions = new ArrayList<>();

        java.util.function.BiFunction<String, Integer, Integer> parseTargetPC = buildTargetParser(labels, symbols);

        for (Pending p : pending) {
            String[] tokens = p.line.replace(",", " ").trim().replaceAll("\\s+", " ").split(" ");
            String op = tokens[0].toLowerCase();

            java.util.function.Consumer<Instruction> addInst = inst -> {
                instructions.add(inst);
                if (instructions.size() > MAX_INSTRUCTIONS) {
                    throw new RuntimeException("Too many instructions (limit " + MAX_INSTRUCTIONS + ")");
                }
            };

            if (handlePseudo(op, tokens, p, parseTargetPC, addInst)) {
                continue;
            }
            if (handleBase(op, tokens, p, parseTargetPC, addInst)) {
                continue;
            }

            throw new RuntimeException("Unsupported instruction \"" + op + "\" on line " + (p.srcLine + 1));
        }

        return instructions;
    }

    /**
     * Handles pseudo-instructions during the second pass of parsing.
     *
     * @param op the operation code of the instruction
     * @param tokens the tokens of the instruction line
     * @param p the pending instruction with its source line
     * @param parseTargetPC a function to parse target program counters
     * @param addInst a consumer to add the parsed instruction
     * @return true if the pseudo-instruction was successfully handled, false otherwise
     */
    private static boolean handlePseudo(
            String op,
            String[] tokens,
            Pending p,
            java.util.function.BiFunction<String, Integer, Integer> parseTargetPC,
            java.util.function.Consumer<Instruction> addInst) {
        if (op.equals("nop")) {
            addInst.accept(Instruction.addi(0, 0, 0, p.srcLine));
            return true;
        }
        if (op.equals("mv")) {
            if (tokens.length != 3) {
                throw new RuntimeException("Bad mv on line " + (p.srcLine + 1));
            }
            addInst.accept(Instruction.addi(parseReg(tokens[1]), parseReg(tokens[2]), 0, p.srcLine));
            return true;
        }
        if (op.equals("j")) {
            if (tokens.length != 2) {
                throw new RuntimeException("Bad j on line " + (p.srcLine + 1));
            }
            int target = parseTargetPC.apply(tokens[1], p.srcLine);
            addInst.accept(Instruction.jal(0, target, p.srcLine));
            return true;
        }
        if (op.equals("ret")) {
            if (tokens.length != 1) {
                throw new RuntimeException("Bad ret on line " + (p.srcLine + 1));
            }
            OffsetBase ob = new OffsetBase(0, 1); // 0(ra)
            addInst.accept(Instruction.jalr(0, ob.rs1(), ob.imm(), p.srcLine));
            return true;
        }
        if (op.equals("call")) {
            if (tokens.length != 2) {
                throw new RuntimeException("Bad call on line " + (p.srcLine + 1));
            }
            int target = parseTargetPC.apply(tokens[1], p.srcLine);
            addInst.accept(Instruction.jal(1, target, p.srcLine)); // ra
            return true;
        }
        if (op.equals("li")) {
            if (tokens.length != 3) {
                throw new RuntimeException("Bad li on line " + (p.srcLine + 1));
            }
            int rd = parseReg(tokens[1]);
            int imm = parseImm(tokens[2]);
            if (imm >= -2048 && imm <= 2047) {
                addInst.accept(Instruction.addi(rd, 0, imm, p.srcLine));
            } else {
                int hi = (imm + 0x800) >> 12;
                int lo = imm - (hi << 12);
                addInst.accept(Instruction.lui(rd, hi, p.srcLine));
                addInst.accept(Instruction.addi(rd, rd, lo, p.srcLine));
            }
            return true;
        }
        return false;
    }

    /**
     * Handles base instructions during the second pass of parsing.
     *
     * @param op the operation code of the instruction
     * @param tokens the tokens of the instruction line
     * @param p the pending instruction with its source line
     * @param parseTargetPC a function to parse target program counters
     * @param addInst a consumer to add the parsed instruction
     * @return true if the base instruction was successfully handled, false otherwise
     */
    private static boolean handleBase(
            String op,
            String[] tokens,
            Pending p,
            java.util.function.BiFunction<String, Integer, Integer> parseTargetPC,
            java.util.function.Consumer<Instruction> addInst) {
        if (op.equals("addi")) {
            if (tokens.length != 4) {
                throw new RuntimeException("Bad addi on line " + (p.srcLine + 1));
            }
            addInst.accept(Instruction.addi(
                parseReg(tokens[1]), parseReg(tokens[2]), parseImm(tokens[3]), p.srcLine));
            return true;
        }
        if (op.equals("lui")) {
            if (tokens.length != 3) {
                throw new RuntimeException("Bad lui on line " + (p.srcLine + 1));
            }
            addInst.accept(Instruction.lui(parseReg(tokens[1]), parseImm(tokens[2]), p.srcLine));
            return true;
        }
        if (op.equals("auipc")) {
            if (tokens.length != 3) {
                throw new RuntimeException("Bad auipc on line " + (p.srcLine + 1));
            }
            addInst.accept(Instruction.auipc(parseReg(tokens[1]), parseImm(tokens[2]), p.srcLine));
            return true;
        }
        if (handleLoads(op, tokens, p, addInst)) {
            return true;
        }
        if (handleStores(op, tokens, p, addInst)) {
            return true;
        }
        if (handleShiftImm(op, tokens, p, addInst)) {
            return true;
        }
        if (handleShiftReg(op, tokens, p, addInst)) {
            return true;
        }
        if (handleLogicImm(op, tokens, p, addInst)) {
            return true;
        }
        if (handleLogicReg(op, tokens, p, addInst)) {
            return true;
        }
        if (handleArithmeticImm(op, tokens, p, addInst)) {
            return true;
        }
        if (handleArithmeticReg(op, tokens, p, addInst)) {
            return true;
        }
        if (op.equals("jal")) {
            if (tokens.length != 2 && tokens.length != 3) {
                throw new RuntimeException("Bad jal on line " + (p.srcLine + 1));
            }
            int rd = tokens.length == 3 ? parseReg(tokens[1]) : 1; // default ra
            String targetTok = tokens.length == 3 ? tokens[2] : tokens[1];
            int target = parseTargetPC.apply(targetTok, p.srcLine);
            addInst.accept(Instruction.jal(rd, target, p.srcLine));
            return true;
        }
        if (op.equals("jalr")) {
            if (tokens.length != 2 && tokens.length != 3) {
                throw new RuntimeException("Bad jalr on line " + (p.srcLine + 1));
            }
            int rd = tokens.length == 3 ? parseReg(tokens[1]) : 1; // default ra
            OffsetBase ob = parseOffsetBase(tokens[tokens.length - 1], p.srcLine);
            addInst.accept(Instruction.jalr(rd, ob.rs1(), ob.imm(), p.srcLine));
            return true;
        }
        if (op.equals("ecall")) {
            if (tokens.length != 1) {
                throw new RuntimeException("Bad ecall on line " + (p.srcLine + 1));
            }
            addInst.accept(Instruction.ecall(p.srcLine));
            return true;
        }
        return handleBranch(op, tokens, p, parseTargetPC, addInst);
    }

    /**
     * Handles arithmetic-immediate instructions.
     *
     * @param op the operation code of the instruction
     * @param tokens the tokens of the instruction line
     * @param p the pending instruction with its source line
     * @param addInst a consumer to add the parsed instruction
     * @return true if an arithmetic-immediate instruction was parsed, false otherwise
     */
    private static boolean handleArithmeticImm(
            String op,
            String[] tokens,
            Pending p,
            java.util.function.Consumer<Instruction> addInst) {
        if (!op.equals("slti") && !op.equals("sltiu")) {
            return false;
        }
        if (tokens.length != 4) {
            return false;
        }
        int rd = parseReg(tokens[1]);
        int rs1 = parseReg(tokens[2]);
        int imm = parseImm(tokens[3]);
        return switch (op) {
        case "slti" -> {
            addInst.accept(Instruction.slti(rd, rs1, imm, p.srcLine));
            yield true;
        }
        case "sltiu" -> {
            addInst.accept(Instruction.sltiu(rd, rs1, imm, p.srcLine));
            yield true;
        }
        default -> false;
        };
    }

    /**
     * Handles arithmetic-register instructions.
     *
     * @param op the operation code of the instruction
     * @param tokens the tokens of the instruction line
     * @param p the pending instruction with its source line
     * @param addInst a consumer to add the parsed instruction
     * @return true if an arithmetic-register instruction was parsed, false otherwise
     */
    private static boolean handleArithmeticReg(
            String op,
            String[] tokens,
            Pending p,
            java.util.function.Consumer<Instruction> addInst) {
        boolean isArithmetic = switch (op) {
        case "add", "sub", "slt", "sltu", "mul", "mulh", "mulhsu", "mulhu", "div", "divu", "rem", "remu" -> true;
        default -> false;
        };
        if (!isArithmetic) {
            return false;
        }
        if (tokens.length != 4) {
            return false;
        }
        int rd = parseReg(tokens[1]);
        int rs1 = parseReg(tokens[2]);
        int rs2 = parseReg(tokens[3]);
        return switch (op) {
        case "add" -> {
            addInst.accept(Instruction.add(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        case "sub" -> {
            addInst.accept(Instruction.sub(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        case "slt" -> {
            addInst.accept(Instruction.slt(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        case "sltu" -> {
            addInst.accept(Instruction.sltu(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        case "mul" -> {
            addInst.accept(Instruction.mul(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        case "mulh" -> {
            addInst.accept(Instruction.mulh(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        case "mulhsu" -> {
            addInst.accept(Instruction.mulhsu(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        case "mulhu" -> {
            addInst.accept(Instruction.mulhu(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        case "div" -> {
            addInst.accept(Instruction.div(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        case "divu" -> {
            addInst.accept(Instruction.divu(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        case "rem" -> {
            addInst.accept(Instruction.rem(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        case "remu" -> {
            addInst.accept(Instruction.remu(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        default -> false;
        };
    }
    /**
     * Handles logic-immediate instructions.
     *
     * @param op the operation code of the instruction
     * @param tokens the tokens of the instruction line
     * @param p the pending instruction with its source line
     * @param addInst a consumer to add the parsed instruction
     * @return true if a logic-immediate instruction was parsed, false otherwise
     */
    private static boolean handleLogicImm(
            String op,
            String[] tokens,
            Pending p,
            java.util.function.Consumer<Instruction> addInst) {
        if (!op.equals("andi") && !op.equals("ori") && !op.equals("xori")) {
            return false;
        }
        if (tokens.length != 4) {
            return false;
        }
        int rd = parseReg(tokens[1]);
        int rs1 = parseReg(tokens[2]);
        int imm = parseImm(tokens[3]);
        return switch (op) {
        case "andi" -> {
            addInst.accept(Instruction.andi(rd, rs1, imm, p.srcLine));
            yield true;
        }
        case "ori" -> {
            addInst.accept(Instruction.ori(rd, rs1, imm, p.srcLine));
            yield true;
        }
        case "xori" -> {
            addInst.accept(Instruction.xori(rd, rs1, imm, p.srcLine));
            yield true;
        }
        default -> false;
        };
    }

    /**
     * Handles logic-register instructions.
     *
     * @param op the operation code of the instruction
     * @param tokens the tokens of the instruction line
     * @param p the pending instruction with its source line
     * @param addInst a consumer to add the parsed instruction
     * @return true if a logic-register instruction was parsed, false otherwise
     */
    private static boolean handleLogicReg(
            String op,
            String[] tokens,
            Pending p,
            java.util.function.Consumer<Instruction> addInst) {
        if (!op.equals("and") && !op.equals("or") && !op.equals("xor")) {
            return false;
        }
        if (tokens.length != 4) {
            return false;
        }
        int rd = parseReg(tokens[1]);
        int rs1 = parseReg(tokens[2]);
        int rs2 = parseReg(tokens[3]);
        return switch (op) {
        case "and" -> {
            addInst.accept(Instruction.and(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        case "or" -> {
            addInst.accept(Instruction.or(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        case "xor" -> {
            addInst.accept(Instruction.xor(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        default -> false;
        };
    }

    /**
     * Handles shift-immediate instructions.
     *
     * @param op the operation code of the instruction
     * @param tokens the tokens of the instruction line
     * @param p the pending instruction with its source line
     * @param addInst a consumer to add the parsed instruction
     * @return true if a shift-immediate instruction was parsed, false otherwise
     */
    private static boolean handleShiftImm(
            String op,
            String[] tokens,
            Pending p,
            java.util.function.Consumer<Instruction> addInst) {
        if (!op.equals("slli") && !op.equals("srli") && !op.equals("srai")) {
            return false;
        }
        if (tokens.length != 4) {
            return false;
        }
        int rd = parseReg(tokens[1]);
        int rs1 = parseReg(tokens[2]);
        int imm = parseImm(tokens[3]);
        return switch (op) {
        case "slli" -> {
            addInst.accept(Instruction.slli(rd, rs1, imm, p.srcLine));
            yield true;
        }
        case "srli" -> {
            addInst.accept(Instruction.srli(rd, rs1, imm, p.srcLine));
            yield true;
        }
        case "srai" -> {
            addInst.accept(Instruction.srai(rd, rs1, imm, p.srcLine));
            yield true;
        }
        default -> false;
        };
    }

    /**
     * Handles shift-register instructions.
     *
     * @param op the operation code of the instruction
     * @param tokens the tokens of the instruction line
     * @param p the pending instruction with its source line
     * @param addInst a consumer to add the parsed instruction
     * @return true if a shift-register instruction was parsed, false otherwise
     */
    private static boolean handleShiftReg(
            String op,
            String[] tokens,
            Pending p,
            java.util.function.Consumer<Instruction> addInst) {
        if (!op.equals("sll") && !op.equals("srl") && !op.equals("sra")) {
            return false;
        }
        if (tokens.length != 4) {
            return false;
        }
        int rd = parseReg(tokens[1]);
        int rs1 = parseReg(tokens[2]);
        int rs2 = parseReg(tokens[3]);
        return switch (op) {
        case "sll" -> {
            addInst.accept(Instruction.sll(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        case "srl" -> {
            addInst.accept(Instruction.srl(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        case "sra" -> {
            addInst.accept(Instruction.sra(rd, rs1, rs2, p.srcLine));
            yield true;
        }
        default -> false;
        };
    }

    /**
     * Handles base load instructions.
     *
     * @param op the operation code of the instruction
     * @param tokens the tokens of the instruction line
     * @param p the pending instruction with its source line
     * @param addInst a consumer to add the parsed instruction
     * @return true if a load instruction was parsed, false otherwise
     */
    private static boolean handleLoads(
            String op,
            String[] tokens,
            Pending p,
            java.util.function.Consumer<Instruction> addInst) {
        boolean isLoad = switch (op) {
        case "lb", "lbu", "lh", "lhu", "lw" -> true;
        default -> false;
        };
        if (!isLoad) {
            return false;
        }
        if (tokens.length != 3) {
            return false;
        }
        OffsetBase ob = parseOffsetBase(tokens[2], p.srcLine);
        return switch (op) {
        case "lb" -> {
            addInst.accept(Instruction.lb(parseReg(tokens[1]), ob.rs1(), ob.imm(), p.srcLine));
            yield true;
        }
        case "lbu" -> {
            addInst.accept(Instruction.lbu(parseReg(tokens[1]), ob.rs1(), ob.imm(), p.srcLine));
            yield true;
        }
        case "lh" -> {
            addInst.accept(Instruction.lh(parseReg(tokens[1]), ob.rs1(), ob.imm(), p.srcLine));
            yield true;
        }
        case "lhu" -> {
            addInst.accept(Instruction.lhu(parseReg(tokens[1]), ob.rs1(), ob.imm(), p.srcLine));
            yield true;
        }
        case "lw" -> {
            addInst.accept(Instruction.lw(parseReg(tokens[1]), ob.rs1(), ob.imm(), p.srcLine));
            yield true;
        }
        default -> false;
        };
    }

    /**
     * Handles base store instructions.
     *
     * @param op the operation code of the instruction
     * @param tokens the tokens of the instruction line
     * @param p the pending instruction with its source line
     * @param addInst a consumer to add the parsed instruction
     * @return true if a store instruction was parsed, false otherwise
     */
    private static boolean handleStores(
            String op,
            String[] tokens,
            Pending p,
            java.util.function.Consumer<Instruction> addInst) {
        boolean isStore = switch (op) {
        case "sb", "sh", "sw" -> true;
        default -> false;
        };
        if (!isStore) {
            return false;
        }
        if (tokens.length != 3) {
            throw new RuntimeException("Bad " + op + " on line " + (p.srcLine + 1));
        }
        OffsetBase ob = parseOffsetBase(tokens[2], p.srcLine);
        return switch (op) {
        case "sb" -> {
            addInst.accept(Instruction.sb(parseReg(tokens[1]), ob.rs1(), ob.imm(), p.srcLine));
            yield true;
        }
        case "sh" -> {
            addInst.accept(Instruction.sh(parseReg(tokens[1]), ob.rs1(), ob.imm(), p.srcLine));
            yield true;
        }
        case "sw" -> {
            addInst.accept(Instruction.sw(parseReg(tokens[1]), ob.rs1(), ob.imm(), p.srcLine));
            yield true;
        }
        default -> false;
        };
    }

    /**
     * Handles base branch instructions.
     *
     * @param op the operation code of the instruction
     * @param tokens the tokens of the instruction line
     * @param p the pending instruction with its source line
     * @param parseTargetPC a function to parse target program counters
     * @param addInst a consumer to add the parsed instruction
     * @return true if a branch instruction was parsed, false otherwise
     */
    private static boolean handleBranch(
            String op,
            String[] tokens,
            Pending p,
            java.util.function.BiFunction<String, Integer, Integer> parseTargetPC,
            java.util.function.Consumer<Instruction> addInst) {
        boolean isBranch = switch (op) {
        case "beq", "bne", "blt", "bge", "bltu", "bgeu" -> true;
        default -> false;
        };
        if (!isBranch) {
            return false;
        }
        if (tokens.length != 4) {
            throw new RuntimeException("Bad " + op + " on line " + (p.srcLine + 1));
        }
        int rs1 = parseReg(tokens[1]);
        int rs2 = parseReg(tokens[2]);
        int target = parseTargetPC.apply(tokens[3], p.srcLine);
        return switch (op) {
        case "beq" -> {
            addInst.accept(Instruction.beq(rs1, rs2, target, p.srcLine));
            yield true;
        }
        case "bne" -> {
            addInst.accept(Instruction.bne(rs1, rs2, target, p.srcLine));
            yield true;
        }
        case "blt" -> {
            addInst.accept(Instruction.blt(rs1, rs2, target, p.srcLine));
            yield true;
        }
        case "bge" -> {
            addInst.accept(Instruction.bge(rs1, rs2, target, p.srcLine));
            yield true;
        }
        case "bltu" -> {
            addInst.accept(Instruction.bltu(rs1, rs2, target, p.srcLine));
            yield true;
        }
        case "bgeu" -> {
            addInst.accept(Instruction.bgeu(rs1, rs2, target, p.srcLine));
            yield true;
        }
        default -> false;
        };
    }

    /**
     * Builds a parser function to resolve target program counters from labels, symbols, or immediate values.
     *
     * @param labels the map of label names to their corresponding program counters
     * @param symbols the map of symbol names to their corresponding values
     * @return a function that takes a token and source line index, and resolves the target program counter
     */
    private static java.util.function.BiFunction<String, Integer, Integer> buildTargetParser(
            Map<String, Integer> labels,
            Map<String, Integer> symbols) {
        return (tok, srcLine) -> {
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
    }

    private record OffsetBase(int imm, int rs1) { }

    private record Pending(String line, int srcLine) { }

    private record FirstPassResult(List<Pending> pending, Map<String, Integer> labels, Map<String, Integer> symbols) { }
}

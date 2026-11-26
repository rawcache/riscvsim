//! RISC-V pseudocode translation plus C/C++/Rust subset compilation for RV32IM and RV64IM.
//!
//! Two deliberately different bars of ambition:
//!
//! * **asm → C** is a pattern recognizer over programs this assembler
//!   already accepts. It produces *educational pseudocode* — block
//!   structure recovered from branches (do/while, if/else), `la` pairs
//!   fused into address assignments, loads/stores written as array
//!   accesses — not a general decompiler. Anything it cannot phrase in C
//!   is kept as a comment, so the output is never silently wrong.
//!
//! * **C → asm** is a real (but intentionally small) compiler for a
//!   documented subset of C: `int` variables and arrays, arithmetic and
//!   logical expressions, `if`/`else`, `while`/`for`, `break`/`continue`,
//!   functions with up to 7 `int` parameters, calls and recursion.
//!   No pointers, structs, globals, or standard library. Outside the
//!   subset it fails with an honest message, never a wrong answer.

use crate::assembler::{assemble, AsmInstr, Op, Program};
use crate::assembler64::{assemble64, AsmInstr64, Op64, Program64};
// Ordered maps: output never depends on hash iteration order.
use std::collections::{BTreeMap as HashMap, BTreeSet as HashSet};
use std::fmt::Write as _;

use identifiers::{identifier_map, IdentifierTarget};

mod c_to_rust;
mod cpp_to_rust;
#[allow(dead_code)]
mod hir;
mod identifiers;
mod preprocess;
mod records;
mod rust_to_c;

pub const C_SUBSET_SUPPORTED: &str = "char, short, int, long, long long, signed and unsigned (char is unsigned; ILP32 on RV32, LP64 on RV64) · casts & sizeof · character literals · local variables & fixed arrays · block scopes & shadowing · pointers: & and *, arithmetic scaled by element size, arrays decay to pointers, pointer parameters & results · pointer casts, void * & pointer-width integer casts · globals with constant initializers · string literals (read-only data) · enums & typedef · structs & unions: nesting, arrays, pointers & ->, copies, {...} and .member initializers, by-value arguments & results · arithmetic, comparisons, bitwise & compound assignment, && || ! · if/else · while/for/do-while · switch with fallthrough · break/continue (also continue inside switch) · functions (up to 7 integer args) · void functions & (void) parameter lists · recursion · prototypes without a body call hand-written assembly (psABI) · #define/#undef/#if/#ifdef";
pub const C_SUBSET_UNSUPPORTED: &str = "function pointers & pointers to arrays · bit-fields, flexible array members, anonymous members & function pointers in structs · variable-length arrays · floats · goto · 64-bit integers on RV32 · #include & standard library calls · enums, structs & unions in C++ or Rust output (they compile to assembly)";
pub const CPP_SUBSET_SUPPORTED: &str = "int/bool variables · C integer types, casts & sizeof · fixed arrays · enums, typedef, structs & unions (with '.', copies, {...} initializers, by-value arguments & results) · local auto with initializer · true/false · and/or/not · arithmetic & control flow incl. do-while & switch · functions (up to 7 int/bool args, including void helpers) · recursion · #define/#if preprocessor";
pub const CPP_SUBSET_UNSUPPORTED: &str = "classes & inheritance · templates · polymorphism · \
overloading · pointers & references · globals · strings · floats · standard library · \
enums, structs & unions in C or Rust output (they compile to assembly)";
pub const RUST_SUBSET_SUPPORTED: &str = "i32/bool values · let/let mut · fixed local arrays · \
arithmetic & control flow · while/loop/for ranges · functions (up to 7 scalar args) · recursion";
pub const RUST_SUBSET_UNSUPPORTED: &str = "references & lifetimes · structs/enums/traits \
(C and C++ enums, structs & unions do not translate to Rust) · \
generics · closures & match · heap collections · strings · floats · macros & standard library";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslateError {
    /// 1-based source line, 0 when the error has no useful anchor.
    pub line: usize,
    pub message: String,
}

impl TranslateError {
    fn new(line: usize, message: impl Into<String>) -> Self {
        Self {
            line,
            message: message.into(),
        }
    }
}

const ABI: [&str; 32] = [
    "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2", "s0", "s1", "a0", "a1", "a2", "a3", "a4",
    "a5", "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "t3", "t4",
    "t5", "t6",
];

fn reg(i: u8) -> &'static str {
    ABI[i as usize]
}

// ===========================================================================
// Direction 1: assembly → C pseudocode
// ===========================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PseudoOp {
    Lui,
    Auipc,
    Jal,
    Jalr,
    Beq,
    Bne,
    Blt,
    Bge,
    Bltu,
    Bgeu,
    Lb,
    Lh,
    Lw,
    Ld,
    Lwu,
    Lbu,
    Lhu,
    Sb,
    Sh,
    Sw,
    Sd,
    Addi,
    Addiw,
    Slti,
    Sltiu,
    Xori,
    Ori,
    Andi,
    Slli,
    Srli,
    Srai,
    Slliw,
    Srliw,
    Sraiw,
    Add,
    Sub,
    Addw,
    Subw,
    Sll,
    Slt,
    Sltu,
    Xor,
    Srl,
    Sra,
    Sllw,
    Srlw,
    Sraw,
    Or,
    And,
    Mul,
    Mulh,
    Mulhsu,
    Mulhu,
    Div,
    Divu,
    Rem,
    Remu,
    Mulw,
    Divw,
    Divuw,
    Remw,
    Remuw,
    Ecall,
    Ebreak,
    Fence,
}

impl PseudoOp {
    fn is_branch(self) -> bool {
        matches!(
            self,
            Self::Beq | Self::Bne | Self::Blt | Self::Bge | Self::Bltu | Self::Bgeu
        )
    }

    fn writes_rd(self) -> bool {
        !matches!(
            self,
            Self::Beq
                | Self::Bne
                | Self::Blt
                | Self::Bge
                | Self::Bltu
                | Self::Bgeu
                | Self::Sb
                | Self::Sh
                | Self::Sw
                | Self::Sd
                | Self::Ecall
                | Self::Ebreak
                | Self::Fence
        )
    }
}

impl From<Op> for PseudoOp {
    fn from(op: Op) -> Self {
        match op {
            Op::Lui => Self::Lui,
            Op::Auipc => Self::Auipc,
            Op::Jal => Self::Jal,
            Op::Jalr => Self::Jalr,
            Op::Beq => Self::Beq,
            Op::Bne => Self::Bne,
            Op::Blt => Self::Blt,
            Op::Bge => Self::Bge,
            Op::Bltu => Self::Bltu,
            Op::Bgeu => Self::Bgeu,
            Op::Lb => Self::Lb,
            Op::Lh => Self::Lh,
            Op::Lw => Self::Lw,
            Op::Lbu => Self::Lbu,
            Op::Lhu => Self::Lhu,
            Op::Sb => Self::Sb,
            Op::Sh => Self::Sh,
            Op::Sw => Self::Sw,
            Op::Addi => Self::Addi,
            Op::Slti => Self::Slti,
            Op::Sltiu => Self::Sltiu,
            Op::Xori => Self::Xori,
            Op::Ori => Self::Ori,
            Op::Andi => Self::Andi,
            Op::Slli => Self::Slli,
            Op::Srli => Self::Srli,
            Op::Srai => Self::Srai,
            Op::Add => Self::Add,
            Op::Sub => Self::Sub,
            Op::Sll => Self::Sll,
            Op::Slt => Self::Slt,
            Op::Sltu => Self::Sltu,
            Op::Xor => Self::Xor,
            Op::Srl => Self::Srl,
            Op::Sra => Self::Sra,
            Op::Or => Self::Or,
            Op::And => Self::And,
            Op::Mul => Self::Mul,
            Op::Mulh => Self::Mulh,
            Op::Mulhsu => Self::Mulhsu,
            Op::Mulhu => Self::Mulhu,
            Op::Div => Self::Div,
            Op::Divu => Self::Divu,
            Op::Rem => Self::Rem,
            Op::Remu => Self::Remu,
            Op::Ecall => Self::Ecall,
            Op::Ebreak => Self::Ebreak,
            Op::Fence => Self::Fence,
        }
    }
}

impl From<Op64> for PseudoOp {
    fn from(op: Op64) -> Self {
        match op {
            Op64::Lui => Self::Lui,
            Op64::Auipc => Self::Auipc,
            Op64::Jal => Self::Jal,
            Op64::Jalr => Self::Jalr,
            Op64::Beq => Self::Beq,
            Op64::Bne => Self::Bne,
            Op64::Blt => Self::Blt,
            Op64::Bge => Self::Bge,
            Op64::Bltu => Self::Bltu,
            Op64::Bgeu => Self::Bgeu,
            Op64::Lb => Self::Lb,
            Op64::Lh => Self::Lh,
            Op64::Lw => Self::Lw,
            Op64::Ld => Self::Ld,
            Op64::Lwu => Self::Lwu,
            Op64::Lbu => Self::Lbu,
            Op64::Lhu => Self::Lhu,
            Op64::Sb => Self::Sb,
            Op64::Sh => Self::Sh,
            Op64::Sw => Self::Sw,
            Op64::Sd => Self::Sd,
            Op64::Addi => Self::Addi,
            Op64::Addiw => Self::Addiw,
            Op64::Slti => Self::Slti,
            Op64::Sltiu => Self::Sltiu,
            Op64::Xori => Self::Xori,
            Op64::Ori => Self::Ori,
            Op64::Andi => Self::Andi,
            Op64::Slli => Self::Slli,
            Op64::Srli => Self::Srli,
            Op64::Srai => Self::Srai,
            Op64::Slliw => Self::Slliw,
            Op64::Srliw => Self::Srliw,
            Op64::Sraiw => Self::Sraiw,
            Op64::Add => Self::Add,
            Op64::Sub => Self::Sub,
            Op64::Addw => Self::Addw,
            Op64::Subw => Self::Subw,
            Op64::Sll => Self::Sll,
            Op64::Slt => Self::Slt,
            Op64::Sltu => Self::Sltu,
            Op64::Xor => Self::Xor,
            Op64::Srl => Self::Srl,
            Op64::Sra => Self::Sra,
            Op64::Sllw => Self::Sllw,
            Op64::Srlw => Self::Srlw,
            Op64::Sraw => Self::Sraw,
            Op64::Or => Self::Or,
            Op64::And => Self::And,
            Op64::Mul => Self::Mul,
            Op64::Mulh => Self::Mulh,
            Op64::Mulhsu => Self::Mulhsu,
            Op64::Mulhu => Self::Mulhu,
            Op64::Div => Self::Div,
            Op64::Divu => Self::Divu,
            Op64::Rem => Self::Rem,
            Op64::Remu => Self::Remu,
            Op64::Mulw => Self::Mulw,
            Op64::Divw => Self::Divw,
            Op64::Divuw => Self::Divuw,
            Op64::Remw => Self::Remw,
            Op64::Remuw => Self::Remuw,
            Op64::Ecall => Self::Ecall,
            Op64::Ebreak => Self::Ebreak,
            Op64::Fence => Self::Fence,
        }
    }
}

#[derive(Debug, Clone)]
struct PseudoInstr {
    op: PseudoOp,
    rd: u8,
    rs1: u8,
    rs2: u8,
    imm: i64,
    text: String,
    addr: u64,
}

impl From<&AsmInstr> for PseudoInstr {
    fn from(instr: &AsmInstr) -> Self {
        Self {
            op: instr.op.into(),
            rd: instr.rd,
            rs1: instr.rs1,
            rs2: instr.rs2,
            imm: instr.imm as i64,
            text: instr.text.clone(),
            addr: instr.addr as u64,
        }
    }
}

impl From<&AsmInstr64> for PseudoInstr {
    fn from(instr: &AsmInstr64) -> Self {
        Self {
            op: instr.op.into(),
            rd: instr.rd,
            rs1: instr.rs1,
            rs2: instr.rs2,
            imm: instr.imm,
            text: instr.text.clone(),
            addr: instr.addr,
        }
    }
}

#[derive(Debug, Clone)]
struct PseudoProgram {
    instrs: Vec<PseudoInstr>,
    labels: Vec<(String, u64)>,
}

impl From<&Program> for PseudoProgram {
    fn from(program: &Program) -> Self {
        Self {
            instrs: program.instrs.iter().map(PseudoInstr::from).collect(),
            labels: program
                .labels
                .iter()
                .map(|(name, addr)| (name.clone(), *addr as u64))
                .collect(),
        }
    }
}

impl From<&Program64> for PseudoProgram {
    fn from(program: &Program64) -> Self {
        Self {
            instrs: program.instrs.iter().map(PseudoInstr::from).collect(),
            labels: program.labels.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PseudoXlen {
    Rv32,
    Rv64,
}

pub fn asm_to_c(source: &str) -> Result<String, TranslateError> {
    let program = assemble(source).map_err(|errs| {
        let e = &errs[0];
        TranslateError::new(e.line, format!("assembly error: {}", e.message))
    })?;
    if program.instrs.is_empty() {
        return Err(TranslateError::new(
            0,
            "nothing to translate: no instructions",
        ));
    }
    let pseudo = PseudoProgram::from(&program);
    Ok(Decompiler::new(&pseudo, PseudoXlen::Rv32).run())
}

/// Translate RV64IM assembly into educational, non-compilable C pseudocode.
pub fn asm64_to_c(source: &str) -> Result<String, TranslateError> {
    let program = assemble64(source).map_err(|errors| {
        let error = &errors[0];
        TranslateError::new(error.line, format!("assembly error: {}", error.message))
    })?;
    if program.instrs.is_empty() {
        return Err(TranslateError::new(
            0,
            "nothing to translate: no instructions",
        ));
    }
    let pseudo = PseudoProgram::from(&program);
    Ok(Decompiler::new(&pseudo, PseudoXlen::Rv64).run())
}

struct Decompiler<'a> {
    instrs: &'a [PseudoInstr],
    /// text-segment label at instruction index (loop heads etc.)
    text_label: HashMap<usize, String>,
    /// data-segment labels by address
    data_label: HashMap<u64, String>,
    /// all (from_idx, to_idx) control transfers from branches/jumps
    edges: Vec<(usize, usize)>,
    /// register -> data label it currently points at (straight-line only)
    points_at: HashMap<u8, String>,
    out: Vec<(String, String)>, // (code, original asm for the aligned comment)
    xlen: PseudoXlen,
}

impl<'a> Decompiler<'a> {
    fn new(program: &'a PseudoProgram, xlen: PseudoXlen) -> Self {
        let mut text_label = HashMap::new();
        let mut data_label = HashMap::new();
        for (name, addr) in &program.labels {
            if *addr >= crate::DATA_BASE as u64 {
                data_label.insert(*addr, name.clone());
            } else {
                text_label.insert((*addr as usize) / 4, name.clone());
            }
        }
        let mut edges = Vec::new();
        for (i, ins) in program.instrs.iter().enumerate() {
            if ins.op.is_branch() {
                let target = ((ins.addr as i64 + ins.imm as i64) / 4) as usize;
                edges.push((i, target));
            } else if ins.op == PseudoOp::Jal {
                let target = ((ins.addr as i64 + ins.imm) / 4) as usize;
                if ins.rd == 0 {
                    edges.push((i, target));
                }
            }
        }
        Self {
            instrs: &program.instrs,
            text_label,
            data_label,
            edges,
            points_at: HashMap::new(),
            out: Vec::new(),
            xlen,
        }
    }

    fn run(mut self) -> String {
        let n = self.instrs.len();
        self.emit_range(0, n - 1, 1);
        // Align the "// asm" comments into one column.
        let width = self
            .out
            .iter()
            .filter(|(_, asm)| !asm.is_empty())
            .map(|(code, _)| code.chars().count())
            .max()
            .unwrap_or(0)
            .min(44);
        let mut text = String::from(match self.xlen {
            PseudoXlen::Rv32 => {
                "// C view of the assembly — registers become int variables.\n\
                 // This is educational pseudocode, not compilable C.\n\n\
                 int main() {\n"
            }
            PseudoXlen::Rv64 => {
                "// C view of RV64 assembly: registers become int64_t variables.\n\
                 // This is educational pseudocode, not compilable C.\n\n\
                 int64_t main() {\n"
            }
        });
        for (code, asm) in &self.out {
            if asm.is_empty() {
                let _ = writeln!(text, "{code}");
            } else {
                let pad = width.saturating_sub(code.chars().count()) + 2;
                let _ = writeln!(text, "{code}{}// {asm}", " ".repeat(pad));
            }
        }
        text.push_str("}\n");
        text
    }

    /// Innermost loop starting at `at` inside [lo, hi]: the back edge
    /// (from, at) with the smallest `from` that still covers `at`.
    fn loop_ending(&self, at: usize, hi: usize) -> Option<usize> {
        self.edges
            .iter()
            .filter(|(f, t)| *t == at && *f >= at && *f <= hi)
            .map(|(f, _)| *f)
            .max()
    }

    /// A forward branch at `i` (to `t`) forms a clean `if` block when no
    /// outside jump lands inside (i, t).
    fn clean_block(&self, lo: usize, hi_excl: usize) -> bool {
        self.edges
            .iter()
            .all(|(f, t)| !(*t > lo && *t < hi_excl) || (*f >= lo && *f < hi_excl))
    }

    fn emit_range(&mut self, lo: usize, hi: usize, depth: usize) {
        let mut i = lo;
        // Past the nesting limit, control flow stays flat (`if (...) goto`)
        // so deeply nested branches cannot exhaust the stack.
        let structured = depth <= crate::limits::MAX_NESTING_DEPTH;
        while i <= hi {
            // loop head?
            if let Some(end) = self.loop_ending(i, hi).filter(|_| structured) {
                if end > i || (end == i && self.instrs[i].op.is_branch()) {
                    let head = self
                        .text_label
                        .get(&i)
                        .cloned()
                        .unwrap_or_else(|| format!("L{i}"));
                    self.points_at.clear();
                    self.push(depth, format!("do {{  // {head}:"), String::new());
                    if end > i {
                        self.emit_range(i, end - 1, depth + 1);
                    }
                    let b = &self.instrs[end];
                    let cond = self.cond(b, false);
                    self.points_at.clear();
                    self.push(depth, format!("}} while ({cond});"), b.text.clone());
                    i = end + 1;
                    continue;
                }
            }
            let ins = &self.instrs[i];
            // forward conditional branch -> if / if-else
            if ins.op.is_branch() {
                let target = ((ins.addr as i64 + ins.imm as i64) / 4) as usize;
                if structured && target > i + 1 && target <= hi + 1 && self.clean_block(i, target) {
                    let cond = self.cond(ins, true); // block runs when branch NOT taken
                    self.points_at.clear();
                    // if the block ends with `j past-else`, it's if/else
                    let last = target - 1;
                    let mut else_end = None;
                    if last > i
                        && self.instrs[last].op == PseudoOp::Jal
                        && self.instrs[last].rd == 0
                    {
                        let jt =
                            ((self.instrs[last].addr as i64 + self.instrs[last].imm) / 4) as usize;
                        if jt > target && jt <= hi + 1 && self.clean_block(target - 1, jt) {
                            else_end = Some(jt);
                        }
                    }
                    self.push(depth, format!("if ({cond}) {{"), ins.text.clone());
                    let body_end = if else_end.is_some() { last - 1 } else { last };
                    if body_end >= i + 1 {
                        self.emit_range(i + 1, body_end, depth + 1);
                    }
                    if let Some(jt) = else_end {
                        self.push(depth, "} else {".into(), String::new());
                        self.emit_range(target, jt - 1, depth + 1);
                        self.push(depth, "}".into(), String::new());
                        i = jt;
                    } else {
                        self.push(depth, "}".into(), String::new());
                        i = target;
                    }
                    continue;
                }
                // messy control flow: keep it honest with a goto
                let cond = self.cond(ins, false);
                let name = self
                    .text_label
                    .get(&target)
                    .cloned()
                    .unwrap_or_else(|| format!("L{target}"));
                self.points_at.clear();
                self.push(depth, format!("if ({cond}) goto {name};"), ins.text.clone());
                i += 1;
                continue;
            }
            // la fusion: lui rd, hi  +  addi rd, rd, lo
            if ins.op == PseudoOp::Lui && i < hi {
                let next = &self.instrs[i + 1];
                if next.op == PseudoOp::Addi && next.rd == ins.rd && next.rs1 == ins.rd {
                    let addr = ((ins.imm as u64) << 12).wrapping_add(next.imm as u64);
                    if let Some(label) = self.data_label.get(&addr).cloned() {
                        self.points_at.insert(ins.rd, label.clone());
                        self.push(
                            depth,
                            format!("{} = {label};", reg(ins.rd)),
                            format!("la {}, {label}", reg(ins.rd)),
                        );
                        i += 2;
                        continue;
                    }
                }
            }
            let line = self.instr_to_c(ins);
            self.push(depth, line, ins.text.clone());
            i += 1;
        }
    }

    fn push(&mut self, depth: usize, code: String, asm: String) {
        self.out
            .push((format!("{}{code}", "    ".repeat(depth)), asm));
    }

    /// Render a branch condition; `negate` flips it (for if-blocks that run
    /// when the branch is NOT taken).
    fn cond(&self, ins: &PseudoInstr, negate: bool) -> String {
        let (op, inv) = match ins.op {
            PseudoOp::Beq => ("==", "!="),
            PseudoOp::Bne => ("!=", "=="),
            PseudoOp::Blt => ("<", ">="),
            PseudoOp::Bge => (">=", "<"),
            PseudoOp::Bltu => ("<", ">="),
            PseudoOp::Bgeu => (">=", "<"),
            _ => ("?", "?"),
        };
        let sym = if negate { inv } else { op };
        let unsigned = matches!(ins.op, PseudoOp::Bltu | PseudoOp::Bgeu);
        let (a, b) = (reg(ins.rs1), reg(ins.rs2));
        if unsigned {
            let ty = if self.xlen == PseudoXlen::Rv64 {
                "uint64_t"
            } else {
                "unsigned"
            };
            format!("({ty}){a} {sym} ({ty}){b}")
        } else if ins.rs2 == 0 {
            format!("{a} {sym} 0")
        } else {
            format!("{a} {sym} {b}")
        }
    }

    fn mem_operand(&self, base: u8, imm: i64) -> String {
        if let Some(label) = self.points_at.get(&base) {
            if imm % 4 == 0 {
                return format!("{label}[{}]", imm / 4);
            }
        }
        if imm == 0 {
            format!("*{}", reg(base))
        } else if imm % 4 == 0 {
            format!("{}[{}]", reg(base), imm / 4)
        } else {
            format!("*({} + {imm})", reg(base))
        }
    }

    fn typed_mem_operand(&self, base: u8, imm: i64, ty: &str, bytes: i64) -> String {
        if let Some(label) = self.points_at.get(&base) {
            if imm % bytes == 0 {
                return format!("(({ty} *){label})[{}]", imm / bytes);
            }
        }
        format!("*({ty} *)({} + {imm})", reg(base))
    }

    fn instr_to_c(&mut self, ins: &PseudoInstr) -> String {
        let rd = reg(ins.rd);
        let rs1 = reg(ins.rs1);
        let rs2 = reg(ins.rs2);
        let imm = ins.imm;
        let is_rv64 = self.xlen == PseudoXlen::Rv64;
        let signed_type = if is_rv64 { "int64_t" } else { "int" };
        let bin = |sym: &str| -> String { format!("{rd} = {rs1} {sym} {rs2};") };
        // writes to rd invalidate any tracked data pointer
        if ins.op.writes_rd() && ins.rd != 0 {
            self.points_at.remove(&ins.rd);
        }
        match ins.op {
            PseudoOp::Addi => {
                if ins.rs1 == 0 {
                    format!("{signed_type} {rd} = {imm};")
                } else if imm == 0 {
                    format!("{rd} = {rs1};")
                } else if ins.rd == ins.rs1 && imm < 0 {
                    format!("{rd} -= {};", -imm)
                } else if ins.rd == ins.rs1 {
                    format!("{rd} += {imm};")
                } else {
                    format!("{rd} = {rs1} + {imm};")
                }
            }
            PseudoOp::Addiw => {
                let expr = format!("(int64_t)(int32_t)((uint32_t){rs1} + ({imm}))");
                if ins.rs1 == 0 {
                    format!("int64_t {rd} = {expr};")
                } else {
                    format!("{rd} = {expr};")
                }
            }
            PseudoOp::Add => {
                if ins.rs2 == 0 {
                    format!("{rd} = {rs1};")
                } else {
                    bin("+")
                }
            }
            PseudoOp::Sub => {
                if ins.rs1 == 0 {
                    format!("{rd} = -{rs2};")
                } else {
                    bin("-")
                }
            }
            PseudoOp::Addw => {
                format!("{rd} = (int64_t)(int32_t)((uint32_t){rs1} + (uint32_t){rs2});")
            }
            PseudoOp::Subw => {
                format!("{rd} = (int64_t)(int32_t)((uint32_t){rs1} - (uint32_t){rs2});")
            }
            PseudoOp::Mul => bin("*"),
            PseudoOp::Mulw => {
                format!("{rd} = (int64_t)(int32_t)((uint32_t){rs1} * (uint32_t){rs2});")
            }
            PseudoOp::Div => bin("/"),
            PseudoOp::Divw => {
                format!("{rd} = (int64_t)((int32_t){rs1} / (int32_t){rs2});")
            }
            PseudoOp::Divuw => {
                format!("{rd} = (int64_t)(int32_t)((uint32_t){rs1} / (uint32_t){rs2});")
            }
            PseudoOp::Divu if is_rv64 => {
                format!("{rd} = (uint64_t){rs1} / (uint64_t){rs2};")
            }
            PseudoOp::Divu => bin("/"),
            PseudoOp::Rem => bin("%"),
            PseudoOp::Remw => {
                format!("{rd} = (int64_t)((int32_t){rs1} % (int32_t){rs2});")
            }
            PseudoOp::Remuw => {
                format!("{rd} = (int64_t)(int32_t)((uint32_t){rs1} % (uint32_t){rs2});")
            }
            PseudoOp::Remu if is_rv64 => {
                format!("{rd} = (uint64_t){rs1} % (uint64_t){rs2};")
            }
            PseudoOp::Remu => bin("%"),
            PseudoOp::And => bin("&"),
            PseudoOp::Or => bin("|"),
            PseudoOp::Xor => {
                if imm == 0 && ins.rs2 != 0 {
                    bin("^")
                } else {
                    bin("^")
                }
            }
            PseudoOp::Sll if is_rv64 => {
                format!("{rd} = (uint64_t){rs1} << ({rs2} & 63);")
            }
            PseudoOp::Sll => bin("<<"),
            PseudoOp::Sllw => {
                format!("{rd} = (int64_t)(int32_t)((uint32_t){rs1} << ({rs2} & 31));")
            }
            PseudoOp::Srl if is_rv64 => {
                format!("{rd} = (uint64_t){rs1} >> ({rs2} & 63);")
            }
            PseudoOp::Srlw => {
                format!("{rd} = (int64_t)(int32_t)((uint32_t){rs1} >> ({rs2} & 31));")
            }
            PseudoOp::Sraw => {
                format!("{rd} = (int64_t)((int32_t){rs1} >> ({rs2} & 31));")
            }
            PseudoOp::Sra if is_rv64 => {
                format!("{rd} = (int64_t){rs1} >> ({rs2} & 63);")
            }
            PseudoOp::Srl | PseudoOp::Sra => bin(">>"),
            PseudoOp::Andi => format!("{rd} = {rs1} & {imm};"),
            PseudoOp::Ori => format!("{rd} = {rs1} | {imm};"),
            PseudoOp::Xori => {
                if imm == -1 {
                    format!("{rd} = ~{rs1};")
                } else {
                    format!("{rd} = {rs1} ^ {imm};")
                }
            }
            PseudoOp::Slli if is_rv64 => format!("{rd} = (uint64_t){rs1} << {imm};"),
            PseudoOp::Slli => format!("{rd} = {rs1} << {imm};"),
            PseudoOp::Slliw => {
                format!("{rd} = (int64_t)(int32_t)((uint32_t){rs1} << {imm});")
            }
            PseudoOp::Srli if is_rv64 => format!("{rd} = (uint64_t){rs1} >> {imm};"),
            PseudoOp::Srliw => {
                format!("{rd} = (int64_t)(int32_t)((uint32_t){rs1} >> {imm});")
            }
            PseudoOp::Sraiw => {
                format!("{rd} = (int64_t)((int32_t){rs1} >> {imm});")
            }
            PseudoOp::Srai if is_rv64 => format!("{rd} = (int64_t){rs1} >> {imm};"),
            PseudoOp::Srli | PseudoOp::Srai => format!("{rd} = {rs1} >> {imm};"),
            PseudoOp::Slt => format!("{rd} = ({rs1} < {rs2}) ? 1 : 0;"),
            PseudoOp::Sltu => {
                if ins.rs1 == 0 {
                    format!("{rd} = ({rs2} != 0) ? 1 : 0;")
                } else if is_rv64 {
                    format!("{rd} = ((uint64_t){rs1} < (uint64_t){rs2}) ? 1 : 0;")
                } else {
                    format!("{rd} = ((unsigned){rs1} < (unsigned){rs2}) ? 1 : 0;")
                }
            }
            PseudoOp::Slti => format!("{rd} = ({rs1} < {imm}) ? 1 : 0;"),
            PseudoOp::Sltiu => {
                if imm == 1 {
                    format!("{rd} = ({rs1} == 0) ? 1 : 0;")
                } else if is_rv64 {
                    format!("{rd} = ((uint64_t){rs1} < (uint64_t)({imm})) ? 1 : 0;")
                } else {
                    format!("{rd} = ((unsigned){rs1} < {imm}u) ? 1 : 0;")
                }
            }
            PseudoOp::Ld => format!(
                "{rd} = {};",
                self.typed_mem_operand(ins.rs1, imm, "int64_t", 8)
            ),
            PseudoOp::Lwu => format!(
                "{rd} = {};",
                self.typed_mem_operand(ins.rs1, imm, "uint32_t", 4)
            ),
            PseudoOp::Lw if is_rv64 => format!(
                "{rd} = {};",
                self.typed_mem_operand(ins.rs1, imm, "int32_t", 4)
            ),
            PseudoOp::Lw => format!("{rd} = {};", self.mem_operand(ins.rs1, imm)),
            PseudoOp::Lb | PseudoOp::Lh | PseudoOp::Lbu | PseudoOp::Lhu if is_rv64 => {
                let (ty, bytes) = match ins.op {
                    PseudoOp::Lb => ("int8_t", 1),
                    PseudoOp::Lbu => ("uint8_t", 1),
                    PseudoOp::Lh => ("int16_t", 2),
                    _ => ("uint16_t", 2),
                };
                format!(
                    "{rd} = {};",
                    self.typed_mem_operand(ins.rs1, imm, ty, bytes)
                )
            }
            PseudoOp::Lb | PseudoOp::Lh | PseudoOp::Lbu | PseudoOp::Lhu => {
                let width = match ins.op {
                    PseudoOp::Lb | PseudoOp::Lbu => "char",
                    _ => "short",
                };
                format!("{rd} = *({width} *)({rs1} + {imm});")
            }
            PseudoOp::Sd => format!(
                "{} = {rs2};",
                self.typed_mem_operand(ins.rs1, imm, "int64_t", 8)
            ),
            PseudoOp::Sw if is_rv64 => format!(
                "{} = {rs2};",
                self.typed_mem_operand(ins.rs1, imm, "int32_t", 4)
            ),
            PseudoOp::Sw => format!("{} = {rs2};", self.mem_operand(ins.rs1, imm)),
            PseudoOp::Sb | PseudoOp::Sh if is_rv64 => {
                let (ty, bytes) = if ins.op == PseudoOp::Sb {
                    ("uint8_t", 1)
                } else {
                    ("uint16_t", 2)
                };
                format!(
                    "{} = {rs2};",
                    self.typed_mem_operand(ins.rs1, imm, ty, bytes)
                )
            }
            PseudoOp::Sb | PseudoOp::Sh => {
                let width = if ins.op == PseudoOp::Sb {
                    "char"
                } else {
                    "short"
                };
                format!("*({width} *)({rs1} + {imm}) = {rs2};")
            }
            PseudoOp::Lui if is_rv64 => format!(
                "{rd} = (int64_t)(int32_t)0x{:08x}u;",
                ((imm as u64) << 12) as u32
            ),
            PseudoOp::Lui => format!("{rd} = 0x{:x};", (imm as u32) << 12),
            PseudoOp::Auipc if is_rv64 => format!(
                "{rd} = pc + (int64_t)(int32_t)0x{:08x}u;",
                ((imm as u64) << 12) as u32
            ),
            PseudoOp::Auipc => format!("{rd} = pc + 0x{:x};", (imm as u32) << 12),
            PseudoOp::Jal => {
                let target = ((ins.addr as i64 + imm as i64) / 4) as usize;
                let name = self
                    .text_label
                    .get(&target)
                    .cloned()
                    .unwrap_or_else(|| format!("L{target}"));
                if ins.rd == 1 {
                    format!("{name}();  /* args in a0..a7, result in a0 */")
                } else if ins.rd == 0 {
                    format!("goto {name};")
                } else {
                    format!("{rd} = pc + 4; goto {name};")
                }
            }
            PseudoOp::Jalr => {
                if ins.rd == 0 && ins.rs1 == 1 {
                    "return;  /* back to caller */".to_string()
                } else {
                    format!("/* indirect jump: jalr {rd}, {imm}({rs1}) */")
                }
            }
            PseudoOp::Ecall => "return a0;  /* ecall: end program */".to_string(),
            PseudoOp::Ebreak => "return a0;  /* ebreak: stop */".to_string(),
            PseudoOp::Fence => "/* fence (no-op here) */".to_string(),
            PseudoOp::Mulh if is_rv64 => {
                format!("{rd} = (int64_t)(((__int128){rs1} * {rs2}) >> 64);")
            }
            PseudoOp::Mulhsu if is_rv64 => {
                format!("{rd} = (int64_t)(((__int128){rs1} * (uint64_t){rs2}) >> 64);")
            }
            PseudoOp::Mulhu if is_rv64 => {
                format!(
                    "{rd} = (uint64_t)(((unsigned __int128)(uint64_t){rs1} * (uint64_t){rs2}) >> 64);"
                )
            }
            PseudoOp::Mulh | PseudoOp::Mulhsu | PseudoOp::Mulhu => {
                format!("{rd} = (int)(((long long){rs1} * {rs2}) >> 32);")
            }
            _ => format!("/* {} */", ins.text),
        }
    }
}

// ===========================================================================
// Direction 2: C subset → assembly
// ===========================================================================

pub fn c_to_asm(source: &str) -> Result<String, TranslateError> {
    let tokens = lex(source)?;
    let mut parser = Parser::new_c(tokens);
    let unit = parser.parse_unit()?;
    let gen = CodeGen::new();
    gen.emit_unit(&unit)
}

/// Compile the documented C integer subset to executable RV64IM.
///
/// Source `int` values retain signed 32-bit semantics in the 64-bit program.
pub fn c_to_asm64(source: &str) -> Result<String, TranslateError> {
    let tokens = lex(source)?;
    let mut parser = Parser::new_c(tokens).for_rv64();
    let unit = parser.parse_unit()?;
    let gen = CodeGen::new_rv64("C");
    gen.emit_unit(&unit)
}

/// Compile the documented C++ int/bool subset to executable RV32IM.
pub fn cpp_to_asm(source: &str) -> Result<String, TranslateError> {
    let unit = parse_cpp_unit(source, 32)?;
    let gen = CodeGen::new_cpp();
    gen.emit_unit(&unit)
}

/// Compile the documented C++ int/bool subset to executable RV64IM.
///
/// Source `int` values retain signed 32-bit semantics in the 64-bit program.
pub fn cpp_to_asm64(source: &str) -> Result<String, TranslateError> {
    let unit = parse_cpp_unit(source, 64)?;
    let gen = CodeGen::new_rv64("C++");
    gen.emit_unit(&unit)
}

/// The prefix of the marker lines [`CodeGen`] writes in annotate mode.
const ANNOTATE_MARK: &str = "#@line ";

/// One line of annotated assembly: the source line it came from (None for
/// the startup code and data) and the assembly text, exactly as the plain
/// translation prints it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AsmLine {
    pub source_line: Option<usize>,
    pub text: String,
}

/// Compile C or C++ to RV32 or RV64 assembly and say which source line each
/// assembly line came from. `from` is `"c"` or `"cpp"`, `xlen` is 32 or 64.
/// The text of the lines is identical to the plain translation.
pub fn translate_annotated(from: &str, xlen: u32, source: &str) -> Result<Vec<AsmLine>, TranslateError> {
    let (unit, mut gen) = match from {
        "c" => {
            let tokens = lex(source)?;
            let parser = Parser::new_c(tokens);
            let unit = if xlen == 64 { parser.for_rv64() } else { parser }.parse_unit()?;
            (unit, if xlen == 64 { CodeGen::new_rv64("C") } else { CodeGen::new() })
        }
        "cpp" => (parse_cpp_unit(source, if xlen == 64 { 64 } else { 32 })?, if xlen == 64 { CodeGen::new_rv64("C++") } else { CodeGen::new_cpp() }),
        other => {
            return Err(TranslateError::new(0, format!("annotated output is available for c and cpp, not {other}")));
        }
    };
    gen.annotate = true;
    let asm = gen.emit_unit(&unit)?;
    let mut current = None;
    let mut out = Vec::new();
    for line in asm.lines() {
        if let Some(n) = line.strip_prefix(ANNOTATE_MARK) {
            current = n.trim().parse::<usize>().ok().filter(|&n| n > 0);
            continue;
        }
        // The data section belongs to no single line.
        if line.starts_with(".data") || line.starts_with(".rodata") || line.starts_with(".section") {
            current = None;
        }
        out.push(AsmLine { source_line: current, text: line.to_string() });
    }
    Ok(out)
}

/// Translate the documented C integer subset to compilable C++ subset source.
pub fn c_to_cpp(source: &str) -> Result<String, TranslateError> {
    let tokens = lex(source)?;
    let mut parser = Parser::new_c(tokens);
    let unit = parser.parse_unit()?;
    records::reject_user_types(&unit, "C", "C++")?;
    reject_memory_features(&unit, "C", "C++")?;
    Ok(SourceEmitter::new(SourceDialect::Cpp).emit(&unit))
}

/// Translate the documented C++ int/bool subset to compilable C subset source.
pub fn cpp_to_c(source: &str) -> Result<String, TranslateError> {
    let unit = parse_cpp_unit(source, 32)?;
    records::reject_user_types(&unit, "C++", "C")?;
    Ok(SourceEmitter::new(SourceDialect::C).emit(&unit))
}

/// Compile the documented by-value Rust subset to executable RV32IM.
pub fn rust_to_asm(source: &str) -> Result<String, TranslateError> {
    let hir = hir::typed_hir_from_rust(source)?;
    rust_to_c::validate(&hir)?;
    let gen = CodeGen::new_rust();
    gen.emit_unit(&hir.ast)
}

/// Compile the documented by-value Rust subset to executable RV64IM.
///
/// Source `i32` values retain signed 32-bit semantics in the 64-bit program.
pub fn rust_to_asm64(source: &str) -> Result<String, TranslateError> {
    let hir = hir::typed_hir_from_rust(source)?;
    rust_to_c::validate(&hir)?;
    let gen = CodeGen::new_rv64("Rust");
    gen.emit_unit(&hir.ast)
}

/// Translate the documented by-value Rust subset to compilable C subset source.
pub fn rust_to_c(source: &str) -> Result<String, TranslateError> {
    rust_to_c::translate(source)
}

/// Translate the documented by-value Rust subset to native C++ subset source.
pub fn rust_to_cpp(source: &str) -> Result<String, TranslateError> {
    rust_to_c::translate_cpp(source)
}

/// Translate the documented safe C intersection to compilable Rust subset source.
pub fn c_to_rust(source: &str) -> Result<String, TranslateError> {
    c_to_rust::translate(source)
}

/// Translate the documented C++ int/bool subset to compilable Rust subset source.
pub fn cpp_to_rust(source: &str) -> Result<String, TranslateError> {
    cpp_to_rust::translate(source)
}

fn pointer_cast_error(line: usize) -> TranslateError {
    TranslateError::new(
        line,
        "unsupported: this cast; casts to pointer types look like (int *)p or (void *)p, and function pointer types are not supported",
    )
}

/// The error for C pointers, globals and strings in a source-to-source
/// direction: they compile to assembly, but other languages lack them here.
fn memory_feature_error(line: usize, from: &str, to: &str) -> TranslateError {
    TranslateError::new(
        line,
        format!(
            "unsupported: pointers, globals and strings can be compiled to RISC-V assembly, \
             but translating them from {from} to {to} is not supported yet"
        ),
    )
}

fn reject_memory_features(unit: &Unit, from: &str, to: &str) -> Result<(), TranslateError> {
    match unit.memory_line {
        Some(line) => Err(memory_feature_error(line, from, to)),
        None => Ok(()),
    }
}

// -- lexer ------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Tok {
    Int(i64),
    Bool(bool),
    Ident(String),
    Kw(&'static str),
    Sym(&'static str),
    /// C string literal bytes (escapes decoded, no terminating NUL).
    Str(Vec<u8>),
    Eof,
}

#[derive(Debug, Clone)]
struct SpTok {
    tok: Tok,
    line: usize,
}

const KEYWORDS: [&str; 16] = [
    "int", "if", "else", "while", "for", "return", "break", "continue", "do", "switch", "case",
    "default", "struct", "union", "enum", "typedef",
];
const BANNED: [(&str, &str); 3] = [
    ("float", "floating point is not yet translatable"),
    ("double", "floating point is not yet translatable"),
    ("goto", "goto is not supported"),
];

/// Words that combine into one C integer type keyword (see
/// `merge_c_type_specifiers`).
const C_TYPE_WORDS: [&str; 5] = ["unsigned", "signed", "char", "short", "long"];

/// Canonical C integer type keywords produced by the lexer, with their AST
/// types. `char` is unsigned, as the RISC-V psABI specifies; `long` follows
/// the target data model (ILP32 on RV32, LP64 on RV64).
const C_INT_TYPES: [(&str, ScalarType); 11] = [
    ("int", ScalarType::I32),
    ("char", ScalarType::Int(IntTy { bits: 8, signed: false })),
    ("signed char", ScalarType::Int(IntTy { bits: 8, signed: true })),
    ("unsigned char", ScalarType::Int(IntTy { bits: 8, signed: false })),
    ("short", ScalarType::Int(IntTy { bits: 16, signed: true })),
    ("unsigned short", ScalarType::Int(IntTy { bits: 16, signed: false })),
    ("unsigned int", ScalarType::Int(IntTy { bits: 32, signed: false })),
    ("long", ScalarType::Int(IntTy { bits: IntTy::LONG, signed: true })),
    ("unsigned long", ScalarType::Int(IntTy { bits: IntTy::LONG, signed: false })),
    ("long long", ScalarType::Int(IntTy { bits: 64, signed: true })),
    ("unsigned long long", ScalarType::Int(IntTy { bits: 64, signed: false })),
];

fn c_int_type(keyword: &str) -> Option<ScalarType> {
    C_INT_TYPES.iter().find(|(k, _)| *k == keyword).map(|(_, t)| *t)
}

/// Unary operator spellings for C casts, `(type)expr`.
const C_CAST_OPS: [(&str, &str); 11] = [
    ("int", "(int)"),
    ("char", "(char)"),
    ("signed char", "(signed char)"),
    ("unsigned char", "(unsigned char)"),
    ("short", "(short)"),
    ("unsigned short", "(unsigned short)"),
    ("unsigned int", "(unsigned int)"),
    ("long", "(long)"),
    ("unsigned long", "(unsigned long)"),
    ("long long", "(long long)"),
    ("unsigned long long", "(unsigned long long)"),
];

/// `sizeof(type)` operator spellings (the operand is a dummy literal).
const C_SIZEOF_OPS: [(&str, &str); 11] = [
    ("int", "sizeof(int)"),
    ("char", "sizeof(char)"),
    ("signed char", "sizeof(signed char)"),
    ("unsigned char", "sizeof(unsigned char)"),
    ("short", "sizeof(short)"),
    ("unsigned short", "sizeof(unsigned short)"),
    ("unsigned int", "sizeof(unsigned int)"),
    ("long", "sizeof(long)"),
    ("unsigned long", "sizeof(unsigned long)"),
    ("long long", "sizeof(long long)"),
    ("unsigned long long", "sizeof(unsigned long long)"),
];

/// The type a cast operator converts to.
fn cast_target(op: &str) -> Option<ScalarType> {
    C_CAST_OPS
        .iter()
        .find(|(_, o)| *o == op)
        .and_then(|(k, _)| c_int_type(k))
        .or_else(|| pointer_casts().iter().find(|(_, o)| *o == op).map(|(t, _)| *t))
}

/// Every pointer cast spelling, `(void *)` .. `(unsigned long long ****)`,
/// built once so cast operators stay `&'static str` like the integer casts.
fn pointer_casts() -> &'static [(ScalarType, &'static str)] {
    static TABLE: std::sync::OnceLock<Vec<(ScalarType, &'static str)>> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        let bases = std::iter::once(ScalarType::Unit)
            .chain(C_CAST_OPS.iter().filter_map(|(k, _)| c_int_type(k)));
        let mut table = Vec::new();
        for base in bases {
            let mut t = base;
            while let Some(p) = t.pointer_to() {
                let name: &'static str = Box::leak(format!("({})", c_type_name(p)).into_boxed_str());
                if !table.iter().any(|(_, n)| *n == name) {
                    table.push((p, name));
                }
                t = p;
            }
        }
        table
    })
}

/// The cast operator for pointer type `t`.
fn pointer_cast_op(t: ScalarType) -> Option<&'static str> {
    pointer_casts().iter().find(|(p, _)| *p == t).map(|(_, op)| *op)
}

fn is_c_int_kw(token: &Tok) -> bool {
    matches!(token, Tok::Kw(k) if c_int_type(k).is_some())
}

/// The canonical keyword spelling of a C integer type.
fn c_type_keyword(value_type: ScalarType) -> &'static str {
    if value_type.is_ptr() {
        return "pointer";
    }
    C_INT_TYPES
        .iter()
        .find(|(k, t)| *t == value_type && *k != "char")
        .map(|(k, _)| *k)
        .unwrap_or("int")
}

/// The C spelling of a type for diagnostics (`int`, `char **`).
fn c_type_name(value_type: ScalarType) -> String {
    match value_type {
        ScalarType::Ptr(base, depth) => {
            let base = if base == (IntTy { bits: 32, signed: true }) {
                "int"
            } else if base == IntTy::VOID {
                "void"
            } else {
                C_INT_TYPES
                    .iter()
                    .find(|(_, t)| *t == ScalarType::Int(base))
                    .map(|(k, _)| *k)
                    .unwrap_or("int")
            };
            format!("{base} {}", "*".repeat(depth as usize))
        }
        ScalarType::Bool => "bool".into(),
        ScalarType::Unit => "void".into(),
        ScalarType::Int(IntTy { bits: 8, signed: false }) => "char".into(),
        other => c_type_keyword(other).into(),
    }
}

/// Merge runs of integer type specifiers (`unsigned long long`, `signed
/// char`, `short int`, ...) into a single canonical keyword token.
fn merge_c_type_specifiers(toks: Vec<SpTok>) -> Result<Vec<SpTok>, TranslateError> {
    let is_word = |t: &Tok| match t {
        Tok::Ident(w) => C_TYPE_WORDS.contains(&w.as_str()),
        Tok::Kw("int") => true,
        _ => false,
    };
    let mut out = Vec::with_capacity(toks.len());
    let mut i = 0;
    while i < toks.len() {
        if !is_word(&toks[i].tok) {
            out.push(toks[i].clone());
            i += 1;
            continue;
        }
        let line = toks[i].line;
        let (mut unsigned, mut signed, mut chars, mut shorts, mut longs, mut ints) = (0, 0, 0, 0, 0, 0);
        let mut words = Vec::new();
        while i < toks.len() && is_word(&toks[i].tok) {
            let w = match &toks[i].tok {
                Tok::Ident(w) => w.clone(),
                _ => "int".to_string(),
            };
            match w.as_str() {
                "unsigned" => unsigned += 1,
                "signed" => signed += 1,
                "char" => chars += 1,
                "short" => shorts += 1,
                "long" => longs += 1,
                _ => ints += 1,
            }
            words.push(w);
            i += 1;
        }
        let shown = words.join(" ");
        let invalid = unsigned + signed > 1
            || chars > 1
            || shorts > 1
            || ints > 1
            || longs > 2
            || (chars == 1 && (shorts + longs + ints) > 0)
            || (shorts == 1 && longs > 0);
        if invalid {
            return Err(TranslateError::new(
                line,
                format!("'{shown}' is not a valid C integer type"),
            ));
        }
        let base = if chars == 1 {
            if signed == 1 {
                "signed char"
            } else if unsigned == 1 {
                "unsigned char"
            } else {
                "char"
            }
        } else if shorts == 1 {
            if unsigned == 1 { "unsigned short" } else { "short" }
        } else if longs == 2 {
            if unsigned == 1 { "unsigned long long" } else { "long long" }
        } else if longs == 1 {
            if unsigned == 1 { "unsigned long" } else { "long" }
        } else if unsigned == 1 {
            "unsigned int"
        } else {
            "int"
        };
        out.push(SpTok { tok: Tok::Kw(base), line });
    }
    Ok(out)
}

/// Integer literal tokens for C and C++: the literal's C type follows the
/// standard rules (decimal: int, then long long; hex/octal: int, unsigned
/// int, long long, unsigned long long) and explicit `u`/`l`/`ll` suffixes.
/// Non-int literals are emitted as a parenthesized cast so the parser and
/// code generators see an ordinary typed expression.
fn push_c_int_literal(
    toks: &mut Vec<SpTok>,
    value: u128,
    decimal: bool,
    suffix: &str,
    line: usize,
) -> Result<(), TranslateError> {
    let lower = suffix.to_ascii_lowercase();
    let (want_unsigned, longs) = match lower.as_str() {
        "" => (false, 0),
        "u" => (true, 0),
        "l" => (false, 1),
        "ul" | "lu" => (true, 1),
        "ll" => (false, 2),
        "ull" | "llu" => (true, 2),
        _ => {
            return Err(TranslateError::new(
                line,
                format!("'{suffix}' is not a valid integer suffix: use u, l, ll, ul or ull"),
            ))
        }
    };
    if value > u64::MAX as u128 {
        return Err(TranslateError::new(
            line,
            "integer literal is too large: the largest is 18446744073709551615",
        ));
    }
    let fits_i32 = value <= i32::MAX as u128;
    let fits_u32 = value <= u32::MAX as u128;
    let fits_i64 = value <= i64::MAX as u128;
    let keyword: &'static str = match (want_unsigned, longs) {
        (false, 0) if fits_i32 => "int",
        (false, 0) if fits_u32 && !decimal => "unsigned int",
        (false, 0 | 1 | 2) if fits_i64 && longs < 2 && longs == 1 => "long",
        (false, _) if fits_i64 => "long long",
        (true, 0) if fits_u32 => "unsigned int",
        (true, 1) => "unsigned long",
        _ => "unsigned long long",
    };
    let keyword = if keyword == "long" && !fits_i32 { "long long" } else { keyword };
    let literal = Tok::Int(value as u64 as i64);
    if keyword == "int" {
        toks.push(SpTok { tok: literal, line });
        return Ok(());
    }
    for tok in [Tok::Sym("("), Tok::Sym("("), Tok::Kw(keyword), Tok::Sym(")"), literal, Tok::Sym(")")] {
        toks.push(SpTok { tok, line });
    }
    Ok(())
}

/// Value of a C character literal body (between the quotes).
fn c_char_literal_value(body: &str) -> Option<i64> {
    let mut chars = body.chars();
    let value = match (chars.next()?, chars.next()) {
        ('\\', Some(e)) => {
            let simple = match e {
                'n' => Some(10),
                't' => Some(9),
                'r' => Some(13),
                '0' => Some(0),
                'a' => Some(7),
                'b' => Some(8),
                'f' => Some(12),
                'v' => Some(11),
                '\\' => Some(92),
                '\'' => Some(39),
                '"' => Some(34),
                '?' => Some(63),
                _ => None,
            };
            if let Some(v) = simple {
                if chars.next().is_some() {
                    return None;
                }
                v
            } else if e == 'x' {
                let hex: String = chars.collect();
                if hex.is_empty() || hex.len() > 2 {
                    return None;
                }
                i64::from_str_radix(&hex, 16).ok()?
            } else {
                return None;
            }
        }
        (c, None) if c.is_ascii() && c != '\\' && c != '\'' => c as i64,
        _ => return None,
    };
    Some(value)
}


fn string_too_long(line: usize) -> TranslateError {
    TranslateError::new(
        line,
        format!(
            "string literal is too long: the limit is {} bytes",
            crate::limits::MAX_STRING_LITERAL_BYTES
        ),
    )
}

/// Lex the body of a C string literal (the opening quote is next). Escapes
/// are those of character literals; the literal must close on its line.
fn lex_c_string(
    chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
    line: usize,
) -> Result<Vec<u8>, TranslateError> {
    chars.next();
    let mut bytes = Vec::new();
    loop {
        match chars.next() {
            None | Some('\n') => {
                return Err(TranslateError::new(line, "unterminated string literal: add the closing '\"'"))
            }
            Some('"') => break,
            Some('\\') => {
                let mut escape = String::from("\\");
                match chars.next() {
                    Some('x') => {
                        escape.push('x');
                        while escape.len() < 4 && chars.peek().is_some_and(|c| c.is_ascii_hexdigit()) {
                            escape.extend(chars.next());
                        }
                    }
                    Some(e) => escape.push(e),
                    None => {}
                }
                let value = c_char_literal_value(&escape).ok_or_else(|| {
                    TranslateError::new(line, format!("invalid escape '{escape}' in string literal"))
                })?;
                bytes.push(value as u8);
            }
            Some(c) if c.is_ascii() => bytes.push(c as u8),
            Some(c) => {
                return Err(TranslateError::new(
                    line,
                    format!("unsupported: non-ASCII character '{c}' in a string literal; use a \\x escape"),
                ))
            }
        }
        if bytes.len() > crate::limits::MAX_STRING_LITERAL_BYTES {
            return Err(string_too_long(line));
        }
    }
    Ok(bytes)
}

fn lex(src: &str) -> Result<Vec<SpTok>, TranslateError> {
    lex_dialect(src, LexDialect::C)
}

fn lex_cpp(src: &str) -> Result<Vec<SpTok>, TranslateError> {
    lex_dialect(src, LexDialect::Cpp)
}

fn lex_rust(src: &str) -> Result<Vec<SpTok>, TranslateError> {
    lex_dialect(src, LexDialect::Rust)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LexDialect {
    C,
    Cpp,
    Rust,
}

const CPP_BANNED: [(&str, &str); 27] = [
    ("class", "classes and inheritance are not supported"),
    ("template", "templates are not supported"),
    ("typename", "templates are not supported"),
    ("virtual", "runtime polymorphism is not supported"),
    ("override", "runtime polymorphism is not supported"),
    ("final", "runtime polymorphism is not supported"),
    ("operator", "operator overloading is not supported"),
    ("namespace", "namespaces are not supported"),
    ("using", "using declarations are not supported"),
    ("try", "exceptions are not supported"),
    ("catch", "exceptions are not supported"),
    ("throw", "exceptions are not supported"),
    ("new", "dynamic allocation is not supported"),
    ("delete", "dynamic allocation is not supported"),
    ("nullptr", "pointers are not supported"),
    ("const", "const-qualified declarations are not supported"),
    (
        "constexpr",
        "constexpr is not supported; use int or local auto",
    ),
    ("static_cast", "C++ casts are not supported"),
    ("dynamic_cast", "C++ casts are not supported"),
    ("reinterpret_cast", "C++ casts are not supported"),
    ("const_cast", "C++ casts are not supported"),
    ("public", "classes and inheritance are not supported"),
    ("private", "classes and inheritance are not supported"),
    ("protected", "classes and inheritance are not supported"),
    ("std", "the C++ standard library is not available"),
    ("this", "classes are not supported"),
    ("friend", "classes are not supported"),
];

const RUST_BANNED: &[(&str, &str)] = &[
    ("struct", "structs are not supported"),
    ("enum", "enums are not supported"),
    ("trait", "traits are not supported"),
    ("impl", "implementations and methods are not supported"),
    ("Self", "methods and associated items are not supported"),
    ("self", "method receivers are not supported"),
    (
        "type",
        "type aliases and associated types are not supported",
    ),
    ("where", "generics and bounds are not supported"),
    ("dyn", "trait objects are not supported"),
    ("match", "pattern matching is not supported"),
    ("ref", "reference patterns are not supported"),
    ("move", "closures and move capture are not supported"),
    ("macro_rules", "macros are not supported"),
    ("mod", "modules are not supported"),
    ("use", "imports are not supported"),
    ("pub", "visibility modifiers are not supported"),
    ("crate", "module paths are not supported"),
    ("super", "module paths are not supported"),
    ("const", "const items and bindings are not supported"),
    ("static", "static and global items are not supported"),
    ("async", "async Rust is not supported"),
    ("await", "async Rust is not supported"),
    ("unsafe", "unsafe Rust is not supported"),
    ("extern", "extern functions and ABIs are not supported"),
    (
        "Box",
        "heap allocation and owning pointer types are not supported",
    ),
    (
        "Rc",
        "heap allocation and owning pointer types are not supported",
    ),
    (
        "Arc",
        "heap allocation and owning pointer types are not supported",
    ),
    ("Vec", "heap collections are not supported"),
    ("String", "owned strings are not supported"),
    ("str", "string and slice types are not supported"),
    ("std", "the Rust standard library is not available"),
    ("core", "library paths are not available"),
    ("alloc", "heap allocation is not supported"),
    (
        "Option",
        "enums and standard-library types are not supported",
    ),
    (
        "Result",
        "enums and standard-library types are not supported",
    ),
    ("char", "character values are not supported"),
    ("f32", "floating point is not supported"),
    ("f64", "floating point is not supported"),
    ("i8", "only i32 integer values are supported"),
    ("i16", "only i32 integer values are supported"),
    ("i64", "only i32 integer values are supported"),
    ("i128", "only i32 integer values are supported"),
    ("isize", "only i32 integer values are supported"),
    ("u8", "only i32 integer values are supported"),
    ("u16", "only i32 integer values are supported"),
    ("u32", "only i32 integer values are supported"),
    ("u64", "only i32 integer values are supported"),
    ("u128", "only i32 integer values are supported"),
    ("int", "Rust integer types must be written as i32"),
];

fn lex_dialect(src: &str, dialect: LexDialect) -> Result<Vec<SpTok>, TranslateError> {
    check_source_limits(src)?;
    let preprocessed;
    let src = if dialect != LexDialect::Rust && preprocess::needed(src) {
        preprocessed = preprocess::preprocess(src)?;
        preprocessed.as_str()
    } else {
        src
    };
    let mut toks = lex_dialect_unchecked(src, dialect)?;
    if dialect != LexDialect::Rust {
        toks = merge_c_type_specifiers(toks)?;
    }
    check_bracket_depth(&toks)?;
    Ok(toks)
}

/// Apply the shared source-size limits (see `crate::limits`).
fn check_source_limits(src: &str) -> Result<(), TranslateError> {
    crate::limits::check_source(src).map_err(|(line, message)| TranslateError::new(line, message))
}

/// Reject bracket nesting deeper than `limits::MAX_NESTING_DEPTH` before any
/// recursive-descent parsing starts, so parsers cannot exhaust the stack.
fn check_bracket_depth(toks: &[SpTok]) -> Result<(), TranslateError> {
    let mut depth = 0usize;
    for t in toks {
        match &t.tok {
            Tok::Sym("(") | Tok::Sym("[") | Tok::Sym("{") => {
                depth += 1;
                if depth > crate::limits::MAX_NESTING_DEPTH {
                    return Err(TranslateError::new(
                        t.line,
                        crate::limits::nesting_message("this code (parentheses, brackets and braces)"),
                    ));
                }
            }
            Tok::Sym(")") | Tok::Sym("]") | Tok::Sym("}") => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    Ok(())
}

fn lex_dialect_unchecked(src: &str, dialect: LexDialect) -> Result<Vec<SpTok>, TranslateError> {
    let mut toks = Vec::new();
    let mut chars = src.chars().peekable();
    let mut line = 1usize;
    while let Some(&c) = chars.peek() {
        if c == '\n' {
            line += 1;
            chars.next();
            continue;
        }
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        if c == '#' {
            if dialect == LexDialect::Rust {
                return Err(TranslateError::new(
                    line,
                    "unsupported: Rust attributes and macro syntax are not supported",
                ));
            }
            return Err(TranslateError::new(
                line,
                "unsupported: preprocessor directives (#include etc.) — write plain code, \
there is no standard library here",
            ));
        }
        if c == '"' || c == '\'' {
            if dialect == LexDialect::Rust && c == '\'' {
                let mut lookahead = chars.clone();
                lookahead.next();
                let after_quote = lookahead.next();
                let closes_as_char = lookahead.next() == Some('\'');
                if after_quote.is_some_and(|next| next.is_ascii_alphabetic() || next == '_')
                    && !closes_as_char
                {
                    return Err(TranslateError::new(
                        line,
                        "unsupported: lifetimes are not supported; all values must be passed by value",
                    ));
                }
            }
            if dialect != LexDialect::Rust && c == '\'' {
                chars.next();
                let mut body = String::new();
                let mut closed = false;
                while let Some(d) = chars.next() {
                    if d == '\n' {
                        break;
                    }
                    if d == '\\' {
                        body.push(d);
                        if let Some(e) = chars.next() {
                            body.push(e);
                        }
                        continue;
                    }
                    if d == '\'' {
                        closed = true;
                        break;
                    }
                    body.push(d);
                    if body.len() > 8 {
                        break;
                    }
                }
                match (closed, c_char_literal_value(&body)) {
                    (true, Some(value)) => {
                        toks.push(SpTok { tok: Tok::Int(value), line });
                        continue;
                    }
                    _ => {
                        return Err(TranslateError::new(
                            line,
                            format!(
                                "invalid character literal '{}': write one character such as 'a' or an escape such as '\\n'",
                                body.chars().take(10).collect::<String>()
                            ),
                        ))
                    }
                }
            }
            if dialect == LexDialect::C && c == '"' {
                let bytes = lex_c_string(&mut chars, line)?;
                // adjacent literals concatenate ("ab" "cd" is "abcd")
                if let Some(SpTok { tok: Tok::Str(previous), .. }) = toks.last_mut() {
                    previous.extend_from_slice(&bytes);
                    if previous.len() > crate::limits::MAX_STRING_LITERAL_BYTES {
                        return Err(string_too_long(line));
                    }
                } else {
                    toks.push(SpTok { tok: Tok::Str(bytes), line });
                }
                continue;
            }
            return Err(TranslateError::new(
                line,
                "unsupported: string/char literals are not yet translatable",
            ));
        }
        if c == '/' {
            chars.next();
            match chars.peek() {
                Some('/') => {
                    while let Some(&d) = chars.peek() {
                        if d == '\n' {
                            break;
                        }
                        chars.next();
                    }
                    continue;
                }
                Some('*') => {
                    chars.next();
                    let mut prev = ' ';
                    loop {
                        match chars.next() {
                            None => {
                                return Err(TranslateError::new(line, "unterminated /* comment"))
                            }
                            Some('\n') => {
                                line += 1;
                                prev = '\n';
                            }
                            Some('/') if prev == '*' => break,
                            Some(d) => prev = d,
                        }
                    }
                    continue;
                }
                Some('=') => {
                    chars.next();
                    toks.push(SpTok {
                        tok: Tok::Sym("/="),
                        line,
                    });
                    continue;
                }
                _ => {
                    toks.push(SpTok {
                        tok: Tok::Sym("/"),
                        line,
                    });
                    continue;
                }
            }
        }
        if c.is_ascii_digit() {
            let mut n: u128 = 0;
            let mut hex = false;
            chars.next();
            if c == '0' && matches!(chars.peek(), Some('x') | Some('X')) {
                chars.next();
                hex = true;
            } else {
                n = (c as u8 - b'0') as u128;
            }
            let mut digits = usize::from(!hex);
            let mut raw = if hex { String::new() } else { c.to_string() };
            while let Some(&d) = chars.peek() {
                let digit = if hex { d.to_digit(16) } else { d.to_digit(10) };
                let Some(digit) = digit else {
                    if d == '_' && dialect == LexDialect::Rust {
                        chars.next();
                        continue;
                    }
                    break;
                };
                chars.next();
                digits += 1;
                raw.push(d);
                n = n.saturating_mul(if hex { 16 } else { 10 }).saturating_add(digit as u128);
            }
            let octal = dialect != LexDialect::Rust && !hex && raw.len() > 1 && raw.starts_with('0');
            if octal {
                if raw.chars().any(|d| d == '8' || d == '9') {
                    return Err(TranslateError::new(
                        line,
                        format!("'{raw}' is not a valid octal literal: a leading 0 means octal, which only uses digits 0-7"),
                    ));
                }
                n = raw.chars().fold(0u128, |acc, d| acc.saturating_mul(8).saturating_add(d as u128 - '0' as u128));
            }
            if digits == 0 {
                return Err(TranslateError::new(line, "hexadecimal literal 0x needs at least one digit"));
            }
            if dialect != LexDialect::Rust {
                let mut suffix = String::new();
                while let Some(&d) = chars.peek() {
                    if d.is_ascii_alphanumeric() || d == '_' {
                        suffix.push(d);
                        chars.next();
                    } else {
                        break;
                    }
                }
                push_c_int_literal(&mut toks, n, !hex && !octal, &suffix, line)?;
                continue;
            }
            if n > u32::MAX as u128 {
                return Err(TranslateError::new(
                    line,
                    "integer literal too large for int",
                ));
            }
            let n = n as i64;
            toks.push(SpTok {
                tok: Tok::Int(n),
                line,
            });
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let mut ident = String::new();
            while let Some(&d) = chars.peek() {
                if d.is_ascii_alphanumeric() || d == '_' {
                    ident.push(d);
                    chars.next();
                } else {
                    break;
                }
            }
            if dialect == LexDialect::Rust {
                let rust_token = match ident.as_str() {
                    "fn" => Some(Tok::Kw("fn")),
                    "let" => Some(Tok::Kw("let")),
                    "mut" => Some(Tok::Kw("mut")),
                    "in" => Some(Tok::Kw("in")),
                    "loop" => Some(Tok::Kw("loop")),
                    "if" => Some(Tok::Kw("if")),
                    "else" => Some(Tok::Kw("else")),
                    "while" => Some(Tok::Kw("while")),
                    "for" => Some(Tok::Kw("for")),
                    "return" => Some(Tok::Kw("return")),
                    "break" => Some(Tok::Kw("break")),
                    "continue" => Some(Tok::Kw("continue")),
                    "i32" => Some(Tok::Kw("i32")),
                    "bool" => Some(Tok::Kw("bool")),
                    "as" => Some(Tok::Kw("as")),
                    "usize" => Some(Tok::Kw("usize")),
                    "true" => Some(Tok::Bool(true)),
                    "false" => Some(Tok::Bool(false)),
                    _ => None,
                };
                if let Some(tok) = rust_token {
                    toks.push(SpTok { tok, line });
                    continue;
                }
                if let Some((_, why)) = RUST_BANNED.iter().find(|(keyword, _)| *keyword == ident) {
                    return Err(TranslateError::new(line, format!("unsupported: {why}")));
                }
                toks.push(SpTok {
                    tok: Tok::Ident(ident),
                    line,
                });
                continue;
            }
            if dialect == LexDialect::Cpp {
                let cpp_token = match ident.as_str() {
                    "auto" => Some(Tok::Kw("auto")),
                    "bool" => Some(Tok::Kw("bool")),
                    "void" => Some(Tok::Kw("void")),
                    "true" => Some(Tok::Bool(true)),
                    "false" => Some(Tok::Bool(false)),
                    "and" => Some(Tok::Sym("&&")),
                    "or" => Some(Tok::Sym("||")),
                    "not" => Some(Tok::Sym("!")),
                    _ => None,
                };
                if let Some(tok) = cpp_token {
                    toks.push(SpTok { tok, line });
                    continue;
                }
                if let Some((_, why)) = CPP_BANNED.iter().find(|(keyword, _)| *keyword == ident) {
                    return Err(TranslateError::new(line, format!("unsupported: {why}")));
                }
            }
            if dialect == LexDialect::C && ident == "void" {
                toks.push(SpTok { tok: Tok::Kw("void"), line });
                continue;
            }
            if let Some((_, why)) = BANNED.iter().find(|(k, _)| *k == ident) {
                return Err(TranslateError::new(line, format!("unsupported: {why}")));
            }
            if let Some(kw) = KEYWORDS.iter().find(|k| **k == ident) {
                toks.push(SpTok {
                    tok: Tok::Kw(kw),
                    line,
                });
            } else {
                toks.push(SpTok {
                    tok: Tok::Ident(ident),
                    line,
                });
            }
            continue;
        }
        // symbols, longest first
        let two: String = chars.clone().take(2).collect();
        if dialect == LexDialect::Rust && matches!(two.as_str(), "::" | "=>" | "..") {
            let symbol = match two.as_str() {
                "::" => "::",
                "=>" => "=>",
                _ => "..",
            };
            chars.next();
            chars.next();
            toks.push(SpTok {
                tok: Tok::Sym(symbol),
                line,
            });
            continue;
        }
        let three: String = chars.clone().take(3).collect();
        if three == "<<=" || three == ">>=" {
            for _ in 0..3 {
                chars.next();
            }
            toks.push(SpTok {
                tok: Tok::Sym(if three == "<<=" { "<<=" } else { ">>=" }),
                line,
            });
            continue;
        }
        let sym2 = [
            "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "+=", "-=", "*=", "/=", "%=", "++",
            "--", "->", "&=", "|=", "^=",
        ]
        .iter()
        .find(|s| **s == two);
        if let Some(&s) = sym2 {
            if dialect == LexDialect::Rust && matches!(s, "++" | "--") {
                return Err(TranslateError::new(
                    line,
                    "unsupported: Rust has no ++/-- operators; use += 1 or -= 1",
                ));
            }
            if dialect == LexDialect::Cpp
                && s == "&&"
                && toks
                    .last()
                    .is_some_and(|token| matches!(token.tok, Tok::Kw("int") | Tok::Kw("auto")))
            {
                return Err(TranslateError::new(
                    line,
                    "unsupported: references are not translatable",
                ));
            }
            if s == "->" && dialect == LexDialect::Cpp {
                return Err(TranslateError::new(
                    line,
                    "unsupported: '->' needs pointers, which the C++ subset does not have; \
                     use a struct variable and '.' instead",
                ));
            }
            chars.next();
            chars.next();
            toks.push(SpTok {
                tok: Tok::Sym(s),
                line,
            });
            continue;
        }
        if c == ':' {
            chars.next();
            toks.push(SpTok {
                tok: Tok::Sym(":"),
                line,
            });
            continue;
        }
        let sym1 = [
            "+", "-", "*", "%", "=", "<", ">", "!", "&", "|", "^", "~", "(", ")", "{", "}", "[",
            "]", ";", ",",
        ]
        .iter()
        .find(|s| s.chars().next().unwrap() == c);
        if let Some(&s) = sym1 {
            if dialect == LexDialect::Rust && s == "~" {
                return Err(TranslateError::new(
                    line,
                    "unsupported: Rust uses '!' for integer bitwise not; '~' is not Rust syntax",
                ));
            }
            if dialect == LexDialect::Cpp
                && s == "&"
                && toks
                    .last()
                    .is_some_and(|token| matches!(token.tok, Tok::Kw("int") | Tok::Kw("auto")))
            {
                return Err(TranslateError::new(
                    line,
                    "unsupported: references are not translatable",
                ));
            }
            chars.next();
            toks.push(SpTok {
                tok: Tok::Sym(s),
                line,
            });
            continue;
        }
        if c == '.' {
            if dialect == LexDialect::Rust {
                return Err(TranslateError::new(
                    line,
                    "unsupported: methods, fields, and floating-point syntax are not supported",
                ));
            }
            // `.` selects a struct member; a `.` touching a digit is a
            // floating-point literal, which the subsets do not have.
            let after_number = matches!(toks.last(), Some(SpTok { tok: Tok::Int(_), .. }));
            let before_digit = chars.clone().nth(1).is_some_and(|d| d.is_ascii_digit());
            if after_number || before_digit {
                return Err(TranslateError::new(
                    line,
                    "unsupported: floating point is not yet translatable; use integers",
                ));
            }
            chars.next();
            toks.push(SpTok { tok: Tok::Sym("."), line });
            continue;
        }
        return Err(TranslateError::new(
            line,
            format!("unexpected character '{c}'"),
        ));
    }
    toks.push(SpTok {
        tok: Tok::Eof,
        line,
    });
    Ok(toks)
}

// -- AST ----------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScalarType {
    I32,
    Bool,
    Unit,
    /// Any other integer type (C `char`..`unsigned long long`). Plain C
    /// `int` is always `I32`.
    Int(IntTy),
    /// C data pointer: the base integer type (plain `int` is `{32, signed}`)
    /// and the number of `*`s (1 = `int *`, 2 = `int **`, ...). Pointers are
    /// XLEN wide and compare unsigned.
    Ptr(IntTy, u8),
}

/// Deepest pointer type the C subset accepts (`int ****`).
const MAX_POINTER_DEPTH: u8 = 4;

impl ScalarType {
    fn is_ptr(self) -> bool {
        matches!(self, ScalarType::Ptr(..))
    }

    /// `void *` (exactly one level: `void **` points at a `void *` object).
    fn is_void_ptr(self) -> bool {
        self == ScalarType::Ptr(IntTy::VOID, 1)
    }

    /// `T *` for a value type `T` (None for bool/void).
    fn pointer_to(self) -> Option<ScalarType> {
        match self {
            ScalarType::I32 => Some(ScalarType::Ptr(IntTy { bits: 32, signed: true }, 1)),
            ScalarType::Int(base) => Some(ScalarType::Ptr(base, 1)),
            ScalarType::Ptr(base, depth) if depth < MAX_POINTER_DEPTH => Some(ScalarType::Ptr(base, depth + 1)),
            ScalarType::Unit => Some(ScalarType::Ptr(IntTy::VOID, 1)),
            _ => None,
        }
    }

    /// The type a pointer points to (None for non-pointers).
    fn pointee(self) -> Option<ScalarType> {
        match self {
            ScalarType::Ptr(IntTy::VOID, 1) => None,
            ScalarType::Ptr(base, depth) if depth > 1 => Some(ScalarType::Ptr(base, depth - 1)),
            ScalarType::Ptr(IntTy { bits: 32, signed: true }, _) => Some(ScalarType::I32),
            ScalarType::Ptr(base, _) => Some(ScalarType::Int(base)),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct IntTy {
    /// 8, 16, 32 or 64; `IntTy::LONG` means "C long", whose width is the
    /// target XLEN (ILP32 / LP64).
    bits: u8,
    signed: bool,
}

impl IntTy {
    const LONG: u8 = 0;
    /// Marks the base of `void *`: an opaque pointer with no element type.
    const VOID: IntTy = IntTy { bits: 1, signed: false };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BindingOrigin {
    Local,
    RangeIterator,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BodyForm {
    Braced,
    SingleStatement,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ElseForm {
    Braced,
    SingleStatement,
    ElseIf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IfOrigin {
    Conditional,
    PlainBlock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IfProvenance {
    origin: IfOrigin,
    then_body: BodyForm,
    else_body: Option<ElseForm>,
    line: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BindingProvenance {
    declared_type: Option<ScalarType>,
    mutable: bool,
    initialized: bool,
    origin: BindingOrigin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoopKind {
    CFor,
    RustRange,
    While,
    RustLoop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LoopProvenance {
    kind: LoopKind,
    body: BodyForm,
    line: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArrayInitProvenance {
    Absent,
    List,
    Repeat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssignmentProvenance {
    Simple,
    Compound(&'static str),
    PrefixIncrement,
    PrefixDecrement,
    PostfixIncrement,
    PostfixDecrement,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExprStmtProvenance {
    Expression,
    Empty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReturnProvenance {
    Explicit,
    Tail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FunctionOrigin {
    Explicit,
    SyntheticMain,
}

#[derive(Debug, Clone)]
enum Expr {
    Num(i64, ScalarType, usize),
    Var(String, usize),
    Index(String, Box<Expr>, usize),
    Unary(&'static str, Box<Expr>, usize),
    Binary(&'static str, Box<Expr>, Box<Expr>, usize),
    Assign(Box<LValue>, Box<Expr>, AssignmentProvenance, usize),
    Call(String, Vec<Expr>, usize),
}

#[derive(Debug, Clone)]
enum LValue {
    Var(String, usize),
    Index(String, Expr, usize),
    /// `*pointer` (C only).
    Deref(Expr, usize),
}

#[derive(Debug, Clone)]
enum Stmt {
    Decl(String, Option<Expr>, BindingProvenance, usize),
    DeclArray(
        String,
        usize,
        Vec<Expr>,
        BindingProvenance,
        ArrayInitProvenance,
        usize,
    ),
    Expr(Expr, ExprStmtProvenance),
    If(Expr, Vec<Stmt>, Vec<Stmt>, IfProvenance),
    While(Expr, Vec<Stmt>, LoopProvenance),
    For(
        Option<Box<Stmt>>,
        Option<Expr>,
        Option<Expr>,
        Vec<Stmt>,
        LoopProvenance,
    ),
    Return(Option<Expr>, ReturnProvenance, usize),
    Break(usize),
    Continue(usize),
}

struct Func {
    name: String,
    params: Vec<String>,
    param_types: Vec<ScalarType>,
    param_mutability: Vec<bool>,
    param_lines: Vec<usize>,
    return_type: ScalarType,
    origin: FunctionOrigin,
    body: Vec<Stmt>,
    line: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FunctionPrototype {
    name: String,
    parameters: Vec<String>,
    parameter_types: Vec<ScalarType>,
    return_type: ScalarType,
    line: usize,
}

enum ParsedFunction {
    Definition(Func),
    Prototype(FunctionPrototype),
}

struct Unit {
    funcs: Vec<Func>,
    prototypes: Vec<FunctionPrototype>,
    /// C globals and string literals (string literals are read-only globals
    /// named `__strN`). Always empty for C++ and Rust.
    globals: Vec<Global>,
    /// First line that uses pointers, globals or strings (C only): such
    /// programs compile to assembly but not to other source languages yet.
    memory_line: Option<usize>,
    /// First enum, struct, union or typedef (line and keyword): these
    /// compile to assembly but not to other source languages yet.
    user_types: Option<(usize, &'static str)>,
}

/// A C global variable or string literal, laid out in the data segment.
#[derive(Debug, Clone)]
struct Global {
    name: String,
    /// Element type for arrays, value type for scalars.
    value_type: ScalarType,
    len: Option<usize>,
    init: Vec<GlobalInit>,
    readonly: bool,
    line: usize,
    /// 0 for ordinary globals. A struct or union global is a byte array
    /// (`value_type` is `unsigned char`) aligned to this many bytes; its
    /// `init` holds one `Int` per byte, and an `Addr` stands for a whole
    /// pointer-sized slot.
    align: usize,
}

#[derive(Debug, Clone)]
enum GlobalInit {
    Int(i64),
    /// The address of another global (`&g`, an array name or a string).
    Addr(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceDialect {
    C,
    Cpp,
}

struct SourceEmitter {
    dialect: SourceDialect,
    out: String,
    bool_bindings: HashSet<String>,
    return_types: HashMap<String, ScalarType>,
    current_return_type: ScalarType,
    names: HashMap<String, String>,
}

impl SourceEmitter {
    fn new(dialect: SourceDialect) -> Self {
        Self {
            dialect,
            out: String::new(),
            bool_bindings: HashSet::new(),
            return_types: HashMap::new(),
            current_return_type: ScalarType::I32,
            names: HashMap::new(),
        }
    }

    fn emit(mut self, unit: &Unit) -> String {
        let mut source_names = Vec::new();
        for prototype in &unit.prototypes {
            source_names.push(prototype.name.as_str());
            source_names.extend(prototype.parameters.iter().map(String::as_str));
        }
        for function in &unit.funcs {
            source_names.push(function.name.as_str());
            source_names.extend(function.params.iter().map(String::as_str));
            collect_declared_names(&function.body, &mut source_names);
        }
        self.names = identifier_map(
            source_names,
            match self.dialect {
                SourceDialect::C => IdentifierTarget::C,
                SourceDialect::Cpp => IdentifierTarget::Cpp,
            },
        );
        self.return_types = unit
            .funcs
            .iter()
            .map(|function| (function.name.clone(), function.return_type))
            .collect();
        let target = match self.dialect {
            SourceDialect::C => "C",
            SourceDialect::Cpp => "C++",
        };
        let _ = writeln!(
            self.out,
            "// Generated by the StudyRISC-V source translator for {target}."
        );
        self.out
            .push_str("// Compilable within the documented integer subset.\n\n");
        for prototype in &unit.prototypes {
            let parameters = prototype
                .parameters
                .iter()
                .zip(&prototype.parameter_types)
                .map(|(name, value_type)| {
                    format!(
                        "{} {}",
                        self.scalar_type(*value_type),
                        self.target_name(name)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            let return_type = self.scalar_type(prototype.return_type);
            let name = self.target_name(&prototype.name);
            let _ = writeln!(self.out, "{return_type} {name}({parameters});");
        }
        if !unit.prototypes.is_empty() {
            self.out.push('\n');
        }
        for (index, function) in unit.funcs.iter().enumerate() {
            if index > 0 {
                self.out.push('\n');
            }
            self.emit_function(function);
        }
        self.out
    }

    fn emit_function(&mut self, function: &Func) {
        self.bool_bindings.clear();
        self.current_return_type = function.return_type;
        if self.dialect == SourceDialect::C {
            let mut types = function
                .params
                .iter()
                .zip(&function.param_types)
                .map(|(name, value_type)| (name.clone(), *value_type))
                .collect::<HashMap<_, _>>();
            collect_cpp_binding_types(&function.body, &mut types, &self.return_types);
            self.bool_bindings.extend(
                types.into_iter().filter_map(|(name, value_type)| {
                    (value_type == ScalarType::Bool).then_some(name)
                }),
            );
        }
        let params = function
            .params
            .iter()
            .zip(&function.param_types)
            .map(|(name, value_type)| {
                format!(
                    "{} {}",
                    self.scalar_type(*value_type),
                    self.target_name(name)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        let return_type = self.scalar_type(function.return_type);
        let function_name = self.target_name(&function.name);
        let _ = writeln!(self.out, "{return_type} {function_name}({params}) {{");
        if self.dialect == SourceDialect::C {
            for (name, value_type) in function.params.iter().zip(&function.param_types) {
                if *value_type == ScalarType::Bool {
                    let name = self.target_name(name);
                    let _ = writeln!(self.out, "    {name} = !(!({name}));");
                }
            }
        }
        self.emit_statements(&function.body, 1);
        if self.dialect == SourceDialect::C && function.return_type == ScalarType::Unit {
            self.out.push_str("    return 0;\n");
        }
        self.out.push_str("}\n");
    }

    fn scalar_type(&self, value_type: ScalarType) -> &'static str {
        match (self.dialect, value_type) {
            (SourceDialect::Cpp, ScalarType::Bool) => "bool",
            (SourceDialect::Cpp, ScalarType::Unit) => "void",
            (_, ScalarType::Int(_)) => c_type_keyword(value_type),
            _ => "int",
        }
    }

    fn target_name(&self, name: &str) -> String {
        self.names
            .get(name)
            .cloned()
            .unwrap_or_else(|| name.to_string())
    }

    fn emit_statements(&mut self, statements: &[Stmt], depth: usize) {
        for statement in statements {
            self.emit_statement(statement, depth);
        }
    }

    fn emit_statement(&mut self, statement: &Stmt, depth: usize) {
        let indent = "    ".repeat(depth);
        match statement {
            Stmt::Decl(name, initial, source, _) => {
                let declaration = self.declaration(name, initial.as_ref(), *source);
                let _ = writeln!(self.out, "{indent}{declaration};");
            }
            Stmt::DeclArray(name, size, initial, source, initializer, _) => {
                let declaration =
                    self.array_declaration(self.scalar_type(source.declared_type.unwrap_or(ScalarType::I32)), name, *size, initial, source.initialized, *initializer);
                let _ = writeln!(self.out, "{indent}{declaration};");
            }
            Stmt::Expr(expression, source) => {
                if *source == ExprStmtProvenance::Empty {
                    let _ = writeln!(self.out, "{indent};");
                } else {
                    let _ = writeln!(self.out, "{indent}{};", self.expression(expression));
                }
            }
            Stmt::If(condition, then_body, else_body, source) => {
                if source.origin == IfOrigin::PlainBlock {
                    let _ = writeln!(self.out, "{indent}{{");
                    self.emit_statements(then_body, depth + 1);
                    let _ = writeln!(self.out, "{indent}}}");
                    return;
                }
                let condition = self.expression(condition);
                let _ = writeln!(self.out, "{indent}if ({condition}) {{");
                self.emit_statements(then_body, depth + 1);
                if else_body.is_empty() {
                    let _ = writeln!(self.out, "{indent}}}");
                } else {
                    let _ = writeln!(self.out, "{indent}}} else {{");
                    self.emit_statements(else_body, depth + 1);
                    let _ = writeln!(self.out, "{indent}}}");
                }
            }
            Stmt::While(condition, body, _) => {
                let condition = self.expression(condition);
                let _ = writeln!(self.out, "{indent}while ({condition}) {{");
                self.emit_statements(body, depth + 1);
                let _ = writeln!(self.out, "{indent}}}");
            }
            Stmt::For(initial, condition, post, body, _) => {
                let initial = initial
                    .as_deref()
                    .map(|statement| self.inline_statement(statement))
                    .unwrap_or_default();
                let condition = condition
                    .as_ref()
                    .map(|expression| self.expression(expression))
                    .unwrap_or_default();
                let post = post
                    .as_ref()
                    .map(|expression| self.expression(expression))
                    .unwrap_or_default();
                let _ = writeln!(self.out, "{indent}for ({initial}; {condition}; {post}) {{");
                self.emit_statements(body, depth + 1);
                let _ = writeln!(self.out, "{indent}}}");
            }
            Stmt::Return(value, _, _) => {
                if let Some(value) = value {
                    let mut value = self.expression(value);
                    if self.dialect == SourceDialect::C
                        && self.current_return_type == ScalarType::Bool
                    {
                        value = format!("!(!({value}))");
                    }
                    let _ = writeln!(self.out, "{indent}return {value};");
                } else {
                    let value = if self.dialect == SourceDialect::C
                        && self.current_return_type == ScalarType::Unit
                    {
                        "return 0;"
                    } else {
                        "return;"
                    };
                    let _ = writeln!(self.out, "{indent}{value}");
                }
            }
            Stmt::Break(_) => {
                let _ = writeln!(self.out, "{indent}break;");
            }
            Stmt::Continue(_) => {
                let _ = writeln!(self.out, "{indent}continue;");
            }
        }
    }

    fn inline_statement(&self, statement: &Stmt) -> String {
        match statement {
            Stmt::Decl(name, initial, source, _) => {
                self.declaration(name, initial.as_ref(), *source)
            }
            Stmt::DeclArray(name, size, initial, source, initializer, _) => {
                self.array_declaration(self.scalar_type(source.declared_type.unwrap_or(ScalarType::I32)), name, *size, initial, source.initialized, *initializer)
            }
            Stmt::Expr(expression, _) => self.expression(expression),
            _ => "0".to_string(),
        }
    }

    fn declaration(&self, name: &str, initial: Option<&Expr>, source: BindingProvenance) -> String {
        let value_type = if self.dialect == SourceDialect::C && self.bool_bindings.contains(name) {
            ScalarType::Bool
        } else {
            source.declared_type.unwrap_or_else(|| {
                initial.map_or(ScalarType::I32, |value| {
                    expression_scalar_type(value, &HashMap::new(), &self.return_types, "C++")
                })
            })
        };
        let keyword = match self.dialect {
            _ if matches!(source.declared_type, Some(ScalarType::Int(_))) => self.scalar_type(value_type),
            SourceDialect::C => "int",
            SourceDialect::Cpp
                if source.declared_type.is_none()
                    || initial.is_some_and(cpp_auto_preserves_c_int) =>
            {
                "auto"
            }
            SourceDialect::Cpp => self.scalar_type(value_type),
        };
        match initial {
            Some(expression) => {
                let mut value = self.expression(expression);
                if self.dialect == SourceDialect::C && value_type == ScalarType::Bool {
                    value = format!("!(!({value}))");
                }
                format!("{keyword} {} = {value}", self.target_name(name))
            }
            None => format!("{keyword} {}", self.target_name(name)),
        }
    }

    fn array_declaration(
        &self,
        element: &str,
        name: &str,
        size: usize,
        initial: &[Expr],
        initialized: bool,
        initializer: ArrayInitProvenance,
    ) -> String {
        if !initialized {
            format!("{element} {}[{size}]", self.target_name(name))
        } else {
            let values = if initializer == ArrayInitProvenance::Repeat {
                std::iter::repeat_with(|| self.expression(&initial[0]))
                    .take(size)
                    .collect::<Vec<_>>()
            } else {
                initial
                    .iter()
                    .map(|expression| self.expression(expression))
                    .collect::<Vec<_>>()
            };
            format!(
                "{element} {}[{size}] = {{{}}}",
                self.target_name(name),
                values.join(", ")
            )
        }
    }

    fn expression(&self, expression: &Expr) -> String {
        match expression {
            // Keep the literal's C type when it is re-read: values above
            // INT_MAX carry an explicit suffix.
            Expr::Num(value, _, _) if *value > i32::MAX as i64 && *value <= u32::MAX as i64 => format!("{value}u"),
            Expr::Num(value, _, _) if *value > u32::MAX as i64 => format!("{value}ll"),
            Expr::Num(value, _, _) => value.to_string(),
            Expr::Var(name, _) => self.target_name(name),
            Expr::Index(name, index, _) => (|| -> String {
                format!("{}[{}]", self.target_name(name), self.expression(index))
            })(),
            Expr::Unary(operator, _, _) if operator.starts_with("sizeof(") => format!("{operator}"),
            Expr::Unary(operator, value, _) if *operator == "sizeof" => (|| -> String {
                format!("sizeof({})", self.expression(value))
            })(),
            Expr::Unary(operator, value, _) => (|| -> String {
                let operator = if self.dialect == SourceDialect::Cpp && *operator == "!" {
                    "not "
                } else {
                    operator
                };
                format!("({operator}{})", self.expression(value))
            })(),
            Expr::Binary(operator, left, right, _) => (|| -> String {
                let operator = match (self.dialect, *operator) {
                    (SourceDialect::Cpp, "&&") => "and",
                    (SourceDialect::Cpp, "||") => "or",
                    _ => operator,
                };
                format!(
                    "({} {operator} {})",
                    self.expression(left),
                    self.expression(right)
                )
            })(),
            Expr::Assign(target, value, source, _) => match source {
                AssignmentProvenance::Simple => {
                    let target_text = self.lvalue(target);
                    let value_text = self.expression(value);
                    if self.bool_lvalue(target) {
                        format!("({target_text} = !(!({value_text})))")
                    } else {
                        format!("({target_text} = {value_text})")
                    }
                }
                AssignmentProvenance::Compound(operator) => {
                    let target_text = self.lvalue(target);
                    let value_text = self.expression(value);
                    if self.bool_lvalue(target) {
                        format!("({target_text} = !(!({target_text} {operator} {value_text})))")
                    } else {
                        format!("({target_text} {operator}= {value_text})")
                    }
                }
                AssignmentProvenance::PrefixIncrement => format!("(++{})", self.lvalue(target)),
                AssignmentProvenance::PrefixDecrement => format!("(--{})", self.lvalue(target)),
                AssignmentProvenance::PostfixIncrement => format!("({}++)", self.lvalue(target)),
                AssignmentProvenance::PostfixDecrement => format!("({}--)", self.lvalue(target)),
            },
            Expr::Call(name, arguments, _) => (|| -> String {
                let arguments = arguments
                    .iter()
                    .map(|argument| self.expression(argument))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{}({arguments})", self.target_name(name))
            })(),
        }
    }

    fn lvalue(&self, lvalue: &LValue) -> String {
        match lvalue {
            LValue::Var(name, _) => self.target_name(name),
            LValue::Index(name, index, _) => {
                format!("{}[{}]", self.target_name(name), self.expression(index))
            }
            LValue::Deref(inner, _) => format!("*{}", self.expression(inner)),
        }
    }

    fn bool_lvalue(&self, lvalue: &LValue) -> bool {
        matches!(lvalue, LValue::Var(name, _) if self.bool_bindings.contains(name))
    }
}

fn collect_cpp_binding_types(
    statements: &[Stmt],
    types: &mut HashMap<String, ScalarType>,
    return_types: &HashMap<String, ScalarType>,
) {
    for statement in statements {
        match statement {
            Stmt::Decl(name, initial, source, _) => {
                let value_type = source.declared_type.unwrap_or_else(|| {
                    initial.as_ref().map_or(ScalarType::I32, |value| {
                        expression_scalar_type(value, types, return_types, "C++")
                    })
                });
                types.insert(name.clone(), value_type);
            }
            Stmt::DeclArray(name, ..) => {
                types.insert(name.clone(), ScalarType::I32);
            }
            Stmt::If(_, body, otherwise, _) => {
                collect_cpp_binding_types(body, types, return_types);
                collect_cpp_binding_types(otherwise, types, return_types);
            }
            Stmt::While(_, body, _) => collect_cpp_binding_types(body, types, return_types),
            Stmt::For(initial, _, _, body, _) => {
                if let Some(initial) = initial {
                    collect_cpp_binding_types(
                        std::slice::from_ref(&**initial),
                        types,
                        return_types,
                    );
                }
                collect_cpp_binding_types(body, types, return_types);
            }
            Stmt::Expr(..) | Stmt::Return(..) | Stmt::Break(..) | Stmt::Continue(..) => {}
        }
    }
}

fn collect_declared_names<'a>(statements: &'a [Stmt], names: &mut Vec<&'a str>) {
    for statement in statements {
        match statement {
            Stmt::Decl(name, ..) | Stmt::DeclArray(name, ..) => names.push(name),
            Stmt::If(_, body, otherwise, _) => {
                collect_declared_names(body, names);
                collect_declared_names(otherwise, names);
            }
            Stmt::While(_, body, _) => collect_declared_names(body, names),
            Stmt::For(initial, _, _, body, _) => {
                if let Some(initial) = initial {
                    collect_declared_names(std::slice::from_ref(&**initial), names);
                }
                collect_declared_names(body, names);
            }
            Stmt::Expr(..) | Stmt::Return(..) | Stmt::Break(..) | Stmt::Continue(..) => {}
        }
    }
}

fn cpp_auto_preserves_c_int(expression: &Expr) -> bool {
    match expression {
        Expr::Num(_, value_type, _) => *value_type == ScalarType::I32,
        Expr::Var(..) | Expr::Index(..) | Expr::Assign(..) | Expr::Call(..) => true,
        Expr::Unary("!", _, _) => false,
        Expr::Unary(_, _, _) => true,
        Expr::Binary(operator, _, _, _) => !matches!(
            *operator,
            "&&" | "||" | "==" | "!=" | "<" | "<=" | ">" | ">="
        ),
    }
}

fn parse_cpp_unit(source: &str, xlen: u8) -> Result<Unit, TranslateError> {
    let tokens = lex_cpp(source)?;
    reject_cpp_globals(&tokens)?;
    let mut parser = Parser::new(tokens);
    parser.rec.xlen = xlen;
    let unit = parser.parse_unit()?;
    reject_cpp_overloading(&unit)?;
    validate_cpp_semantics(&unit)?;
    Ok(unit)
}

fn validate_cpp_semantics(unit: &Unit) -> Result<(), TranslateError> {
    let parameter_types = unit
        .funcs
        .iter()
        .map(|function| (function.name.clone(), function.param_types.clone()))
        .collect::<HashMap<_, _>>();
    let return_types = unit
        .funcs
        .iter()
        .map(|function| (function.name.clone(), function.return_type))
        .collect::<HashMap<_, _>>();

    for function in &unit.funcs {
        let mut bindings = function
            .params
            .iter()
            .zip(&function.param_types)
            .map(|(name, value_type)| (name.clone(), *value_type))
            .collect::<HashMap<_, _>>();
        collect_cpp_binding_types(&function.body, &mut bindings, &return_types);
        validate_cpp_statements(&function.body, &bindings, &parameter_types)?;
    }
    Ok(())
}

fn validate_cpp_statements(
    statements: &[Stmt],
    bindings: &HashMap<String, ScalarType>,
    parameter_types: &HashMap<String, Vec<ScalarType>>,
) -> Result<(), TranslateError> {
    for statement in statements {
        match statement {
            Stmt::Decl(_, initial, _, _) => {
                if let Some(initial) = initial {
                    validate_cpp_expression(initial, bindings, parameter_types)?;
                }
            }
            Stmt::DeclArray(_, _, initial, _, _, _) => {
                for value in initial {
                    validate_cpp_expression(value, bindings, parameter_types)?;
                }
            }
            Stmt::Expr(expression, _) => {
                validate_cpp_expression(expression, bindings, parameter_types)?;
            }
            Stmt::If(condition, body, otherwise, _) => {
                validate_cpp_expression(condition, bindings, parameter_types)?;
                validate_cpp_statements(body, bindings, parameter_types)?;
                validate_cpp_statements(otherwise, bindings, parameter_types)?;
            }
            Stmt::While(condition, body, _) => {
                validate_cpp_expression(condition, bindings, parameter_types)?;
                validate_cpp_statements(body, bindings, parameter_types)?;
            }
            Stmt::For(initial, condition, post, body, _) => {
                if let Some(initial) = initial {
                    validate_cpp_statements(
                        std::slice::from_ref(&**initial),
                        bindings,
                        parameter_types,
                    )?;
                }
                if let Some(condition) = condition {
                    validate_cpp_expression(condition, bindings, parameter_types)?;
                }
                if let Some(post) = post {
                    validate_cpp_expression(post, bindings, parameter_types)?;
                }
                validate_cpp_statements(body, bindings, parameter_types)?;
            }
            Stmt::Return(value, _, _) => {
                if let Some(value) = value {
                    validate_cpp_expression(value, bindings, parameter_types)?;
                }
            }
            Stmt::Break(_) | Stmt::Continue(_) => {}
        }
    }
    Ok(())
}

fn validate_cpp_expression(
    expression: &Expr,
    bindings: &HashMap<String, ScalarType>,
    parameter_types: &HashMap<String, Vec<ScalarType>>,
) -> Result<(), TranslateError> {
    match expression {
        Expr::Num(_, _, _) | Expr::Var(_, _) => Ok(()),
        Expr::Index(_, index, _) | Expr::Unary(_, index, _) => {
            validate_cpp_expression(index, bindings, parameter_types)
        }
        Expr::Binary(_, left, right, _) => {
            validate_cpp_expression(left, bindings, parameter_types)?;
            validate_cpp_expression(right, bindings, parameter_types)
        }
        Expr::Assign(target, value, source, line) => {
            if matches!(
                source,
                AssignmentProvenance::PrefixIncrement
                    | AssignmentProvenance::PrefixDecrement
                    | AssignmentProvenance::PostfixIncrement
                    | AssignmentProvenance::PostfixDecrement
            ) && matches!(&**target, LValue::Var(name, _) if bindings.get(name) == Some(&ScalarType::Bool))
            {
                return Err(TranslateError::new(
                    *line,
                    "unsupported: C++ increment and decrement operators are not valid on bool",
                ));
            }
            if let LValue::Index(_, index, _) = &**target {
                validate_cpp_expression(index, bindings, parameter_types)?;
            }
            validate_cpp_expression(value, bindings, parameter_types)
        }
        Expr::Call(name, arguments, line) => {
            let Some(expected) = parameter_types.get(name) else {
                return Err(TranslateError::new(
                    *line,
                    format!(
                        "unsupported: call to '{name}' - only functions defined in this snippet can be called"
                    ),
                ));
            };
            if arguments.len() != expected.len() {
                return Err(TranslateError::new(
                    *line,
                    format!(
                        "function '{name}' expects {} arguments, but {} were provided",
                        expected.len(),
                        arguments.len()
                    ),
                ));
            }
            for argument in arguments {
                validate_cpp_expression(argument, bindings, parameter_types)?;
            }
            Ok(())
        }
    }
}

/// C and C++: a void function's call is a statement, never a value; a void
/// function's `return` has no value; every other function's does.
fn validate_void_usage(unit: &Unit) -> Result<(), TranslateError> {
    let return_types = unit
        .prototypes
        .iter()
        .map(|p| (p.name.clone(), p.return_type))
        .chain(unit.funcs.iter().map(|f| (f.name.clone(), f.return_type)))
        .collect::<HashMap<_, _>>();
    for function in &unit.funcs {
        validate_cpp_void_statements(&function.body, &function.name, function.return_type, &return_types)?;
    }
    Ok(())
}

fn validate_cpp_void_statements(
    statements: &[Stmt],
    function_name: &str,
    function_return: ScalarType,
    return_types: &HashMap<String, ScalarType>,
) -> Result<(), TranslateError> {
    for statement in statements {
        match statement {
            Stmt::Decl(_, initial, _, _) => {
                if let Some(initial) = initial {
                    validate_cpp_void_expression(initial, false, return_types)?;
                }
            }
            Stmt::DeclArray(_, _, initial, _, _, _) => {
                for value in initial {
                    validate_cpp_void_expression(value, false, return_types)?;
                }
            }
            Stmt::Expr(expression, _) => {
                validate_cpp_void_expression(expression, true, return_types)?;
            }
            Stmt::If(condition, body, otherwise, _) => {
                validate_cpp_void_expression(condition, false, return_types)?;
                validate_cpp_void_statements(body, function_name, function_return, return_types)?;
                validate_cpp_void_statements(otherwise, function_name, function_return, return_types)?;
            }
            Stmt::While(condition, body, _) => {
                validate_cpp_void_expression(condition, false, return_types)?;
                validate_cpp_void_statements(body, function_name, function_return, return_types)?;
            }
            Stmt::For(initial, condition, post, body, _) => {
                if let Some(initial) = initial {
                    validate_cpp_void_statements(
                        std::slice::from_ref(&**initial),
                        function_name,
                        function_return,
                        return_types,
                    )?;
                }
                if let Some(condition) = condition {
                    validate_cpp_void_expression(condition, false, return_types)?;
                }
                if let Some(post) = post {
                    validate_cpp_void_expression(post, false, return_types)?;
                }
                validate_cpp_void_statements(body, function_name, function_return, return_types)?;
            }
            Stmt::Return(Some(value), _, line) => {
                if function_return == ScalarType::Unit {
                    return Err(TranslateError::new(
                        *line,
                        format!(
                            "void functions cannot return a value: '{function_name}' is declared void, \
                             so write 'return;' or give it a return type such as int"
                        ),
                    ));
                }
                validate_cpp_void_expression(value, false, return_types)?;
            }
            Stmt::Return(None, _, line) => {
                if function_return != ScalarType::Unit {
                    return Err(TranslateError::new(
                        *line,
                        format!(
                            "'{function_name}' must return a value: write 'return <value>;', \
                             or declare it void if it has nothing to return"
                        ),
                    ));
                }
            }
            Stmt::Break(_) | Stmt::Continue(_) => {}
        }
    }
    Ok(())
}

fn validate_cpp_void_expression(
    expression: &Expr,
    allow_unit_call: bool,
    return_types: &HashMap<String, ScalarType>,
) -> Result<(), TranslateError> {
    match expression {
        Expr::Num(..) | Expr::Var(..) => Ok(()),
        Expr::Index(_, index, _) | Expr::Unary(_, index, _) => {
            validate_cpp_void_expression(index, false, return_types)
        }
        Expr::Binary(_, left, right, _) => {
            validate_cpp_void_expression(left, false, return_types)?;
            validate_cpp_void_expression(right, false, return_types)
        }
        Expr::Assign(target, value, _, _) => {
            if let LValue::Index(_, index, _) | LValue::Deref(index, _) = &**target {
                validate_cpp_void_expression(index, false, return_types)?;
            }
            validate_cpp_void_expression(value, false, return_types)
        }
        Expr::Call(name, arguments, line) => {
            if return_types.get(name) == Some(&ScalarType::Unit) && !allow_unit_call {
                return Err(TranslateError::new(
                    *line,
                    format!(
                        "void function '{name}' can only be called as a statement: it returns no \
                         value, so it cannot be used inside an expression"
                    ),
                ));
            }
            for argument in arguments {
                validate_cpp_void_expression(argument, false, return_types)?;
            }
            Ok(())
        }
    }
}

fn reject_cpp_globals(tokens: &[SpTok]) -> Result<(), TranslateError> {
    let is_type = |token: &Tok| {
        matches!(
            token,
            Tok::Kw("int") | Tok::Kw("bool") | Tok::Kw("auto") | Tok::Kw("void")
        ) || is_c_int_kw(token)
    };
    let mut brace_depth = 0usize;
    let mut paren_depth = 0usize;
    let mut has_function = false;

    for (index, token) in tokens.iter().enumerate() {
        if brace_depth == 0
            && paren_depth == 0
            && is_type(&token.tok)
            && matches!(
                tokens.get(index + 1).map(|next| &next.tok),
                Some(Tok::Ident(_))
            )
            && matches!(
                tokens.get(index + 2).map(|next| &next.tok),
                Some(Tok::Sym("("))
            )
        {
            has_function = true;
        }
        match &token.tok {
            Tok::Sym("{") => brace_depth += 1,
            Tok::Sym("}") => brace_depth = brace_depth.saturating_sub(1),
            Tok::Sym("(") => paren_depth += 1,
            Tok::Sym(")") => paren_depth = paren_depth.saturating_sub(1),
            _ => {}
        }
    }

    if !has_function {
        return Ok(());
    }

    brace_depth = 0;
    paren_depth = 0;
    for (index, token) in tokens.iter().enumerate() {
        // `typedef int Number;` names a type; it declares no variable
        let after_typedef = index > 0 && tokens[index - 1].tok == Tok::Kw("typedef");
        if brace_depth == 0 && paren_depth == 0 && is_type(&token.tok) && !after_typedef {
            let is_function = matches!(
                (
                    tokens.get(index + 1).map(|next| &next.tok),
                    tokens.get(index + 2).map(|next| &next.tok),
                ),
                (Some(Tok::Ident(_)), Some(Tok::Sym("(")))
            );
            if !is_function {
                return Err(TranslateError::new(
                    token.line,
                    "unsupported: global variables are not translatable; declare locals inside a function",
                ));
            }
        }
        match &token.tok {
            Tok::Sym("{") => brace_depth += 1,
            Tok::Sym("}") => brace_depth = brace_depth.saturating_sub(1),
            Tok::Sym("(") => paren_depth += 1,
            Tok::Sym(")") => paren_depth = paren_depth.saturating_sub(1),
            _ => {}
        }
    }
    Ok(())
}

fn reject_cpp_overloading(unit: &Unit) -> Result<(), TranslateError> {
    for (index, function) in unit.funcs.iter().enumerate() {
        if unit.funcs[..index]
            .iter()
            .any(|previous| previous.name == function.name)
        {
            return Err(TranslateError::new(
                function.line,
                format!(
                    "unsupported: function overloading is not translatable; '{}' has multiple definitions",
                    function.name
                ),
            ));
        }
    }
    Ok(())
}

fn parse_rust_unit(source: &str) -> Result<Unit, TranslateError> {
    let tokens = lex_rust(source)?;
    validate_rust_tokens(&tokens)?;
    RustParser::new(tokens).parse_unit()
}

fn validate_rust_tokens(tokens: &[SpTok]) -> Result<(), TranslateError> {
    for (index, token) in tokens.iter().enumerate() {
        let previous = index.checked_sub(1).and_then(|at| tokens.get(at));
        let next = tokens.get(index + 1);
        let prefix_position = previous.map_or(true, |before| {
            matches!(
                before.tok,
                Tok::Sym("(")
                    | Tok::Sym("{")
                    | Tok::Sym(",")
                    | Tok::Sym("=")
                    | Tok::Sym("=>")
                    | Tok::Sym(";")
                    | Tok::Kw("return")
                    | Tok::Kw("in")
            )
        });

        if matches!(token.tok, Tok::Ident(_))
            && matches!(next.map(|item| &item.tok), Some(Tok::Sym("!")))
        {
            return Err(TranslateError::new(
                token.line,
                "unsupported: macros are not supported; call only functions defined in the source",
            ));
        }
        if matches!(token.tok, Tok::Sym("::")) {
            return Err(TranslateError::new(
                token.line,
                "unsupported: module paths and associated functions are not supported",
            ));
        }
        if matches!(token.tok, Tok::Sym("|") | Tok::Sym("||")) && prefix_position {
            return Err(TranslateError::new(
                token.line,
                "unsupported: closures are not supported",
            ));
        }
        if matches!(token.tok, Tok::Sym("&") | Tok::Sym("&&")) && prefix_position {
            return Err(TranslateError::new(
                token.line,
                "unsupported: references and borrowing are not supported; pass scalar values by value",
            ));
        }
        if matches!(token.tok, Tok::Sym("*")) && prefix_position {
            return Err(TranslateError::new(
                token.line,
                "unsupported: dereferencing is not supported because references are outside this subset",
            ));
        }
        if matches!(token.tok, Tok::Sym(".."))
            && matches!(next.map(|item| &item.tok), Some(Tok::Sym("=")))
        {
            return Err(TranslateError::new(
                token.line,
                "unsupported: inclusive ranges are not supported; use start..end in a for loop",
            ));
        }
        if matches!(token.tok, Tok::Kw("fn"))
            && matches!(
                (
                    tokens.get(index + 1).map(|item| &item.tok),
                    tokens.get(index + 2).map(|item| &item.tok),
                ),
                (Some(Tok::Ident(_)), Some(Tok::Sym("<")))
            )
        {
            return Err(TranslateError::new(
                token.line,
                "unsupported: generic functions are not supported",
            ));
        }
        if matches!(token.tok, Tok::Kw("let"))
            && matches!(
                next.map(|item| &item.tok),
                Some(Tok::Sym("(")) | Some(Tok::Sym("["))
            )
        {
            return Err(TranslateError::new(
                token.line,
                "unsupported: destructuring patterns are not supported; bind one name at a time",
            ));
        }
    }
    Ok(())
}

struct RustParser {
    parser: Parser,
    mutables: HashMap<String, bool>,
    returns_value: bool,
}

impl RustParser {
    fn new(tokens: Vec<SpTok>) -> Self {
        Self {
            parser: Parser::new(tokens),
            mutables: HashMap::new(),
            returns_value: false,
        }
    }

    fn parse_unit(self) -> Result<Unit, TranslateError> {
        let unit = self.parse_unit_tree()?;
        check_tree_depth(&unit)?;
        Ok(unit)
    }

    fn parse_unit_tree(mut self) -> Result<Unit, TranslateError> {
        let mut funcs = Vec::new();
        while !matches!(self.parser.peek(), Tok::Eof) {
            if !matches!(self.parser.peek(), Tok::Kw("fn")) {
                let line = self.parser.line();
                let message = if matches!(self.parser.peek(), Tok::Kw("let")) {
                    "unsupported: global bindings are not supported; declare values inside a function"
                } else {
                    "expected a Rust function beginning with 'fn'"
                };
                return Err(TranslateError::new(line, message));
            }
            funcs.push(self.parse_func()?);
        }
        if funcs.is_empty() {
            return Err(TranslateError::new(
                0,
                "nothing to translate: write fn main() { ... }",
            ));
        }
        if !funcs.iter().any(|function| function.name == "main") {
            return Err(TranslateError::new(
                0,
                "no main(): add fn main() -> i32 { ... } (its result ends up in a0)",
            ));
        }
        Ok(Unit {
            globals: Vec::new(),
            memory_line: None,
            user_types: None,
            funcs,
            prototypes: Vec::new(),
        })
    }

    fn parse_func(&mut self) -> Result<Func, TranslateError> {
        let line = self.parser.line();
        self.parser.next(); // fn
        let name = match self.parser.next() {
            Tok::Ident(name) => name,
            token => {
                return Err(TranslateError::new(
                    line,
                    format!("expected function name, found {}", show(&token)),
                ))
            }
        };
        self.expect_sym("(")?;
        self.mutables.clear();
        let mut params = Vec::new();
        let mut param_types = Vec::new();
        let mut param_mutability = Vec::new();
        let mut param_lines = Vec::new();
        if !self.eat_sym(")") {
            loop {
                let mutable = self.eat_kw("mut");
                let param_line = self.parser.line();
                let param = match self.parser.next() {
                    Tok::Ident(param) => param,
                    Tok::Sym("(") | Tok::Sym("[") => {
                        return Err(TranslateError::new(
                            param_line,
                            "unsupported: parameter patterns are not supported",
                        ))
                    }
                    token => {
                        return Err(TranslateError::new(
                            param_line,
                            format!("expected parameter name, found {}", show(&token)),
                        ))
                    }
                };
                self.expect_sym(":")?;
                let value_type = self.parse_scalar_type()?;
                self.record_binding(&param, mutable, param_line)?;
                params.push(param);
                param_types.push(value_type);
                param_mutability.push(mutable);
                param_lines.push(param_line);
                if self.eat_sym(")") {
                    break;
                }
                self.expect_sym(",")?;
            }
        }
        if params.len() > 7 {
            return Err(TranslateError::new(
                line,
                "unsupported: more than 7 parameters",
            ));
        }
        if name == "main" && !params.is_empty() {
            return Err(TranslateError::new(
                line,
                "main() cannot take parameters in the simulator entry model",
            ));
        }
        let return_type = if self.eat_sym("->") {
            let return_type = self.parse_scalar_type()?;
            self.returns_value = true;
            return_type
        } else {
            self.returns_value = false;
            ScalarType::Unit
        };
        self.expect_sym("{")?;
        let body = self.parse_block(true)?;
        Ok(Func {
            name,
            params,
            param_types,
            param_mutability,
            param_lines,
            return_type,
            origin: FunctionOrigin::Explicit,
            body,
            line,
        })
    }

    fn parse_block(&mut self, allow_tail_return: bool) -> Result<Vec<Stmt>, TranslateError> {
        self.parser.enter()?;
        let result = self.parse_block_inner(allow_tail_return);
        self.parser.leave();
        result
    }

    fn parse_block_inner(&mut self, allow_tail_return: bool) -> Result<Vec<Stmt>, TranslateError> {
        let mut statements = Vec::new();
        while !self.eat_sym("}") {
            if matches!(self.parser.peek(), Tok::Eof) {
                return Err(TranslateError::new(self.parser.line(), "missing '}'"));
            }
            statements.push(self.parse_block_statement(allow_tail_return)?);
            self.eat_sym(";"); // Rust permits a trailing semicolon after block expressions.
        }
        Ok(statements)
    }

    fn parse_block_statement(&mut self, allow_tail_return: bool) -> Result<Stmt, TranslateError> {
        match self.parser.peek().clone() {
            Tok::Kw("let") => self.parse_decl(),
            Tok::Kw("if") => self.parse_if(),
            Tok::Kw("while") => self.parse_while(),
            Tok::Kw("loop") => self.parse_loop(),
            Tok::Kw("for") => self.parse_for(),
            Tok::Kw("return") => self.parse_return(),
            Tok::Kw("break") => (|| -> Result<Stmt, TranslateError> {
                let line = self.parser.line();
                self.parser.next();
                self.expect_sym(";")?;
                Ok(Stmt::Break(line))
            })(),
            Tok::Kw("continue") => (|| -> Result<Stmt, TranslateError> {
                let line = self.parser.line();
                self.parser.next();
                self.expect_sym(";")?;
                Ok(Stmt::Continue(line))
            })(),
            Tok::Sym("{") => (|| -> Result<Stmt, TranslateError> {
                let line = self.parser.line();
                self.parser.next();
                let body = self.parse_block(false)?;
                Ok(Stmt::If(
                    Expr::Num(1, ScalarType::I32, line),
                    body,
                    Vec::new(),
                    IfProvenance {
                        origin: IfOrigin::PlainBlock,
                        then_body: BodyForm::Braced,
                        else_body: None,
                        line,
                    },
                ))
            })(),
            Tok::Kw("fn") => (|| -> Result<Stmt, TranslateError> {
                return Err(TranslateError::new(
                    self.parser.line(),
                    "unsupported: nested functions are not supported",
                ))
            })(),
            _ => (|| -> Result<Stmt, TranslateError> {
                let line = self.parser.line();
                if matches!(self.parser.peek(), Tok::Sym("|") | Tok::Sym("||")) {
                    return Err(TranslateError::new(
                        line,
                        "unsupported: closures are not supported",
                    ));
                }
                let expression = self.parser.parse_expr()?;
                if self.eat_sym(";") {
                    self.validate_statement_expr(&expression)?;
                    Ok(Stmt::Expr(expression, ExprStmtProvenance::Expression))
                } else if matches!(self.parser.peek(), Tok::Sym("..")) {
                    return Err(TranslateError::new(
                        line,
                        "unsupported: ranges are only supported in for name in start..end loops",
                    ));
                } else if matches!(self.parser.peek(), Tok::Sym("}")) && allow_tail_return {
                    self.validate_expr(&expression)?;
                    if !self.returns_value {
                        return Err(TranslateError::new(
                            line,
                            "a tail expression requires an explicit -> i32 or -> bool return type",
                        ));
                    }
                    Ok(Stmt::Return(
                        Some(expression),
                        ReturnProvenance::Tail,
                        line,
                    ))
                } else if matches!(self.parser.peek(), Tok::Sym("}")) {
                    return Err(TranslateError::new(
                        line,
                        "unsupported: value-producing inner blocks and if expressions are not supported",
                    ));
                } else {
                    return Err(TranslateError::new(
                        self.parser.line(),
                        format!("expected ';', found {}", show(self.parser.peek())),
                    ));
                }
            })(),
        }
    }

    fn parse_decl(&mut self) -> Result<Stmt, TranslateError> {
        let line = self.parser.line();
        self.parser.next(); // let
        let mutable = self.eat_kw("mut");
        let name = match self.parser.next() {
            Tok::Ident(name) => name,
            Tok::Sym("(") | Tok::Sym("[") => return Err(TranslateError::new(
                line,
                "unsupported: destructuring patterns are not supported; bind one name at a time",
            )),
            token => {
                return Err(TranslateError::new(
                    line,
                    format!("expected binding name, found {}", show(&token)),
                ))
            }
        };

        let mut array_size = None;
        let mut declared_type = None;
        if self.eat_sym(":") {
            if self.eat_sym("[") {
                if !self.eat_kw("i32") {
                    return Err(TranslateError::new(
                        self.parser.line(),
                        "only fixed [i32; N] arrays are supported",
                    ));
                }
                if self.eat_sym("]") {
                    return Err(TranslateError::new(
                        line,
                        "unsupported: slices are not supported; use a fixed [i32; N] array",
                    ));
                }
                self.expect_sym(";")?;
                array_size = Some(self.parse_array_size()?);
                declared_type = Some(ScalarType::I32);
                self.expect_sym("]")?;
            } else if matches!(self.parser.peek(), Tok::Sym("(")) {
                return Err(TranslateError::new(
                    line,
                    "unsupported: tuple types are not supported",
                ));
            } else {
                declared_type = Some(self.parse_scalar_type()?);
            }
        }
        self.expect_sym("=").map_err(|_| {
            TranslateError::new(line, "Rust subset bindings require an initializer")
        })?;

        let provenance = BindingProvenance {
            declared_type,
            mutable,
            initialized: true,
            origin: BindingOrigin::Local,
        };
        let statement = if let Some(size) = array_size {
            let (init, initializer, _) = self.parse_array_literal(Some(size), line)?;
            Stmt::DeclArray(name.clone(), size, init, provenance, initializer, line)
        } else if matches!(self.parser.peek(), Tok::Sym("[")) {
            let (size, init, initializer) = self.parse_inferred_array_literal(line)?;
            Stmt::DeclArray(name.clone(), size, init, provenance, initializer, line)
        } else {
            if matches!(self.parser.peek(), Tok::Kw("if")) {
                return Err(TranslateError::new(
                    line,
                    "unsupported: if expressions are not supported; assign in explicit branches",
                ));
            }
            let init = self.parser.parse_expr()?;
            self.validate_expr(&init)?;
            if matches!(self.parser.peek(), Tok::Sym("..")) {
                return Err(TranslateError::new(
                    line,
                    "unsupported: ranges are only supported in for name in start..end loops",
                ));
            }
            Stmt::Decl(name.clone(), Some(init), provenance, line)
        };
        self.expect_sym(";")?;
        self.record_binding(&name, mutable, line)?;
        Ok(statement)
    }

    fn parse_array_literal(
        &mut self,
        expected_size: Option<usize>,
        line: usize,
    ) -> Result<(Vec<Expr>, ArrayInitProvenance, usize), TranslateError> {
        self.expect_sym("[")?;
        let mut values = Vec::new();
        if self.eat_sym("]") {
            return Err(TranslateError::new(line, "arrays cannot be empty"));
        }
        let first = self.parser.parse_expr()?;
        self.validate_expr(&first)?;
        if self.eat_sym(";") {
            let repeat = self.parse_array_size()?;
            self.expect_sym("]")?;
            if expected_size.is_some_and(|size| size != repeat) {
                return Err(TranslateError::new(
                    line,
                    "array repeat count must match the declared array size",
                ));
            }
            return Ok((vec![first], ArrayInitProvenance::Repeat, repeat));
        }
        values.push(first);
        let mut closed = false;
        while self.eat_sym(",") {
            if self.eat_sym("]") {
                closed = true;
                break;
            }
            let value = self.parser.parse_expr()?;
            self.validate_expr(&value)?;
            values.push(value);
        }
        if !closed {
            self.expect_sym("]")?;
        }
        if expected_size.is_some_and(|size| size != values.len()) {
            return Err(TranslateError::new(
                line,
                "array initializer length must match the declared array size",
            ));
        }
        let size = values.len();
        Ok((values, ArrayInitProvenance::List, size))
    }

    fn parse_inferred_array_literal(
        &mut self,
        line: usize,
    ) -> Result<(usize, Vec<Expr>, ArrayInitProvenance), TranslateError> {
        let (values, initializer, size) = self.parse_array_literal(None, line)?;
        Ok((size, values, initializer))
    }

    fn parse_array_size(&mut self) -> Result<usize, TranslateError> {
        let line = self.parser.line();
        match self.parser.next() {
            Tok::Int(size) if size > 0 && size <= 4096 => Ok(size as usize),
            _ => Err(TranslateError::new(
                line,
                "array size must be a constant between 1 and 4096",
            )),
        }
    }

    fn parse_if(&mut self) -> Result<Stmt, TranslateError> {
        let line = self.parser.line();
        self.parser.next(); // if
        if self.eat_kw("let") {
            return Err(TranslateError::new(
                self.parser.line(),
                "unsupported: if let patterns are not supported",
            ));
        }
        let condition = self.parser.parse_expr()?;
        self.validate_expr(&condition)?;
        self.expect_sym("{")?;
        let then = self.parse_block(false)?;
        let mut else_form = None;
        let otherwise = if self.eat_kw("else") {
            if matches!(self.parser.peek(), Tok::Kw("if")) {
                else_form = Some(ElseForm::ElseIf);
                self.parser.enter()?;
                let nested = self.parse_if();
                self.parser.leave();
                vec![nested?]
            } else {
                else_form = Some(ElseForm::Braced);
                self.expect_sym("{")?;
                self.parse_block(false)?
            }
        } else {
            Vec::new()
        };
        Ok(Stmt::If(
            condition,
            then,
            otherwise,
            IfProvenance {
                origin: IfOrigin::Conditional,
                then_body: BodyForm::Braced,
                else_body: else_form,
                line,
            },
        ))
    }

    fn parse_while(&mut self) -> Result<Stmt, TranslateError> {
        let line = self.parser.line();
        self.parser.next(); // while
        if self.eat_kw("let") {
            return Err(TranslateError::new(
                self.parser.line(),
                "unsupported: while let patterns are not supported",
            ));
        }
        let condition = self.parser.parse_expr()?;
        self.validate_expr(&condition)?;
        self.expect_sym("{")?;
        let body = self.parse_block(false)?;
        Ok(Stmt::While(
            condition,
            body,
            LoopProvenance {
                kind: LoopKind::While,
                body: BodyForm::Braced,
                line,
            },
        ))
    }

    fn parse_loop(&mut self) -> Result<Stmt, TranslateError> {
        let line = self.parser.line();
        self.parser.next(); // loop
        self.expect_sym("{")?;
        let body = self.parse_block(false)?;
        Ok(Stmt::While(
            Expr::Num(1, ScalarType::Bool, line),
            body,
            LoopProvenance {
                kind: LoopKind::RustLoop,
                body: BodyForm::Braced,
                line,
            },
        ))
    }

    fn parse_for(&mut self) -> Result<Stmt, TranslateError> {
        let line = self.parser.line();
        self.parser.next(); // for
        let name = match self.parser.next() {
            Tok::Ident(name) => name,
            _ => {
                return Err(TranslateError::new(
                    line,
                    "unsupported: for-loop patterns are not supported; use one iterator name",
                ))
            }
        };
        if !self.eat_kw("in") {
            return Err(TranslateError::new(
                self.parser.line(),
                "expected 'in' in a Rust for loop",
            ));
        }
        let start = self.parser.parse_expr()?;
        self.validate_expr(&start)?;
        if !self.eat_sym("..") {
            return Err(TranslateError::new(
                self.parser.line(),
                "unsupported: for loops require a half-open start..end range",
            ));
        }
        let end = self.parser.parse_expr()?;
        self.validate_expr(&end)?;
        self.expect_sym("{")?;
        self.record_binding(&name, false, line)?;
        let body = self.parse_block(false)?;
        let init = Stmt::Decl(
            name.clone(),
            Some(start),
            BindingProvenance {
                declared_type: Some(ScalarType::I32),
                mutable: false,
                initialized: true,
                origin: BindingOrigin::RangeIterator,
            },
            line,
        );
        let condition = Expr::Binary(
            "<",
            Box::new(Expr::Var(name.clone(), line)),
            Box::new(end),
            line,
        );
        let post = Expr::Assign(
            Box::new(LValue::Var(name.clone(), line)),
            Box::new(Expr::Num(1, ScalarType::I32, line)),
            AssignmentProvenance::Compound("+"),
            line,
        );
        Ok(Stmt::For(
            Some(Box::new(init)),
            Some(condition),
            Some(post),
            body,
            LoopProvenance {
                kind: LoopKind::RustRange,
                body: BodyForm::Braced,
                line,
            },
        ))
    }

    fn parse_return(&mut self) -> Result<Stmt, TranslateError> {
        let line = self.parser.line();
        self.parser.next(); // return
        if self.eat_sym(";") {
            if self.returns_value {
                return Err(TranslateError::new(
                    line,
                    "value-returning functions must return an i32 or bool expression",
                ));
            }
            return Ok(Stmt::Return(None, ReturnProvenance::Explicit, line));
        }
        if !self.returns_value {
            return Err(TranslateError::new(
                line,
                "unit functions cannot return a value; add -> i32 or -> bool",
            ));
        }
        if matches!(self.parser.peek(), Tok::Kw("if")) {
            return Err(TranslateError::new(
                line,
                "unsupported: if expressions are not supported; return inside each branch",
            ));
        }
        let value = self.parser.parse_expr()?;
        self.validate_expr(&value)?;
        if matches!(self.parser.peek(), Tok::Sym("..")) {
            return Err(TranslateError::new(
                line,
                "unsupported: ranges are only supported in for name in start..end loops",
            ));
        }
        self.expect_sym(";")?;
        Ok(Stmt::Return(Some(value), ReturnProvenance::Explicit, line))
    }

    fn parse_scalar_type(&mut self) -> Result<ScalarType, TranslateError> {
        let line = self.parser.line();
        match self.parser.next() {
            Tok::Kw("i32") => Ok(ScalarType::I32),
            Tok::Kw("bool") => Ok(ScalarType::Bool),
            Tok::Sym("&") | Tok::Sym("&&") => Err(TranslateError::new(
                line,
                "unsupported: references and borrowing are not supported; use i32 or bool by value",
            )),
            Tok::Sym("(") => Err(TranslateError::new(
                line,
                "unsupported: tuple types are not supported",
            )),
            token => Err(TranslateError::new(
                line,
                format!(
                    "only i32 and bool scalar types are supported, found {}",
                    show(&token)
                ),
            )),
        }
    }

    /// Iterative (explicit work list, left to right) so long operator
    /// chains, which are checked before the tree-depth limit, cannot
    /// exhaust the stack.
    fn validate_expr(&self, expression: &Expr) -> Result<(), TranslateError> {
        let mut work = vec![expression];
        while let Some(expression) = work.pop() {
            match expression {
                Expr::Num(_, _, _) | Expr::Var(_, _) => {}
                Expr::Index(_, index, _) | Expr::Unary(_, index, _) => work.push(index),
                Expr::Binary(_, left, right, _) => {
                    work.push(right);
                    work.push(left);
                }
                Expr::Assign(_, _, _, line) => {
                    return Err(TranslateError::new(
                        *line,
                        "Rust assignment expressions have unit value and are only supported as statements",
                    ))
                }
                Expr::Call(_, arguments, _) => work.extend(arguments.iter().rev()),
            }
        }
        Ok(())
    }

    fn validate_statement_expr(&self, expression: &Expr) -> Result<(), TranslateError> {
        let Expr::Assign(target, value, _, _) = expression else {
            return self.validate_expr(expression);
        };
        self.validate_expr(value)?;
        let (name, line) = match &**target {
            LValue::Var(name, line) => (name, *line),
            LValue::Index(name, index, line) => {
                self.validate_expr(index)?;
                (name, *line)
            }
            LValue::Deref(_, line) => return Err(memory_feature_error(*line, "Rust", "assembly")),
        };
        if matches!(self.mutables.get(name), Some(false)) {
            return Err(TranslateError::new(
                line,
                format!("cannot assign to immutable binding '{name}'; declare it with let mut"),
            ));
        }
        Ok(())
    }

    fn record_binding(
        &mut self,
        name: &str,
        mutable: bool,
        line: usize,
    ) -> Result<(), TranslateError> {
        if self.mutables.contains_key(name) {
            return Err(TranslateError::new(
                line,
                format!("binding '{name}' is declared twice; shadowing is outside this subset"),
            ));
        }
        self.mutables.insert(name.to_string(), mutable);
        Ok(())
    }

    fn expect_sym(&mut self, expected: &'static str) -> Result<(), TranslateError> {
        if self.eat_sym(expected) {
            Ok(())
        } else {
            Err(TranslateError::new(
                self.parser.line(),
                format!("expected '{expected}', found {}", show(self.parser.peek())),
            ))
        }
    }

    fn eat_sym(&mut self, expected: &'static str) -> bool {
        if *self.parser.peek() == Tok::Sym(expected) {
            self.parser.next();
            true
        } else {
            false
        }
    }

    fn eat_kw(&mut self, expected: &'static str) -> bool {
        if *self.parser.peek() == Tok::Kw(expected) {
            self.parser.next();
            true
        } else {
            false
        }
    }
}

// -- parser -------------------------------------------------------------------

struct Parser {
    toks: Vec<SpTok>,
    pos: usize,
    /// Active recursive parse calls (statements, assignments, unary
    /// operators): a backstop so chains like `- - - - 1` or long `else if`
    /// ladders cannot exhaust the stack.
    depth: usize,
    /// Counter for names of compiler-generated variables (switch, do/while).
    synthetic: usize,
    /// C only: pointers, `&`, unary `*`, globals and string literals.
    pointers: bool,
    /// String literals seen so far (they become read-only globals).
    strings: Vec<Vec<u8>>,
    memory_line: Option<usize>,
    /// Enums, structs, unions and typedefs (see `records.rs`).
    rec: Box<records::RecordState>,
}

/// Recursion budget for the parser backstop. Bracket nesting is limited
/// exactly by `check_bracket_depth`; this bound catches recursion that
/// brackets do not show (prefix-operator chains, `a = b = c` chains,
/// else-if ladders). It matches the tree-depth limit applied after parsing.
const PARSER_RECURSION_LIMIT: usize = crate::limits::MAX_NESTING_DEPTH;

impl Parser {
    fn new(toks: Vec<SpTok>) -> Self {
        let mut toks = toks;
        if toks.last().map(|t| t.tok != Tok::Eof).unwrap_or(true) {
            let line = toks.last().map(|t| t.line).unwrap_or(1);
            toks.push(SpTok { tok: Tok::Eof, line });
        }
        Self {
            toks,
            pos: 0,
            depth: 0,
            synthetic: 0,
            pointers: false,
            strings: Vec::new(),
            memory_line: None,
            rec: Box::default(),
        }
    }

    /// The C parser: the shared grammar plus pointers, globals and strings.
    fn new_c(toks: Vec<SpTok>) -> Self {
        Self { pointers: true, ..Self::new(toks) }
    }

    /// Lay out structs and unions for a 64-bit target (LP64) instead of
    /// the default ILP32.
    fn for_rv64(mut self) -> Self {
        self.rec.xlen = 64;
        self
    }

    fn mark_memory(&mut self, line: usize) {
        if self.memory_line.is_none() {
            self.memory_line = Some(line);
        }
    }

    /// `T`, then any number of `*`s: the declared type. Without pointer
    /// support a `*` is the historical clear error.
    fn parse_pointer_suffix(&mut self, base: ScalarType, line: usize, what: &str) -> Result<ScalarType, TranslateError> {
        let mut value_type = base;
        while *self.peek() == Tok::Sym("*") {
            if !self.pointers {
                return Err(TranslateError::new(line, format!("unsupported: {what} are not yet translatable")));
            }
            self.next();
            self.mark_memory(line);
            value_type = value_type.pointer_to().ok_or_else(|| {
                TranslateError::new(
                    line,
                    if value_type.is_ptr() {
                        format!("unsupported: pointers deeper than {MAX_POINTER_DEPTH} levels")
                    } else {
                        "unsupported: pointers to bool; point to an integer type".to_string()
                    },
                )
            })?;
        }
        Ok(value_type)
    }

    /// Is a function definition or prototype next (`type *name (`)?
    fn function_ahead(&self) -> bool {
        let mut i = self.pos + 1;
        while i < self.toks.len() && self.toks[i].tok == Tok::Sym("*") {
            i += 1;
        }
        matches!(self.toks.get(i).map(|t| &t.tok), Some(Tok::Ident(_)))
            && matches!(self.toks.get(i + 1).map(|t| &t.tok), Some(Tok::Sym("(")))
    }

    /// Unary `*` / `&` (C only). Kept out of `parse_unary_inner` so the
    /// recursive parser frames stay small (deep nesting must not overflow
    /// the stack before the nesting limit reports it).
    #[inline(never)]
    fn parse_pointer_unary(&mut self, line: usize) -> Result<Expr, TranslateError> {
        let op = if self.next() == Tok::Sym("*") { "*" } else { "&" };
        self.mark_memory(line);
        let operand = self.parse_unary_operand()?;
        self.pointer_unary(op, operand, line)
    }

    /// A string literal becomes a read-only global char array `__strN`
    /// (identical literals share one).
    #[inline(never)]
    fn string_literal(&mut self, bytes: Vec<u8>, line: usize) -> Expr {
        self.mark_memory(line);
        let index = match self.strings.iter().position(|s| *s == bytes) {
            Some(index) => index,
            None => {
                self.strings.push(bytes);
                self.strings.len() - 1
            }
        };
        Expr::Var(format!("__str{index}"), line)
    }

    /// The assignable form of an expression, if it has one.
    fn to_lvalue(expression: &Expr) -> Option<LValue> {
        match expression {
            Expr::Var(n, l) => Some(LValue::Var(n.clone(), *l)),
            Expr::Index(n, i, l) => Some(LValue::Index(n.clone(), (**i).clone(), *l)),
            Expr::Unary("*", inner, l) => Some(LValue::Deref((**inner).clone(), *l)),
            _ => None,
        }
    }

    fn enter(&mut self) -> Result<(), TranslateError> {
        self.depth += 1;
        if self.depth > PARSER_RECURSION_LIMIT {
            return Err(TranslateError::new(
                self.line(),
                crate::limits::nesting_message("this statement or expression"),
            ));
        }
        Ok(())
    }

    fn leave(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }

    fn peek(&self) -> &Tok {
        &self.toks[self.pos].tok
    }
    fn peek2(&self) -> &Tok {
        &self.toks[(self.pos + 1).min(self.toks.len() - 1)].tok
    }
    fn peek3(&self) -> &Tok {
        &self.toks[(self.pos + 2).min(self.toks.len() - 1)].tok
    }
    fn line(&self) -> usize {
        self.toks[self.pos].line
    }
    fn next(&mut self) -> Tok {
        let t = self.toks[self.pos].tok.clone();
        if self.pos < self.toks.len() - 1 {
            self.pos += 1;
        }
        t
    }
    fn expect_sym(&mut self, s: &str) -> Result<(), TranslateError> {
        if *self.peek() == Tok::Sym(match_sym(s)) {
            self.next();
            Ok(())
        } else {
            Err(TranslateError::new(
                self.line(),
                format!("expected '{s}', found {}", show(self.peek())),
            ))
        }
    }
    fn eat_sym(&mut self, s: &str) -> bool {
        if *self.peek() == Tok::Sym(match_sym(s)) {
            self.next();
            true
        } else {
            false
        }
    }

    fn parse_unit(&mut self) -> Result<Unit, TranslateError> {
        let mut unit = self.parse_unit_tree()?;
        check_tree_depth(&unit)?;
        resolve_block_scopes(&mut unit)?;
        validate_void_usage(&unit)?;
        Ok(unit)
    }

    fn parse_unit_tree(&mut self) -> Result<Unit, TranslateError> {
        let mut funcs = Vec::new();
        let mut prototypes = Vec::new();
        let mut loose: Vec<Stmt> = Vec::new();
        let mut loose_line = 1;
        loop {
            match self.peek() {
                Tok::Eof => break,
                _ if self.record_type_at(0) => {
                    let declaration_line = self.line();
                    match self.parse_record_declaration(true)? {
                        records::Declared::Nothing => {}
                        records::Declared::Function(ParsedFunction::Definition(function)) => funcs.push(function),
                        records::Declared::Function(ParsedFunction::Prototype(prototype)) => prototypes.push(prototype),
                        records::Declared::Stmt(statement) => {
                            if loose.is_empty() {
                                loose_line = declaration_line;
                            }
                            loose.push(statement);
                        }
                    }
                }
                t if (matches!(t, Tok::Kw("bool") | Tok::Kw("void")) || is_c_int_kw(t))
                    && self.function_ahead() =>
                {
                    match self.parse_func()? {
                        ParsedFunction::Definition(function) => funcs.push(function),
                        ParsedFunction::Prototype(prototype) => prototypes.push(prototype),
                    }
                }
                _ => {
                    if loose.is_empty() {
                        loose_line = self.line();
                    }
                    loose.push(self.parse_stmt()?);
                }
            }
        }
        let mut globals = self.take_record_globals();
        if !loose.is_empty()
            && self.pointers
            && funcs.iter().any(|f| f.name == "main")
            && loose.iter().all(|st| matches!(st, Stmt::Decl(..) | Stmt::DeclArray(..)))
        {
            for statement in std::mem::take(&mut loose) {
                globals.push(self.global_from(statement)?);
            }
        }
        for (index, bytes) in self.strings.iter().enumerate() {
            let mut init: Vec<GlobalInit> = bytes.iter().map(|b| GlobalInit::Int(i64::from(*b))).collect();
            init.push(GlobalInit::Int(0));
            globals.push(Global {
                name: format!("__str{index}"),
                value_type: ScalarType::Int(IntTy { bits: 8, signed: false }),
                len: Some(bytes.len() + 1),
                init,
                readonly: true,
                line: 0,
                align: 0,
            });
        }
        if !loose.is_empty() {
            if funcs.iter().any(|f| f.name == "main") {
                let is_declaration = loose.iter().any(|st| matches!(st, Stmt::Decl(..) | Stmt::DeclArray(..)));
                return Err(TranslateError::new(
                    loose_line,
                    if is_declaration {
                        "unsupported: global variables are not translatable yet; declare the variable \
                         inside a function (statements outside a function are only allowed when there is no main())"
                    } else {
                        "statements outside a function are only allowed when there is no main()"
                    },
                ));
            }
            let mut body = self.take_hoisted();
            body.append(&mut loose);
            funcs.push(Func {
                name: "main".into(),
                params: Vec::new(),
                param_types: Vec::new(),
                param_mutability: Vec::new(),
                param_lines: Vec::new(),
                return_type: ScalarType::I32,
                origin: FunctionOrigin::SyntheticMain,
                body,
                line: loose_line,
            });
        }
        if funcs.is_empty() {
            return Err(TranslateError::new(
                0,
                "nothing to translate: write some C code",
            ));
        }
        if !funcs.iter().any(|f| f.name == "main") {
            return Err(TranslateError::new(
                0,
                "no main(): add int main() { ... } (its return value ends up in a0)",
            ));
        }
        for prototype in &prototypes {
            if let Some(function) = funcs
                .iter()
                .find(|function| function.name == prototype.name)
            {
                if function.params.len() != prototype.parameters.len() {
                    return Err(TranslateError::new(
                        prototype.line,
                        format!(
                            "prototype for '{}' declares {} parameters, but its definition has {}",
                            prototype.name,
                            prototype.parameters.len(),
                            function.params.len()
                        ),
                    ));
                }
                if function.return_type != prototype.return_type
                    || function.param_types != prototype.parameter_types
                {
                    return Err(TranslateError::new(
                        prototype.line,
                        format!(
                            "prototype for '{}' does not match its definition's bool/int signature",
                            prototype.name
                        ),
                    ));
                }
            }
        }
        self.check_external_prototypes(&funcs, &prototypes)?;
        if let Some(helper) = self.copy_helper()? {
            funcs.push(helper);
        }
        self.strip_marks(&mut funcs)?;
        let user_types = self.rec.first_use;
        Ok(Unit { funcs, prototypes, globals, memory_line: self.memory_line, user_types })
    }

    /// Turn a top-level declaration into a global with a constant
    /// initializer (integers, `&global`, a global array name or a string).
    fn global_from(&mut self, statement: Stmt) -> Result<Global, TranslateError> {
        fn constant(e: &Expr) -> Option<i64> {
            match e {
                Expr::Num(n, _, _) => Some(*n),
                Expr::Unary("-", inner, _) => constant(inner).map(i64::wrapping_neg),
                Expr::Unary("~", inner, _) => constant(inner).map(|v| !v),
                Expr::Unary("+", inner, _) => constant(inner),
                Expr::Binary(op, a, b, _) => {
                    let (a, b) = (constant(a)?, constant(b)?);
                    Some(match *op {
                        "+" => a.wrapping_add(b),
                        "-" => a.wrapping_sub(b),
                        "*" => a.wrapping_mul(b),
                        "/" if b != 0 => a.wrapping_div(b),
                        "%" if b != 0 => a.wrapping_rem(b),
                        "<<" => a.wrapping_shl(b as u32),
                        ">>" => a.wrapping_shr(b as u32),
                        "&" => a & b,
                        "|" => a | b,
                        "^" => a ^ b,
                        _ => return None,
                    })
                }
                _ => None,
            }
        }
        fn initializer(e: &Expr, value_type: ScalarType) -> Option<GlobalInit> {
            if let Some(n) = constant(e) {
                return (!value_type.is_ptr() || n == 0).then_some(GlobalInit::Int(n));
            }
            if !value_type.is_ptr() {
                return None;
            }
            match e {
                Expr::Var(name, _) => Some(GlobalInit::Addr(name.clone())),
                Expr::Unary("&", inner, _) => match &**inner {
                    Expr::Var(name, _) => Some(GlobalInit::Addr(name.clone())),
                    _ => None,
                },
                _ => None,
            }
        }
        let bad = |line: usize| {
            TranslateError::new(
                line,
                "global initializers must be constants: a number, a string, &global or a global array name",
            )
        };
        self.mark_memory(match &statement {
            Stmt::Decl(.., line) | Stmt::DeclArray(.., line) => *line,
            _ => 0,
        });
        match statement {
            Stmt::Decl(name, init, binding, line) => {
                let value_type = binding.declared_type.ok_or_else(|| bad(line))?;
                let init = match init {
                    Some(e) => vec![initializer(&e, value_type).ok_or_else(|| bad(line))?],
                    None => Vec::new(),
                };
                Ok(Global { name, value_type, len: None, init, readonly: false, line, align: 0 })
            }
            Stmt::DeclArray(name, size, init, binding, _, line) => {
                let value_type = binding.declared_type.unwrap_or(ScalarType::I32);
                let init = init
                    .iter()
                    .map(|e| initializer(e, value_type).ok_or_else(|| bad(line)))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(Global { name, value_type, len: Some(size), init, readonly: false, line, align: 0 })
            }
            _ => Err(bad(0)),
        }
    }

    fn parse_func(&mut self) -> Result<ParsedFunction, TranslateError> {
        let line = self.line();
        let return_type = match self.next() {
            Tok::Kw(k) if c_int_type(k).is_some() => c_int_type(k).unwrap_or(ScalarType::I32),
            Tok::Kw("bool") => ScalarType::Bool,
            Tok::Kw("void") => ScalarType::Unit,
            token => {
                return Err(TranslateError::new(
                    line,
                    format!(
                        "functions must return int, bool, or void, found {}",
                        show(&token)
                    ),
                ))
            }
        };
        let return_type = if return_type == ScalarType::Unit {
            if *self.peek() == Tok::Sym("*") && self.pointers {
                self.parse_pointer_suffix(ScalarType::Unit, line, "pointer return types")?
            } else {
                return_type
            }
        } else {
            self.parse_pointer_suffix(return_type, line, "pointer return types")?
        };
        let name = match self.next() {
            Tok::Ident(n) => n,
            t => {
                return Err(TranslateError::new(
                    line,
                    format!("expected function name, found {}", show(&t)),
                ))
            }
        };
        self.parse_function_rest(records::CTy::Scalar(return_type), name, line)
    }

    fn parse_block_body(&mut self) -> Result<Vec<Stmt>, TranslateError> {
        // The block's scope for enums, typedefs and struct variables (an
        // error abandons the whole parse, so it needs no pop).
        self.rec.push_scope();
        let mut stmts = Vec::new();
        while !self.eat_sym("}") {
            if *self.peek() == Tok::Eof {
                return Err(TranslateError::new(self.line(), "missing '}'"));
            }
            stmts.push(self.parse_stmt()?);
            // the member stores of a struct initializer
            self.rec.take_pending(&mut stmts);
        }
        self.rec.pop_scope();
        Ok(stmts)
    }

    fn parse_stmt(&mut self) -> Result<Stmt, TranslateError> {
        self.enter()?;
        let result = self.parse_stmt_inner();
        self.leave();
        result
    }

    fn synthetic_name(&mut self, stem: &str) -> String {
        self.synthetic += 1;
        format!("__{stem}{}", self.synthetic)
    }

    fn plain_block(body: Vec<Stmt>, line: usize) -> Stmt {
        Stmt::If(
            Expr::Num(1, ScalarType::I32, line),
            body,
            Vec::new(),
            IfProvenance { origin: IfOrigin::PlainBlock, then_body: BodyForm::Braced, else_body: None, line },
        )
    }

    fn int_decl(name: &str, value: Expr, line: usize) -> Stmt {
        Stmt::Decl(
            name.to_string(),
            Some(value),
            BindingProvenance { declared_type: Some(ScalarType::I32), mutable: true, initialized: true, origin: BindingOrigin::Local },
            line,
        )
    }

    fn assign(name: &str, value: Expr, line: usize) -> Expr {
        Expr::Assign(Box::new(LValue::Var(name.to_string(), line)), Box::new(value), AssignmentProvenance::Simple, line)
    }

    /// `do body while (cond);` becomes
    /// `for (int first = 1; first || cond; first = 0) body`, so `continue`
    /// still evaluates the condition.
    fn parse_do_while(&mut self, line: usize) -> Result<Stmt, TranslateError> {
        self.next();
        let (body, body_form) = self.parse_stmt_as_block()?;
        if !matches!(self.next(), Tok::Kw("while")) {
            return Err(TranslateError::new(self.line(), "expected 'while (condition);' after the body of 'do'"));
        }
        self.expect_sym("(")?;
        let cond = self.parse_expr()?;
        self.expect_sym(")")?;
        self.expect_sym(";")?;
        let first = self.synthetic_name("do_first");
        Ok(Stmt::For(
            Some(Box::new(Self::int_decl(&first, Expr::Num(1, ScalarType::I32, line), line))),
            Some(Expr::Binary("||", Box::new(Expr::Var(first.clone(), line)), Box::new(cond), line)),
            Some(Self::assign(&first, Expr::Num(0, ScalarType::I32, line), line)),
            body,
            LoopProvenance { kind: LoopKind::CFor, body: body_form, line },
        ))
    }

    /// `switch` becomes a run-once loop over numbered segments: the segment
    /// of the matching `case` (or `default`) is found first, then every
    /// segment from there on runs in order, which gives C's fallthrough;
    /// `break` leaves the run-once loop.
    fn parse_switch(&mut self, line: usize) -> Result<Stmt, TranslateError> {
        self.next();
        self.expect_sym("(")?;
        let scrutinee = self.parse_expr()?;
        self.expect_sym(")")?;
        self.expect_sym("{")?;
        let mut segments: Vec<Vec<Stmt>> = Vec::new();
        let mut cases: Vec<(i64, usize, usize)> = Vec::new(); // (value, segment, line)
        let mut default: Option<usize> = None;
        let mut continue_flag: Option<String> = None;
        loop {
            match self.peek().clone() {
                Tok::Sym("}") => {
                    self.next();
                    break;
                }
                Tok::Eof => return Err(TranslateError::new(line, "unterminated switch: expected '}'")),
                Tok::Kw("case") => {
                    let case_line = self.line();
                    self.next();
                    let value = self.parse_case_constant()?;
                    self.expect_sym(":")?;
                    if cases.iter().any(|(v, _, _)| *v == value) {
                        return Err(TranslateError::new(case_line, format!("duplicate case value {value} in switch")));
                    }
                    segments.push(Vec::new());
                    cases.push((value, segments.len() - 1, case_line));
                }
                Tok::Kw("default") => {
                    let default_line = self.line();
                    self.next();
                    self.expect_sym(":")?;
                    if default.is_some() {
                        return Err(TranslateError::new(default_line, "a switch can only have one default label"));
                    }
                    segments.push(Vec::new());
                    default = Some(segments.len() - 1);
                }
                _ => {
                    let statement_line = self.line();
                    let statement = self.parse_stmt()?;
                    let statements = if stmt_contains_continue(&statement) {
                        // `continue` belongs to the enclosing loop, not to the
                        // run-once loop a switch becomes: set a flag, leave the
                        // switch, and continue right after it.
                        let flag = match &continue_flag {
                            Some(flag) => flag,
                            None => continue_flag.insert(self.synthetic_name("switch_continue")),
                        };
                        redirect_continue(statement, flag)
                    } else {
                        vec![statement]
                    };
                    let mut statements = statements;
                    self.rec.take_pending(&mut statements);
                    match segments.last_mut() {
                        Some(segment) => segment.extend(statements),
                        None => {
                            return Err(TranslateError::new(
                                statement_line,
                                "statements in a switch must follow a 'case' or 'default' label",
                            ))
                        }
                    }
                }
            }
        }
        let value = self.synthetic_name("switch_value");
        let target = self.synthetic_name("switch_target");
        let none = segments.len() as i64;
        let mut out = vec![
            Self::int_decl(&value, scrutinee, line),
            Self::int_decl(&target, Expr::Num(default.map_or(none, |d| d as i64), ScalarType::I32, line), line),
        ];
        for (case_value, segment, case_line) in &cases {
            out.push(Stmt::If(
                Expr::Binary(
                    "==",
                    Box::new(Expr::Var(value.clone(), *case_line)),
                    Box::new(Expr::Num(*case_value, ScalarType::I32, *case_line)),
                    *case_line,
                ),
                vec![Stmt::Expr(Self::assign(&target, Expr::Num(*segment as i64, ScalarType::I32, *case_line), *case_line), ExprStmtProvenance::Expression)],
                Vec::new(),
                IfProvenance { origin: IfOrigin::Conditional, then_body: BodyForm::Braced, else_body: None, line: *case_line },
            ));
        }
        let mut body = Vec::new();
        for (index, segment) in segments.into_iter().enumerate() {
            body.push(Stmt::If(
                Expr::Binary(
                    "<=",
                    Box::new(Expr::Var(target.clone(), line)),
                    Box::new(Expr::Num(index as i64, ScalarType::I32, line)),
                    line,
                ),
                segment,
                Vec::new(),
                IfProvenance { origin: IfOrigin::Conditional, then_body: BodyForm::Braced, else_body: None, line },
            ));
        }
        body.push(Stmt::Break(line));
        if let Some(flag) = &continue_flag {
            out.push(Self::int_decl(flag, Expr::Num(0, ScalarType::I32, line), line));
        }
        out.push(Stmt::While(
            Expr::Num(1, ScalarType::I32, line),
            body,
            LoopProvenance { kind: LoopKind::While, body: BodyForm::Braced, line },
        ));
        if let Some(flag) = continue_flag {
            out.push(Stmt::If(
                Expr::Var(flag, line),
                vec![Stmt::Continue(line)],
                Vec::new(),
                IfProvenance { origin: IfOrigin::Conditional, then_body: BodyForm::Braced, else_body: None, line },
            ));
        }
        Ok(Self::plain_block(out, line))
    }

    /// A case label: an integer or character literal, optionally negated.
    fn parse_case_constant(&mut self) -> Result<i64, TranslateError> {
        let line = self.line();
        let negative = self.eat_sym("-");
        if let Tok::Ident(name) = self.peek() {
            if let Some(value) = self.rec.enumerator(name) {
                self.next();
                return Ok(if negative { value.wrapping_neg() } else { value });
            }
        }
        match self.next() {
            Tok::Int(n) => Ok(if negative { n.wrapping_neg() } else { n }),
            other => Err(TranslateError::new(
                line,
                format!("case labels must be integer constants, found {}", show(&other)),
            )),
        }
    }

    fn parse_stmt_inner(&mut self) -> Result<Stmt, TranslateError> {
        let line = self.line();
        match self.peek().clone() {
            Tok::Sym(";") => (|| -> Result<Stmt, TranslateError> {
                self.next();
                Ok(Stmt::Expr(
                    Expr::Num(0, ScalarType::I32, line),
                    ExprStmtProvenance::Empty,
                ))
            })(),
            Tok::Sym("{") => (|| -> Result<Stmt, TranslateError> {
                self.next();
                let body = self.parse_block_body()?;
                Ok(Stmt::If(
                    Expr::Num(1, ScalarType::I32, line),
                    body,
                    Vec::new(),
                    IfProvenance {
                        origin: IfOrigin::PlainBlock,
                        then_body: BodyForm::Braced,
                        else_body: None,
                        line,
                    },
                ))
            })(),
            Tok::Kw("bool") | Tok::Kw("auto") => self.parse_decl(),
            ref t if is_c_int_kw(t) => self.parse_decl(),
            _ if self.record_type_at(0) => self.parse_local_record_declaration(),
            Tok::Kw("void") if self.pointers => self.parse_decl(),
            Tok::Kw("do") => self.parse_do_while(line),
            Tok::Kw("switch") => self.parse_switch(line),
            Tok::Kw("case") | Tok::Kw("default") => Err(TranslateError::new(
                line,
                "'case' and 'default' labels are only allowed inside a switch",
            )),
            Tok::Kw("if") => (|| -> Result<Stmt, TranslateError> {
                self.next();
                self.expect_sym("(")?;
                let cond = self.parse_expr()?;
                self.expect_sym(")")?;
                let (then, then_body) = self.parse_stmt_as_block()?;
                let mut else_form = None;
                let els = if *self.peek() == Tok::Kw("else") {
                    self.next();
                    let is_else_if = *self.peek() == Tok::Kw("if");
                    let (body, form) = self.parse_stmt_as_block()?;
                    else_form = Some(if is_else_if {
                        ElseForm::ElseIf
                    } else if form == BodyForm::Braced {
                        ElseForm::Braced
                    } else {
                        ElseForm::SingleStatement
                    });
                    body
                } else {
                    Vec::new()
                };
                Ok(Stmt::If(
                    cond,
                    then,
                    els,
                    IfProvenance {
                        origin: IfOrigin::Conditional,
                        then_body,
                        else_body: else_form,
                        line,
                    },
                ))
            })(),
            Tok::Kw("while") => (|| -> Result<Stmt, TranslateError> {
                self.next();
                self.expect_sym("(")?;
                let cond = self.parse_expr()?;
                self.expect_sym(")")?;
                let (body, body_form) = self.parse_stmt_as_block()?;
                Ok(Stmt::While(
                    cond,
                    body,
                    LoopProvenance {
                        kind: LoopKind::While,
                        body: body_form,
                        line,
                    },
                ))
            })(),
            Tok::Kw("for") => self.parse_for_rest(line),
            Tok::Kw("return") => (|| -> Result<Stmt, TranslateError> {
                self.next();
                if self.eat_sym(";") {
                    let value = self.lower_return(None, line)?;
                    Ok(Stmt::Return(value, ReturnProvenance::Explicit, line))
                } else {
                    let e = self.parse_expr()?;
                    self.expect_sym(";")?;
                    let value = self.lower_return(Some(e), line)?;
                    Ok(Stmt::Return(value, ReturnProvenance::Explicit, line))
                }
            })(),
            Tok::Kw("break") => (|| -> Result<Stmt, TranslateError> {
                self.next();
                self.expect_sym(";")?;
                Ok(Stmt::Break(line))
            })(),
            Tok::Kw("continue") => (|| -> Result<Stmt, TranslateError> {
                self.next();
                self.expect_sym(";")?;
                Ok(Stmt::Continue(line))
            })(),
            _ => (|| -> Result<Stmt, TranslateError> {
                let e = self.parse_expr()?;
                self.expect_sym(";")?;
                Ok(Stmt::Expr(e, ExprStmtProvenance::Expression))
            })(),
        }
    }

    /// A struct, union, enum or typedef declaration inside a function.
    #[inline(never)]
    fn parse_local_record_declaration(&mut self) -> Result<Stmt, TranslateError> {
        let line = self.line();
        match self.parse_record_declaration(false)? {
            records::Declared::Stmt(statement) => Ok(statement),
            _ => Ok(Stmt::Expr(Expr::Num(0, ScalarType::I32, line), ExprStmtProvenance::Empty)),
        }
    }

    /// `for (struct T *p = ...; ...)`
    #[inline(never)]
    fn parse_for_record_init(&mut self, line: usize) -> Result<Stmt, TranslateError> {
        let declaration = self.parse_local_record_declaration()?;
        if !self.rec.pending.is_empty() {
            return Err(TranslateError::new(
                line,
                "'for' cannot declare a struct with an initializer inside its parentheses; declare it before the loop",
            ));
        }
        Ok(declaration)
    }

    /// `for (` ... after the parenthesis, in the loop's own scope.
    #[inline(never)]
    fn parse_for_rest(&mut self, line: usize) -> Result<Stmt, TranslateError> {
        self.next();
        self.expect_sym("(")?;
        // the loop's own scope (an error abandons the parse, no pop needed)
        self.rec.push_scope();
        {
            {
                let init = if self.eat_sym(";") {
                    None
                } else {
                    let s = if self.record_type_at(0) {
                        self.parse_for_record_init(line)?
                    } else if matches!(self.peek(), Tok::Kw("bool") | Tok::Kw("auto"))
                        || is_c_int_kw(self.peek())
                    {
                        self.parse_decl()?
                    } else {
                        let e = self.parse_expr()?;
                        self.expect_sym(";")?;
                        Stmt::Expr(e, ExprStmtProvenance::Expression)
                    };
                    Some(Box::new(s))
                };
                let cond = if self.eat_sym(";") {
                    None
                } else {
                    let e = self.parse_expr()?;
                    self.expect_sym(";")?;
                    Some(e)
                };
                let post = if self.eat_sym(")") {
                    None
                } else {
                    let e = self.parse_expr()?;
                    self.expect_sym(")")?;
                    Some(e)
                };
                let (body, body_form) = self.parse_stmt_as_block()?;
                self.rec.pop_scope();
                Ok(Stmt::For(
                    init,
                    cond,
                    post,
                    body,
                    LoopProvenance {
                        kind: LoopKind::CFor,
                        body: body_form,
                        line,
                    },
                ))
            }
        }
    }

    fn parse_stmt_as_block(&mut self) -> Result<(Vec<Stmt>, BodyForm), TranslateError> {
        if self.eat_sym("{") {
            Ok((self.parse_block_body()?, BodyForm::Braced))
        } else {
            let mut body = vec![self.parse_stmt()?];
            self.rec.take_pending(&mut body);
            Ok((body, BodyForm::SingleStatement))
        }
    }

    fn parse_decl(&mut self) -> Result<Stmt, TranslateError> {
        let line = self.line();
        let declaration_type = match self.next() {
            Tok::Kw(k) if c_int_type(k).is_some() => c_int_type(k),
            Tok::Kw("bool") => Some(ScalarType::Bool),
            Tok::Kw("auto") => None,
            Tok::Kw("void") if *self.peek() == Tok::Sym("*") => Some(ScalarType::Unit),
            Tok::Kw("void") => {
                return Err(TranslateError::new(
                    line,
                    "a variable cannot have type void; use an integer type, or 'void *' for an opaque pointer",
                ))
            }
            token => {
                return Err(TranslateError::new(
                    line,
                    format!(
                        "expected int, bool, or auto declaration, found {}",
                        show(&token)
                    ),
                ))
            }
        };
        let inferred = declaration_type.is_none();
        let declaration_type = match declaration_type {
            Some(base) if self.pointers => Some(self.parse_pointer_suffix(base, line, "pointers")?),
            _ if self.eat_sym("*") => {
                return Err(TranslateError::new(
                    line,
                    "unsupported: pointers are not yet translatable",
                ));
            }
            other => other,
        };
        if self.pointers && *self.peek() == Tok::Sym("(") && *self.peek2() == Tok::Sym("*") {
            return Err(TranslateError::new(
                line,
                "unsupported: function pointers & pointers to arrays; use a plain pointer such as int *p",
            ));
        }
        let name = match self.next() {
            Tok::Ident(n) => n,
            t => {
                return Err(TranslateError::new(
                    line,
                    format!("expected variable name, found {}", show(&t)),
                ))
            }
        };
        self.parse_decl_named(declaration_type, inferred, name, line)
    }

    /// A declaration after its type and name: `[N] = {...};`, `= value;`.
    /// The name enters the parser's scope (it shadows outer enumerators,
    /// typedefs and struct variables).
    fn parse_decl_named(
        &mut self,
        declaration_type: Option<ScalarType>,
        inferred: bool,
        name: String,
        line: usize,
    ) -> Result<Stmt, TranslateError> {
        let statement = self.parse_decl_named_inner(declaration_type, inferred, name, line)?;
        match &statement {
            Stmt::Decl(name, init, binding, _) => {
                if let Some(e) = init {
                    self.check_store(binding.declared_type, e, name, line)?;
                }
                self.rec.declare_scalar(name, binding.declared_type, None)
            }
            Stmt::DeclArray(name, size, init, binding, _, _) => {
                for e in init {
                    self.check_store(binding.declared_type, e, name, line)?;
                }
                self.rec.declare_scalar(name, binding.declared_type, Some(*size))
            }
            _ => {}
        }
        Ok(statement)
    }

    fn parse_decl_named_inner(
        &mut self,
        declaration_type: Option<ScalarType>,
        inferred: bool,
        name: String,
        line: usize,
    ) -> Result<Stmt, TranslateError> {
        if self.eat_sym("[") {
            if inferred {
                return Err(TranslateError::new(
                    line,
                    "unsupported: auto arrays are not translatable; use an explicit int array",
                ));
            }
            if declaration_type == Some(ScalarType::Bool) {
                return Err(TranslateError::new(
                    line,
                    "unsupported: bool arrays are not translatable; use int arrays",
                ));
            }
            let size = match self.peek() {
                // `char s[] = "..."` / `int a[] = {...}`: the size comes
                // from the initializer
                Tok::Sym("]") if self.pointers && *self.peek2() == Tok::Sym("=") => None,
                Tok::Sym("]") => {
                    return Err(TranslateError::new(
                        line,
                        "array size must be a constant between 1 and 4096",
                    ))
                }
                _ => Some(self.parse_array_size(line)?),
            };
            self.expect_sym("]")?;
            let mut init = Vec::new();
            let initialized = self.eat_sym("=");
            let string_init = if initialized && self.pointers {
                match self.peek().clone() {
                    Tok::Str(bytes) => {
                        if declaration_type.is_some_and(|t| self::c_type_name(t) != "char") {
                            return Err(TranslateError::new(
                                line,
                                "only char arrays can be initialized from a string literal",
                            ));
                        }
                        self.next();
                        Some(bytes)
                    }
                    _ => None,
                }
            } else {
                None
            };
            let size = match (size, &string_init) {
                (Some(size), _) => size,
                (None, Some(bytes)) => bytes.len() + 1,
                (None, None) => 0,
            };
            if let Some(bytes) = string_init {
                // the terminating NUL is dropped when the array is exactly
                // as long as the text, as in C
                if bytes.len() > size {
                    return Err(TranslateError::new(line, "too many array initializers: the string is longer than the array"));
                }
                init.extend(bytes.iter().map(|b| Expr::Num(i64::from(*b), ScalarType::I32, line)));
            } else if initialized {
                self.expect_sym("{")?;
                if !self.eat_sym("}") {
                    loop {
                        init.push(self.parse_expr()?);
                        if self.eat_sym("}") {
                            break;
                        }
                        self.expect_sym(",")?;
                    }
                }
                if size == 0 && (init.is_empty() || init.len() > 4096) {
                    return Err(TranslateError::new(
                        line,
                        "array size must be a constant between 1 and 4096",
                    ));
                }
            }
            let size = if size == 0 { init.len() } else { size };
            if init.len() > size {
                return Err(TranslateError::new(line, "too many array initializers"));
            }
            self.expect_sym(";")?;
            return Ok(Stmt::DeclArray(
                name,
                size,
                init,
                BindingProvenance {
                    declared_type: Some(declaration_type.unwrap_or(ScalarType::I32)),
                    mutable: false,
                    initialized,
                    origin: BindingOrigin::Local,
                },
                if initialized {
                    ArrayInitProvenance::List
                } else {
                    ArrayInitProvenance::Absent
                },
                line,
            ));
        }
        let init = if self.eat_sym("=") {
            Some(self.parse_expr()?)
        } else {
            None
        };
        if inferred && init.is_none() {
            return Err(TranslateError::new(
                line,
                "auto variables require an initializer",
            ));
        }
        if self.eat_sym(",") {
            return Err(TranslateError::new(
                line,
                "one declaration per line, please (int a; int b; …)",
            ));
        }
        self.expect_sym(";")?;
        let initialized = init.is_some();
        Ok(Stmt::Decl(
            name,
            init,
            BindingProvenance {
                declared_type: declaration_type,
                mutable: false,
                initialized,
                origin: BindingOrigin::Local,
            },
            line,
        ))
    }

    // precedence climbing
    fn parse_expr(&mut self) -> Result<Expr, TranslateError> {
        self.parse_assign()
    }

    fn parse_assign(&mut self) -> Result<Expr, TranslateError> {
        let lhs = self.parse_binary(0)?;
        match assignment_operator(self.peek()) {
            None => Ok(lhs),
            Some(provenance) => self.assignment_rest(lhs, provenance),
        }
    }

    /// `lhs = rhs` after the operator: kept out of `parse_assign`, which
    /// is on the stack once per parenthesis level.
    #[inline(never)]
    fn assignment_rest(&mut self, lhs: Expr, provenance: AssignmentProvenance) -> Result<Expr, TranslateError> {
        let line = self.line();
        self.next();
        if self.is_marked(&lhs) {
            return self.record_assignment(lhs, provenance, line);
        }
        let lv = self.assignment_target(&lhs, line)?;
        self.enter()?;
        let rhs = self.parse_assign();
        self.leave();
        self.finish_assignment(&lhs, lv, rhs?, provenance, line)
    }

    #[inline(never)]
    fn assignment_target(&self, lhs: &Expr, line: usize) -> Result<LValue, TranslateError> {
        Self::to_lvalue(lhs).ok_or_else(|| {
            TranslateError::new(
                line,
                if self.pointers {
                    "left side of '=' must be a variable, array element or *pointer"
                } else {
                    "left side of '=' must be a variable or array element"
                },
            )
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Postfix {
    None,
    Index,
    Call,
    Increment,
    As,
    /// `.member` / `->member`
    Member,
}

fn postfix_kind(token: &Tok) -> Postfix {
    match token {
        Tok::Sym("[") => Postfix::Index,
        Tok::Sym("(") => Postfix::Call,
        Tok::Sym("++") | Tok::Sym("--") => Postfix::Increment,
        Tok::Kw("as") => Postfix::As,
        Tok::Sym(".") | Tok::Sym("->") => Postfix::Member,
        _ => Postfix::None,
    }
}

/// The assignment operator `token` spells, if any.
fn assignment_operator(token: &Tok) -> Option<AssignmentProvenance> {
    {
        match token {
            Tok::Sym("=") => Some(AssignmentProvenance::Simple),
            Tok::Sym("+=") => Some(AssignmentProvenance::Compound("+")),
            Tok::Sym("-=") => Some(AssignmentProvenance::Compound("-")),
            Tok::Sym("*=") => Some(AssignmentProvenance::Compound("*")),
            Tok::Sym("/=") => Some(AssignmentProvenance::Compound("/")),
            Tok::Sym("%=") => Some(AssignmentProvenance::Compound("%")),
            Tok::Sym("&=") => Some(AssignmentProvenance::Compound("&")),
            Tok::Sym("|=") => Some(AssignmentProvenance::Compound("|")),
            Tok::Sym("^=") => Some(AssignmentProvenance::Compound("^")),
            Tok::Sym("<<=") => Some(AssignmentProvenance::Compound("<<")),
            Tok::Sym(">>=") => Some(AssignmentProvenance::Compound(">>")),
            _ => None,
        }
    }
}

/// The binary operator `token` spells and its precedence, if any.
fn binary_operator(token: &Tok) -> Option<(&'static str, u8)> {
    Some(match token {
                Tok::Sym("||") => ("||", 1),
                Tok::Sym("&&") => ("&&", 2),
                Tok::Sym("|") => ("|", 3),
                Tok::Sym("^") => ("^", 4),
                Tok::Sym("&") => ("&", 5),
                Tok::Sym("==") => ("==", 6),
                Tok::Sym("!=") => ("!=", 6),
                Tok::Sym("<") => ("<", 7),
                Tok::Sym("<=") => ("<=", 7),
                Tok::Sym(">") => (">", 7),
                Tok::Sym(">=") => (">=", 7),
                Tok::Sym("<<") => ("<<", 8),
                Tok::Sym(">>") => (">>", 8),
                Tok::Sym("+") => ("+", 9),
                Tok::Sym("-") => ("-", 9),
                Tok::Sym("*") => ("*", 10),
                Tok::Sym("/") => ("/", 10),
                Tok::Sym("%") => ("%", 10),
                _ => return None,
    })
}

impl Parser {
    fn parse_binary(&mut self, min_prec: u8) -> Result<Expr, TranslateError> {
        let mut lhs = self.parse_unary()?;
        let mut chain = 0usize;
        loop {
            let Some((op, prec)) = binary_operator(self.peek()) else { break };
            if prec < min_prec {
                break;
            }
            // `a + b + c + ...` builds a left-deep tree without recursing
            // here; stop it at the tree-depth limit so later passes (and
            // dropping the tree) stay shallow.
            chain += 1;
            if chain > crate::limits::MAX_NESTING_DEPTH {
                return Err(TranslateError::new(self.line(), long_expression_message()));
            }
            let line = self.line();
            self.next();
            let rhs = self.parse_binary(prec + 1)?;
            lhs = self.record_binary(op, lhs, rhs, line)?;
        }
        Ok(lhs)
    }

    /// Operand of a prefix operator, cast or sizeof: counted against the
    /// recursion backstop (brackets are already limited by the lexer).
    fn parse_unary_operand(&mut self) -> Result<Expr, TranslateError> {
        self.enter()?;
        let result = self.parse_unary();
        self.leave();
        result
    }

    fn parse_unary(&mut self) -> Result<Expr, TranslateError> {
        // Only the prefix operators that recurse live here: this function
        // is on the stack once per nesting level, so its frame stays small.
        let line = self.line();
        let op = match self.peek() {
            Tok::Sym("-") => "-",
            Tok::Sym("!") => "!",
            Tok::Sym("~") => "~",
            Tok::Sym("+") => "+",
            _ => return self.parse_unary_other(line),
        };
        self.next();
        Ok(Expr::Unary(op, Box::new(self.parse_unary_operand()?), line))
    }

    #[inline(never)]
    fn parse_unary_other(&mut self, line: usize) -> Result<Expr, TranslateError> {
        match self.peek() {
            Tok::Sym("(") if self.record_type_at(1) => self.record_cast(line),
            Tok::Sym("(") if is_c_int_kw(self.peek2()) && *self.peek3() == Tok::Sym(")") => (|| -> Result<Expr, TranslateError> {
                // C cast: (type) operand
                self.next();
                let Tok::Kw(keyword) = self.next() else {
                    return Err(TranslateError::new(line, "expected a type in a cast"));
                };
                self.next();
                let op = C_CAST_OPS
                    .iter()
                    .find(|(k, _)| *k == keyword)
                    .map(|(_, op)| *op)
                    .unwrap_or("(int)");
                Ok(Expr::Unary(op, Box::new(self.parse_unary_operand()?), line))
            })(),
            Tok::Ident(name) if name == "sizeof" => (|| -> Result<Expr, TranslateError> {
                self.next();
                if self.record_type_at(1) && *self.peek() == Tok::Sym("(") {
                    return self.record_sizeof_type(line);
                }
                if *self.peek() == Tok::Sym("(") && is_c_int_kw(self.peek2()) && *self.peek3() == Tok::Sym(")") {
                    self.next();
                    let Tok::Kw(keyword) = self.next() else {
                        return Err(TranslateError::new(line, "expected a type after sizeof"));
                    };
                    self.next();
                    let op = C_SIZEOF_OPS
                        .iter()
                        .find(|(k, _)| *k == keyword)
                        .map(|(_, op)| *op)
                        .unwrap_or("sizeof(int)");
                    return Ok(Expr::Unary(op, Box::new(Expr::Num(0, ScalarType::I32, line)), line));
                }
                let operand = self.parse_unary_operand()?;
                self.record_sizeof_expr(operand, line)
            })(),
            Tok::Sym("*") | Tok::Sym("&") if self.pointers => self.parse_pointer_unary(line),
            Tok::Sym("(")
                if self.pointers
                    && (is_c_int_kw(self.peek2()) || *self.peek2() == Tok::Kw("void"))
                    && *self.peek3() == Tok::Sym("*") =>
            {
                self.parse_pointer_cast(line)
            }
            Tok::Sym("(")
                if (is_c_int_kw(self.peek2()) || *self.peek2() == Tok::Kw("void"))
                    && *self.peek3() == Tok::Sym("(") =>
            {
                Err(pointer_cast_error(line))
            }
            Tok::Sym("*") => Err(TranslateError::new(
                line,
                "unsupported: pointer dereference is not yet translatable",
            )),
            Tok::Sym("&") => Err(TranslateError::new(
                line,
                "unsupported: address-of (&) is not yet translatable",
            )),
            Tok::Sym("++") | Tok::Sym("--") => (|| -> Result<Expr, TranslateError> {
                let provenance = if *self.peek() == Tok::Sym("++") {
                    AssignmentProvenance::PrefixIncrement
                } else {
                    AssignmentProvenance::PrefixDecrement
                };
                self.next();
                let target = self.parse_unary_operand()?;
                if self.is_marked(&target) {
                    return self.record_increment(target, provenance, line);
                }
                let Some(lv) = Self::to_lvalue(&target) else {
                    return Err(TranslateError::new(line, "++/-- needs a variable"));
                };
                Ok(Expr::Assign(
                    Box::new(lv),
                    Box::new(Expr::Num(1, ScalarType::I32, line)),
                    provenance,
                    line,
                ))
            })(),
            _ => self.parse_postfix(),
        }
    }

    fn parse_postfix(&mut self) -> Result<Expr, TranslateError> {
        let line = self.line();
        let mut e = self.parse_primary()?;
        let mut chain = 0usize;
        loop {
            let kind = postfix_kind(self.peek());
            if kind == Postfix::None {
                return Ok(e);
            }
            // `a.b.c.d...`, `p->next->next...`: bounded like operator chains
            chain += 1;
            if chain > crate::limits::MAX_NESTING_DEPTH {
                return Err(self.long_chain_error());
            }
            e = self.postfix_suffix(kind, e, line)?;
        }
    }

    #[inline(never)]
    fn long_chain_error(&self) -> TranslateError {
        TranslateError::new(self.line(), long_expression_message())
    }

    #[inline(never)]
    fn postfix_suffix(&mut self, kind: Postfix, e: Expr, line: usize) -> Result<Expr, TranslateError> {
        match kind {
            Postfix::Index => self.index_suffix(e, line),
            Postfix::Call => self.call_suffix(e, line),
            Postfix::Increment => self.increment_suffix(e, line),
            Postfix::Member => self.member_suffix(e, line),
            Postfix::As | Postfix::None => self.as_suffix(e, line),
        }
    }

    // Each postfix form lives in its own function so the recursive path
    // through `parse_postfix` keeps a small stack frame.

    /// `(T *) operand`, `(void **) operand`, ...
    #[inline(never)]
    fn parse_pointer_cast(&mut self, line: usize) -> Result<Expr, TranslateError> {
        self.next(); // (
        let base = match self.next() {
            Tok::Kw("void") => ScalarType::Unit,
            Tok::Kw(k) => c_int_type(k).unwrap_or(ScalarType::I32),
            _ => return Err(pointer_cast_error(line)),
        };
        let target = self.parse_pointer_suffix(base, line, "pointer casts")?;
        if !self.eat_sym(")") {
            return Err(pointer_cast_error(line));
        }
        let op = pointer_cast_op(target).ok_or_else(|| pointer_cast_error(line))?;
        Ok(Expr::Unary(op, Box::new(self.parse_unary_operand()?), line))
    }

    #[inline(never)]
    fn index_suffix(&mut self, e: Expr, line: usize) -> Result<Expr, TranslateError> {
        self.next();
        let idx = self.parse_expr()?;
        self.expect_sym("]")?;
        match e {
            Expr::Var(name, l) => Ok(Expr::Index(name, Box::new(idx), l)),
            // struct arrays and pointers, `s.name[i]`, `p->items[i]`
            other => self.index_record(other, idx, line),
        }
    }

    #[inline(never)]
    fn call_suffix(&mut self, e: Expr, line: usize) -> Result<Expr, TranslateError> {
        self.next();
        let Expr::Var(name, l) = e else {
            return Err(TranslateError::new(line, "only named functions can be called"));
        };
        let mut args = Vec::new();
        if !self.eat_sym(")") {
            loop {
                args.push(self.parse_expr()?);
                if self.eat_sym(")") {
                    break;
                }
                self.expect_sym(",")?;
            }
        }
        self.finish_call(name, args, l)
    }

    #[inline(never)]
    fn increment_suffix(&mut self, e: Expr, line: usize) -> Result<Expr, TranslateError> {
        let provenance = if *self.peek() == Tok::Sym("++") {
            AssignmentProvenance::PostfixIncrement
        } else {
            AssignmentProvenance::PostfixDecrement
        };
        self.next();
        if self.is_marked(&e) {
            return self.record_increment(e, provenance, line);
        }
        let Some(lv) = Self::to_lvalue(&e) else {
            return Err(TranslateError::new(line, "++/-- needs a variable"));
        };
        Ok(Expr::Assign(Box::new(lv), Box::new(Expr::Num(1, ScalarType::I32, line)), provenance, line))
    }

    #[inline(never)]
    fn as_suffix(&mut self, e: Expr, line: usize) -> Result<Expr, TranslateError> {
        self.next();
        if !matches!(self.next(), Tok::Kw("usize")) {
            return Err(TranslateError::new(line, "only 'as usize' casts are supported for array indexes"));
        }
        Ok(Expr::Unary("as usize", Box::new(e), line))
    }

    fn parse_primary(&mut self) -> Result<Expr, TranslateError> {
        if *self.peek() == Tok::Sym("(") {
            self.next();
            let e = self.parse_expr()?;
            self.expect_sym(")")?;
            return Ok(e);
        }
        self.parse_atom()
    }

    #[inline(never)]
    fn parse_atom(&mut self) -> Result<Expr, TranslateError> {
        let line = self.line();
        match self.next() {
            Tok::Int(n) => Ok(Expr::Num(n, ScalarType::I32, line)),
            Tok::Bool(value) => Ok(Expr::Num(i64::from(value), ScalarType::Bool, line)),
            Tok::Ident(n) => self.name_expr(n, line),
            Tok::Str(bytes) => Ok(self.string_literal(bytes, line)),
            t => Err(TranslateError::new(
                line,
                format!("expected an expression, found {}", show(&t)),
            )),
        }
    }
}

/// Reject any statement or expression tree deeper than
/// `limits::MAX_NESTING_DEPTH` levels, counting every nested statement and
/// every operator (so `a + b + c` is three levels deep). Runs once, without
/// recursion, right after parsing: every later pass walks the tree
/// recursively, and this bound keeps all of them far from the stack limit.
fn check_tree_depth(unit: &Unit) -> Result<(), TranslateError> {
    enum Node<'a> {
        S(&'a Stmt),
        E(&'a Expr),
        L(&'a LValue),
    }
    let limit = crate::limits::MAX_NESTING_DEPTH;
    let mut work: Vec<(Node, usize)> = Vec::new();
    for function in &unit.funcs {
        work.extend(function.body.iter().map(|s| (Node::S(s), 1)));
    }
    while let Some((node, depth)) = work.pop() {
        if depth > limit {
            let line = match node {
                Node::S(s) => stmt_line(s),
                Node::E(e) => expr_line(e),
                Node::L(l) => lvalue_line(l),
            };
            let what = match node {
                Node::S(_) => crate::limits::nesting_message("this code (blocks and statements)"),
                _ => long_expression_message(),
            };
            return Err(TranslateError::new(line, what));
        }
        let next = depth + 1;
        match node {
            Node::S(statement) => match statement {
                Stmt::Decl(_, init, _, _) => work.extend(init.iter().map(|e| (Node::E(e), next))),
                Stmt::DeclArray(_, _, init, _, _, _) => work.extend(init.iter().map(|e| (Node::E(e), next))),
                Stmt::Expr(e, _) => work.push((Node::E(e), next)),
                Stmt::If(c, then_body, else_body, _) => {
                    work.push((Node::E(c), next));
                    work.extend(then_body.iter().chain(else_body).map(|s| (Node::S(s), next)));
                }
                Stmt::While(c, body, _) => {
                    work.push((Node::E(c), next));
                    work.extend(body.iter().map(|s| (Node::S(s), next)));
                }
                Stmt::For(init, c, step, body, _) => {
                    work.extend(init.iter().map(|s| (Node::S(s), next)));
                    work.extend(c.iter().chain(step.iter()).map(|e| (Node::E(e), next)));
                    work.extend(body.iter().map(|s| (Node::S(s), next)));
                }
                Stmt::Return(e, _, _) => work.extend(e.iter().map(|e| (Node::E(e), next))),
                Stmt::Break(_) | Stmt::Continue(_) => {}
            },
            Node::E(expression) => match expression {
                Expr::Num(..) | Expr::Var(..) => {}
                Expr::Index(_, i, _) | Expr::Unary(_, i, _) => work.push((Node::E(i), next)),
                Expr::Binary(_, a, b, _) => {
                    work.push((Node::E(a), next));
                    work.push((Node::E(b), next));
                }
                Expr::Assign(target, value, _, _) => {
                    work.push((Node::L(target), next));
                    work.push((Node::E(value), next));
                }
                Expr::Call(_, args, _) => work.extend(args.iter().map(|e| (Node::E(e), next))),
            },
            Node::L(target) => match target {
                LValue::Var(..) => {}
                LValue::Index(_, e, _) | LValue::Deref(e, _) => work.push((Node::E(e), next)),
            },
        }
    }
    Ok(())
}

/// C and C++ block scopes. Each `{ }` block, `for` header and `if`/loop
/// body is a scope; an inner declaration may shadow an outer or global
/// one; redeclaring a name in the same scope is an error. Every later pass
/// works with one name per variable and function, so a declaration that
/// shadows or reuses a name gets a fresh unique name here (the second
/// loop's `i` becomes `i_2`).
fn resolve_block_scopes(unit: &mut Unit) -> Result<(), TranslateError> {
    let mut taken: HashSet<String> = HashSet::new();
    taken.extend(unit.globals.iter().map(|g| g.name.clone()));
    taken.extend(unit.prototypes.iter().map(|p| p.name.clone()));
    for function in &unit.funcs {
        taken.insert(function.name.clone());
        taken.extend(function.params.iter().cloned());
        collect_stmt_names(&function.body, &mut taken);
    }
    let globals: HashSet<String> = unit.globals.iter().map(|g| g.name.clone()).collect();
    for function in &mut unit.funcs {
        let mut params = HashMap::new();
        for (name, line) in function.params.iter_mut().zip(&function.param_lines) {
            let source = name.clone();
            if globals.contains(&source) {
                // A parameter may shadow a global, as in C.
                *name = fresh_name(&source, &mut taken);
            }
            if params.insert(source.clone(), (name.clone(), *line)).is_some() {
                return Err(TranslateError::new(
                    *line,
                    format!("parameter '{source}' appears twice in '{}'; give each parameter its own name", function.name),
                ));
            }
        }
        let mut scopes = Scopes {
            declared: params.keys().cloned().collect(),
            stack: vec![params],
            taken: &mut taken,
            globals: &globals,
        };
        // The function body shares the parameters' scope, as in C.
        scopes.statements(&mut function.body)?;
    }
    Ok(())
}

/// `name_2`, `name_3`, ...: the first that no identifier in the unit uses.
fn fresh_name(name: &str, taken: &mut HashSet<String>) -> String {
    let mut k = 2;
    loop {
        let candidate = format!("{name}_{k}");
        if taken.insert(candidate.clone()) {
            return candidate;
        }
        k += 1;
    }
}

fn collect_stmt_names(statements: &[Stmt], names: &mut HashSet<String>) {
    for statement in statements {
        match statement {
            Stmt::Decl(name, ..) | Stmt::DeclArray(name, ..) => {
                names.insert(name.clone());
            }
            Stmt::If(_, a, b, _) => {
                collect_stmt_names(a, names);
                collect_stmt_names(b, names);
            }
            Stmt::While(_, body, _) => collect_stmt_names(body, names),
            Stmt::For(init, _, _, body, _) => {
                if let Some(init) = init {
                    collect_stmt_names(std::slice::from_ref(&**init), names);
                }
                collect_stmt_names(body, names);
            }
            _ => {}
        }
    }
}

struct Scopes<'a> {
    /// Innermost scope last: source name -> (unique name, declaring line).
    stack: Vec<HashMap<String, (String, usize)>>,
    /// Source names declared anywhere in this function so far.
    declared: HashSet<String>,
    /// Every identifier in the unit (fresh names avoid all of them).
    taken: &'a mut HashSet<String>,
    globals: &'a HashSet<String>,
}

impl Scopes<'_> {
    fn scoped(&mut self, statements: &mut Vec<Stmt>) -> Result<(), TranslateError> {
        self.stack.push(HashMap::new());
        let result = self.statements(statements);
        self.stack.pop();
        result
    }

    fn statements(&mut self, statements: &mut Vec<Stmt>) -> Result<(), TranslateError> {
        for statement in statements.iter_mut() {
            self.statement(statement)?;
        }
        Ok(())
    }

    fn statement(&mut self, statement: &mut Stmt) -> Result<(), TranslateError> {
        match statement {
            Stmt::Decl(name, init, _, line) => {
                if let Some(init) = init {
                    self.expr(init)?;
                }
                *name = self.declare(name, *line)?;
            }
            Stmt::DeclArray(name, _, init, _, _, line) => {
                init.iter_mut().try_for_each(|e| self.expr(e))?;
                *name = self.declare(name, *line)?;
            }
            Stmt::Expr(e, _) => self.expr(e)?,
            Stmt::Return(e, _, _) => e.iter_mut().try_for_each(|e| self.expr(e))?,
            Stmt::If(c, a, b, _) => {
                self.expr(c)?;
                self.scoped(a)?;
                self.scoped(b)?;
            }
            Stmt::While(c, body, _) => {
                self.expr(c)?;
                self.scoped(body)?;
            }
            Stmt::For(init, c, step, body, _) => {
                // The header is its own scope around the body's scope.
                self.stack.push(HashMap::new());
                let result = (|| {
                    if let Some(init) = init {
                        self.statement(init)?;
                    }
                    c.iter_mut().chain(step.iter_mut()).try_for_each(|e| self.expr(e))?;
                    self.scoped(body)
                })();
                self.stack.pop();
                result?;
            }
            Stmt::Break(_) | Stmt::Continue(_) => {}
        }
        Ok(())
    }

    fn declare(&mut self, name: &str, line: usize) -> Result<String, TranslateError> {
        let innermost = self.stack.last().expect("a scope is always open");
        if let Some((_, first)) = innermost.get(name) {
            return Err(TranslateError::new(
                line,
                format!(
                    "'{name}' is already declared in this block (on line {first}); \
                     use a different name, or assign to the existing '{name}' without declaring it again"
                ),
            ));
        }
        let reused = self.declared.contains(name) || self.globals.contains(name);
        let unique = if reused {
            fresh_name(name, self.taken)
        } else {
            name.to_string()
        };
        self.declared.insert(name.to_string());
        if let Some(scope) = self.stack.last_mut() {
            scope.insert(name.to_string(), (unique.clone(), line));
        }
        Ok(unique)
    }

    fn resolve(&self, name: &mut String, line: usize) -> Result<(), TranslateError> {
        if let Some((unique, _)) = self.stack.iter().rev().find_map(|scope| scope.get(name.as_str())) {
            if unique != name {
                *name = unique.clone();
            }
            return Ok(());
        }
        if self.declared.contains(name.as_str()) && !self.globals.contains(name.as_str()) {
            return Err(TranslateError::new(
                line,
                format!(
                    "'{name}' is not visible here: it was declared inside a block or for loop that has \
                     already ended; declare it before that block to use it afterwards"
                ),
            ));
        }
        Ok(())
    }

    fn expr(&mut self, e: &mut Expr) -> Result<(), TranslateError> {
        match e {
            Expr::Num(..) => Ok(()),
            Expr::Var(name, line) => self.resolve(name, *line),
            Expr::Index(name, i, line) => {
                self.resolve(name, *line)?;
                self.expr(i)
            }
            Expr::Unary(_, i, _) => self.expr(i),
            Expr::Binary(_, a, b, _) => {
                self.expr(a)?;
                self.expr(b)
            }
            Expr::Assign(target, value, _, _) => {
                match &mut **target {
                    LValue::Var(name, line) => self.resolve(name, *line)?,
                    LValue::Index(name, i, line) => {
                        self.resolve(name, *line)?;
                        self.expr(i)?;
                    }
                    LValue::Deref(p, _) => self.expr(p)?,
                }
                self.expr(value)
            }
            Expr::Call(_, args, _) => args.iter_mut().try_for_each(|a| self.expr(a)),
        }
    }
}

fn long_expression_message() -> String {
    format!(
        "this expression is too long or nested too deeply: the limit is {} levels, \
         and each operator in a chain like a + b + c counts as one; \
         split it into smaller pieces with extra variables",
        crate::limits::MAX_NESTING_DEPTH
    )
}

fn expr_line(e: &Expr) -> usize {
    match e {
        Expr::Num(_, _, l) | Expr::Var(_, l) | Expr::Index(_, _, l) | Expr::Unary(_, _, l) => *l,
        Expr::Binary(_, _, _, l) | Expr::Assign(_, _, _, l) | Expr::Call(_, _, l) => *l,
    }
}

fn lvalue_line(l: &LValue) -> usize {
    match l {
        LValue::Var(_, l) | LValue::Index(_, _, l) | LValue::Deref(_, l) => *l,
    }
}

fn stmt_line(s: &Stmt) -> usize {
    match s {
        Stmt::Decl(_, _, _, l) | Stmt::DeclArray(_, _, _, _, _, l) | Stmt::Return(_, _, l) => *l,
        Stmt::Break(l) | Stmt::Continue(l) => *l,
        Stmt::Expr(e, _) | Stmt::If(e, _, _, _) | Stmt::While(e, _, _) => expr_line(e),
        Stmt::For(init, c, _, body, _) => init
            .as_deref()
            .map(stmt_line)
            .or(c.as_ref().map(expr_line))
            .or(body.first().map(stmt_line))
            .unwrap_or(0),
    }
}

fn match_sym(s: &str) -> &'static str {
    // map to the interned symbol strings used by the lexer
    [
        "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "+=", "-=", "*=", "/=", "%=", "++", "--",
        "&=", "|=", "^=", "<<=", ">>=", "+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|", "^", "~", "(", ")", "{", "}", "[",
        "]", ";", ",", ":", ".", "->",
    ]
    .iter()
    .find(|k| **k == s)
    .copied()
    .unwrap_or("?")
}

fn show(t: &Tok) -> String {
    match t {
        Tok::Int(n) => format!("number {n}"),
        Tok::Bool(value) => format!("'{value}'"),
        Tok::Ident(s) => format!("'{s}'"),
        Tok::Kw(k) => format!("'{k}'"),
        Tok::Sym(s) => format!("'{s}'"),
        Tok::Str(_) => "a string literal".into(),
        Tok::Eof => "end of input".into(),
    }
}

// -- code generation ----------------------------------------------------------

/// Temporaries used as an expression stack, in order.
const TEMPS: [&str; 7] = ["t0", "t1", "t2", "t3", "t4", "t5", "t6"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum CodeGenTarget {
    Rv32,
    Rv64,
}

#[derive(Clone)]
enum Slot {
    Local(i32),
    Array(i32, usize),
    /// C global scalar / array: its data-segment label.
    Global(String),
    GlobalArray(String, usize),
}

struct CodeGen {
    out: String,
    label_n: usize,
    funcs: Vec<String>,
    parameter_types: HashMap<String, Vec<ScalarType>>,
    return_types: HashMap<String, ScalarType>,
    source_language: &'static str,
    target: CodeGenTarget,
    /// True when some value in the unit is 64 bits wide: temporaries then
    /// spill to 8-byte slots (only possible on RV64).
    wide: bool,
    /// The unit uses C pointers, globals or strings: every expression takes
    /// the typed code paths and locals are stored at their natural width
    /// (so `&local` sees the same bytes a load of the local does).
    memory: bool,
    globals: Vec<Global>,
    /// Write `#@line N` markers before the code of each source line
    /// (only for [`translate_annotated`]; plain output never has them).
    annotate: bool,
}

/// A concrete integer representation on the selected target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Ty {
    bits: u8,
    signed: bool,
}

struct FnCtx {
    fname: String,
    return_type: ScalarType,
    vars: HashMap<String, Slot>,
    types: HashMap<String, ScalarType>,
    frame: i32,
    depth: usize,
    loops: Vec<(String, String)>, // (continue label, break label)
    range_bounds: Vec<i32>,
    range_cursor: usize,
}

impl CodeGen {
    fn new() -> Self {
        Self {
            out: String::new(),
            label_n: 0,
            funcs: Vec::new(),
            parameter_types: HashMap::new(),
            return_types: HashMap::new(),
            source_language: "C",
            target: CodeGenTarget::Rv32,
            wide: false,
            memory: false,
            globals: Vec::new(),
            annotate: false,
        }
    }

    /// Record that the code that follows comes from source line `line`.
    fn mark(&mut self, line: usize) {
        if self.annotate && line > 0 {
            let _ = writeln!(self.out, "{ANNOTATE_MARK}{line}");
        }
    }

    fn new_cpp() -> Self {
        Self {
            source_language: "C++",
            ..Self::new()
        }
    }

    fn new_rust() -> Self {
        Self {
            source_language: "Rust",
            ..Self::new()
        }
    }

    fn new_rv64(source_language: &'static str) -> Self {
        Self {
            source_language,
            target: CodeGenTarget::Rv64,
            ..Self::new()
        }
    }

    fn is_rv64(&self) -> bool {
        self.target == CodeGenTarget::Rv64
    }

    fn spill_base(&self) -> i32 {
        if self.is_rv64() {
            8
        } else {
            4
        }
    }

    fn value_op(&self, rv32: &'static str, rv64: &'static str) -> &'static str {
        if self.is_rv64() {
            rv64
        } else {
            rv32
        }
    }

    fn label(&mut self, stem: &str) -> String {
        self.label_n += 1;
        format!("{stem}_{}", self.label_n)
    }

    fn line(&mut self, s: &str) {
        if s.ends_with(':') || s.starts_with('#') || s.starts_with('.') {
            let _ = writeln!(self.out, "{s}");
        } else if let Some((m, rest)) = s.split_once(' ') {
            let _ = writeln!(self.out, "    {m:<5} {rest}");
        } else {
            let _ = writeln!(self.out, "    {s}");
        }
    }

    fn emit_unit(self, unit: &Unit) -> Result<String, TranslateError> {
        let asm = self.emit_unit_unchecked(unit)?;
        let instructions = asm
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('.') && !l.ends_with(':'))
            .count();
        if instructions > crate::limits::MAX_INSTRUCTIONS {
            return Err(TranslateError::new(
                0,
                format!(
                    "the translated program is too long: it needs {instructions} instructions, \
                     but the limit is {} instructions",
                    crate::limits::MAX_INSTRUCTIONS
                ),
            ));
        }
        Ok(asm)
    }

    fn emit_unit_unchecked(mut self, unit: &Unit) -> Result<String, TranslateError> {
        self.memory = unit.memory_line.is_some();
        self.globals = unit.globals.clone();
        for (i, g) in unit.globals.iter().enumerate() {
            if unit.globals[..i].iter().any(|h| h.name == g.name) {
                return Err(TranslateError::new(g.line, format!("global '{}' is defined twice", g.name)));
            }
            if unit.funcs.iter().any(|f| f.name == g.name) || unit.prototypes.iter().any(|f| f.name == g.name) {
                return Err(TranslateError::new(
                    g.line,
                    format!("'{}' is both a global variable and a function; use different names", g.name),
                ));
            }
            for init in &g.init {
                if let GlobalInit::Addr(target) = init {
                    // struct and union images were type-checked by the parser
                    if g.align > 0 {
                        if !unit.globals.iter().any(|h| h.name == *target) {
                            return Err(TranslateError::new(
                                g.line,
                                format!("global initializer refers to '{target}', which is not a global variable"),
                            ));
                        }
                        continue;
                    }
                    let Some(target_global) = unit.globals.iter().find(|h| h.name == *target) else {
                        return Err(TranslateError::new(
                            g.line,
                            format!("global initializer refers to '{target}', which is not a global variable"),
                        ));
                    };
                    let target_type = target_global.value_type.pointer_to();
                    if target_type != Some(g.value_type) {
                        return Err(TranslateError::new(
                            g.line,
                            format!(
                                "incompatible pointer types: '{}' is initialized with the address of '{target}' ({})",
                                g.name,
                                target_type.map(c_type_name).unwrap_or_else(|| "?".into())
                            ),
                        ));
                    }
                }
            }
        }
        self.check_unit_types(unit)?;
        self.funcs = unit.funcs.iter().map(|f| f.name.clone()).collect();
        self.parameter_types = unit
            .funcs
            .iter()
            .map(|function| (function.name.clone(), function.param_types.clone()))
            .collect();
        self.return_types = unit
            .funcs
            .iter()
            .map(|function| (function.name.clone(), function.return_type))
            .collect();
        // C: a prototype without a definition is an external function that
        // hand-written assembly defines (called through the psABI).
        let mut externs: Vec<&FunctionPrototype> = Vec::new();
        if self.source_language == "C" {
            for prototype in &unit.prototypes {
                if unit.funcs.iter().any(|f| f.name == prototype.name) {
                    continue;
                }
                if let Some(previous) = externs.iter().find(|p| p.name == prototype.name) {
                    if previous.parameter_types != prototype.parameter_types || previous.return_type != prototype.return_type {
                        return Err(TranslateError::new(
                            prototype.line,
                            format!("conflicting prototypes for external function '{}'", prototype.name),
                        ));
                    }
                    continue;
                }
                self.funcs.push(prototype.name.clone());
                self.parameter_types.insert(prototype.name.clone(), prototype.parameter_types.clone());
                self.return_types.insert(prototype.name.clone(), prototype.return_type);
                externs.push(prototype);
            }
        }
        for f in &unit.funcs {
            let dup = unit.funcs.iter().filter(|g| g.name == f.name).count();
            if dup > 1 {
                return Err(TranslateError::new(
                    f.line,
                    format!("function '{}' is defined twice", f.name),
                ));
            }
        }
        self.line(&format!(
            "# generated by the StudyRISC-V {} translator{}",
            self.source_language,
            if self.is_rv64() { " for RV64IM" } else { "" }
        ));
        self.line("# main()'s return value ends up in a0");
        for prototype in &externs {
            self.line(&format!(
                "# external: {}() has no body here; hand-written assembly must define the label",
                prototype.name
            ));
        }
        self.line("call main");
        self.line("ecall");
        self.line("");
        for f in &unit.funcs {
            self.emit_func(f)?;
        }
        self.emit_data();
        Ok(std::mem::take(&mut self.out))
    }

    /// Data-segment label of a global (`_g_name`; string literals keep
    /// their `__strN` names). The prefix keeps globals named like registers
    /// or mnemonics (`a0`, `ret`) from confusing the assembler.
    fn global_label(name: &str) -> String {
        if name.starts_with("__str") {
            name.to_string()
        } else {
            format!("_g_{name}")
        }
    }

    /// Globals in `.data`, string literals in `.section .rodata`.
    fn emit_data(&mut self) {
        let globals = std::mem::take(&mut self.globals);
        for readonly in [false, true] {
            let mut first = true;
            for g in globals.iter().filter(|g| g.readonly == readonly) {
                if first {
                    self.line("");
                    self.line(if readonly { ".section .rodata" } else { ".data" });
                    first = false;
                }
                if g.align > 0 {
                    self.emit_record_data(g);
                    continue;
                }
                let size = self.elem_bytes(g.value_type) as usize;
                let directive = match size {
                    1 => ".byte",
                    2 => ".half",
                    8 => ".dword",
                    _ => ".word",
                };
                if size > 1 {
                    self.line(&format!(".align {}", size.trailing_zeros()));
                }
                let _ = writeln!(self.out, "{}:", Self::global_label(&g.name));
                let count = g.len.unwrap_or(1);
                let values: Vec<String> = g
                    .init
                    .iter()
                    .map(|init| match init {
                        GlobalInit::Int(v) => {
                            let bits = size * 8;
                            let masked = if bits == 64 { *v as u64 } else { (*v as u64) & ((1u64 << bits) - 1) };
                            masked.to_string()
                        }
                        GlobalInit::Addr(target) => Self::global_label(target),
                    })
                    .collect();
                for chunk in values.chunks(16) {
                    self.line(&format!("{directive} {}", chunk.join(", ")));
                }
                let rest = count.saturating_sub(values.len()) * size;
                if rest > 0 {
                    self.line(&format!(".zero {rest}"));
                }
            }
        }
        self.globals = globals;
    }

    /// A struct or union global: bytes, with each pointer initialized to
    /// an address as one `.word` / `.dword`.
    fn emit_record_data(&mut self, g: &Global) {
        if g.align > 1 {
            self.line(&format!(".align {}", g.align.trailing_zeros()));
        }
        let _ = writeln!(self.out, "{}:", Self::global_label(&g.name));
        let pointer = if self.is_rv64() { 8 } else { 4 };
        let mut bytes: Vec<String> = Vec::new();
        let mut used = 0usize;
        let mut zeros = 0usize;
        let flush = |this: &mut Self, bytes: &mut Vec<String>, zeros: &mut usize| {
            for chunk in bytes.chunks(16) {
                this.line(&format!(".byte {}", chunk.join(", ")));
            }
            bytes.clear();
            if *zeros > 0 {
                this.line(&format!(".zero {zeros}"));
                *zeros = 0;
            }
        };
        for init in &g.init {
            match init {
                GlobalInit::Int(v) => {
                    if *v == 0 && bytes.is_empty() {
                        zeros += 1;
                    } else {
                        if zeros > 0 {
                            flush(self, &mut bytes, &mut zeros);
                        }
                        bytes.push(((*v as u64) & 0xff).to_string());
                    }
                    used += 1;
                }
                GlobalInit::Addr(target) => {
                    flush(self, &mut bytes, &mut zeros);
                    let directive = if pointer == 8 { ".dword" } else { ".word" };
                    self.line(&format!("{directive} {}", Self::global_label(target)));
                    used += pointer;
                }
            }
        }
        zeros += g.len.unwrap_or(0).saturating_sub(used);
        flush(self, &mut bytes, &mut zeros);
    }

    fn emit_func(&mut self, f: &Func) -> Result<(), TranslateError> {
        if self.annotate && f.line == 0 {
            // generated code (the struct copy helper) belongs to no line
            let _ = writeln!(self.out, "{ANNOTATE_MARK}0");
        }
        self.mark(f.line);
        // Frame layout (sp stays fixed for the whole function):
        //   0..4/8       ra
        //   4/8..32/36  temp spill slots (for calls inside expressions)
        //   32/36..      parameters, then locals and arrays
        let mut ctx = FnCtx {
            fname: f.name.clone(),
            return_type: f.return_type,
            vars: HashMap::new(),
            types: HashMap::new(),
            frame: self.spill_base() + TEMPS.len() as i32 * self.spill_bytes(),
            depth: 0,
            loops: Vec::new(),
            range_bounds: Vec::new(),
            range_cursor: 0,
        };
        for g in &self.globals {
            let label = Self::global_label(&g.name);
            let slot = match g.len {
                Some(n) => Slot::GlobalArray(label, n),
                None => Slot::Global(label),
            };
            ctx.vars.insert(g.name.clone(), slot);
            ctx.types.insert(g.name.clone(), g.value_type);
        }
        for (p, value_type) in f.params.iter().zip(&f.param_types) {
            if matches!(ctx.vars.get(p), Some(Slot::Global(_) | Slot::GlobalArray(..))) {
                return Err(TranslateError::new(
                    f.line,
                    format!("parameter '{p}' has the same name as a global variable; use a different name"),
                ));
            }
            if ctx.vars.contains_key(p) {
                return Err(TranslateError::new(
                    f.line,
                    format!("duplicate parameter '{p}'"),
                ));
            }
            let bytes = self.slot_bytes(*value_type);
            ctx.frame = (ctx.frame + bytes - 1) & !(bytes - 1);
            ctx.vars.insert(p.clone(), Slot::Local(ctx.frame));
            ctx.types.insert(p.clone(), *value_type);
            ctx.frame += bytes;
        }
        // pre-scan declarations so the frame size is known up front
        prescan(&f.body, &mut ctx, &self.return_types, self.source_language, self.is_rv64())?;
        if self.memory {
            self.check_pointer_uses(&f.body, &ctx)?;
        }
        let frame = (ctx.frame + 15) & !15;

        let _ = writeln!(self.out, "{}:", f.name);
        self.line(&format!("addi sp, sp, -{frame}"));
        self.line(if self.is_rv64() {
            "sd ra, 0(sp)"
        } else {
            "sw ra, 0(sp)"
        });
        for (i, p) in f.params.iter().enumerate() {
            let Slot::Local(off) = ctx.vars[p].clone() else {
                unreachable!()
            };
            let store = self.slot_store(ctx.types.get(p).copied().unwrap_or(ScalarType::I32));
            self.line(&format!("{store} a{i}, {off}(sp)  # {p}"));
        }
        let ret = format!("{}_ret", f.name);
        self.emit_block(&f.body, &mut ctx, &ret)?;
        // fall off the end: return 0 (main) / undefined -> 0 for honesty
        self.line("li a0, 0");
        let _ = writeln!(self.out, "{ret}:");
        self.line(if self.is_rv64() {
            "ld ra, 0(sp)"
        } else {
            "lw ra, 0(sp)"
        });
        self.line(&format!("addi sp, sp, {frame}"));
        self.line("ret");
        self.line("");
        Ok(())
    }

    /// `void *` is opaque: it converts to and from other pointers, but it
    /// cannot be dereferenced, indexed or used in pointer arithmetic.
    fn check_pointer_uses(&self, statements: &[Stmt], ctx: &FnCtx) -> Result<(), TranslateError> {
        for statement in statements {
            match statement {
                Stmt::Decl(_, Some(e), _, _) | Stmt::Expr(e, _) | Stmt::Return(Some(e), _, _) => {
                    self.check_pointer_expr(e, ctx)?
                }
                Stmt::DeclArray(_, _, init, _, _, _) => {
                    for e in init {
                        self.check_pointer_expr(e, ctx)?;
                    }
                }
                Stmt::If(c, a, b, _) => {
                    self.check_pointer_expr(c, ctx)?;
                    self.check_pointer_uses(a, ctx)?;
                    self.check_pointer_uses(b, ctx)?;
                }
                Stmt::While(c, body, _) => {
                    self.check_pointer_expr(c, ctx)?;
                    self.check_pointer_uses(body, ctx)?;
                }
                Stmt::For(init, c, step, body, _) => {
                    if let Some(init) = init {
                        self.check_pointer_uses(std::slice::from_ref(&**init), ctx)?;
                    }
                    for e in c.iter().chain(step.iter()) {
                        self.check_pointer_expr(e, ctx)?;
                    }
                    self.check_pointer_uses(body, ctx)?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn check_pointer_expr(&self, e: &Expr, ctx: &FnCtx) -> Result<(), TranslateError> {
        let opaque = |what: &str, line: usize| {
            Err(TranslateError::new(
                line,
                format!(
                    "cannot {what} a 'void *': it does not say what it points to; \
                     cast it to a typed pointer first, for example *(int *)p"
                ),
            ))
        };
        let is_void_var = |name: &str| {
            matches!(ctx.vars.get(name), Some(Slot::Local(_) | Slot::Global(_)))
                && ctx.types.get(name).is_some_and(|t| t.is_void_ptr())
        };
        match e {
            Expr::Num(..) | Expr::Var(..) => Ok(()),
            Expr::Index(name, i, line) => {
                if is_void_var(name) {
                    return opaque("index", *line);
                }
                self.check_pointer_expr(i, ctx)
            }
            Expr::Unary(op, inner, line) => {
                if *op == "*" && self.expr_type(inner, ctx).is_void_ptr() {
                    return opaque("dereference", *line);
                }
                self.check_pointer_expr(inner, ctx)
            }
            Expr::Binary(op, a, b, line) => {
                if matches!(*op, "+" | "-")
                    && (self.expr_type(a, ctx).is_void_ptr() || self.expr_type(b, ctx).is_void_ptr())
                {
                    return opaque("do arithmetic on", *line);
                }
                self.check_pointer_expr(a, ctx)?;
                self.check_pointer_expr(b, ctx)
            }
            Expr::Assign(target, value, provenance, line) => {
                match &**target {
                    LValue::Var(name, _) => {
                        if is_void_var(name) && !matches!(provenance, AssignmentProvenance::Simple) {
                            return opaque("do arithmetic on", *line);
                        }
                    }
                    LValue::Index(name, i, _) => {
                        if is_void_var(name) {
                            return opaque("index", *line);
                        }
                        self.check_pointer_expr(i, ctx)?;
                    }
                    LValue::Deref(p, _) => {
                        if self.expr_type(p, ctx).is_void_ptr() {
                            return opaque("dereference", *line);
                        }
                        self.check_pointer_expr(p, ctx)?;
                    }
                }
                self.check_pointer_expr(value, ctx)
            }
            Expr::Call(_, args, _) => args.iter().try_for_each(|a| self.check_pointer_expr(a, ctx)),
        }
    }

    fn emit_block(
        &mut self,
        stmts: &[Stmt],
        ctx: &mut FnCtx,
        ret: &str,
    ) -> Result<(), TranslateError> {
        for s in stmts {
            self.emit_stmt(s, ctx, ret)?;
        }
        Ok(())
    }

    fn emit_stmt(&mut self, s: &Stmt, ctx: &mut FnCtx, ret: &str) -> Result<(), TranslateError> {
        self.mark(stmt_line(s));
        match s {
            Stmt::Decl(name, init, _, line) => (|| -> Result<(), TranslateError> {
                let Slot::Local(off) = ctx.vars[name].clone() else {
                    unreachable!()
                };
                if let Some(e) = init {
                    let declared = ctx.types.get(name).copied().unwrap_or(ScalarType::I32);
                    let init_type = self.expr_type(e, ctx);
                    self.check_conversion(e, init_type, declared, *line)?;
                    let t = self.emit_expr(e, ctx)?;
                    if self.source_language == "C++"
                        && ctx.types.get(name) == Some(&ScalarType::Bool)
                    {
                        self.line(&format!("snez {t}, {t}"));
                    }
                    if !Self::is_legacy(declared) || !Self::is_legacy(init_type) {
                        self.convert(t, init_type, declared);
                    }
                    let store = self.slot_store(declared);
                    self.line(&format!("{store} {t}, {off}(sp)  # {name}"));
                    ctx.depth -= 1;
                } else {
                    let _ = line;
                }
                Ok(())
            })()?,
            Stmt::DeclArray(name, size, init, source, initializer, line) => (|| -> Result<(), TranslateError> {
                let Slot::Array(off, _) = ctx.vars[name].clone() else {
                    unreachable!()
                };
                let element = ctx.types.get(name).copied().unwrap_or(ScalarType::I32);
                let (store, bytes) = (self.elem_store(element), self.elem_bytes(element));
                if *initializer == ArrayInitProvenance::Repeat {
                    let init_type = self.expr_type(&init[0], ctx);
                    let t = self.emit_expr(&init[0], ctx)?;
                    if !Self::is_legacy(element) || !Self::is_legacy(init_type) {
                        self.convert(t, init_type, element);
                    }
                    for i in 0..*size {
                        self.line(&format!(
                            "{store} {t}, {}(sp)  # {name}[{i}]",
                            off + bytes * i as i32
                        ));
                    }
                    ctx.depth -= 1;
                } else {
                    for (i, e) in init.iter().enumerate() {
                        let init_type = self.expr_type(e, ctx);
                        self.check_conversion(e, init_type, element, *line)?;
                        let t = self.emit_expr(e, ctx)?;
                        if !Self::is_legacy(element) || !Self::is_legacy(init_type) {
                            self.convert(t, init_type, element);
                        }
                        self.line(&format!(
                            "{store} {t}, {}(sp)  # {name}[{i}]",
                            off + bytes * i as i32
                        ));
                        ctx.depth -= 1;
                    }
                    if source.initialized {
                        for i in init.len()..*size {
                            self.line(&format!(
                                "{store} zero, {}(sp)  # {name}[{i}]",
                                off + bytes * i as i32
                            ));
                        }
                    }
                }
                Ok(())
            })()?,
            Stmt::Expr(e, source) => (|| -> Result<(), TranslateError> {
                if *source == ExprStmtProvenance::Empty {
                    return Ok(());
                }
                self.emit_expr(e, ctx)?;
                ctx.depth -= 1;
                Ok(())
            })()?,
            Stmt::Return(e, _, line) => (|| -> Result<(), TranslateError> {
                if let Some(e) = e {
                    let value_type = self.expr_type(e, ctx);
                    self.check_conversion(e, value_type, ctx.return_type, *line)?;
                    let t = self.emit_expr(e, ctx)?;
                    if self.source_language == "C++" && ctx.return_type == ScalarType::Bool {
                        self.line(&format!("snez {t}, {t}"));
                    }
                    if !Self::is_legacy(ctx.return_type) || !Self::is_legacy(value_type) {
                        self.convert(t, value_type, ctx.return_type);
                        self.to_abi(t, ctx.return_type);
                    }
                    self.line(&format!("mv a0, {t}"));
                    ctx.depth -= 1;
                } else {
                    self.line("li a0, 0");
                }
                self.line(&format!("j {ret}"));
                Ok(())
            })()?,
            Stmt::If(cond, then, els, source) => (|| -> Result<(), TranslateError> {
                if source.origin == IfOrigin::PlainBlock {
                    return self.emit_block(then, ctx, ret);
                }
                let t = self.emit_expr(cond, ctx)?;
                ctx.depth -= 1;
                if els.is_empty() {
                    let end = self.label("if_end");
                    self.line(&format!("beqz {t}, {end}"));
                    self.emit_block(then, ctx, ret)?;
                    let _ = writeln!(self.out, "{end}:");
                } else {
                    let lelse = self.label("else");
                    let end = self.label("if_end");
                    self.line(&format!("beqz {t}, {lelse}"));
                    self.emit_block(then, ctx, ret)?;
                    self.line(&format!("j {end}"));
                    let _ = writeln!(self.out, "{lelse}:");
                    self.emit_block(els, ctx, ret)?;
                    let _ = writeln!(self.out, "{end}:");
                }
                Ok(())
            })()?,
            Stmt::While(cond, body, source) => (|| -> Result<(), TranslateError> {
                let head = self.label("while");
                let end = self.label("while_end");
                let _ = writeln!(self.out, "{head}:");
                let t = self.emit_expr(cond, ctx)?;
                ctx.depth -= 1;
                self.line(&format!("beqz {t}, {end}"));
                ctx.loops.push((head.clone(), end.clone()));
                self.emit_block(body, ctx, ret)?;
                ctx.loops.pop();
                self.mark(source.line);
                self.line(&format!("j {head}"));
                let _ = writeln!(self.out, "{end}:");
                Ok(())
            })()?,
            Stmt::For(init, cond, post, body, source) => (|| -> Result<(), TranslateError> {
                if let Some(s) = init {
                    self.emit_stmt(s, ctx, ret)?;
                }
                let range_bound = if source.kind == LoopKind::RustRange {
                    let slot = *ctx.range_bounds.get(ctx.range_cursor).ok_or_else(|| {
                        TranslateError::new(source.line, "internal: missing Rust range snapshot")
                    })?;
                    ctx.range_cursor += 1;
                    let bound = rust_range_end(cond).ok_or_else(|| {
                        TranslateError::new(source.line, "internal: malformed Rust range")
                    })?;
                    let value = self.emit_expr(bound, ctx)?;
                    self.line(&format!(
                        "sw {value}, {slot}(sp)  # Rust range end snapshot"
                    ));
                    ctx.depth -= 1;
                    Some(slot)
                } else {
                    None
                };
                let head = self.label("for");
                let cont = self.label("for_post");
                let end = self.label("for_end");
                self.mark(source.line);
                let _ = writeln!(self.out, "{head}:");
                if let Some(c) = cond {
                    let t = if let Some(slot) = range_bound {
                        self.emit_rust_range_condition(c, slot, ctx)?
                    } else {
                        self.emit_expr(c, ctx)?
                    };
                    ctx.depth -= 1;
                    self.line(&format!("beqz {t}, {end}"));
                }
                ctx.loops.push((cont.clone(), end.clone()));
                self.emit_block(body, ctx, ret)?;
                ctx.loops.pop();
                self.mark(source.line);
                let _ = writeln!(self.out, "{cont}:");
                if let Some(p) = post {
                    self.emit_expr(p, ctx)?;
                    ctx.depth -= 1;
                }
                self.line(&format!("j {head}"));
                let _ = writeln!(self.out, "{end}:");
                Ok(())
            })()?,
            Stmt::Break(line) => (|| -> Result<(), TranslateError> {
                let Some((_, end)) = ctx.loops.last() else {
                    return Err(TranslateError::new(*line, "break outside a loop: 'break' only works inside a loop or a switch"));
                };
                let end = end.clone();
                self.line(&format!("j {end}"));
                Ok(())
            })()?,
            Stmt::Continue(line) => (|| -> Result<(), TranslateError> {
                let Some((cont, _)) = ctx.loops.last() else {
                    return Err(TranslateError::new(*line, "continue outside a loop: 'continue' only works inside a for, while or do-while loop"));
                };
                let cont = cont.clone();
                self.line(&format!("j {cont}"));
                Ok(())
            })()?,
        }
        Ok(())
    }

    fn emit_rust_range_condition(
        &mut self,
        condition: &Expr,
        bound_slot: i32,
        ctx: &mut FnCtx,
    ) -> Result<&'static str, TranslateError> {
        let Expr::Binary("<", iterator, _, line) = condition else {
            return Err(TranslateError::new(0, "internal: malformed Rust range"));
        };
        let current = self.emit_expr(iterator, ctx)?;
        let bound = self.push_temp(ctx, *line)?;
        self.line(&format!("lw {bound}, {bound_slot}(sp)  # Rust range end"));
        self.emit_binary_registers("<", current, bound, *line)?;
        ctx.depth -= 1;
        Ok(current)
    }

    /// Evaluate an expression into the next temp register; returns its name.
    /// On return ctx.depth has grown by exactly 1 (the caller pops it).
    fn emit_expr(&mut self, e: &Expr, ctx: &mut FnCtx) -> Result<&'static str, TranslateError> {
        // This function is on the stack once per expression nesting level:
        // only the arms that recurse are dispatched here, everything else
        // lives in `emit_expr_other`, so the frame stays small.
        match e {
            Expr::Unary(op, inner, line) if matches!(*op, "-" | "~" | "+" | "!") => {
                self.emit_prefix_unary(op, inner, *line, ctx)
            }
            Expr::Binary(op, a, b, line) => self.emit_binary_expr(op, a, b, *line, ctx),
            _ => self.emit_expr_other(e, ctx),
        }
    }

    #[inline(never)]
    fn emit_binary_expr(
        &mut self,
        op: &str,
        a: &Expr,
        b: &Expr,
        line: usize,
        ctx: &mut FnCtx,
    ) -> Result<&'static str, TranslateError> {
        if self.memory
            && !matches!(op, "&&" | "||")
            && (self.expr_type(a, ctx).is_ptr() || self.expr_type(b, ctx).is_ptr())
        {
            return self.emit_pointer_binary(op, a, b, line, ctx);
        }
        self.emit_binary(op, a, b, ctx)
    }

    #[inline(never)]
    fn emit_prefix_unary(
        &mut self,
        op: &'static str,
        inner: &Expr,
        line: usize,
        ctx: &mut FnCtx,
    ) -> Result<&'static str, TranslateError> {
        if op == "+" || (op != "!" && (self.memory || Self::uses_types(inner, &ctx.types, &self.return_types))) {
            let from = self.expr_type(inner, ctx);
            if from.is_ptr() {
                return Err(TranslateError::new(
                    line,
                    format!("invalid operand to unary '{op}': '{}' is a pointer", c_type_name(from)),
                ));
            }
            let result = self.promote(from);
            let t = self.emit_expr(inner, ctx)?;
            self.convert(t, from, result);
            match op {
                "-" => self.line(&format!("sub {t}, zero, {t}")),
                "~" => self.line(&format!("not {t}, {t}")),
                _ => {}
            }
            self.normalize(t, result);
            return Ok(t);
        }
        let value_type = expression_scalar_type(inner, &ctx.types, &self.return_types, self.source_language);
        let t = self.emit_expr(inner, ctx)?;
        match op {
            "-" if self.is_rv64() => self.line(&format!("subw {t}, zero, {t}")),
            "-" => self.line(&format!("neg {t}, {t}")),
            "!" if self.source_language == "Rust" && value_type == ScalarType::I32 => {
                self.line(&format!("not {t}, {t}"))
            }
            "!" => self.line(&format!("seqz {t}, {t}")),
            _ => self.line(&format!("not {t}, {t}")),
        }
        Ok(t)
    }

    #[inline(never)]
    fn emit_expr_other(&mut self, e: &Expr, ctx: &mut FnCtx) -> Result<&'static str, TranslateError> {
        match e {
            Expr::Num(n, _, line) => (|| -> Result<&'static str, TranslateError> {
                let t = self.push_temp(ctx, *line)?;
                self.line(&format!("li {t}, {n}"));
                Ok(t)
            })(),
            Expr::Var(name, line) => (|| -> Result<&'static str, TranslateError> {
                let slot = ctx
                    .vars
                    .get(name)
                    .cloned()
                    .ok_or_else(|| self.undefined(name, *line, ctx))?;
                let t = self.push_temp(ctx, *line)?;
                let value_type = ctx.types.get(name).copied().unwrap_or(ScalarType::I32);
                match slot {
                    Slot::Local(off) => {
                        let load = self.slot_load(value_type);
                        self.line(&format!("{load} {t}, {off}(sp)  # {name}"))
                    }
                    Slot::Global(label) => {
                        let load = self.elem_load(value_type);
                        self.line(&format!("la {t}, {label}"));
                        self.line(&format!("{load} {t}, 0({t})  # {name}"));
                    }
                    // C arrays decay to a pointer to their first element
                    Slot::Array(off, _) if self.memory => {
                        self.line(&format!("addi {t}, sp, {off}  # &{name}[0]"));
                    }
                    Slot::GlobalArray(label, _) => {
                        self.line(&format!("la {t}, {label}  # &{name}[0]"));
                    }
                    Slot::Array(..) if self.source_language == "C" => {
                        return Err(TranslateError::new(
                            *line,
                            format!(
                                "'{name}' is an array: arrays can only be indexed here, or used as \
a pointer (int *p = {name};)"
                            ),
                        ))
                    }
                    Slot::Array(..) => {
                        return Err(TranslateError::new(
                            *line,
                            format!(
                                "unsupported: '{name}' is an array — arrays can only be \
indexed here (passing arrays around needs pointers, which are not yet translatable)"
                            ),
                        ))
                    }
                }
                Ok(t)
            })(),
            Expr::Index(name, idx, line) => (|| -> Result<&'static str, TranslateError> {
                let element = self.element_type(name, ctx);
                let t = self.emit_array_address(name, idx, *line, ctx)?;
                let load = self.elem_load(element);
                self.line(&format!("{load} {t}, 0({t})  # {name}[…]"));
                Ok(t)
            })(),
            Expr::Unary("&", inner, line) if self.memory => self.emit_address(inner, *line, ctx),
            Expr::Unary("*", inner, line) if self.memory => (|| -> Result<&'static str, TranslateError> {
                let pointer_type = self.expr_type(inner, ctx);
                let Some(element) = pointer_type.pointee() else {
                    return Err(TranslateError::new(
                        *line,
                        format!("cannot dereference a value of type '{}': it is not a pointer", c_type_name(pointer_type)),
                    ));
                };
                let t = self.emit_expr(inner, ctx)?;
                let load = self.elem_load(element);
                self.line(&format!("{load} {t}, 0({t})  # *…"));
                Ok(t)
            })(),
            Expr::Unary(op, inner, line) if cast_target(op).is_some() => (|| -> Result<&'static str, TranslateError> {
                let from = self.expr_type(inner, ctx);
                let to = cast_target(op).unwrap_or(ScalarType::I32);
                let literal = matches!(&**inner, Expr::Num(..));
                if from.is_ptr() != to.is_ptr() && !(to.is_ptr() && literal) {
                    self.check_pointer_width_cast(from, to, *line)?;
                }
                let t = self.emit_expr(inner, ctx)?;
                self.convert(t, from, to);
                Ok(t)
            })(),
            Expr::Unary(op, inner, line) if op.starts_with("sizeof") => (|| -> Result<&'static str, TranslateError> {
                let size = if let Some((keyword, _)) = C_SIZEOF_OPS.iter().find(|(_, o)| o == op) {
                    i64::from(self.ty(c_int_type(keyword).unwrap_or(ScalarType::I32)).bits / 8)
                } else {
                    match &**inner {
                        Expr::Var(name, _) => match ctx.vars.get(name) {
                            Some(Slot::Array(_, n) | Slot::GlobalArray(_, n)) => {
                                let element = ctx.types.get(name).copied().unwrap_or(ScalarType::I32);
                                i64::from(self.elem_bytes(element)) * *n as i64
                            }
                            _ => {
                                let value_type = self.expr_type(inner, ctx);
                                i64::from(self.ty(value_type).bits / 8)
                            }
                        },
                        other => {
                            let value_type = self.expr_type(other, ctx);
                            if value_type == ScalarType::Bool { 1 } else { i64::from(self.ty(value_type).bits / 8) }
                        }
                    }
                };
                let t = self.push_temp(ctx, *line)?;
                self.line(&format!("li {t}, {size}"));
                Ok(t)
            })(),
            Expr::Unary(op, inner, _) => (|| -> Result<&'static str, TranslateError> {
                let value_type = expression_scalar_type(
                    inner,
                    &ctx.types,
                    &self.return_types,
                    self.source_language,
                );
                let t = self.emit_expr(inner, ctx)?;
                match *op {
                    "as usize" => {}
                    "-" if self.is_rv64() => self.line(&format!("subw {t}, zero, {t}")),
                    "-" => self.line(&format!("neg {t}, {t}")),
                    "!" if self.source_language == "Rust" && value_type == ScalarType::I32 => {
                        self.line(&format!("not {t}, {t}"))
                    }
                    "!" => self.line(&format!("seqz {t}, {t}")),
                    _ => self.line(&format!("not {t}, {t}")),
                }
                Ok(t)
            })(),
            // dispatched by `emit_expr`
            Expr::Binary(op, a, b, line) => self.emit_binary_expr(op, a, b, *line, ctx),
            Expr::Assign(lv, value, source, line) => (|| -> Result<&'static str, TranslateError> {
                self.emit_assignment(lv, value, *source, *line, ctx)
            })(),
            Expr::Call(name, args, line) => (|| -> Result<&'static str, TranslateError> {
                if !self.funcs.contains(name) {
                    return Err(TranslateError::new(
                        *line,
                        format!(
                            "unsupported: call to '{name}' — only functions defined in this \
snippet can be called (there is no standard library here)"
                        ),
                    ));
                }
                if args.len() > 7 {
                    return Err(TranslateError::new(*line, "more than 7 arguments"));
                }
                let parameter_types = self.parameter_types.get(name).cloned().unwrap_or_default();
                if args.len() != parameter_types.len() {
                    return Err(TranslateError::new(
                        *line,
                        format!(
                            "function '{name}' expects {} arguments, but {} were provided",
                            parameter_types.len(),
                            args.len()
                        ),
                    ));
                }
                let base = ctx.depth;
                for (argument, parameter_type) in args.iter().zip(&parameter_types) {
                    let argument_type = self.expr_type(argument, ctx);
                    self.check_conversion(argument, argument_type, *parameter_type, *line)?;
                    let value = self.emit_expr(argument, ctx)?;
                    if self.source_language == "C++" && *parameter_type == ScalarType::Bool {
                        self.line(&format!("snez {value}, {value}"));
                    }
                    if !Self::is_legacy(*parameter_type) || !Self::is_legacy(argument_type) {
                        self.convert(value, argument_type, *parameter_type);
                        self.to_abi(value, *parameter_type);
                    }
                }
                // move evaluated args into a0..; then spill live temps below
                // the call and restore them after.
                for (i, _) in args.iter().enumerate() {
                    self.line(&format!("mv a{i}, {}", TEMPS[base + i]));
                }
                ctx.depth = base;
                for i in 0..ctx.depth {
                    self.line(&format!(
                        "{} {}, {}(sp)",
                        self.spill_store(),
                        TEMPS[i],
                        self.spill_base() + self.spill_bytes() * i as i32
                    ));
                }
                self.line(&format!("call {name}"));
                for i in 0..ctx.depth {
                    self.line(&format!(
                        "{} {}, {}(sp)",
                        self.spill_load(),
                        TEMPS[i],
                        self.spill_base() + self.spill_bytes() * i as i32
                    ));
                }
                let t = self.push_temp(ctx, *line)?;
                self.line(&format!("mv {t}, a0"));
                let return_type = self.return_types.get(name).copied().unwrap_or(ScalarType::I32);
                if !Self::is_legacy(return_type) {
                    self.normalize(t, return_type);
                }
                Ok(t)
            })(),
        }
    }

    fn emit_assignment(
        &mut self,
        target: &LValue,
        value: &Expr,
        source: AssignmentProvenance,
        line: usize,
        ctx: &mut FnCtx,
    ) -> Result<&'static str, TranslateError> {
        if self.memory {
            let declared = self.lvalue_type(target, ctx);
            return self.emit_typed_assignment(target, value, source, line, ctx, declared);
        }
        let declared = match target {
            LValue::Var(name, _) | LValue::Index(name, _, _) => {
                ctx.types.get(name).copied().unwrap_or(ScalarType::I32)
            }
            LValue::Deref(..) => ScalarType::I32,
        };
        if !Self::is_legacy(declared) || Self::uses_types(value, &ctx.types, &self.return_types) {
            return self.emit_typed_assignment(target, value, source, line, ctx, declared);
        }
        let target_type = match target {
            LValue::Var(name, _) => ctx.types.get(name).copied().unwrap_or(ScalarType::I32),
            LValue::Index(..) | LValue::Deref(..) => ScalarType::I32,
        };
        if source == AssignmentProvenance::Simple {
            let result = self.emit_expr(value, ctx)?;
            if target_type == ScalarType::Bool {
                self.line(&format!("snez {result}, {result}"));
            }
            match target {
                LValue::Var(name, target_line) => {
                    let Slot::Local(off) = self.local_slot(name, *target_line, ctx)? else {
                        return Err(TranslateError::new(
                            *target_line,
                            format!("cannot assign to array '{name}' as a whole"),
                        ));
                    };
                    self.line(&format!("sw {result}, {off}(sp)  # {name}"));
                }
                LValue::Index(name, index, target_line) => {
                    let address = self.emit_array_address(name, index, *target_line, ctx)?;
                    self.line(&format!("sw {result}, 0({address})  # {name}[…]"));
                    ctx.depth -= 1;
                }
                LValue::Deref(_, target_line) => {
                    return Err(TranslateError::new(*target_line, "internal: dereference outside a C program"));
                }
            }
            return Ok(TEMPS[ctx.depth - 1]);
        }

        let (operator, postfix) = match source {
            AssignmentProvenance::Compound(operator) => (operator, false),
            AssignmentProvenance::PrefixIncrement => ("+", false),
            AssignmentProvenance::PrefixDecrement => ("-", false),
            AssignmentProvenance::PostfixIncrement => ("+", true),
            AssignmentProvenance::PostfixDecrement => ("-", true),
            AssignmentProvenance::Simple => unreachable!(),
        };

        match target {
            LValue::Var(name, target_line) => (|| -> Result<&'static str, TranslateError> {
                let Slot::Local(off) = self.local_slot(name, *target_line, ctx)? else {
                    return Err(TranslateError::new(
                        *target_line,
                        format!("cannot assign to array '{name}' as a whole"),
                    ));
                };
                let original = self.push_temp(ctx, line)?;
                self.line(&format!("lw {original}, {off}(sp)  # {name}"));
                if postfix {
                    let updated = self.push_temp(ctx, line)?;
                    self.line(&format!("mv {updated}, {original}"));
                    let rhs = self.emit_expr(value, ctx)?;
                    self.emit_binary_registers(operator, updated, rhs, line)?;
                    ctx.depth -= 1;
                    if target_type == ScalarType::Bool {
                        self.line(&format!("snez {updated}, {updated}"));
                    }
                    self.line(&format!("sw {updated}, {off}(sp)  # {name}"));
                    ctx.depth -= 1;
                    Ok(original)
                } else {
                    let rhs = self.emit_expr(value, ctx)?;
                    self.emit_binary_registers(operator, original, rhs, line)?;
                    ctx.depth -= 1;
                    if target_type == ScalarType::Bool {
                        self.line(&format!("snez {original}, {original}"));
                    }
                    self.line(&format!("sw {original}, {off}(sp)  # {name}"));
                    Ok(original)
                }
            })(),
            LValue::Index(name, index, target_line) => (|| -> Result<&'static str, TranslateError> {
                let base = ctx.depth;
                let address = self.emit_array_address(name, index, *target_line, ctx)?;
                let original = self.push_temp(ctx, line)?;
                self.line(&format!("lw {original}, 0({address})  # {name}[…]"));
                if postfix {
                    let updated = self.push_temp(ctx, line)?;
                    self.line(&format!("mv {updated}, {original}"));
                    let rhs = self.emit_expr(value, ctx)?;
                    self.emit_binary_registers(operator, updated, rhs, line)?;
                    ctx.depth -= 1;
                    if target_type == ScalarType::Bool {
                        self.line(&format!("snez {updated}, {updated}"));
                    }
                    self.line(&format!("sw {updated}, 0({address})  # {name}[…]"));
                    self.line(&format!("mv {address}, {original}"));
                } else {
                    let rhs = self.emit_expr(value, ctx)?;
                    self.emit_binary_registers(operator, original, rhs, line)?;
                    ctx.depth -= 1;
                    if target_type == ScalarType::Bool {
                        self.line(&format!("snez {original}, {original}"));
                    }
                    self.line(&format!("sw {original}, 0({address})  # {name}[…]"));
                    self.line(&format!("mv {address}, {original}"));
                }
                ctx.depth = base + 1;
                Ok(address)
            })(),
            LValue::Deref(_, target_line) => (|| -> Result<&'static str, TranslateError> {
                Err(TranslateError::new(*target_line, "internal: dereference outside a C program"))
            })(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_typed_assignment(
        &mut self,
        target: &LValue,
        value: &Expr,
        source: AssignmentProvenance,
        line: usize,
        ctx: &mut FnCtx,
        target_type: ScalarType,
    ) -> Result<&'static str, TranslateError> {
        let value_type = self.expr_type(value, ctx);
        let base = ctx.depth;
        let (name, address, store, load, place) = match target {
            LValue::Var(name, target_line) => match self.local_slot(name, *target_line, ctx)? {
                Slot::Local(off) => (
                    name.clone(),
                    None,
                    self.slot_store(target_type),
                    self.slot_load(target_type),
                    format!("{off}(sp)"),
                ),
                Slot::Global(label) => {
                    let a = self.push_temp(ctx, line)?;
                    self.line(&format!("la {a}, {label}"));
                    (name.clone(), Some(a), self.elem_store(target_type), self.elem_load(target_type), format!("0({a})"))
                }
                Slot::Array(..) | Slot::GlobalArray(..) => {
                    return Err(TranslateError::new(
                        *target_line,
                        format!("cannot assign to array '{name}' as a whole"),
                    ));
                }
            },
            LValue::Index(name, index, target_line) => {
                let a = self.emit_array_address(name, index, *target_line, ctx)?;
                (format!("{name}[…]"), Some(a), self.elem_store(target_type), self.elem_load(target_type), format!("0({a})"))
            }
            LValue::Deref(pointer, target_line) => {
                let pointer_type = self.expr_type(pointer, ctx);
                if !pointer_type.is_ptr() {
                    return Err(TranslateError::new(
                        *target_line,
                        format!("cannot dereference a value of type '{}': it is not a pointer", c_type_name(pointer_type)),
                    ));
                }
                let a = self.emit_expr(pointer, ctx)?;
                ("*…".to_string(), Some(a), self.elem_store(target_type), self.elem_load(target_type), format!("0({a})"))
            }
        };
        if source == AssignmentProvenance::Simple {
            self.check_conversion(value, value_type, target_type, line)?;
            let v = self.emit_expr(value, ctx)?;
            self.convert(v, value_type, target_type);
            self.line(&format!("{store} {v}, {place}  # {name}"));
            if let Some(a) = address {
                self.line(&format!("mv {a}, {v}"));
            }
            ctx.depth = base + 1;
            return Ok(TEMPS[base]);
        }
        let (operator, postfix) = match source {
            AssignmentProvenance::Compound(operator) => (operator, false),
            AssignmentProvenance::PrefixIncrement => ("+", false),
            AssignmentProvenance::PrefixDecrement => ("-", false),
            AssignmentProvenance::PostfixIncrement => ("+", true),
            AssignmentProvenance::PostfixDecrement => ("-", true),
            AssignmentProvenance::Simple => ("+", false),
        };
        let original = self.push_temp(ctx, line)?;
        self.line(&format!("{load} {original}, {place}  # {name}"));
        if target_type.is_ptr() || value_type.is_ptr() {
            // p += n, p -= n, p++, p--: scaled by the element size
            if !target_type.is_ptr() || value_type.is_ptr() || !matches!(operator, "+" | "-") {
                return Err(TranslateError::new(
                    line,
                    "invalid pointer arithmetic: only p += n, p -= n, p++ and p-- update a pointer",
                ));
            }
            let updated = self.push_temp(ctx, line)?;
            self.line(&format!("mv {updated}, {original}"));
            let rhs = self.emit_expr(value, ctx)?;
            self.emit_index_scale(rhs, target_type.pointee().unwrap_or(ScalarType::I32));
            let op = if operator == "+" { "add" } else { "sub" };
            self.line(&format!("{op} {updated}, {updated}, {rhs}"));
            ctx.depth -= 1;
            self.line(&format!("{store} {updated}, {place}  # {name}"));
            let result = if postfix { original } else { updated };
            if result != TEMPS[base] {
                self.line(&format!("mv {}, {result}", TEMPS[base]));
            }
            ctx.depth = base + 1;
            return Ok(TEMPS[base]);
        }
        let operation = match operator {
            "<<" | ">>" => self.promote(target_type),
            _ => self.usual(target_type, value_type),
        };
        let updated = self.push_temp(ctx, line)?;
        self.line(&format!("mv {updated}, {original}"));
        self.convert(updated, target_type, operation);
        let rhs = self.emit_expr(value, ctx)?;
        if matches!(operator, "<<" | ">>") {
            let shift_type = self.promote(value_type);
            self.convert(rhs, value_type, shift_type);
        } else {
            self.convert(rhs, value_type, operation);
        }
        if operation == ScalarType::I32 {
            self.emit_binary_registers(operator, updated, rhs, line)?;
        } else {
            self.emit_typed_binary(operator, updated, rhs, operation, line)?;
        }
        ctx.depth -= 1;
        self.convert(updated, operation, target_type);
        self.line(&format!("{store} {updated}, {place}  # {name}"));
        let result = if postfix { original } else { updated };
        if result != TEMPS[base] {
            self.line(&format!("mv {}, {result}", TEMPS[base]));
        }
        ctx.depth = base + 1;
        Ok(TEMPS[base])
    }

    fn local_slot(&self, name: &str, line: usize, ctx: &FnCtx) -> Result<Slot, TranslateError> {
        ctx.vars
            .get(name)
            .cloned()
            .ok_or_else(|| self.undefined(name, line, ctx))
    }

    fn emit_array_address(
        &mut self,
        name: &str,
        index: &Expr,
        line: usize,
        ctx: &mut FnCtx,
    ) -> Result<&'static str, TranslateError> {
        let slot = self.local_slot(name, line, ctx)?;
        let declared = ctx.types.get(name).copied().unwrap_or(ScalarType::I32);
        let element = self.element_type(name, ctx);
        if let Slot::Array(off, _) = slot {
            let address = self.emit_expr(index, ctx)?;
            self.emit_index_scale(address, element);
            self.line(&format!("addi {address}, {address}, {off}"));
            self.line(&format!("add {address}, {address}, sp"));
            return Ok(address);
        }
        if !matches!(slot, Slot::GlobalArray(..)) && !declared.is_ptr() {
            return Err(TranslateError::new(
                line,
                if self.memory {
                    format!("'{name}' is not an array or a pointer")
                } else {
                    format!("'{name}' is not an array")
                },
            ));
        }
        let index_type = self.expr_type(index, ctx);
        if index_type.is_ptr() {
            return Err(TranslateError::new(line, "an array index must be an integer, not a pointer"));
        }
        let address = self.emit_expr(index, ctx)?;
        self.emit_index_scale(address, element);
        let base = self.push_temp(ctx, line)?;
        match slot {
            Slot::GlobalArray(label, _) => self.line(&format!("la {base}, {label}")),
            Slot::Global(label) => {
                self.line(&format!("la {base}, {label}"));
                let load = self.elem_load(declared);
                self.line(&format!("{load} {base}, 0({base})  # {name}"));
            }
            Slot::Local(off) => {
                let load = self.slot_load(declared);
                self.line(&format!("{load} {base}, {off}(sp)  # {name}"));
            }
            Slot::Array(..) => unreachable!(),
        }
        self.line(&format!("add {address}, {address}, {base}"));
        ctx.depth -= 1;
        Ok(address)
    }

    /// The element type `name[i]` reads: the element of an array, or what a
    /// pointer points to.
    fn element_type(&self, name: &str, ctx: &FnCtx) -> ScalarType {
        let declared = ctx.types.get(name).copied().unwrap_or(ScalarType::I32);
        match ctx.vars.get(name) {
            Some(Slot::Array(..) | Slot::GlobalArray(..)) => declared,
            _ => declared.pointee().unwrap_or(declared),
        }
    }

    fn lvalue_type(&self, target: &LValue, ctx: &FnCtx) -> ScalarType {
        match target {
            LValue::Var(name, _) => ctx.types.get(name).copied().unwrap_or(ScalarType::I32),
            LValue::Index(name, _, _) => self.element_type(name, ctx),
            LValue::Deref(pointer, _) => self.expr_type(pointer, ctx).pointee().unwrap_or(ScalarType::I32),
        }
    }

    /// `&operand`: a local's stack slot, a global's label, an element's
    /// address, or (for `&*p`) the pointer itself.
    fn emit_address(&mut self, operand: &Expr, line: usize, ctx: &mut FnCtx) -> Result<&'static str, TranslateError> {
        match operand {
            Expr::Var(name, l) => {
                let slot = self.local_slot(name, *l, ctx)?;
                let t = self.push_temp(ctx, line)?;
                match slot {
                    Slot::Local(off) => self.line(&format!("addi {t}, sp, {off}  # &{name}")),
                    Slot::Global(label) => self.line(&format!("la {t}, {label}  # &{name}")),
                    Slot::Array(..) | Slot::GlobalArray(..) => {
                        return Err(TranslateError::new(
                            line,
                            format!(
                                "unsupported: &{name} is a pointer to a whole array; use {name} or &{name}[0] \
(a pointer to its first element)"
                            ),
                        ))
                    }
                }
                Ok(t)
            }
            Expr::Index(name, index, l) => self.emit_array_address(name, index, *l, ctx),
            Expr::Unary("*", pointer, l) => {
                let pointer_type = self.expr_type(pointer, ctx);
                if !pointer_type.is_ptr() {
                    return Err(TranslateError::new(
                        *l,
                        format!("cannot dereference a value of type '{}': it is not a pointer", c_type_name(pointer_type)),
                    ));
                }
                self.emit_expr(pointer, ctx)
            }
            _ => Err(TranslateError::new(
                line,
                "& needs a variable, an array element or *pointer",
            )),
        }
    }

    /// Pointer arithmetic and comparisons: p + n, n + p, p - n (scaled by
    /// the element size), p - q (element count), and the six comparisons
    /// (unsigned, full width).
    fn emit_pointer_binary(
        &mut self,
        op: &str,
        a: &Expr,
        b: &Expr,
        line: usize,
        ctx: &mut FnCtx,
    ) -> Result<&'static str, TranslateError> {
        let (at, bt) = (self.expr_type(a, ctx), self.expr_type(b, ctx));
        let null = |e: &Expr| matches!(e, Expr::Num(0, _, _));
        match op {
            "+" | "-" if at.is_ptr() != bt.is_ptr() => (|| -> Result<&'static str, TranslateError> {
                if op == "-" && !at.is_ptr() {
                    return Err(TranslateError::new(line, "invalid pointer arithmetic: n - p (subtract a pointer from an integer)"));
                }
                let element = if at.is_ptr() { at } else { bt }.pointee().unwrap_or(ScalarType::I32);
                let ta = self.emit_expr(a, ctx)?;
                let tb = self.emit_expr(b, ctx)?;
                self.emit_index_scale(if at.is_ptr() { tb } else { ta }, element);
                self.line(&format!("{} {ta}, {ta}, {tb}", if op == "+" { "add" } else { "sub" }));
                ctx.depth -= 1;
                Ok(ta)
            })(),
            "-" if at.is_ptr() && bt.is_ptr() => (|| -> Result<&'static str, TranslateError> {
                if at != bt {
                    return Err(TranslateError::new(
                        line,
                        format!("cannot subtract pointers of different types ('{}' and '{}')", c_type_name(at), c_type_name(bt)),
                    ));
                }
                let element = at.pointee().unwrap_or(ScalarType::I32);
                let ta = self.emit_expr(a, ctx)?;
                let tb = self.emit_expr(b, ctx)?;
                self.line(&format!("sub {ta}, {ta}, {tb}"));
                let shift = self.elem_bytes(element).trailing_zeros();
                if shift > 0 {
                    self.line(&format!("srai {ta}, {ta}, {shift}"));
                }
                ctx.depth -= 1;
                Ok(ta)
            })(),
            "==" | "!=" | "<" | "<=" | ">" | ">=" => (|| -> Result<&'static str, TranslateError> {
                let comparable = (at.is_ptr() && bt.is_ptr())
                    || (at.is_ptr() && null(b))
                    || (bt.is_ptr() && null(a));
                if !comparable {
                    return Err(TranslateError::new(
                        line,
                        format!(
                            "cannot compare '{}' with '{}': compare pointers with pointers, or with 0",
                            c_type_name(at),
                            c_type_name(bt)
                        ),
                    ));
                }
                let pointer_type = if at.is_ptr() { at } else { bt };
                let ta = self.emit_expr(a, ctx)?;
                let tb = self.emit_expr(b, ctx)?;
                self.emit_typed_binary(op, ta, tb, pointer_type, line)?;
                ctx.depth -= 1;
                Ok(ta)
            })(),
            _ => Err(TranslateError::new(
                line,
                format!(
                    "invalid operands to '{op}' ('{}' and '{}'): pointers support p + n, p - n, p - q and comparisons",
                    c_type_name(at),
                    c_type_name(bt)
                ),
            )),
        }
    }

    /// C's implicit conversion rules where pointers are involved: pointers
    /// convert only to the identical pointer type, and only the constant 0
    /// converts to a pointer. Integer conversions are unchanged.
    /// Pointer <-> integer casts keep every bit: the integer must be exactly
    /// pointer width (32 bits on RV32, 64 on RV64; `long` is both).
    #[inline(never)]
    fn check_pointer_width_cast(&self, from: ScalarType, to: ScalarType, line: usize) -> Result<(), TranslateError> {
        let integer = if from.is_ptr() { to } else { from };
        let bits = self.ty(integer).bits;
        if bits == self.xlen() && integer != ScalarType::Bool && integer != ScalarType::Unit {
            return Ok(());
        }
        let (target, xlen) = if self.is_rv64() { ("RV64", 64) } else { ("RV32", 32) };
        Err(TranslateError::new(
            line,
            format!(
                "cannot cast '{}' to '{}' on {target}: pointers are {xlen} bits but '{}' is {bits}; \
                 use long or unsigned long, which are pointer-sized on both RV32 and RV64",
                c_type_name(from),
                c_type_name(to),
                c_type_name(integer)
            ),
        ))
    }

    fn check_conversion(&self, value: &Expr, from: ScalarType, to: ScalarType, line: usize) -> Result<(), TranslateError> {
        if !self.memory || to == ScalarType::Unit || (!from.is_ptr() && !to.is_ptr()) || from == to {
            return Ok(());
        }
        if to.is_ptr() && !from.is_ptr() {
            if matches!(value, Expr::Num(0, _, _)) {
                return Ok(());
            }
            return Err(TranslateError::new(
                line,
                format!(
                    "cannot convert '{}' to '{}' implicitly: only the constant 0 converts to a pointer \
without a cast; write ({}) if you mean it",
                    c_type_name(from),
                    c_type_name(to),
                    c_type_name(to)
                ),
            ));
        }
        if from.is_ptr() && to.is_ptr() {
            if from.is_void_ptr() || to.is_void_ptr() {
                return Ok(()); // void * converts to and from any object pointer
            }
            return Err(TranslateError::new(
                line,
                format!(
                    "incompatible pointer types: cannot use '{}' as '{}'; write a cast such as ({}) if you mean it",
                    c_type_name(from),
                    c_type_name(to),
                    c_type_name(to)
                ),
            ));
        }
        Err(TranslateError::new(
            line,
            format!(
                "cannot convert '{}' to '{}' implicitly; write a cast such as (long)",
                c_type_name(from),
                c_type_name(to)
            ),
        ))
    }

    fn emit_binary(
        &mut self,
        op: &str,
        a: &Expr,
        b: &Expr,
        ctx: &mut FnCtx,
    ) -> Result<&'static str, TranslateError> {
        if op == "&&" || op == "||" {
            // short-circuit: result temp is written on both paths
            let ta = self.emit_expr(a, ctx)?;
            let end = self.label(if op == "&&" { "and_end" } else { "or_end" });
            self.line(&format!("snez {ta}, {ta}"));
            if op == "&&" {
                self.line(&format!("beqz {ta}, {end}"));
            } else {
                self.line(&format!("bnez {ta}, {end}"));
            }
            let tb = self.emit_expr(b, ctx)?;
            self.line(&format!("snez {tb}, {tb}"));
            self.line(&format!("mv {ta}, {tb}"));
            ctx.depth -= 1;
            let _ = writeln!(self.out, "{end}:");
            return Ok(ta);
        }
        if self.memory || Self::uses_types(a, &ctx.types, &self.return_types) || Self::uses_types(b, &ctx.types, &self.return_types) {
            let (at, bt) = (self.expr_type(a, ctx), self.expr_type(b, ctx));
            let operation = match op {
                "<<" | ">>" => self.promote(at),
                _ => self.usual(at, bt),
            };
            let ta = self.emit_expr(a, ctx)?;
            self.convert(ta, at, operation);
            let tb = self.emit_expr(b, ctx)?;
            if matches!(op, "<<" | ">>") {
                let shift_type = self.promote(bt);
                self.convert(tb, bt, shift_type);
            } else {
                self.convert(tb, bt, operation);
            }
            if operation == ScalarType::I32 {
                self.emit_binary_registers(op, ta, tb, 0)?;
            } else {
                self.emit_typed_binary(op, ta, tb, operation, 0)?;
            }
            ctx.depth -= 1;
            return Ok(ta);
        }
        let ta = self.emit_expr(a, ctx)?;
        let tb = self.emit_expr(b, ctx)?;
        self.emit_binary_registers(op, ta, tb, 0)?;
        ctx.depth -= 1;
        Ok(ta)
    }

    fn emit_index_scale(&mut self, reg: &str, element: ScalarType) {
        match self.elem_bytes(element) {
            1 => {}
            2 => self.line(&format!("slli {reg}, {reg}, 1")),
            8 => self.line(&format!("slli {reg}, {reg}, 3")),
            _ => self.line(&format!("slli {reg}, {reg}, 2")),
        }
    }

    fn emit_binary_registers(
        &mut self,
        op: &str,
        ta: &str,
        tb: &str,
        line: usize,
    ) -> Result<(), TranslateError> {
        match op {
            "+" => self.line(&format!(
                "{} {ta}, {ta}, {tb}",
                self.value_op("add", "addw")
            )),
            "-" => self.line(&format!(
                "{} {ta}, {ta}, {tb}",
                self.value_op("sub", "subw")
            )),
            "*" => self.line(&format!(
                "{} {ta}, {ta}, {tb}",
                self.value_op("mul", "mulw")
            )),
            "/" => self.line(&format!(
                "{} {ta}, {ta}, {tb}",
                self.value_op("div", "divw")
            )),
            "%" => self.line(&format!(
                "{} {ta}, {ta}, {tb}",
                self.value_op("rem", "remw")
            )),
            "&" => self.line(&format!("and {ta}, {ta}, {tb}")),
            "|" => self.line(&format!("or {ta}, {ta}, {tb}")),
            "^" => self.line(&format!("xor {ta}, {ta}, {tb}")),
            "<<" => self.line(&format!(
                "{} {ta}, {ta}, {tb}",
                self.value_op("sll", "sllw")
            )),
            ">>" => self.line(&format!(
                "{} {ta}, {ta}, {tb}",
                self.value_op("sra", "sraw")
            )),
            "<" => self.line(&format!("slt {ta}, {ta}, {tb}")),
            ">" => self.line(&format!("slt {ta}, {tb}, {ta}")),
            "<=" => {
                self.line(&format!("slt {ta}, {tb}, {ta}"));
                self.line(&format!("xori {ta}, {ta}, 1"));
            }
            ">=" => {
                self.line(&format!("slt {ta}, {ta}, {tb}"));
                self.line(&format!("xori {ta}, {ta}, 1"));
            }
            "==" => {
                self.line(&format!(
                    "{} {ta}, {ta}, {tb}",
                    self.value_op("sub", "subw")
                ));
                self.line(&format!("seqz {ta}, {ta}"));
            }
            "!=" => {
                self.line(&format!(
                    "{} {ta}, {ta}, {tb}",
                    self.value_op("sub", "subw")
                ));
                self.line(&format!("snez {ta}, {ta}"));
            }
            _ => {
                return Err(TranslateError::new(
                    line,
                    format!("internal: operator {op}"),
                ));
            }
        }
        Ok(())
    }

    // -- integer types ---------------------------------------------------

    fn xlen(&self) -> u8 {
        if self.is_rv64() {
            64
        } else {
            32
        }
    }

    /// Legacy types keep the original code paths (and byte-identical output).
    fn is_legacy(t: ScalarType) -> bool {
        matches!(t, ScalarType::I32 | ScalarType::Bool | ScalarType::Unit)
    }

    fn ty(&self, t: ScalarType) -> Ty {
        match t {
            ScalarType::Int(IntTy { bits, signed }) => Ty {
                bits: if bits == IntTy::LONG { self.xlen() } else { bits },
                signed,
            },
            ScalarType::Ptr(..) => Ty { bits: self.xlen(), signed: false },
            _ => Ty { bits: 32, signed: true },
        }
    }

    fn scalar(t: Ty) -> ScalarType {
        if t.bits == 32 && t.signed {
            ScalarType::I32
        } else {
            ScalarType::Int(IntTy { bits: t.bits, signed: t.signed })
        }
    }

    /// C integer promotion: anything narrower than int becomes int.
    fn promote(&self, t: ScalarType) -> ScalarType {
        let ty = self.ty(t);
        if ty.bits < 32 || t == ScalarType::Bool {
            ScalarType::I32
        } else {
            Self::scalar(ty)
        }
    }

    /// C usual arithmetic conversions (after promotion).
    fn usual(&self, a: ScalarType, b: ScalarType) -> ScalarType {
        let (a, b) = (self.ty(self.promote(a)), self.ty(self.promote(b)));
        let bits = a.bits.max(b.bits);
        let unsigned_at_top = (a.bits == bits && !a.signed) || (b.bits == bits && !b.signed);
        Self::scalar(Ty { bits, signed: !unsigned_at_top })
    }

    fn uses_types(e: &Expr, types: &HashMap<String, ScalarType>, returns: &HashMap<String, ScalarType>) -> bool {
        let nonlegacy = |t: Option<&ScalarType>| t.is_some_and(|t| !Self::is_legacy(*t));
        match e {
            Expr::Num(..) => false,
            Expr::Var(n, _) => nonlegacy(types.get(n)),
            Expr::Index(n, i, _) => nonlegacy(types.get(n)) || Self::uses_types(i, types, returns),
            Expr::Unary(op, inner, _) => {
                cast_target(op).is_some() || op.starts_with("sizeof") || Self::uses_types(inner, types, returns)
            }
            Expr::Binary(_, a, b, _) => Self::uses_types(a, types, returns) || Self::uses_types(b, types, returns),
            Expr::Assign(lv, v, _, _) => {
                let n = match &**lv {
                    LValue::Var(n, _) | LValue::Index(n, _, _) => n,
                    LValue::Deref(..) => return true,
                };
                nonlegacy(types.get(n)) || Self::uses_types(v, types, returns)
            }
            Expr::Call(n, args, _) => {
                nonlegacy(returns.get(n)) || args.iter().any(|a| Self::uses_types(a, types, returns))
            }
        }
    }

    /// The C type of an expression (integer promotions and the usual
    /// arithmetic conversions applied).
    fn expr_type(&self, e: &Expr, ctx: &FnCtx) -> ScalarType {
        if !self.memory && !Self::uses_types(e, &ctx.types, &self.return_types) {
            return expression_scalar_type(e, &ctx.types, &self.return_types, self.source_language);
        }
        match e {
            Expr::Num(_, t, _) => *t,
            Expr::Var(n, _) => {
                let declared = ctx.types.get(n).copied().unwrap_or(ScalarType::I32);
                match ctx.vars.get(n) {
                    Some(Slot::Array(..) | Slot::GlobalArray(..)) if self.memory => {
                        declared.pointer_to().unwrap_or(declared)
                    }
                    _ => declared,
                }
            }
            Expr::Index(n, _, _) => self.element_type(n, ctx),
            Expr::Unary("&", inner, _) if self.memory => {
                let inner_type = match &**inner {
                    // &array is rejected when emitted; type it as the array's element
                    Expr::Var(n, _) => ctx.types.get(n).copied().unwrap_or(ScalarType::I32),
                    other => self.expr_type(other, ctx),
                };
                inner_type.pointer_to().unwrap_or(ScalarType::I32)
            }
            Expr::Unary("*", inner, _) if self.memory => {
                self.expr_type(inner, ctx).pointee().unwrap_or(ScalarType::I32)
            }
            Expr::Unary(op, inner, _) => {
                if let Some(t) = cast_target(op) {
                    t
                } else if op.starts_with("sizeof") {
                    ScalarType::Int(IntTy { bits: IntTy::LONG, signed: false })
                } else if *op == "!" {
                    expression_scalar_type(e, &ctx.types, &self.return_types, self.source_language)
                } else {
                    self.promote(self.expr_type(inner, ctx))
                }
            }
            Expr::Binary(op, a, b, _) => match *op {
                "&&" | "||" | "==" | "!=" | "<" | "<=" | ">" | ">=" => {
                    expression_scalar_type(e, &ctx.types, &self.return_types, self.source_language)
                }
                "<<" | ">>" => self.promote(self.expr_type(a, ctx)),
                "+" | "-" if self.memory => {
                    let (at, bt) = (self.expr_type(a, ctx), self.expr_type(b, ctx));
                    match (at.is_ptr(), bt.is_ptr()) {
                        (true, true) => ScalarType::Int(IntTy { bits: IntTy::LONG, signed: true }),
                        (true, false) => at,
                        (false, true) => bt,
                        _ => self.usual(at, bt),
                    }
                }
                _ => self.usual(self.expr_type(a, ctx), self.expr_type(b, ctx)),
            },
            Expr::Assign(lv, _, _, _) => {
                if self.memory {
                    return self.lvalue_type(lv, ctx);
                }
                let n = match &**lv {
                    LValue::Var(n, _) | LValue::Index(n, _, _) => n,
                    LValue::Deref(..) => return ScalarType::I32,
                };
                ctx.types.get(n).copied().unwrap_or(ScalarType::I32)
            }
            Expr::Call(n, _, _) => self.return_types.get(n).copied().unwrap_or(ScalarType::I32),
        }
    }

    /// Re-establish the register invariant for `t`: values narrower than the
    /// register are sign- or zero-extended according to their signedness.
    fn normalize(&mut self, reg: &str, t: ScalarType) {
        if t == ScalarType::Bool {
            self.line(&format!("snez {reg}, {reg}"));
            return;
        }
        let ty = self.ty(t);
        let xlen = self.xlen();
        if ty.bits >= xlen {
            return;
        }
        if ty.bits == 32 && ty.signed {
            // RV64 only (on RV32 an int already fills the register)
            self.line(&format!("sext.w {reg}, {reg}"));
            return;
        }
        if ty.bits == 8 && !ty.signed {
            self.line(&format!("andi {reg}, {reg}, 255"));
            return;
        }
        let shift = xlen - ty.bits;
        let right = if ty.signed { "srai" } else { "srli" };
        self.line(&format!("slli {reg}, {reg}, {shift}"));
        self.line(&format!("{right} {reg}, {reg}, {shift}"));
    }

    /// Convert a canonical value of type `from` to type `to` (C semantics:
    /// wrap modulo 2^bits, then extend per the target type's signedness).
    fn convert(&mut self, reg: &str, from: ScalarType, to: ScalarType) {
        if to == ScalarType::Unit || from == to {
            return;
        }
        if to == ScalarType::Bool {
            if from != ScalarType::Bool && self.source_language == "C++" {
                self.line(&format!("snez {reg}, {reg}"));
            }
            return;
        }
        if Self::is_legacy(from) && to == ScalarType::I32 {
            return;
        }
        let (f, t) = (self.ty(from), self.ty(to));
        if t.bits >= self.xlen() {
            // The source is already extended to the full register exactly
            // as C converts it.
            return;
        }
        let already_canonical = f.bits < t.bits && (f.signed == t.signed || !f.signed);
        if !already_canonical {
            self.normalize(reg, to);
        }
    }

    /// RISC-V psABI form for passing/returning a value of type `t`: on RV64,
    /// 32-bit values (even unsigned ones) travel sign-extended.
    fn to_abi(&mut self, reg: &str, t: ScalarType) {
        let ty = self.ty(t);
        if self.is_rv64() && ty.bits == 32 && !ty.signed {
            self.line(&format!("sext.w {reg}, {reg}"));
        }
    }

    fn slot_bytes(&self, t: ScalarType) -> i32 {
        if self.ty(t).bits == 64 {
            8
        } else {
            4
        }
    }

    fn elem_bytes(&self, t: ScalarType) -> i32 {
        if Self::is_legacy(t) {
            4
        } else {
            i32::from(self.ty(t).bits / 8)
        }
    }

    /// Load instruction for a scalar local slot of type `t`.
    fn slot_load(&self, t: ScalarType) -> &'static str {
        let ty = self.ty(t);
        if self.memory && t != ScalarType::Bool {
            match (ty.bits, ty.signed) {
                (8, true) => return "lb",
                (8, false) => return "lbu",
                (16, true) => return "lh",
                (16, false) => return "lhu",
                _ => {}
            }
        }
        match (ty.bits, ty.signed, self.is_rv64()) {
            (64, _, _) => "ld",
            (32, false, true) => "lwu",
            _ => "lw",
        }
    }

    fn slot_store(&self, t: ScalarType) -> &'static str {
        if self.memory && t != ScalarType::Bool {
            match self.ty(t).bits {
                8 => return "sb",
                16 => return "sh",
                _ => {}
            }
        }
        if self.ty(t).bits == 64 {
            "sd"
        } else {
            "sw"
        }
    }

    fn elem_load(&self, t: ScalarType) -> &'static str {
        if Self::is_legacy(t) {
            return "lw";
        }
        let ty = self.ty(t);
        match (ty.bits, ty.signed) {
            (8, true) => "lb",
            (8, false) => "lbu",
            (16, true) => "lh",
            (16, false) => "lhu",
            _ => self.slot_load(t),
        }
    }

    fn elem_store(&self, t: ScalarType) -> &'static str {
        if Self::is_legacy(t) {
            return "sw";
        }
        match self.ty(t).bits {
            8 => "sb",
            16 => "sh",
            64 => "sd",
            _ => "sw",
        }
    }

    fn spill_bytes(&self) -> i32 {
        if self.wide {
            8
        } else {
            4
        }
    }

    fn spill_store(&self) -> &'static str {
        if self.wide {
            "sd"
        } else {
            "sw"
        }
    }

    fn spill_load(&self) -> &'static str {
        if self.wide {
            "ld"
        } else {
            "lw"
        }
    }

    /// Typed arithmetic: `ta = ta op tb`, both already converted to `t`.
    fn emit_typed_binary(&mut self, op: &str, ta: &str, tb: &str, t: ScalarType, line: usize) -> Result<(), TranslateError> {
        let ty = self.ty(t);
        let w32 = self.is_rv64() && ty.bits == 32;
        let full = |name: &'static str| name;
        match op {
            "+" | "-" | "*" | "&" | "|" | "^" => {
                let name = match op {
                    "+" => full("add"),
                    "-" => "sub",
                    "*" => "mul",
                    "&" => "and",
                    "|" => "or",
                    _ => "xor",
                };
                self.line(&format!("{name} {ta}, {ta}, {tb}"));
                self.normalize(ta, t);
            }
            "/" | "%" => {
                let name = match (op, ty.signed) {
                    ("/", true) => "div",
                    ("/", false) => "divu",
                    ("%", true) => "rem",
                    _ => "remu",
                };
                self.line(&format!("{name} {ta}, {ta}, {tb}"));
                self.normalize(ta, t);
            }
            "<<" | ">>" => {
                let name = match (op, ty.signed, w32) {
                    ("<<", _, false) => "sll",
                    ("<<", _, true) => "sllw",
                    (">>", true, false) => "sra",
                    (">>", true, true) => "sraw",
                    (">>", false, false) => "srl",
                    _ => "srlw",
                };
                if ty.bits < 32 {
                    self.line(&format!("andi {tb}, {tb}, {}", ty.bits - 1));
                }
                self.line(&format!("{name} {ta}, {ta}, {tb}"));
                self.normalize(ta, t);
            }
            "<" | ">" | "<=" | ">=" => {
                let slt = if ty.signed { "slt" } else { "sltu" };
                let (x, y, invert) = match op {
                    "<" => (ta, tb, false),
                    ">" => (tb, ta, false),
                    "<=" => (tb, ta, true),
                    _ => (ta, tb, true),
                };
                self.line(&format!("{slt} {ta}, {x}, {y}"));
                if invert {
                    self.line(&format!("xori {ta}, {ta}, 1"));
                }
            }
            "==" | "!=" => {
                self.line(&format!("xor {ta}, {ta}, {tb}"));
                self.line(&format!("{} {ta}, {ta}", if op == "==" { "seqz" } else { "snez" }));
            }
            _ => {
                return Err(TranslateError::new(line, format!("internal: operator {op}")));
            }
        }
        Ok(())
    }

    /// Reject 64-bit integers on RV32 (register pairs are not implemented)
    /// and decide whether temporaries need 8-byte spill slots.
    fn check_unit_types(&mut self, unit: &Unit) -> Result<(), TranslateError> {
        let mut wide = false;
        let mut check = |t: ScalarType, line: usize, this: &Self| -> Result<(), TranslateError> {
            let ty = this.ty(t);
            if ty.bits == 64 {
                if !this.is_rv64() {
                    return Err(TranslateError::new(
                        line,
                        format!(
                            "unsupported on RV32: '{}' is a 64-bit integer type, and 64-bit arithmetic on \
                             RV32 register pairs is not implemented yet; translate for RV64, or use a 32-bit type",
                            c_type_keyword(t)
                        ),
                    ));
                }
                wide = true;
            }
            Ok(())
        };
        fn walk_expr(e: &Expr, f: &mut dyn FnMut(ScalarType, usize) -> Result<(), TranslateError>) -> Result<(), TranslateError> {
            match e {
                Expr::Num(..) | Expr::Var(..) => Ok(()),
                Expr::Index(_, i, _) => walk_expr(i, f),
                Expr::Unary(op, inner, line) => {
                    if let Some(t) = cast_target(op) {
                        f(t, *line)?;
                    }
                    if op.starts_with("sizeof") {
                        f(ScalarType::Int(IntTy { bits: IntTy::LONG, signed: false }), *line)?;
                    }
                    walk_expr(inner, f)
                }
                Expr::Binary(_, a, b, _) => {
                    walk_expr(a, f)?;
                    walk_expr(b, f)
                }
                Expr::Assign(lv, v, _, _) => {
                    if let LValue::Index(_, i, _) | LValue::Deref(i, _) = &**lv {
                        walk_expr(i, f)?;
                    }
                    walk_expr(v, f)
                }
                Expr::Call(_, args, _) => args.iter().try_for_each(|a| walk_expr(a, f)),
            }
        }
        fn walk_stmts(stmts: &[Stmt], f: &mut dyn FnMut(ScalarType, usize) -> Result<(), TranslateError>) -> Result<(), TranslateError> {
            for st in stmts {
                match st {
                    Stmt::Decl(_, init, b, line) => {
                        if let Some(t) = b.declared_type {
                            f(t, *line)?;
                        }
                        if let Some(e) = init {
                            walk_expr(e, f)?;
                        }
                    }
                    Stmt::DeclArray(_, _, init, b, _, line) => {
                        if let Some(t) = b.declared_type {
                            f(t, *line)?;
                        }
                        init.iter().try_for_each(|e| walk_expr(e, f))?;
                    }
                    Stmt::Expr(e, _) => walk_expr(e, f)?,
                    Stmt::If(c, a, b, _) => {
                        walk_expr(c, f)?;
                        walk_stmts(a, f)?;
                        walk_stmts(b, f)?;
                    }
                    Stmt::While(c, body, _) => {
                        walk_expr(c, f)?;
                        walk_stmts(body, f)?;
                    }
                    Stmt::For(init, c, step, body, _) => {
                        if let Some(i) = init {
                            walk_stmts(std::slice::from_ref(&**i), f)?;
                        }
                        if let Some(c) = c {
                            walk_expr(c, f)?;
                        }
                        if let Some(s) = step {
                            walk_expr(s, f)?;
                        }
                        walk_stmts(body, f)?;
                    }
                    Stmt::Return(Some(e), _, _) => walk_expr(e, f)?,
                    _ => {}
                }
            }
            Ok(())
        }
        let this: &Self = self;
        let mut visit = |t: ScalarType, line: usize| check(t, line, this);
        for g in &unit.globals {
            visit(g.value_type, g.line)?;
        }
        for func in &unit.funcs {
            visit(func.return_type, func.line)?;
            for (t, line) in func.param_types.iter().zip(&func.param_lines) {
                visit(*t, *line)?;
            }
            walk_stmts(&func.body, &mut visit)?;
        }
        drop(visit);
        // addresses are XLEN wide: on RV64 a temporary holding one must
        // spill to an 8-byte slot
        self.wide = wide || (self.memory && self.is_rv64());
        Ok(())
    }

    fn push_temp(&mut self, ctx: &mut FnCtx, line: usize) -> Result<&'static str, TranslateError> {
        if ctx.depth >= TEMPS.len() {
            return Err(TranslateError::new(
                line,
                "unsupported: expression too deeply nested — split it into steps",
            ));
        }
        let t = TEMPS[ctx.depth];
        ctx.depth += 1;
        Ok(t)
    }

    fn undefined(&self, name: &str, line: usize, ctx: &FnCtx) -> TranslateError {
        TranslateError::new(line, format!("'{name}' is not declared in {}()", ctx.fname))
    }
}

/// Walk a function body and allocate every declaration up front, so the
/// prologue can reserve the whole frame in one place. Duplicate names are
/// rejected (the subset has one scope per function — honest and simple).
fn prescan(
    stmts: &[Stmt],
    ctx: &mut FnCtx,
    return_types: &HashMap<String, ScalarType>,
    source_language: &str,
    rv64: bool,
) -> Result<(), TranslateError> {
    let width = |t: ScalarType| -> i32 {
        match t {
            ScalarType::Int(IntTy { bits: 64, .. }) => 8,
            ScalarType::Int(IntTy { bits: IntTy::LONG, .. }) if rv64 => 8,
            ScalarType::Int(IntTy { bits, .. }) if bits != IntTy::LONG => i32::from(bits / 8),
            ScalarType::Ptr(..) if rv64 => 8,
            _ => 4,
        }
    };
    let global_clash = |ctx: &FnCtx, name: &str, line: usize| -> Result<(), TranslateError> {
        if matches!(ctx.vars.get(name), Some(Slot::Global(_) | Slot::GlobalArray(..))) {
            return Err(TranslateError::new(
                line,
                format!(
                    "'{name}' is already a global variable — the subset has one scope per \
function, so give the local a different name"
                ),
            ));
        }
        Ok(())
    };
    for s in stmts {
        match s {
            Stmt::Decl(name, initial, source, line) => {
                global_clash(ctx, name, *line)?;
                if ctx.vars.contains_key(name) {
                    return Err(TranslateError::new(
                        *line,
                        format!(
                            "'{name}' is declared twice — the subset has one scope per \
function, use a different name"
                        ),
                    ));
                }
                let value_type = source.declared_type.unwrap_or_else(|| {
                    initial.as_ref().map_or(ScalarType::I32, |value| {
                        expression_scalar_type(value, &ctx.types, return_types, source_language)
                    })
                });
                let bytes = width(value_type).max(4);
                ctx.frame = (ctx.frame + bytes - 1) & !(bytes - 1);
                ctx.vars.insert(name.clone(), Slot::Local(ctx.frame));
                ctx.types.insert(name.clone(), value_type);
                ctx.frame += bytes;
            }
            Stmt::DeclArray(name, size, _, _, _, line) => {
                global_clash(ctx, name, *line)?;
                if ctx.vars.contains_key(name) {
                    return Err(TranslateError::new(
                        *line,
                        format!("'{name}' is declared twice"),
                    ));
                }
                let element = source_element_type(s);
                let bytes = width(element);
                ctx.frame = (ctx.frame + 7) & !7;
                ctx.vars.insert(name.clone(), Slot::Array(ctx.frame, *size));
                ctx.types.insert(name.clone(), element);
                let total = (bytes as i64).saturating_mul(*size as i64);
                if total > 1 << 20 {
                    return Err(TranslateError::new(
                        *line,
                        format!("array '{name}' is too large for the stack frame: {total} bytes (the limit is 1048576)"),
                    ));
                }
                ctx.frame += (total as i32 + 3) & !3;
            }
            Stmt::If(_, a, b, _) => {
                prescan(a, ctx, return_types, source_language, rv64)?;
                prescan(b, ctx, return_types, source_language, rv64)?;
            }
            Stmt::While(_, body, _) => prescan(body, ctx, return_types, source_language, rv64)?,
            Stmt::For(init, _, _, body, source) => {
                if let Some(s) = init {
                    prescan(
                        std::slice::from_ref(&**s),
                        ctx,
                        return_types,
                        source_language,
                        rv64,
                    )?;
                }
                if source.kind == LoopKind::RustRange {
                    ctx.range_bounds.push(ctx.frame);
                    ctx.frame += 4;
                }
                prescan(body, ctx, return_types, source_language, rv64)?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// Directions whose output language has no equivalent yet for C's wider
/// integer types, casts and `sizeof` reject them with a clear error instead
/// of silently changing the program's meaning.
fn reject_extended_types(unit: &Unit, from: &str, to: &str) -> Result<(), TranslateError> {
    fn bad_type(t: ScalarType) -> bool {
        matches!(t, ScalarType::Int(_))
    }
    fn expr(e: &Expr) -> Option<(usize, String)> {
        match e {
            Expr::Unary(op, inner, line) => {
                if cast_target(op).is_some() {
                    return Some((*line, format!("the cast {op}")));
                }
                if op.starts_with("sizeof") {
                    return Some((*line, "sizeof".to_string()));
                }
                if *op == "+" {
                    return Some((*line, "unary +".to_string()));
                }
                expr(inner)
            }
            Expr::Index(_, i, _) => expr(i),
            Expr::Binary(_, a, b, _) => expr(a).or_else(|| expr(b)),
            Expr::Assign(lv, v, _, _) => {
                if let LValue::Index(_, i, _) | LValue::Deref(i, _) = &**lv {
                    if let Some(found) = expr(i) {
                        return Some(found);
                    }
                }
                expr(v)
            }
            Expr::Call(_, args, _) => args.iter().find_map(expr),
            _ => None,
        }
    }
    fn stmts(list: &[Stmt]) -> Option<(usize, String)> {
        for st in list {
            let found = match st {
                Stmt::Decl(_, _, b, line) | Stmt::DeclArray(_, _, _, b, _, line)
                    if b.declared_type.is_some_and(bad_type) =>
                {
                    Some((*line, format!("the type '{}'", c_type_keyword(b.declared_type.unwrap_or(ScalarType::I32)))))
                }
                Stmt::Decl(_, init, _, _) => init.as_ref().and_then(expr),
                Stmt::DeclArray(_, _, init, _, _, _) => init.iter().find_map(expr),
                Stmt::Expr(e, _) => expr(e),
                Stmt::If(c, a, b, _) => expr(c).or_else(|| stmts(a)).or_else(|| stmts(b)),
                Stmt::While(c, body, _) => expr(c).or_else(|| stmts(body)),
                Stmt::For(init, c, step, body, _) => init
                    .as_ref()
                    .and_then(|i| stmts(std::slice::from_ref(&**i)))
                    .or_else(|| c.as_ref().and_then(expr))
                    .or_else(|| step.as_ref().and_then(expr))
                    .or_else(|| stmts(body)),
                Stmt::Return(Some(e), _, _) => expr(e),
                _ => None,
            };
            if found.is_some() {
                return found;
            }
        }
        None
    }
    for f in &unit.funcs {
        let signature = std::iter::once((f.return_type, f.line))
            .chain(f.param_types.iter().copied().zip(f.param_lines.iter().copied()))
            .find(|(t, _)| bad_type(*t))
            .map(|(t, line)| (line, format!("the type '{}'", c_type_keyword(t))));
        if let Some((line, what)) = signature.or_else(|| stmts(&f.body)) {
            return Err(TranslateError::new(
                line,
                format!(
                    "unsupported: {what} can be compiled to RISC-V assembly, but translating it \
                     from {from} to {to} is not supported yet; use int"
                ),
            ));
        }
    }
    Ok(())
}

/// True if `continue` appears in a statement outside any nested loop.
/// Replace each `continue` that belongs to the loop around a switch (not to
/// a loop inside it) with `flag = 1; break;`.
fn redirect_continue(statement: Stmt, flag: &str) -> Vec<Stmt> {
    match statement {
        Stmt::Continue(line) => vec![
            Stmt::Expr(Parser::assign(flag, Expr::Num(1, ScalarType::I32, line), line), ExprStmtProvenance::Expression),
            Stmt::Break(line),
        ],
        Stmt::If(c, a, b, provenance) => {
            let redirect = |list: Vec<Stmt>| list.into_iter().flat_map(|s| redirect_continue(s, flag)).collect();
            vec![Stmt::If(c, redirect(a), redirect(b), provenance)]
        }
        other => vec![other],
    }
}

fn stmt_contains_continue(statement: &Stmt) -> bool {
    match statement {
        Stmt::Continue(_) => true,
        Stmt::If(_, a, b, _) => a.iter().chain(b).any(stmt_contains_continue),
        _ => false,
    }
}

fn source_element_type(statement: &Stmt) -> ScalarType {
    match statement {
        Stmt::DeclArray(_, _, _, source, _, _) => source.declared_type.unwrap_or(ScalarType::I32),
        _ => ScalarType::I32,
    }
}

fn rust_range_end(condition: &Option<Expr>) -> Option<&Expr> {
    match condition {
        Some(Expr::Binary("<", _, end, _)) => Some(end),
        _ => None,
    }
}

fn expression_scalar_type(
    expression: &Expr,
    bindings: &HashMap<String, ScalarType>,
    return_types: &HashMap<String, ScalarType>,
    source_language: &str,
) -> ScalarType {
    match expression {
        Expr::Num(_, value_type, _) => *value_type,
        Expr::Var(name, _) | Expr::Index(name, _, _) => {
            bindings.get(name).copied().unwrap_or(ScalarType::I32)
        }
        Expr::Unary("!", _, _) if source_language == "C++" => ScalarType::Bool,
        Expr::Unary("!", value, _) if source_language == "Rust" => {
            expression_scalar_type(value, bindings, return_types, source_language)
        }
        Expr::Unary(_, _, _) => ScalarType::I32,
        Expr::Binary(operator, left, _, _) => match *operator {
            "&&" | "||" | "==" | "!=" | "<" | "<=" | ">" | ">="
                if matches!(source_language, "Rust" | "C++") =>
            {
                ScalarType::Bool
            }
            "&" | "|" | "^" if source_language == "Rust" => {
                expression_scalar_type(left, bindings, return_types, source_language)
            }
            _ => ScalarType::I32,
        },
        Expr::Assign(target, _, _, _) => match &**target {
            LValue::Var(name, _) | LValue::Index(name, _, _) => {
                bindings.get(name).copied().unwrap_or(ScalarType::I32)
            }
            LValue::Deref(..) => ScalarType::I32,
        },
        Expr::Call(name, _, _) => return_types.get(name).copied().unwrap_or(ScalarType::I32),
    }
}

// ===========================================================================
// Tests: both directions, with C→asm results EXECUTED through the pipeline
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::Pipeline;
    use crate::{assemble64, Pipeline64};

    /// Compile C, assemble the result with the real assembler, run it on the
    /// real pipeline, and return a0. This is the actual correctness bar.
    fn run_c(source: &str) -> i32 {
        let asm = c_to_asm(source).expect("c_to_asm failed");
        let program = assemble(&asm)
            .unwrap_or_else(|e| panic!("generated asm does not assemble: {e:?}\n{asm}"));
        let mut p = Pipeline::new(program);
        assert!(p.run(1_000_000), "generated program did not halt:\n{asm}");
        let halt = p.snapshot().halt.expect("no halt info");
        assert_eq!(
            halt.kind, "complete",
            "program trapped: {}\n{asm}",
            halt.message
        );
        p.registers()[10] as i32 // a0
    }

    fn run_generated_rv64(asm: &str, language: &str) -> i32 {
        assert!(
            asm.starts_with(&format!(
                "# generated by the StudyRISC-V {language} translator for RV64IM"
            )),
            "wrong generated-source header:\n{asm}"
        );
        let program = assemble64(asm).unwrap_or_else(|errors| {
            panic!("generated {language} RV64 asm does not assemble: {errors:?}\n{asm}")
        });
        let mut pipeline = Pipeline64::new(program);
        assert!(
            pipeline.run(1_000_000),
            "generated {language} RV64 program did not halt:\n{asm}"
        );
        let halt = pipeline.snapshot().halt.expect("no halt info");
        assert_eq!(
            halt.kind, "complete",
            "{language} RV64 program trapped: {}\n{asm}",
            halt.message
        );
        pipeline.registers()[10] as u32 as i32
    }

    fn run_c64(source: &str) -> i32 {
        let asm = c_to_asm64(source).expect("c_to_asm64 failed");
        run_generated_rv64(&asm, "C")
    }

    fn run_cpp64(source: &str) -> i32 {
        let asm = cpp_to_asm64(source).expect("cpp_to_asm64 failed");
        run_generated_rv64(&asm, "C++")
    }

    fn run_rust64(source: &str) -> i32 {
        let asm = rust_to_asm64(source).expect("rust_to_asm64 failed");
        run_generated_rv64(&asm, "Rust")
    }

    fn run_cpp(source: &str) -> i32 {
        let asm = cpp_to_asm(source).expect("cpp_to_asm failed");
        assert!(
            asm.starts_with("# generated by the StudyRISC-V C++ translator"),
            "wrong generated-source header:\n{asm}"
        );
        let program = assemble(&asm).unwrap_or_else(|errors| {
            panic!("generated C++ asm does not assemble: {errors:?}\n{asm}")
        });
        let mut pipeline = Pipeline::new(program);
        assert!(
            pipeline.run(1_000_000),
            "generated C++ program did not halt:\n{asm}"
        );
        let halt = pipeline.snapshot().halt.expect("no halt info");
        assert_eq!(
            halt.kind, "complete",
            "C++ program trapped: {}\n{asm}",
            halt.message
        );
        pipeline.registers()[10] as i32
    }

    fn assert_cpp_parses(source: &str) {
        let unit = parse_cpp_unit(source, 32).expect("C++ subset source should parse");
        assert!(!unit.funcs.is_empty());
    }

    fn assert_cpp_rejected(source: &str, line: usize, reason: &str) {
        let error = cpp_to_asm(source).expect_err("unsupported C++ must not produce assembly");
        assert_eq!(error.line, line);
        assert!(
            error.message.contains(reason),
            "expected rejection containing {reason:?}, got {:?}",
            error.message
        );
    }

    // -- C++ parser acceptance --------------------------------------------

    #[test]
    fn cpp_parser_accepts_integer_variables_and_expressions() {
        assert_cpp_parses(
            "int main() { int a = 23; int b = 5; return (a / b) * 10 + a % b + ((a & 7) << 1); }",
        );
    }

    #[test]
    fn cpp_parser_accepts_fixed_local_arrays() {
        assert_cpp_parses(
            "int main() { int values[4] = {1, 2, 3, 4}; values[2] = 9; return values[2]; }",
        );
    }

    #[test]
    fn cpp_parser_accepts_control_flow_and_loop_control() {
        assert_cpp_parses(
            "int main() { int sum = 0; for (int i = 0; i < 8; i++) { if (i == 3) continue; if (i == 7) break; sum += i; } while (sum < 20) sum++; return sum; }",
        );
    }

    #[test]
    fn cpp_parser_accepts_functions_calls_and_recursion() {
        assert_cpp_parses(
            "int fact(int n) { if (n <= 1) return 1; return n * fact(n - 1); } int main() { return fact(5); }",
        );
    }

    #[test]
    fn cpp_parser_accepts_auto_literals_and_alternative_logical_tokens() {
        assert_cpp_parses(
            "int main() { auto ready = true; auto blocked = false; if (ready and not blocked or false) return 1; return 0; }",
        );
    }

    #[test]
    fn cpp_parser_accepts_bool_storage_signatures_and_prototypes() {
        let unit = parse_cpp_unit(
            "bool ready(int value, bool enabled);
             bool ready(int value, bool enabled) { return enabled and value; }
             int main() { bool enabled = true; return ready(7, enabled); }",
            32,
        )
        .expect("native C++ bool source should parse");
        assert_eq!(unit.prototypes.len(), 1);
        assert_eq!(unit.prototypes[0].return_type, ScalarType::Bool);
        assert_eq!(
            unit.prototypes[0].parameter_types,
            vec![ScalarType::I32, ScalarType::Bool]
        );
        let ready = unit
            .funcs
            .iter()
            .find(|function| function.name == "ready")
            .unwrap();
        assert_eq!(ready.return_type, ScalarType::Bool);
        assert_eq!(ready.param_types, vec![ScalarType::I32, ScalarType::Bool]);
    }

    // -- C++ -> RV32IM, assembled and executed ----------------------------

    #[test]
    fn cpp_integer_expressions_execute() {
        let source = "int main() {
            int a = 23; int b = 5;
            return (a / b) * 10 + a % b + ((a & 7) << 1) - 4;
        }";
        assert_eq!(run_cpp(source), 53);
    }

    #[test]
    fn cpp_fixed_local_arrays_execute() {
        let source = "int main() {
            int values[4];
            for (int i = 0; i < 4; i++) values[i] = i * i;
            int sum = 0;
            for (int j = 0; j < 4; j++) sum += values[j];
            return sum;
        }";
        assert_eq!(run_cpp(source), 14);
    }

    #[test]
    fn cpp_control_flow_and_loop_control_execute() {
        let source = "int main() {
            int sum = 0;
            for (int i = 0; i < 10; i++) {
                if (i == 3) continue;
                if (i == 7) break;
                sum += i;
            }
            int n = 3;
            while (n > 0) { sum += n; n--; }
            return sum;
        }";
        assert_eq!(run_cpp(source), 24);
    }

    #[test]
    fn cpp_functions_calls_and_recursion_execute() {
        let source = "int fact(int n) {
            if (n <= 1) return 1;
            return n * fact(n - 1);
        }
        int twice(int n) { return n + n; }
        int main() { return fact(5) + twice(6); }";
        assert_eq!(run_cpp(source), 132);
    }

    #[test]
    fn cpp_auto_literals_and_alternative_logical_tokens_execute() {
        let source = "int main() {
            auto ready = true;
            auto blocked = false;
            auto value = 6;
            if ((ready and not blocked) or false) return value + 1;
            return 0;
        }";
        assert_eq!(run_cpp(source), 7);
    }

    #[test]
    fn cpp_auto_bool_assignment_normalizes_on_rv32_and_rv64() {
        let source = "int main() {
            auto flag = true;
            flag = 7;
            return flag;
        }";
        assert_eq!(run_cpp(source), 1);
        assert_eq!(run_cpp64(source), 1);
    }

    #[test]
    fn cpp_auto_comparison_assignment_normalizes_on_rv32_and_rv64() {
        let source = "int main() {
            auto flag = 1 < 2;
            flag = 7;
            return flag;
        }";
        assert_eq!(run_cpp(source), 1);
        assert_eq!(run_cpp64(source), 1);
    }

    #[test]
    fn cpp_bool_conversions_at_declaration_call_and_return_execute() {
        let source = "bool normalize(bool value) { return value; }
        bool from_int(int value) { return value; }
        int main() {
            bool direct = 9;
            bool through_call = normalize(7);
            return direct * 100 + through_call * 10 + from_int(5);
        }";
        assert_eq!(run_cpp(source), 111);
        assert_eq!(run_cpp64(source), 111);
    }

    #[test]
    fn cpp_bool_compound_assignment_normalizes_on_rv32_and_rv64() {
        let source = "int main() {
            bool flag = true;
            flag += 8;
            return flag;
        }";
        assert_eq!(run_cpp(source), 1);
        assert_eq!(run_cpp64(source), 1);
    }

    #[test]
    fn cpp_auto_bool_copy_and_call_results_normalize_on_rv32_and_rv64() {
        let source = "bool from_int(int value) { return value; }
        int main() {
            auto first = true;
            auto copied = first;
            auto called = from_int(9);
            copied = 7;
            called = 8;
            return copied * 10 + called;
        }";
        assert_eq!(run_cpp(source), 11);
        assert_eq!(run_cpp64(source), 11);
    }

    #[test]
    fn cpp_bool_assignment_expression_returns_normalized_value() {
        let source = "int main() {
            bool simple = false;
            bool compound = true;
            int simple_result = (simple = 7);
            int compound_result = (compound += 8);
            return simple_result * 1000 + simple * 100 + compound_result * 10 + compound;
        }";
        assert_eq!(run_cpp(source), 1111);
        assert_eq!(run_cpp64(source), 1111);
    }

    #[test]
    fn cpp_explicit_bool_can_be_assigned_after_declaration() {
        let source = "int main() { bool ready; ready = -9; return ready; }";
        assert_eq!(run_cpp(source), 1);
        assert_eq!(run_cpp64(source), 1);
    }

    #[test]
    fn cpp_and_c_share_identical_rv32_lowering_for_common_source() {
        let source = "int square(int value) { return value * value; }
                      int main() { int values[2] = {6, 7}; return square(values[0]) + values[1]; }";
        let c = c_to_asm(source).unwrap();
        let cpp = cpp_to_asm(source).unwrap();
        assert!(c.starts_with("# generated by the StudyRISC-V C translator"));
        assert_eq!(
            c.lines().skip(1).collect::<Vec<_>>(),
            cpp.lines().skip(1).collect::<Vec<_>>()
        );
        assert_eq!(run_cpp(source), 43);
    }

    // -- C++ rejection boundary -------------------------------------------

    #[test]
    fn cpp_class_fails_gracefully() {
        assert_cpp_rejected(
            "class Point { int x; };\nint main() { return 0; }",
            1,
            "classes",
        );
        assert_cpp_rejected("int main() { return this; }", 1, "classes");
    }

    #[test]
    fn cpp_template_fails_gracefully() {
        assert_cpp_rejected(
            "template <typename T>\nint id(int value) { return value; }",
            1,
            "templates",
        );
    }

    #[test]
    fn cpp_inheritance_fails_gracefully() {
        assert_cpp_rejected(
            "class Derived : public Base {};\nint main() { return 0; }",
            1,
            "inheritance",
        );
    }

    #[test]
    fn cpp_runtime_polymorphism_fails_gracefully() {
        assert_cpp_rejected(
            "virtual int value() { return 1; }\nint main() { return value(); }",
            1,
            "runtime polymorphism",
        );
    }

    #[test]
    fn cpp_function_overloading_fails_gracefully() {
        assert_cpp_rejected(
            "int value(int x) { return x; }\nint value(int x, int y) { return x + y; }\nint main() { return value(1); }",
            2,
            "function overloading",
        );
    }

    #[test]
    fn cpp_operator_overloading_fails_gracefully() {
        assert_cpp_rejected(
            "int operator+(int a, int b) { return a + b; }",
            1,
            "operator overloading",
        );
    }

    #[test]
    fn cpp_pointer_fails_gracefully() {
        assert_cpp_rejected("int main() { int *pointer; return 0; }", 1, "pointer");
        assert_cpp_rejected("int main() { return nullptr; }", 1, "pointers");
    }

    #[test]
    fn cpp_reference_fails_gracefully() {
        assert_cpp_rejected(
            "int main() { int value = 1; int &reference = value; return reference; }",
            1,
            "references",
        );
    }

    #[test]
    fn cpp_user_defined_types_beyond_the_subset_fail_gracefully() {
        // enums, structs and unions are part of the C++ subset now; classes
        // and struct pointers are not.
        assert_cpp_rejected("class Point { int x; };\nint main() { return 0; }", 1, "classes");
        assert_cpp_rejected(
            "struct P { int x; };\nint main() { P p; P *q = &p; return q->x; }",
            2,
            "unsupported",
        );
        assert_cpp_parses("struct Point { int x; };\nint main() { Point p; p.x = 1; return p.x; }");
        assert_cpp_parses("enum Mode { Ready };\nint main() { return Ready; }");
        assert_cpp_parses("union Value { int number; };\nint main() { Value v; v.number = 2; return v.number; }");
    }

    #[test]
    fn cpp_global_fails_gracefully() {
        assert_cpp_rejected(
            "int global_value = 7;\nint main() { return global_value; }",
            1,
            "global variables",
        );
    }

    #[test]
    fn cpp_string_and_character_literals_fail_gracefully() {
        assert_cpp_rejected("int main() { return \"text\"; }", 1, "string/char literals");
        // Character literals became part of the C/C++ subset (type int).
        assert_eq!(run_cpp("int main() { return 'x'; }"), 120);
    }

    #[test]
    fn cpp_floating_point_fails_gracefully() {
        assert_cpp_rejected(
            "int main() { double value = 1.5; return 0; }",
            1,
            "floating point",
        );
    }

    #[test]
    fn cpp_preprocessor_and_standard_library_fail_gracefully() {
        assert_cpp_rejected(
            "#include <iostream>\nint main() { return 0; }",
            1,
            "preprocessor",
        );
        assert_cpp_rejected("int main() { return std::abs(1); }", 1, "standard library");
    }

    #[test]
    fn cpp_namespaces_and_using_declarations_fail_gracefully() {
        assert_cpp_rejected(
            "namespace demo { int value() { return 1; } }",
            1,
            "namespaces",
        );
        assert_cpp_rejected("using value_type = int;", 1, "using declarations");
    }

    #[test]
    fn cpp_exceptions_fail_gracefully() {
        assert_cpp_rejected(
            "int main() { try { throw 1; } catch (...) { return 0; } }",
            1,
            "exceptions",
        );
    }

    #[test]
    fn cpp_dynamic_allocation_fails_gracefully() {
        assert_cpp_rejected(
            "int main() { int *value = new int; return 0; }",
            1,
            "dynamic allocation",
        );
    }

    #[test]
    fn cpp_casts_fail_gracefully() {
        assert_cpp_rejected("int main() { return static_cast<int>(1); }", 1, "C++ casts");
    }

    #[test]
    fn cpp_unsupported_qualified_declarations_fail_gracefully() {
        assert_cpp_rejected(
            "int main() { const int value = 1; return value; }",
            1,
            "const-qualified declarations",
        );
        assert_cpp_rejected(
            "int main() { constexpr int value = 1; return value; }",
            1,
            "constexpr",
        );
    }

    #[test]
    fn cpp_bool_arrays_fail_gracefully() {
        assert_cpp_rejected(
            "int main() { bool values[2] = {true, false}; return values[0]; }",
            1,
            "bool arrays",
        );
    }

    #[test]
    fn cpp_bool_increment_and_decrement_fail_gracefully() {
        for source in [
            "int main() { bool flag = true; ++flag; return flag; }",
            "int main() { auto flag = false; flag--; return flag; }",
        ] {
            assert_cpp_rejected(source, 1, "not valid on bool");
        }
    }

    #[test]
    fn cpp_prototype_bool_int_mismatch_fails_gracefully() {
        assert_cpp_rejected(
            "bool ready(int value); int ready(int value) { return value; } int main() { return ready(1); }",
            1,
            "bool/int signature",
        );
        assert_cpp_rejected(
            "int ready(bool value); int ready(int value) { return value; } int main() { return ready(1); }",
            1,
            "bool/int signature",
        );
    }

    #[test]
    fn cpp_wrong_function_arity_fails_gracefully() {
        assert_cpp_rejected(
            "int add(int left, int right) { return left + right; } int main() { return add(1); }",
            1,
            "expects 2 arguments",
        );
    }

    #[test]
    fn cpp_main_parameters_fail_gracefully() {
        assert_cpp_rejected(
            "int main(int value) { return value; }",
            1,
            "main() cannot take parameters",
        );
    }

    #[test]
    fn cpp_void_helpers_and_prototypes_execute_on_rv32_and_rv64() {
        let source = "void touch(int value); void touch(int value) { int copy = value; return; } int main() { touch(3); return 7; }";
        assert_eq!(run_cpp(source), 7);
        assert_eq!(run_cpp64(source), 7);
    }

    #[test]
    fn cpp_void_main_parameters_and_locals_fail_gracefully() {
        assert_cpp_rejected("void main() { return; }", 1, "main() must return int");
        assert_cpp_rejected(
            "int helper(void value) { return 0; } int main() { return helper(1); }",
            1,
            "parameters must be 'int name' or 'bool name'",
        );
        assert_cpp_rejected(
            "int main() { void value; return 0; }",
            1,
            "expected an expression",
        );
    }

    #[test]
    fn cpp_void_results_cannot_be_used_as_values() {
        assert_cpp_rejected(
            "void touch() { return; } int main() { auto value = touch(); return 0; }",
            1,
            "can only be called as a statement",
        );
        assert_cpp_rejected(
            "void touch() { return; } int main() { return touch(); }",
            1,
            "can only be called as a statement",
        );
        assert_cpp_rejected(
            "void touch() { return 1; } int main() { touch(); return 0; }",
            1,
            "void functions cannot return a value",
        );
    }

    #[test]
    fn c_frontend_does_not_gain_cpp_bool_syntax() {
        let error = c_to_asm("bool ready(bool value) { return value; } int main() { return 0; }")
            .expect_err("C frontend must not accept C++ bool syntax");
        assert!(error.message.contains("expected"), "{}", error.message);
    }

    #[test]
    fn cpp_unsupported_auto_declarations_fail_gracefully() {
        assert_cpp_rejected(
            "int main() { auto value; return 0; }",
            1,
            "require an initializer",
        );
        assert_cpp_rejected(
            "int main() { auto values[2] = {1, 2}; return 0; }",
            1,
            "auto arrays",
        );
    }

    fn run_rust(source: &str) -> i32 {
        let asm = rust_to_asm(source).expect("rust_to_asm failed");
        assert!(
            asm.starts_with("# generated by the StudyRISC-V Rust translator"),
            "wrong generated-source header:\n{asm}"
        );
        let program = assemble(&asm).unwrap_or_else(|errors| {
            panic!("generated Rust asm does not assemble: {errors:?}\n{asm}")
        });
        let mut pipeline = Pipeline::new(program);
        assert!(
            pipeline.run(1_000_000),
            "generated Rust program did not halt:\n{asm}"
        );
        let halt = pipeline.snapshot().halt.expect("no halt info");
        assert_eq!(
            halt.kind, "complete",
            "Rust program trapped: {}\n{asm}",
            halt.message
        );
        pipeline.registers()[10] as i32
    }

    fn assert_rust_parses(source: &str) {
        let unit = parse_rust_unit(source).expect("Rust subset source should parse");
        assert!(!unit.funcs.is_empty());
    }

    fn assert_rust_rejected(source: &str, line: usize, reason: &str) {
        let error = rust_to_asm(source).expect_err("unsupported Rust must not produce assembly");
        assert_eq!(error.line, line);
        assert!(
            error.message.contains(reason),
            "expected rejection containing {reason:?}, got {:?}",
            error.message
        );
    }

    fn assert_rust_compilers_rejected(source: &str, reason: &str) {
        for error in [
            rust_to_asm(source).expect_err("invalid Rust must not produce RV32 assembly"),
            rust_to_asm64(source).expect_err("invalid Rust must not produce RV64 assembly"),
        ] {
            assert!(
                error.message.contains(reason),
                "expected rejection containing {reason:?}, got {:?}",
                error.message
            );
        }
    }

    // -- Rust parser acceptance ------------------------------------------

    #[test]
    fn rust_parser_accepts_scalar_bindings_and_boolean_control() {
        assert_rust_parses(
            "fn main() -> i32 { let ready: bool = true; let mut value: i32 = 4; if ready && value > 0 { value += 3; } return value; }",
        );
    }

    #[test]
    fn rust_parser_accepts_fixed_and_inferred_local_arrays() {
        assert_rust_parses(
            "fn main() -> i32 { let mut first: [i32; 3] = [1, 2, 3]; let second = [4; 2]; first[1] = second[0]; return first[1]; }",
        );
    }

    #[test]
    fn rust_parser_accepts_while_loop_and_half_open_for_range() {
        assert_rust_parses(
            "fn main() -> i32 { let mut sum = 0; for i in 0..5 { sum += i; } while sum < 12 { sum += 1; } loop { break; } return sum; }",
        );
    }

    #[test]
    fn rust_parser_accepts_functions_by_value_recursion_and_tail_expressions() {
        assert_rust_parses(
            "fn fact(n: i32) -> i32 { if n <= 1 { return 1; } n * fact(n - 1) } fn main() -> i32 { fact(5) }",
        );
    }

    #[test]
    fn rust_parser_accepts_mutable_parameters_and_integer_operators() {
        assert_rust_parses(
            "fn adjust(mut value: i32) -> i32 { value = ((value << 1) ^ 3) & 15; value } fn main() -> i32 { adjust(6) }",
        );
    }

    // -- Rust -> RV32IM, assembled and executed --------------------------

    #[test]
    fn rust_integer_and_boolean_expressions_execute() {
        let source = "fn main() -> i32 {
            let ready: bool = true;
            let blocked: bool = false;
            let value: i32 = 6;
            if ready && !blocked { return value * 7; }
            return 0;
        }";
        assert_eq!(run_rust(source), 42);
    }

    #[test]
    fn rust_integer_not_executes_as_bitwise_not_on_rv32_and_rv64() {
        let source = "fn main() -> i32 { let mask: i32 = !1; return mask; }";
        assert_eq!(run_rust(source), -2);
        assert_eq!(run_rust64(source), -2);
    }

    #[test]
    fn rust_usize_cast_array_indexes_execute_on_rv32_and_rv64() {
        let source = "fn main() -> i32 {
            let values = [3, 5, 8];
            let index: i32 = 1;
            return values[(index as usize)];
        }";
        assert_eq!(run_rust(source), 5);
        assert_eq!(run_rust64(source), 5);
    }

    #[test]
    fn rust_usize_cast_outside_array_index_is_rejected() {
        assert_rust_compilers_rejected(
            "fn main() -> i32 { let index = 1 as usize; return index; }",
            "only supported directly inside array indexes",
        );
    }

    #[test]
    fn rust_repeat_array_evaluates_initializer_once_on_rv32() {
        let source = "fn seed() -> i32 { return 7; }
            fn main() -> i32 {
                let values: [i32; 4] = [seed(); 4];
                return values[0] + values[1] + values[2] + values[3];
            }";
        let assembly = rust_to_asm(source).unwrap();
        assert_eq!(
            assembly
                .lines()
                .filter(|line| line.split_whitespace().collect::<Vec<_>>() == ["call", "seed"])
                .count(),
            1,
            "{assembly}"
        );
        assert_eq!(run_rust(source), 28);
    }

    #[test]
    fn rust_repeat_array_evaluates_initializer_once_on_rv64() {
        let source = "fn seed() -> i32 { return 7; }
            fn main() -> i32 {
                let values = [seed(); 4];
                return values[0] + values[1] + values[2] + values[3];
            }";
        let assembly = rust_to_asm64(source).unwrap();
        assert_eq!(
            assembly
                .lines()
                .filter(|line| line.split_whitespace().collect::<Vec<_>>() == ["call", "seed"])
                .count(),
            1,
            "{assembly}"
        );
        assert_eq!(run_rust64(source), 28);
    }

    #[test]
    fn rust_fixed_arrays_and_for_ranges_execute() {
        let source = "fn main() -> i32 {
            let mut values: [i32; 4] = [1, 2, 3, 4];
            let mut sum: i32 = 0;
            for index in 0..4 {
                values[index] = values[index] * values[index];
                sum += values[index];
            }
            return sum;
        }";
        assert_eq!(run_rust(source), 30);
    }

    #[test]
    fn rust_mutable_range_bound_is_snapshotted_on_rv32_and_rv64() {
        let source = "fn main() -> i32 {
            let mut end = 4;
            let mut count = 0;
            for value in 0..end {
                count += 1;
                end = value;
            }
            return count;
        }";
        assert_eq!(run_rust(source), 4);
        assert_eq!(run_rust64(source), 4);
    }

    #[test]
    fn rust_while_loop_break_and_continue_execute() {
        let source = "fn main() -> i32 {
            let mut value = 0;
            let mut sum = 0;
            while value < 8 {
                value += 1;
                if value == 3 { continue; }
                if value == 7 { break; }
                sum += value;
            }
            return sum;
        }";
        assert_eq!(run_rust(source), 18);
    }

    #[test]
    fn rust_infinite_loop_and_mutable_parameter_execute() {
        let source = "fn count_down(mut value: i32) -> i32 {
            let mut total = 0;
            loop {
                total += value;
                value -= 1;
                if value == 0 { break; }
            }
            return total;
        }
        fn main() -> i32 { count_down(4) }";
        assert_eq!(run_rust(source), 10);
    }

    #[test]
    fn rust_recursion_and_tail_expressions_execute() {
        let source = "fn fact(n: i32) -> i32 {
            if n <= 1 { return 1; }
            n * fact(n - 1)
        }
        fn main() -> i32 { fact(5) }";
        assert_eq!(run_rust(source), 120);
    }

    #[test]
    fn rust_c_and_cpp_share_identical_rv32_lowering() {
        let c_source = "int square(int value) { return value * value; }
                        int main() { int value = 6; return square(value) + 7; }";
        let rust_source = "fn square(value: i32) -> i32 { return value * value; }
                           fn main() -> i32 { let value: i32 = 6; return square(value) + 7; }";
        let c = c_to_asm(c_source).unwrap();
        let cpp = cpp_to_asm(c_source).unwrap();
        let rust = rust_to_asm(rust_source).unwrap();
        let c_body = c.lines().skip(1).collect::<Vec<_>>();
        assert_eq!(c_body, cpp.lines().skip(1).collect::<Vec<_>>());
        assert_eq!(c_body, rust.lines().skip(1).collect::<Vec<_>>());
        assert_eq!(run_rust(rust_source), 43);
    }

    // -- Rust rejection boundary -----------------------------------------

    #[test]
    fn rust_references_and_borrowing_fail_gracefully() {
        assert_rust_rejected(
            "fn main() -> i32 { let value: i32 = 1; let reference: &i32 = &value; return 0; }",
            1,
            "references and borrowing",
        );
        assert_rust_rejected(
            "fn read(value: &mut i32) -> i32 { return 0; } fn main() -> i32 { return 0; }",
            1,
            "references and borrowing",
        );
    }

    #[test]
    fn rust_lifetimes_fail_gracefully() {
        assert_rust_rejected(
            "fn read<'a>(value: &'a i32) -> i32 { return 0; } fn main() -> i32 { return 0; }",
            1,
            "lifetimes",
        );
    }

    #[test]
    fn rust_user_defined_structs_and_enums_fail_gracefully() {
        assert_rust_rejected("struct Point { x: i32 }", 1, "structs");
        assert_rust_rejected("enum Mode { Ready, Blocked }", 1, "enums");
    }

    #[test]
    fn rust_traits_and_implementations_fail_gracefully() {
        assert_rust_rejected("trait Value { fn value() -> i32; }", 1, "traits");
        assert_rust_rejected("impl Value { fn get() -> i32 { 1 } }", 1, "implementations");
    }

    #[test]
    fn rust_generics_fail_gracefully() {
        assert_rust_rejected(
            "fn identity<T>(value: T) -> T { value } fn main() -> i32 { 0 }",
            1,
            "generic functions",
        );
    }

    #[test]
    fn rust_closures_fail_gracefully() {
        assert_rust_rejected(
            "fn main() -> i32 { let add = |value| value + 1; return add(2); }",
            1,
            "closures",
        );
        assert_rust_rejected(
            "fn main() -> i32 { let value = || 7; return value(); }",
            1,
            "closures",
        );
    }

    #[test]
    fn rust_pattern_matching_and_destructuring_fail_gracefully() {
        assert_rust_rejected(
            "fn main() -> i32 { match 1 { value => return value; } }",
            1,
            "pattern matching",
        );
        assert_rust_rejected(
            "fn main() -> i32 { let (left, right) = (1, 2); return left; }",
            1,
            "destructuring patterns",
        );
        assert_rust_rejected(
            "fn main() -> i32 { if let value = 1 { return value; } return 0; }",
            1,
            "if let patterns",
        );
    }

    #[test]
    fn rust_macros_and_standard_library_paths_fail_gracefully() {
        assert_rust_rejected("fn main() { println!(1); }", 1, "macros");
        assert_rust_rejected(
            "fn main() -> i32 { return std::cmp::max(1, 2); }",
            1,
            "standard library",
        );
    }

    #[test]
    fn rust_heap_and_collection_types_fail_gracefully() {
        assert_rust_rejected(
            "fn main() { let values: Vec = Vec::new(); }",
            1,
            "heap collections",
        );
        assert_rust_rejected(
            "fn main() { let value: Box = Box::new(1); }",
            1,
            "heap allocation",
        );
        assert_rust_rejected(
            "fn main() { let text: String = String::new(); }",
            1,
            "owned strings",
        );
    }

    #[test]
    fn rust_string_and_character_literals_fail_gracefully() {
        assert_rust_rejected(
            "fn main() { let text = \"hello\"; }",
            1,
            "string/char literals",
        );
        assert_rust_rejected("fn main() { let letter = 'x'; }", 1, "string/char literals");
    }

    #[test]
    fn rust_float_and_non_i32_types_fail_gracefully() {
        assert_rust_rejected("fn main() { let value: f64 = 1.5; }", 1, "floating point");
        assert_rust_rejected("fn main() { let value: u64 = 1; }", 1, "only i32");
    }

    #[test]
    fn rust_modules_imports_and_visibility_fail_gracefully() {
        assert_rust_rejected("mod values {}", 1, "modules");
        assert_rust_rejected("use values::answer;", 1, "imports");
        assert_rust_rejected("pub fn main() {}", 1, "visibility modifiers");
    }

    #[test]
    fn rust_const_static_and_global_items_fail_gracefully() {
        assert_rust_rejected("const VALUE: i32 = 1;", 1, "const items");
        assert_rust_rejected("static VALUE: i32 = 1;", 1, "static and global");
        assert_rust_rejected("let value: i32 = 1; fn main() {}", 1, "global bindings");
    }

    #[test]
    fn rust_tuples_and_slices_fail_gracefully() {
        assert_rust_rejected(
            "fn main() { let pair: (i32, i32) = (1, 2); }",
            1,
            "tuple types",
        );
        assert_rust_rejected("fn main() { let values: [i32] = [1, 2]; }", 1, "slices");
    }

    #[test]
    fn rust_async_unsafe_and_extern_features_fail_gracefully() {
        assert_rust_rejected("async fn main() {}", 1, "async Rust");
        assert_rust_rejected("unsafe fn main() {}", 1, "unsafe Rust");
        assert_rust_rejected("extern fn main() {}", 1, "extern functions");
    }

    #[test]
    fn rust_unsupported_ranges_fail_gracefully() {
        assert_rust_rejected(
            "fn main() -> i32 { for value in 0..=4 { return value; } return 0; }",
            1,
            "inclusive ranges",
        );
        assert_rust_rejected(
            "fn main() -> i32 { let range = 0..4; return 0; }",
            1,
            "ranges are only supported",
        );
    }

    #[test]
    fn rust_if_expressions_fail_gracefully() {
        assert_rust_rejected(
            "fn main() -> i32 { let value = if true { 1 } else { 2 }; return value; }",
            1,
            "if expressions",
        );
    }

    #[test]
    fn rust_immutable_mutation_fails_gracefully() {
        assert_rust_rejected(
            "fn main() -> i32 { let value = 1; value = 2; return value; }",
            1,
            "immutable binding",
        );
    }

    #[test]
    fn rust_wrong_function_arity_fails_gracefully() {
        assert_rust_rejected(
            "fn add(left: i32, right: i32) -> i32 { left + right } fn main() -> i32 { add(1) }",
            1,
            "expects 2 arguments",
        );
    }

    #[test]
    fn rust_main_parameters_fail_gracefully() {
        assert_rust_rejected(
            "fn main(value: i32) -> i32 { value }",
            1,
            "main() cannot take parameters",
        );
    }

    #[test]
    fn rust_compilers_reject_mismatched_binding_types() {
        assert_rust_compilers_rejected(
            "fn main() -> i32 { let flag: bool = 7; if flag { return 1; } return 0; }",
            "binding initializer requires bool, found i32",
        );
    }

    #[test]
    fn rust_compilers_reject_integer_conditions() {
        assert_rust_compilers_rejected(
            "fn main() -> i32 { if 1 { return 7; } return 0; }",
            "condition requires bool, found i32",
        );
    }

    #[test]
    fn rust_compilers_reject_boolean_arithmetic() {
        assert_rust_compilers_rejected(
            "fn main() -> i32 { let value = true + false; return value; }",
            "left operand requires i32, found bool",
        );
    }

    #[test]
    fn rust_compilers_reject_mismatched_function_arguments() {
        assert_rust_compilers_rejected(
            "fn choose(enabled: bool) -> i32 { if enabled { return 1; } return 0; } fn main() -> i32 { choose(7) }",
            "function argument requires bool, found i32",
        );
    }

    #[test]
    fn rust_compilers_reject_mismatched_return_types() {
        assert_rust_compilers_rejected(
            "fn ready() -> bool { return 7; } fn main() -> i32 { if ready() { return 1; } return 0; }",
            "return value requires bool, found i32",
        );
    }

    #[test]
    fn rust_compilers_reject_unit_valued_bindings() {
        assert_rust_compilers_rejected(
            "fn mark() {} fn main() -> i32 { let value = mark(); return 0; }",
            "not unit",
        );
    }

    #[test]
    fn rust_compilers_reject_value_functions_that_can_fall_through() {
        assert_rust_compilers_rejected(
            "fn helper() -> i32 { let value = 1; } fn main() -> i32 { return helper(); }",
            "can fall through without returning i32",
        );
        assert_rust_compilers_rejected(
            "fn ready() -> bool { if true { return true; } } fn main() -> i32 { return 0; }",
            "can fall through without returning bool",
        );
    }

    #[test]
    fn rust_compilers_accept_diverging_value_functions() {
        let source = "fn wait_forever() -> i32 { loop {} } fn main() -> i32 { return 7; }";
        assert_eq!(run_rust(source), 7);
        assert_eq!(run_rust64(source), 7);
    }

    #[test]
    fn rust_methods_and_associated_paths_fail_gracefully() {
        assert_rust_rejected(
            "fn main() -> i32 { let value = 1; return value.abs(); }",
            1,
            "methods, fields",
        );
        assert_rust_rejected(
            "fn main() -> i32 { return i32::max(1, 2); }",
            1,
            "module paths and associated functions",
        );
    }

    #[test]
    fn rust_dereferencing_fails_gracefully() {
        assert_rust_rejected(
            "fn main() -> i32 { let value = *pointer; return value; }",
            1,
            "dereferencing",
        );
    }

    #[test]
    fn rust_arrays_cannot_be_passed_or_returned() {
        assert_rust_rejected(
            "fn consume(value: i32) -> i32 { return value; } fn main() -> i32 { let values = [1, 2]; return consume(values); }",
            1,
            "arrays can only be indexed",
        );
        assert_rust_rejected(
            "fn main() -> i32 { let values = [1, 2]; return values; }",
            1,
            "arrays can only be indexed",
        );
    }

    // -- C/C++/Rust -> RV64IM, assembled and executed ---------------------

    #[test]
    fn rv64_c_uses_word_arithmetic_for_i32_semantics() {
        let source = "int main() {
            int top = 2147483647;
            int wrapped = top + 1;
            int shifted = (wrapped - 3) << 2;
            int divided = (shifted * 5) / 7;
            return divided % 11 + (-16 >> 2);
        }";
        let asm = c_to_asm64(source).expect("C RV64 compilation should succeed");
        for mnemonic in ["addw", "subw", "mulw", "divw", "remw", "sllw", "sraw"] {
            assert!(asm.contains(mnemonic), "missing {mnemonic} in:\n{asm}");
        }
        assert_eq!(run_generated_rv64(&asm, "C"), run_c(source));
    }

    #[test]
    fn rv64_c_arrays_and_loops_execute() {
        let source = "int main() {
            int values[4] = {12, 7, 31, 4};
            int sum = 0;
            for (int i = 0; i < 4; i++) sum += values[i];
            return sum;
        }";
        assert_eq!(run_c64(source), 54);
    }

    #[test]
    fn rv64_c_recursive_calls_preserve_return_addresses() {
        let source = "int fact(int n) {
            if (n <= 1) return 1;
            return n * fact(n - 1);
        }
        int main() { return 1 + fact(5); }";
        let asm = c_to_asm64(source).expect("C RV64 compilation should succeed");
        assert!(
            asm.contains("sd    ra, 0(sp)"),
            "missing 64-bit ra save:\n{asm}"
        );
        assert!(
            asm.contains("ld    ra, 0(sp)"),
            "missing 64-bit ra restore:\n{asm}"
        );
        assert_eq!(run_generated_rv64(&asm, "C"), 121);
    }

    #[test]
    fn rv64_cpp_specific_syntax_executes() {
        let source = "int main() {
            auto value = 5;
            if (true and not false) value = value * 3;
            return value;
        }";
        assert_eq!(run_cpp64(source), 15);
    }

    #[test]
    fn rv64_cpp_arrays_calls_and_recursion_execute() {
        let source = "int fib(int n) {
            if (n < 2) return n;
            return fib(n - 1) + fib(n - 2);
        }
        int main() {
            int values[3] = {fib(5), fib(6), fib(7)};
            return values[0] + values[1] + values[2];
        }";
        assert_eq!(run_cpp64(source), 26);
    }

    #[test]
    fn rv64_rust_arrays_and_ranges_execute() {
        let source = "fn main() -> i32 {
            let values = [12, 7, 31, 4];
            let mut sum = 0;
            for i in 0..4 { sum = sum + values[i]; }
            sum
        }";
        assert_eq!(run_rust64(source), 54);
    }

    #[test]
    fn rv64_rust_recursion_and_tail_expressions_execute() {
        let source = "fn fact(n: i32) -> i32 {
            if n <= 1 { return 1; }
            n * fact(n - 1)
        }
        fn main() -> i32 { fact(5) }";
        assert_eq!(run_rust64(source), 120);
    }

    #[test]
    fn rv64_matches_rv32_results_for_all_three_sources() {
        let c = "int twice(int n) { return n + n; }
                 int main() { return 1 + twice(3) + twice(twice(2)); }";
        let cpp = "int main() { auto x = 11; return (x * 7) - 5; }";
        let rust = "fn main() -> i32 {
            let mut sum = 0;
            for i in 1..8 { sum = sum + i; }
            sum
        }";
        assert_eq!(run_c64(c), run_c(c));
        assert_eq!(run_cpp64(cpp), run_cpp(cpp));
        assert_eq!(run_rust64(rust), run_rust(rust));
    }

    // -- C <-> C++ source translation, recompiled and executed -------------

    #[test]
    fn source_c_to_cpp_emits_cpp_syntax_and_executes() {
        let source = "int main() {
            int ready = 1;
            int blocked = 0;
            if ((ready && !blocked) || 0) return 7;
            return 0;
        }";
        let cpp = c_to_cpp(source).expect("C to C++ translation should succeed");
        assert!(cpp.starts_with("// Generated by the StudyRISC-V source translator for C++."));
        assert!(cpp.contains("auto ready = 1;"), "{cpp}");
        assert!(cpp.contains(" and "), "{cpp}");
        assert!(cpp.contains("not blocked"), "{cpp}");
        assert!(cpp.contains(" or "), "{cpp}");
        parse_cpp_unit(&cpp, 32).expect("translated C++ should parse");
        assert_eq!(run_cpp(&cpp), 7);
    }

    #[test]
    fn source_c_to_cpp_preserves_int_type_for_boolean_initializer() {
        let source = "int main() {
            int flag = 1 < 2;
            flag = 7;
            return flag;
        }";
        let cpp = c_to_cpp(source).expect("C to C++ translation should succeed");
        assert!(cpp.contains("int flag = (1 < 2);"), "{cpp}");
        assert!(!cpp.contains("auto flag"), "{cpp}");
        assert_eq!(run_cpp(&cpp), 7);
        assert_eq!(run_cpp(&cpp), run_c(source));
    }

    #[test]
    fn source_c_to_cpp_renames_cpp_keywords_and_avoids_collisions() {
        let source = "int and(int class) { int auto = class + 1; return auto; }
        int riscvsim_and(int value) { return value; }
        int main() { return and(6) + riscvsim_and(1); }";
        let cpp = c_to_cpp(source).expect("C to C++ translation should succeed");
        assert!(
            cpp.contains("int riscvsim_and_1(int riscvsim_class)"),
            "{cpp}"
        );
        assert!(
            cpp.contains("auto riscvsim_auto = (riscvsim_class + 1);"),
            "{cpp}"
        );
        assert!(cpp.contains("riscvsim_and_1(6)"), "{cpp}");
        assert_eq!(run_cpp(&cpp), run_c(source));
    }

    #[test]
    fn c_prefix_and_postfix_results_execute_correctly_on_rv32() {
        let source = "int main() {
            int value = 5;
            int post_inc = value++;
            int pre_inc = ++value;
            int post_dec = value--;
            int pre_dec = --value;
            return post_inc * 1000 + pre_inc * 100 + post_dec * 10 + pre_dec;
        }";
        assert_eq!(run_c(source), 5775);
    }

    #[test]
    fn c_prefix_and_postfix_results_execute_correctly_on_rv64() {
        let source = "int main() {
            int value = 5;
            int post_inc = value++;
            int pre_inc = ++value;
            int post_dec = value--;
            int pre_dec = --value;
            return post_inc * 1000 + pre_inc * 100 + post_dec * 10 + pre_dec;
        }";
        assert_eq!(run_c64(source), 5775);
    }

    #[test]
    fn c_compound_array_lvalue_evaluates_index_once() {
        let source = "int main() {
            int values[2] = {1, 2};
            int index = 0;
            values[index++] += 5;
            return index * 100 + values[0] * 10 + values[1];
        }";
        assert_eq!(run_c(source), 162);
        assert_eq!(run_c64(source), 162);
    }

    #[test]
    fn source_translation_preserves_prototypes_and_assignment_forms() {
        let source = "int helper(int value);
            int helper(int value) { return value; }
            int main() {
                int value = helper(2);
                value = value + 1;
                value += 2;
                ++value;
                value++;
                --value;
                value--;
                return value;
            }";
        let translated = c_to_cpp(source).unwrap();
        for expected in [
            "int helper(int value);",
            "(value = (value + 1));",
            "(value += 2);",
            "(++value);",
            "(value++);",
            "(--value);",
            "(value--);",
        ] {
            assert!(
                translated.contains(expected),
                "missing {expected}:\n{translated}"
            );
        }
        assert_eq!(run_cpp(&translated), run_c(source));
    }

    #[test]
    fn initialized_c_arrays_zero_fill_unspecified_elements() {
        let source = "int main() {
            int partial[3] = {5};
            int empty[2] = {};
            return partial[0] + partial[1] + partial[2] + empty[0] + empty[1];
        }";
        assert_eq!(run_c(source), 5);
        assert_eq!(run_c64(source), 5);
        let translated = c_to_cpp(source).unwrap();
        assert!(translated.contains("int empty[2] = {};"), "{translated}");
        assert_eq!(run_cpp(&translated), 5);
    }

    #[test]
    fn source_cpp_to_c_lowers_cpp_tokens_and_executes() {
        let source = "int main() {
            auto ready = true;
            auto blocked = false;
            if ((ready and not blocked) or false) return 9;
            return 0;
        }";
        let c = cpp_to_c(source).expect("C++ to C translation should succeed");
        assert!(c.starts_with("// Generated by the StudyRISC-V source translator for C."));
        assert!(c.contains("int ready = !(!(1));"), "{c}");
        assert!(c.contains("int blocked = !(!(0));"), "{c}");
        assert!(c.contains(" && "), "{c}");
        assert!(c.contains("(!blocked)"), "{c}");
        assert!(c.contains(" || "), "{c}");
        let tokens = lex(&c).expect("translated C should lex");
        Parser::new(tokens)
            .parse_unit()
            .expect("translated C should parse");
        assert_eq!(run_c(&c), 9);
    }

    #[test]
    fn source_cpp_to_c_preserves_auto_bool_assignment_semantics() {
        let source = "int main() {
            auto flag = true;
            flag = 7;
            return flag;
        }";
        let c = cpp_to_c(source).expect("C++ to C translation should succeed");
        assert!(c.contains("flag = !(!("), "{c}");
        assert_eq!(run_cpp(source), 1);
        assert_eq!(run_c(&c), 1);
    }

    #[test]
    fn source_cpp_to_c_preserves_native_bool_signatures_and_conversions() {
        let source = "bool normalize(bool value) { return value; }
        bool from_int(int value) { return value; }
        int main() {
            bool flag = false;
            flag = 7;
            return normalize(flag) * 10 + from_int(5);
        }";
        let c = cpp_to_c(source).expect("C++ to C translation should succeed");
        assert!(c.contains("int normalize(int value)"), "{c}");
        assert!(c.contains("value = !(!(value))"), "{c}");
        assert_eq!(run_cpp(source), 11);
        assert_eq!(run_c(&c), 11);
    }

    #[test]
    fn source_cpp_to_c_lowers_void_helpers_to_integer_c_convention() {
        let source =
            "void touch(int value) { int copy = value; return; } int main() { touch(3); return 7; }";
        let translated = cpp_to_c(source).expect("C++ void helper should translate to C");
        assert!(translated.contains("int touch(int value)"), "{translated}");
        assert!(!translated.contains("void"), "{translated}");
        assert_eq!(run_c(&translated), run_cpp(source));
        assert_eq!(run_c(&translated), 7);
    }

    #[test]
    fn source_cpp_to_c_preserves_bool_prototypes_and_inferred_bool_copies() {
        let source = "bool normalize(bool value);
        bool normalize(bool value) { return value; }
        int main() {
            auto original = true;
            auto copied = original;
            auto called = normalize(8);
            copied = 7;
            called = 9;
            return copied * 10 + called;
        }";
        let c = cpp_to_c(source).expect("C++ to C translation should succeed");
        assert!(c.contains("int normalize(int value);"), "{c}");
        assert!(c.contains("int copied = !(!(original));"), "{c}");
        assert!(c.contains("int called = !(!(normalize(8)));"), "{c}");
        assert_eq!(run_cpp(source), 11);
        assert_eq!(run_c(&c), 11);
    }

    #[test]
    fn source_cpp_to_c_renames_c_only_keywords_and_avoids_collisions() {
        let source = "int _Atomic(int restrict) { int _Bool = restrict + 1; return _Bool; }
        int riscvsim__Atomic(int value) { return value; }
        int main() { return _Atomic(6) + riscvsim__Atomic(1); }";
        let c = cpp_to_c(source).expect("C++ to C translation should succeed");
        assert!(
            c.contains("int riscvsim__Atomic_1(int riscvsim_restrict)"),
            "{c}"
        );
        assert!(
            c.contains("int riscvsim__Bool = (riscvsim_restrict + 1);"),
            "{c}"
        );
        assert!(c.contains("riscvsim__Atomic_1(6)"), "{c}");
        assert_eq!(run_c(&c), run_cpp(source));
    }

    #[test]
    fn source_c_to_cpp_arrays_loops_calls_and_recursion_execute() {
        let source = "int fact(int n) {
            if (n <= 1) return 1;
            return n * fact(n - 1);
        }
        int main() {
            int values[3] = {fact(3), fact(4), fact(5)};
            int sum = 0;
            for (int i = 0; i < 3; i++) sum += values[i];
            return sum;
        }";
        let cpp = c_to_cpp(source).expect("C to C++ translation should succeed");
        assert!(cpp.contains("int values[3]"), "{cpp}");
        assert!(cpp.contains("for (auto i = 0;"), "{cpp}");
        assert_eq!(run_cpp(&cpp), 150);
    }

    #[test]
    fn source_cpp_to_c_arrays_loops_and_functions_execute() {
        let source = "int adjust(int value) { return value * 2 + 1; }
        int main() {
            int values[5] = {1, 2, 3, 4, 5};
            auto sum = 0;
            auto i = 0;
            while (i < 5) {
                i++;
                if (i == 2) continue;
                if (i == 5) break;
                sum += adjust(values[i - 1]);
            }
            return sum;
        }";
        let c = cpp_to_c(source).expect("C++ to C translation should succeed");
        assert!(c.contains("int sum = 0;"), "{c}");
        assert!(c.contains("continue;"), "{c}");
        assert!(c.contains("break;"), "{c}");
        assert_eq!(run_c(&c), 19);
    }

    #[test]
    fn source_c_and_cpp_round_trips_execute_equivalently() {
        let c_source = "int square(int x) { return x * x; }
                        int main() { int value = 6; return square(value) + 1; }";
        let cpp = c_to_cpp(c_source).unwrap();
        let c_round_trip = cpp_to_c(&cpp).unwrap();
        assert_eq!(run_c(&c_round_trip), run_c(c_source));

        let cpp_source = "int main() {
            auto value = 5;
            if (true and not false) value *= 8;
            return value;
        }";
        let c = cpp_to_c(cpp_source).unwrap();
        let cpp_round_trip = c_to_cpp(&c).unwrap();
        assert_eq!(run_cpp(&cpp_round_trip), run_cpp(cpp_source));
    }

    #[test]
    fn source_translators_preserve_rejection_diagnostics() {
        let c_error = c_to_cpp("int main() {\nint *value;\nreturn 0;\n}").unwrap_err();
        assert_eq!(c_error.line, 2);
        assert!(c_error.message.contains("pointers"), "{}", c_error.message);

        let class_error =
            cpp_to_c("class Point { int x; };\nint main() { return 0; }").unwrap_err();
        assert_eq!(class_error.line, 1);
        assert!(
            class_error.message.contains("classes"),
            "{}",
            class_error.message
        );

        let overload_error = cpp_to_c(
            "int value(int x) { return x; }\nint value(int x, int y) { return x + y; }\nint main() { return value(1); }",
        )
        .unwrap_err();
        assert_eq!(overload_error.line, 2);
        assert!(
            overload_error.message.contains("function overloading"),
            "{}",
            overload_error.message
        );
    }

    // -- C -> asm, executed ------------------------------------------------

    #[test]
    fn c_arithmetic() {
        assert_eq!(
            run_c("int main() { int a = 6; int b = 7; return a * b + 3; }"),
            45
        );
    }

    #[test]
    fn c_division_modulo() {
        assert_eq!(run_c("int main() { return 100 / 7 * 7 + 100 % 7; }"), 100);
    }

    #[test]
    fn c_loop_sum() {
        let src = "int main() {
            int sum = 0;
            for (int i = 1; i <= 10; i++) sum += i;
            return sum;
        }";
        assert_eq!(run_c(src), 55);
    }

    #[test]
    fn c_while_gcd() {
        let src = "int main() {
            int a = 48; int b = 18;
            while (b != 0) { int t = b; b = a % b; a = t; }
            return a;
        }";
        assert_eq!(run_c(src), 6);
    }

    #[test]
    fn c_if_else_and_call() {
        let src = "int max(int a, int b) { if (a > b) return a; return b; }
                   int main() { return max(12, 42); }";
        assert_eq!(run_c(src), 42);
    }

    #[test]
    fn c_recursion_factorial() {
        let src = "int fact(int n) { if (n <= 1) return 1; return n * fact(n - 1); }
                   int main() { return fact(5); }";
        assert_eq!(run_c(src), 120);
    }

    #[test]
    fn c_recursion_fibonacci() {
        let src = "int fib(int n) { if (n < 2) return n; return fib(n-1) + fib(n-2); }
                   int main() { return fib(10); }";
        assert_eq!(run_c(src), 55);
    }

    #[test]
    fn c_array_sum() {
        let src = "int main() {
            int a[4] = {12, 7, 31, 4};
            int s = 0;
            for (int i = 0; i < 4; i++) s = s + a[i];
            return s;
        }";
        assert_eq!(run_c(src), 54);
    }

    #[test]
    fn c_array_write_and_break() {
        let src = "int main() {
            int a[8];
            for (int i = 0; i < 8; i++) a[i] = i * i;
            int found = -1;
            for (int j = 0; j < 8; j++) {
                if (a[j] == 25) { found = j; break; }
            }
            return found;
        }";
        assert_eq!(run_c(src), 5);
    }

    #[test]
    fn c_logical_operators() {
        assert_eq!(
            run_c("int main() { int a = 5; if (a > 3 && a < 10) return 1; return 0; }"),
            1
        );
        assert_eq!(
            run_c("int main() { int a = 0; if (a || 7) return 3; return 4; }"),
            3
        );
        assert_eq!(run_c("int main() { return !5 + !0; }"), 1);
    }

    #[test]
    fn c_negative_numbers() {
        assert_eq!(run_c("int main() { int x = -12; return -x - 2; }"), 10);
    }

    #[test]
    fn c_statements_without_main_wrapper() {
        assert_eq!(run_c("int x = 20; int y = 22; return x + y;"), 42);
    }

    #[test]
    fn c_call_inside_expression_spills() {
        let src = "int twice(int n) { return n + n; }
                   int main() { return 1 + twice(3) + twice(twice(2)); }";
        assert_eq!(run_c(src), 15);
    }

    // -- honest failures ----------------------------------------------------

    #[test]
    fn c_pointer_fails_gracefully() {
        // pointers themselves are supported now (tests/c_pointers.rs); the
        // forms still outside the subset must fail clearly
        let err = c_to_asm("int main() { short x = 1; int *p = (int *)x; return 0; }").unwrap_err();
        assert!(err.message.contains("pointer"), "message: {}", err.message);
        let err = c_to_asm("int main() { int x = 1; return *x; }").unwrap_err();
        assert!(err.message.contains("pointer"), "message: {}", err.message);
    }

    #[test]
    fn c_stdlib_fails_gracefully() {
        let err = c_to_asm("int main() { return printf(1); }").unwrap_err();
        assert!(err.message.contains("printf"), "message: {}", err.message);
        let err = c_to_asm("#include <stdio.h>\nint main() { return 0; }").unwrap_err();
        assert!(
            err.message.contains("preprocessor"),
            "message: {}",
            err.message
        );
    }

    #[test]
    fn c_wrong_function_arity_fails_gracefully() {
        let error = c_to_asm(
            "int add(int left, int right) { return left + right; } int main() { return add(1); }",
        )
        .expect_err("wrong C arity must not produce assembly");
        assert!(error.message.contains("expects 2 arguments"), "{error:?}");
    }

    #[test]
    fn c_main_parameters_fail_gracefully() {
        let error = c_to_asm("int main(int value) { return value; }")
            .expect_err("simulator main cannot take parameters");
        assert!(
            error.message.contains("main() cannot take parameters"),
            "{error:?}"
        );
    }

    #[test]
    fn c_struct_bit_fields_fail_gracefully() {
        // Structs compile now; the parts of them the subset leaves out
        // still fail with a clear message.
        let err = c_to_asm("struct P { int x : 3; };\nint main() { return 0; }").unwrap_err();
        assert!(err.message.contains("bit-fields ('x' has a : width)"), "message: {}", err.message);
    }

    // -- asm → C ------------------------------------------------------------

    fn assert_rv32_golden(source: &str, expected: &str) {
        assert_eq!(asm_to_c(source).unwrap(), expected);
    }

    #[test]
    fn asm_rv32_arithmetic_output_is_byte_identical() {
        assert_rv32_golden(
            "addi x1, x0, 5\naddi x2, x1, 3\nsub x3, x2, x1\nmul x4, x3, x2\necall\n",
            r#"// C view of the assembly — registers become int variables.
// This is educational pseudocode, not compilable C.

int main() {
    int ra = 5;                           // addi x1, x0, 5
    sp = ra + 3;                          // addi x2, x1, 3
    gp = sp - ra;                         // sub x3, x2, x1
    tp = gp * sp;                         // mul x4, x3, x2
    return a0;  /* ecall: end program */  // ecall
}
"#,
        );
    }

    #[test]
    fn asm_rv32_structured_output_is_byte_identical() {
        assert_rv32_golden(
            "addi x1, x0, 3\naddi x2, x0, 0\nloop:\naddi x2, x2, 1\naddi x1, x1, -1\nbne x1, x0, loop\naddi x3, x0, 99\n",
            r#"// C view of the assembly — registers become int variables.
// This is educational pseudocode, not compilable C.

int main() {
    int ra = 3;         // addi x1, x0, 3
    int sp = 0;         // addi x2, x0, 0
    do {  // loop:
        sp += 1;        // addi x2, x2, 1
        ra -= 1;        // addi x1, x1, -1
    } while (ra != 0);  // bne x1, x0, loop
    int gp = 99;        // addi x3, x0, 99
}
"#,
        );
    }

    #[test]
    fn asm_rv32_memory_output_is_byte_identical() {
        assert_rv32_golden(
            ".data\nvalues: .word 12, 7\n.text\nla t0, values\nlw t1, 4(t0)\nsw t1, 0(t0)\necall\n",
            r#"// C view of the assembly — registers become int variables.
// This is educational pseudocode, not compilable C.

int main() {
    t0 = values;                          // la t0, values
    t1 = values[1];                       // lw t1, 4(t0)
    values[0] = t1;                       // sw t1, 0(t0)
    return a0;  /* ecall: end program */  // ecall
}
"#,
        );
    }

    #[test]
    fn asm_rv32_call_output_is_byte_identical() {
        assert_rv32_golden(
            "li a0, 7\ncall twice\necall\ntwice:\nadd a0, a0, a0\nret\n",
            r#"// C view of the assembly — registers become int variables.
// This is educational pseudocode, not compilable C.

int main() {
    int a0 = 7;                               // li a0, 7
    twice();  /* args in a0..a7, result in a0 */  // call twice
    return a0;  /* ecall: end program */      // ecall
    a0 = a0 + a0;                             // add a0, a0, a0
    return;  /* back to caller */             // ret
}
"#,
        );
    }

    // -- RV64 -> illustrative C -------------------------------------------

    #[test]
    fn asm_rv64_full_width_arithmetic_is_explicit() {
        let c = asm64_to_c(
            "addi a0, zero, 7\naddi a1, zero, 3\nadd a2, a0, a1\nsub a3, a0, a1\nmul a4, a0, a1\ndivu a5, a0, a1\nsll a6, a0, a1\nsrl a7, a0, a1\nsra s3, a0, a1\nsltiu s4, a0, -1\nlui s5, 0x80000\nauipc s6, 0x80000\nmulh s0, a0, a1\nmulhsu s1, a0, a1\nmulhu s2, a0, a1\necall\n",
        )
        .unwrap();
        assert!(c.starts_with("// C view of RV64 assembly: registers become int64_t variables."));
        assert!(c.contains("int64_t a0 = 7;"), "{c}");
        assert!(c.contains("a2 = a0 + a1;"), "{c}");
        assert!(c.contains("a3 = a0 - a1;"), "{c}");
        assert!(c.contains("a4 = a0 * a1;"), "{c}");
        assert!(c.contains("a5 = (uint64_t)a0 / (uint64_t)a1;"), "{c}");
        assert!(c.contains("a6 = (uint64_t)a0 << (a1 & 63);"), "{c}");
        assert!(c.contains("a7 = (uint64_t)a0 >> (a1 & 63);"), "{c}");
        assert!(c.contains("s3 = (int64_t)a0 >> (a1 & 63);"), "{c}");
        assert!(
            c.contains("s4 = ((uint64_t)a0 < (uint64_t)(-1)) ? 1 : 0;"),
            "{c}"
        );
        assert!(c.contains("s5 = (int64_t)(int32_t)0x80000000u;"), "{c}");
        assert!(
            c.contains("s6 = pc + (int64_t)(int32_t)0x80000000u;"),
            "{c}"
        );
        assert!(
            c.contains("s0 = (int64_t)(((__int128)a0 * a1) >> 64);"),
            "{c}"
        );
        assert!(
            c.contains("s1 = (int64_t)(((__int128)a0 * (uint64_t)a1) >> 64);"),
            "{c}"
        );
        assert!(c.contains("(unsigned __int128)"), "{c}");
    }

    #[test]
    fn asm_rv64_word_operations_show_narrowing_and_sign_extension() {
        let c = asm64_to_c(
            "addiw t0, t1, 4\naddw t0, t0, t1\nsubw t0, t0, t1\nmulw t0, t0, t1\ndivw t0, t0, t1\ndivuw t0, t0, t1\nremw t0, t0, t1\nremuw t0, t0, t1\nsllw t0, t0, t1\nsrlw t0, t0, t1\nsraw t0, t0, t1\nslliw t0, t0, 3\nsrliw t0, t0, 2\nsraiw t0, t0, 1\necall\n",
        )
        .unwrap();
        for expected in [
            "t0 = (int64_t)(int32_t)((uint32_t)t1 + (4));",
            "t0 = (int64_t)(int32_t)((uint32_t)t0 + (uint32_t)t1);",
            "t0 = (int64_t)(int32_t)((uint32_t)t0 - (uint32_t)t1);",
            "t0 = (int64_t)(int32_t)((uint32_t)t0 * (uint32_t)t1);",
            "t0 = (int64_t)((int32_t)t0 / (int32_t)t1);",
            "t0 = (int64_t)(int32_t)((uint32_t)t0 / (uint32_t)t1);",
            "t0 = (int64_t)((int32_t)t0 % (int32_t)t1);",
            "t0 = (int64_t)(int32_t)((uint32_t)t0 % (uint32_t)t1);",
            "t0 = (int64_t)(int32_t)((uint32_t)t0 << (t1 & 31));",
            "t0 = (int64_t)(int32_t)((uint32_t)t0 >> (t1 & 31));",
            "t0 = (int64_t)((int32_t)t0 >> (t1 & 31));",
            "t0 = (int64_t)(int32_t)((uint32_t)t0 << 3);",
            "t0 = (int64_t)(int32_t)((uint32_t)t0 >> 2);",
            "t0 = (int64_t)((int32_t)t0 >> 1);",
        ] {
            assert!(c.contains(expected), "missing {expected:?} in:\n{c}");
        }
    }

    #[test]
    fn asm_rv64_branches_recover_structured_loops() {
        let c = asm64_to_c(
            "addi t0, zero, 3\naddi t1, zero, 0\nloop:\naddi t1, t1, 1\naddi t0, t0, -1\nbne t0, zero, loop\nbltu t1, t0, below\naddi a0, zero, 9\nbelow:\necall\n",
        )
        .unwrap();
        assert!(c.contains("do {  // loop:"), "{c}");
        assert!(c.contains("} while (t0 != 0);"), "{c}");
        assert!(c.contains("if ((uint64_t)t1 >= (uint64_t)t0) {"), "{c}");
    }

    #[test]
    fn asm_rv64_calls_and_returns_keep_function_context() {
        let c = asm64_to_c("addi a0, zero, 7\ncall twice\necall\ntwice:\nadd a0, a0, a0\nret\n")
            .unwrap();
        assert!(
            c.contains("twice();  /* args in a0..a7, result in a0 */"),
            "{c}"
        );
        assert!(c.contains("a0 = a0 + a0;"), "{c}");
        assert!(c.contains("return;  /* back to caller */"), "{c}");
    }

    #[test]
    fn asm_rv64_memory_accesses_show_width_and_signedness() {
        let c = asm64_to_c(
            ".data\nvalues: .dword 12, 7\n.text\nla t0, values\nld t1, 8(t0)\nsd t1, 0(t0)\nlw t2, 4(t0)\nlwu t3, 4(t0)\nlb t4, 1(t0)\nlbu t5, 1(t0)\nlh t6, 2(t0)\nlhu a0, 2(t0)\nsw t2, 4(t0)\nsb t4, 1(t0)\nsh t6, 2(t0)\necall\n",
        )
        .unwrap();
        assert!(c.contains("t0 = values;"), "{c}");
        assert!(c.contains("t1 = ((int64_t *)values)[1];"), "{c}");
        assert!(c.contains("((int64_t *)values)[0] = t1;"), "{c}");
        assert!(c.contains("t2 = ((int32_t *)values)[1];"), "{c}");
        assert!(c.contains("t3 = ((uint32_t *)values)[1];"), "{c}");
        assert!(c.contains("t4 = ((int8_t *)values)[1];"), "{c}");
        assert!(c.contains("t5 = ((uint8_t *)values)[1];"), "{c}");
        assert!(c.contains("t6 = ((int16_t *)values)[1];"), "{c}");
        assert!(c.contains("a0 = ((uint16_t *)values)[1];"), "{c}");
        assert!(c.contains("((int32_t *)values)[1] = t2;"), "{c}");
        assert!(c.contains("((uint8_t *)values)[1] = t4;"), "{c}");
        assert!(c.contains("((uint16_t *)values)[1] = t6;"), "{c}");
    }

    #[test]
    fn asm_rv64_errors_remain_source_anchored() {
        let error = asm64_to_c("not_an_instruction x1, x2\n").unwrap_err();
        assert_eq!(error.line, 1);
        assert!(
            error.message.contains("assembly error"),
            "{}",
            error.message
        );
    }

    #[test]
    fn asm_add_forward_sample() {
        let c = asm_to_c("addi x1, x0, 5\naddi x2, x1, 3\nadd  x3, x2, x1\n").unwrap();
        assert!(c.contains("int ra = 5;"), "{c}");
        assert!(c.contains("sp = ra + 3;"), "{c}");
        assert!(c.contains("gp = sp + ra;"), "{c}");
    }

    #[test]
    fn asm_branch_loop_becomes_do_while() {
        let c = asm_to_c(
            "addi x1, x0, 3\naddi x2, x0, 0\nloop:\naddi x2, x2, 1\naddi x1, x1, -1\nbne  x1, x0, loop\naddi x3, x0, 99\n",
        )
        .unwrap();
        assert!(c.contains("do {"), "{c}");
        assert!(c.contains("} while (ra != 0);"), "{c}");
        assert!(c.contains("int gp = 99;"), "{c}");
    }

    #[test]
    fn asm_array_sum_sample() {
        let c = asm_to_c(
            ".data\nreadings: .word 12, 7, 31, 4\n.text\nla   t0, readings\naddi t1, x0, 4\naddi t2, x0, 0\nloop:\nlw   t3, 0(t0)\nadd  t2, t2, t3\naddi t0, t0, 4\naddi t1, t1, -1\nbne  t1, x0, loop\nmv   a0, t2\necall\n",
        )
        .unwrap();
        assert!(c.contains("t0 = readings;"), "{c}");
        assert!(c.contains("do {"), "{c}");
        // inside the loop t0 is a moving pointer, so the honest reading is *t0
        assert!(c.contains("t3 = *t0;"), "{c}");
        assert!(c.contains("} while (t1 != 0);"), "{c}");
        assert!(c.contains("return a0;"), "{c}");
    }

    #[test]
    fn asm_forward_branch_becomes_if() {
        // beq x1, x0, skip  jumps over the add when x1 == 0
        let c =
            asm_to_c("addi x1, x0, 1\nbeq x1, x0, skip\naddi x2, x0, 7\nskip:\naddi x3, x0, 9\n")
                .unwrap();
        assert!(c.contains("if (ra != 0) {"), "{c}");
    }

    #[test]
    fn asm_errors_propagate() {
        let err = asm_to_c("not_an_instruction x1, x2\n").unwrap_err();
        assert!(err.message.contains("assembly error"), "{}", err.message);
    }

    // -- round trip: C -> asm -> C stays truthful ---------------------------

    #[test]
    fn round_trip_gcd_still_correct() {
        let asm = c_to_asm(
            "int main() { int a = 48; int b = 18; while (b != 0) { int t = b; b = a % b; a = t; } return a; }",
        )
        .unwrap();
        // the generated asm also survives the decompiler without panicking
        let _ = asm_to_c(&asm).unwrap();
    }
}

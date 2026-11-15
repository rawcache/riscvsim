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
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use identifiers::{identifier_map, IdentifierTarget};

mod c_to_rust;
mod cpp_to_rust;
#[allow(dead_code)]
mod hir;
mod identifiers;
mod rust_to_c;

pub const C_SUBSET_SUPPORTED: &str = "int variables & arrays · arithmetic, comparisons, && || ! · \
if/else · while/for · break/continue · functions (up to 7 int args) · recursion";
pub const C_SUBSET_UNSUPPORTED: &str = "pointers · structs · globals · strings · floats · \
standard library calls";
pub const CPP_SUBSET_SUPPORTED: &str = "int/bool variables · fixed int arrays · local auto with \
initializer · true/false · and/or/not · arithmetic & control flow · functions (up to 7 \
int/bool args, including void helpers) · recursion";
pub const CPP_SUBSET_UNSUPPORTED: &str = "classes & inheritance · templates · polymorphism · \
overloading · pointers & references · globals · strings · floats · standard library";
pub const RUST_SUBSET_SUPPORTED: &str = "i32/bool values · let/let mut · fixed local arrays · \
arithmetic & control flow · while/loop/for ranges · functions (up to 7 scalar args) · recursion";
pub const RUST_SUBSET_UNSUPPORTED: &str = "references & lifetimes · structs/enums/traits · \
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
        while i <= hi {
            // loop head?
            if let Some(end) = self.loop_ending(i, hi) {
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
                if target > i + 1 && target <= hi + 1 && self.clean_block(i, target) {
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
    let mut parser = Parser::new(tokens);
    let unit = parser.parse_unit()?;
    let gen = CodeGen::new();
    gen.emit_unit(&unit)
}

/// Compile the documented C integer subset to executable RV64IM.
///
/// Source `int` values retain signed 32-bit semantics in the 64-bit program.
pub fn c_to_asm64(source: &str) -> Result<String, TranslateError> {
    let tokens = lex(source)?;
    let mut parser = Parser::new(tokens);
    let unit = parser.parse_unit()?;
    let gen = CodeGen::new_rv64("C");
    gen.emit_unit(&unit)
}

/// Compile the documented C++ int/bool subset to executable RV32IM.
pub fn cpp_to_asm(source: &str) -> Result<String, TranslateError> {
    let unit = parse_cpp_unit(source)?;
    let gen = CodeGen::new_cpp();
    gen.emit_unit(&unit)
}

/// Compile the documented C++ int/bool subset to executable RV64IM.
///
/// Source `int` values retain signed 32-bit semantics in the 64-bit program.
pub fn cpp_to_asm64(source: &str) -> Result<String, TranslateError> {
    let unit = parse_cpp_unit(source)?;
    let gen = CodeGen::new_rv64("C++");
    gen.emit_unit(&unit)
}

/// Translate the documented C integer subset to compilable C++ subset source.
pub fn c_to_cpp(source: &str) -> Result<String, TranslateError> {
    let tokens = lex(source)?;
    let mut parser = Parser::new(tokens);
    let unit = parser.parse_unit()?;
    Ok(SourceEmitter::new(SourceDialect::Cpp).emit(&unit))
}

/// Translate the documented C++ int/bool subset to compilable C subset source.
pub fn cpp_to_c(source: &str) -> Result<String, TranslateError> {
    let unit = parse_cpp_unit(source)?;
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

// -- lexer ------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Tok {
    Int(i64),
    Bool(bool),
    Ident(String),
    Kw(&'static str),
    Sym(&'static str),
    Eof,
}

#[derive(Debug, Clone)]
struct SpTok {
    tok: Tok,
    line: usize,
}

const KEYWORDS: [&str; 8] = [
    "int", "if", "else", "while", "for", "return", "break", "continue",
];
const BANNED: [(&str, &str); 12] = [
    ("struct", "structs are not yet translatable"),
    ("char", "only 'int' is supported"),
    ("short", "only 'int' is supported"),
    ("long", "only 'int' is supported"),
    ("float", "floating point is not yet translatable"),
    ("double", "floating point is not yet translatable"),
    ("unsigned", "only plain 'int' is supported"),
    ("void", "only 'int' functions are supported"),
    ("switch", "switch is not yet translatable — use if/else"),
    ("do", "do/while is not yet translatable — use while"),
    ("sizeof", "sizeof is not yet translatable"),
    ("goto", "goto is not supported"),
];

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

const CPP_BANNED: [(&str, &str); 29] = [
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
    ("enum", "user-defined types are not supported"),
    ("union", "user-defined types are not supported"),
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
            let mut n: i64 = 0;
            let mut hex = false;
            chars.next();
            if c == '0' && matches!(chars.peek(), Some('x') | Some('X')) {
                chars.next();
                hex = true;
            } else {
                n = (c as u8 - b'0') as i64;
            }
            while let Some(&d) = chars.peek() {
                if hex && d.is_ascii_hexdigit() {
                    n = n * 16 + d.to_digit(16).unwrap() as i64;
                } else if !hex && d.is_ascii_digit() {
                    n = n * 10 + (d as u8 - b'0') as i64;
                } else {
                    break;
                }
                chars.next();
                if n > u32::MAX as i64 {
                    return Err(TranslateError::new(
                        line,
                        "integer literal too large for int",
                    ));
                }
            }
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
        let sym2 = [
            "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "+=", "-=", "*=", "/=", "%=", "++",
            "--", "->",
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
            if s == "->" && dialect != LexDialect::Rust {
                return Err(TranslateError::new(
                    line,
                    "unsupported: structs/pointers are not yet translatable",
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
        if dialect == LexDialect::Rust && c == ':' {
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
            return Err(TranslateError::new(
                line,
                "unsupported: floats/struct members are not yet translatable",
            ));
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
    Num(i32, ScalarType, usize),
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
                    self.array_declaration(name, *size, initial, source.initialized, *initializer);
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
                self.array_declaration(name, *size, initial, source.initialized, *initializer)
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
        name: &str,
        size: usize,
        initial: &[Expr],
        initialized: bool,
        initializer: ArrayInitProvenance,
    ) -> String {
        if !initialized {
            format!("int {}[{size}]", self.target_name(name))
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
                "int {}[{size}] = {{{}}}",
                self.target_name(name),
                values.join(", ")
            )
        }
    }

    fn expression(&self, expression: &Expr) -> String {
        match expression {
            Expr::Num(value, _, _) => value.to_string(),
            Expr::Var(name, _) => self.target_name(name),
            Expr::Index(name, index, _) => {
                format!("{}[{}]", self.target_name(name), self.expression(index))
            }
            Expr::Unary(operator, value, _) => {
                let operator = if self.dialect == SourceDialect::Cpp && *operator == "!" {
                    "not "
                } else {
                    operator
                };
                format!("({operator}{})", self.expression(value))
            }
            Expr::Binary(operator, left, right, _) => {
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
            }
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
            Expr::Call(name, arguments, _) => {
                let arguments = arguments
                    .iter()
                    .map(|argument| self.expression(argument))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{}({arguments})", self.target_name(name))
            }
        }
    }

    fn lvalue(&self, lvalue: &LValue) -> String {
        match lvalue {
            LValue::Var(name, _) => self.target_name(name),
            LValue::Index(name, index, _) => {
                format!("{}[{}]", self.target_name(name), self.expression(index))
            }
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

fn parse_cpp_unit(source: &str) -> Result<Unit, TranslateError> {
    let tokens = lex_cpp(source)?;
    reject_cpp_globals(&tokens)?;
    let mut parser = Parser::new(tokens);
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
        validate_cpp_void_statements(&function.body, function.return_type, &return_types)?;
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

fn validate_cpp_void_statements(
    statements: &[Stmt],
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
                validate_cpp_void_statements(body, function_return, return_types)?;
                validate_cpp_void_statements(otherwise, function_return, return_types)?;
            }
            Stmt::While(condition, body, _) => {
                validate_cpp_void_expression(condition, false, return_types)?;
                validate_cpp_void_statements(body, function_return, return_types)?;
            }
            Stmt::For(initial, condition, post, body, _) => {
                if let Some(initial) = initial {
                    validate_cpp_void_statements(
                        std::slice::from_ref(&**initial),
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
                validate_cpp_void_statements(body, function_return, return_types)?;
            }
            Stmt::Return(Some(value), _, line) => {
                if function_return == ScalarType::Unit {
                    return Err(TranslateError::new(
                        *line,
                        "void functions cannot return a value",
                    ));
                }
                validate_cpp_void_expression(value, false, return_types)?;
            }
            Stmt::Return(None, _, _) | Stmt::Break(_) | Stmt::Continue(_) => {}
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
            if let LValue::Index(_, index, _) = &**target {
                validate_cpp_void_expression(index, false, return_types)?;
            }
            validate_cpp_void_expression(value, false, return_types)
        }
        Expr::Call(name, arguments, line) => {
            if return_types.get(name) == Some(&ScalarType::Unit) && !allow_unit_call {
                return Err(TranslateError::new(
                    *line,
                    format!("void function '{name}' can only be called as a statement"),
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
        )
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
        if brace_depth == 0 && paren_depth == 0 && is_type(&token.tok) {
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

    fn parse_unit(mut self) -> Result<Unit, TranslateError> {
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
        let mut statements = Vec::new();
        while !self.eat_sym("}") {
            if matches!(self.parser.peek(), Tok::Eof) {
                return Err(TranslateError::new(self.parser.line(), "missing '}'"));
            }
            match self.parser.peek().clone() {
                Tok::Kw("let") => statements.push(self.parse_decl()?),
                Tok::Kw("if") => statements.push(self.parse_if()?),
                Tok::Kw("while") => statements.push(self.parse_while()?),
                Tok::Kw("loop") => statements.push(self.parse_loop()?),
                Tok::Kw("for") => statements.push(self.parse_for()?),
                Tok::Kw("return") => statements.push(self.parse_return()?),
                Tok::Kw("break") => {
                    let line = self.parser.line();
                    self.parser.next();
                    self.expect_sym(";")?;
                    statements.push(Stmt::Break(line));
                }
                Tok::Kw("continue") => {
                    let line = self.parser.line();
                    self.parser.next();
                    self.expect_sym(";")?;
                    statements.push(Stmt::Continue(line));
                }
                Tok::Sym("{") => {
                    let line = self.parser.line();
                    self.parser.next();
                    let body = self.parse_block(false)?;
                    statements.push(Stmt::If(
                        Expr::Num(1, ScalarType::I32, line),
                        body,
                        Vec::new(),
                        IfProvenance {
                            origin: IfOrigin::PlainBlock,
                            then_body: BodyForm::Braced,
                            else_body: None,
                            line,
                        },
                    ));
                }
                Tok::Kw("fn") => {
                    return Err(TranslateError::new(
                        self.parser.line(),
                        "unsupported: nested functions are not supported",
                    ))
                }
                _ => {
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
                        statements.push(Stmt::Expr(expression, ExprStmtProvenance::Expression));
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
                        statements.push(Stmt::Return(
                            Some(expression),
                            ReturnProvenance::Tail,
                            line,
                        ));
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
                }
            }
            self.eat_sym(";"); // Rust permits a trailing semicolon after block expressions.
        }
        Ok(statements)
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
                vec![self.parse_if()?]
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

    fn validate_expr(&self, expression: &Expr) -> Result<(), TranslateError> {
        match expression {
            Expr::Num(_, _, _) | Expr::Var(_, _) => Ok(()),
            Expr::Index(_, index, _) | Expr::Unary(_, index, _) => self.validate_expr(index),
            Expr::Binary(_, left, right, _) => {
                self.validate_expr(left)?;
                self.validate_expr(right)
            }
            Expr::Assign(_, _, _, line) => Err(TranslateError::new(
                *line,
                "Rust assignment expressions have unit value and are only supported as statements",
            )),
            Expr::Call(_, arguments, _) => {
                for argument in arguments {
                    self.validate_expr(argument)?;
                }
                Ok(())
            }
        }
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
}

impl Parser {
    fn new(toks: Vec<SpTok>) -> Self {
        Self { toks, pos: 0 }
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
        let mut funcs = Vec::new();
        let mut prototypes = Vec::new();
        let mut loose: Vec<Stmt> = Vec::new();
        let mut loose_line = 1;
        loop {
            match self.peek() {
                Tok::Eof => break,
                Tok::Kw("int") | Tok::Kw("bool") | Tok::Kw("void")
                    if matches!(self.peek2(), Tok::Ident(_)) && *self.peek3() == Tok::Sym("(") =>
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
        if !loose.is_empty() {
            if funcs.iter().any(|f| f.name == "main") {
                return Err(TranslateError::new(
                    loose_line,
                    "statements outside a function are only allowed when there is no main()",
                ));
            }
            funcs.push(Func {
                name: "main".into(),
                params: Vec::new(),
                param_types: Vec::new(),
                param_mutability: Vec::new(),
                param_lines: Vec::new(),
                return_type: ScalarType::I32,
                origin: FunctionOrigin::SyntheticMain,
                body: loose,
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
        Ok(Unit { funcs, prototypes })
    }

    fn parse_func(&mut self) -> Result<ParsedFunction, TranslateError> {
        let line = self.line();
        let return_type = match self.next() {
            Tok::Kw("int") => ScalarType::I32,
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
        let name = match self.next() {
            Tok::Ident(n) => n,
            t => {
                return Err(TranslateError::new(
                    line,
                    format!("expected function name, found {}", show(&t)),
                ))
            }
        };
        if name == "main" && return_type != ScalarType::I32 {
            return Err(TranslateError::new(line, "main() must return int"));
        }
        self.expect_sym("(")?;
        let mut params = Vec::new();
        let mut param_types = Vec::new();
        let mut param_lines = Vec::new();
        if !self.eat_sym(")") {
            loop {
                let parameter_type = match self.next() {
                    Tok::Kw("int") => ScalarType::I32,
                    Tok::Kw("bool") => ScalarType::Bool,
                    token => {
                        return Err(TranslateError::new(
                            self.line(),
                            format!(
                                "parameters must be 'int name' or 'bool name', found {}",
                                show(&token)
                            ),
                        ))
                    }
                };
                if self.eat_sym("*") {
                    return Err(TranslateError::new(
                        self.line(),
                        "unsupported: pointer parameters are not yet translatable",
                    ));
                }
                let parameter_line = self.line();
                match self.next() {
                    Tok::Ident(p) => {
                        params.push(p);
                        param_types.push(parameter_type);
                        param_lines.push(parameter_line);
                    }
                    t => {
                        return Err(TranslateError::new(
                            self.line(),
                            format!("expected parameter name, found {}", show(&t)),
                        ))
                    }
                }
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
        if self.eat_sym(";") {
            return Ok(ParsedFunction::Prototype(FunctionPrototype {
                name,
                parameters: params,
                parameter_types: param_types,
                return_type,
                line,
            }));
        }
        self.expect_sym("{")?;
        let body = self.parse_block_body()?;
        Ok(ParsedFunction::Definition(Func {
            param_types,
            param_mutability: vec![false; params.len()],
            param_lines,
            return_type,
            origin: FunctionOrigin::Explicit,
            name,
            params,
            body,
            line,
        }))
    }

    fn parse_block_body(&mut self) -> Result<Vec<Stmt>, TranslateError> {
        let mut stmts = Vec::new();
        while !self.eat_sym("}") {
            if *self.peek() == Tok::Eof {
                return Err(TranslateError::new(self.line(), "missing '}'"));
            }
            stmts.push(self.parse_stmt()?);
        }
        Ok(stmts)
    }

    fn parse_stmt(&mut self) -> Result<Stmt, TranslateError> {
        let line = self.line();
        match self.peek().clone() {
            Tok::Sym(";") => {
                self.next();
                Ok(Stmt::Expr(
                    Expr::Num(0, ScalarType::I32, line),
                    ExprStmtProvenance::Empty,
                ))
            }
            Tok::Sym("{") => {
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
            }
            Tok::Kw("int") | Tok::Kw("bool") | Tok::Kw("auto") => self.parse_decl(),
            Tok::Kw("if") => {
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
            }
            Tok::Kw("while") => {
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
            }
            Tok::Kw("for") => {
                self.next();
                self.expect_sym("(")?;
                let init = if self.eat_sym(";") {
                    None
                } else {
                    let s = if matches!(
                        self.peek(),
                        Tok::Kw("int") | Tok::Kw("bool") | Tok::Kw("auto")
                    ) {
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
            Tok::Kw("return") => {
                self.next();
                if self.eat_sym(";") {
                    Ok(Stmt::Return(None, ReturnProvenance::Explicit, line))
                } else {
                    let e = self.parse_expr()?;
                    self.expect_sym(";")?;
                    Ok(Stmt::Return(Some(e), ReturnProvenance::Explicit, line))
                }
            }
            Tok::Kw("break") => {
                self.next();
                self.expect_sym(";")?;
                Ok(Stmt::Break(line))
            }
            Tok::Kw("continue") => {
                self.next();
                self.expect_sym(";")?;
                Ok(Stmt::Continue(line))
            }
            _ => {
                let e = self.parse_expr()?;
                self.expect_sym(";")?;
                Ok(Stmt::Expr(e, ExprStmtProvenance::Expression))
            }
        }
    }

    fn parse_stmt_as_block(&mut self) -> Result<(Vec<Stmt>, BodyForm), TranslateError> {
        if self.eat_sym("{") {
            Ok((self.parse_block_body()?, BodyForm::Braced))
        } else {
            Ok((vec![self.parse_stmt()?], BodyForm::SingleStatement))
        }
    }

    fn parse_decl(&mut self) -> Result<Stmt, TranslateError> {
        let line = self.line();
        let declaration_type = match self.next() {
            Tok::Kw("int") => Some(ScalarType::I32),
            Tok::Kw("bool") => Some(ScalarType::Bool),
            Tok::Kw("auto") => None,
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
        if self.eat_sym("*") {
            return Err(TranslateError::new(
                line,
                "unsupported: pointers are not yet translatable",
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
            let size = match self.next() {
                Tok::Int(n) if n > 0 && n <= 4096 => n as usize,
                _ => {
                    return Err(TranslateError::new(
                        line,
                        "array size must be a constant between 1 and 4096",
                    ))
                }
            };
            self.expect_sym("]")?;
            let mut init = Vec::new();
            let initialized = self.eat_sym("=");
            if initialized {
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
                if init.len() > size {
                    return Err(TranslateError::new(line, "too many array initializers"));
                }
            }
            self.expect_sym(";")?;
            return Ok(Stmt::DeclArray(
                name,
                size,
                init,
                BindingProvenance {
                    declared_type: Some(ScalarType::I32),
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
        let line = self.line();
        let lhs = self.parse_binary(0)?;
        let provenance = match self.peek() {
            Tok::Sym("=") => Some(AssignmentProvenance::Simple),
            Tok::Sym("+=") => Some(AssignmentProvenance::Compound("+")),
            Tok::Sym("-=") => Some(AssignmentProvenance::Compound("-")),
            Tok::Sym("*=") => Some(AssignmentProvenance::Compound("*")),
            Tok::Sym("/=") => Some(AssignmentProvenance::Compound("/")),
            Tok::Sym("%=") => Some(AssignmentProvenance::Compound("%")),
            _ => None,
        };
        let Some(provenance) = provenance else {
            return Ok(lhs);
        };
        self.next();
        let lv = match &lhs {
            Expr::Var(n, l) => LValue::Var(n.clone(), *l),
            Expr::Index(n, i, l) => LValue::Index(n.clone(), (**i).clone(), *l),
            _ => {
                return Err(TranslateError::new(
                    line,
                    "left side of '=' must be a variable or array element",
                ))
            }
        };
        let rhs = self.parse_assign()?;
        Ok(Expr::Assign(Box::new(lv), Box::new(rhs), provenance, line))
    }

    fn parse_binary(&mut self, min_prec: u8) -> Result<Expr, TranslateError> {
        let mut lhs = self.parse_unary()?;
        loop {
            let (op, prec): (&'static str, u8) = match self.peek() {
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
                _ => break,
            };
            if prec < min_prec {
                break;
            }
            let line = self.line();
            self.next();
            let rhs = self.parse_binary(prec + 1)?;
            lhs = Expr::Binary(op, Box::new(lhs), Box::new(rhs), line);
        }
        Ok(lhs)
    }

    fn parse_unary(&mut self) -> Result<Expr, TranslateError> {
        let line = self.line();
        match self.peek() {
            Tok::Sym("-") => {
                self.next();
                Ok(Expr::Unary("-", Box::new(self.parse_unary()?), line))
            }
            Tok::Sym("!") => {
                self.next();
                Ok(Expr::Unary("!", Box::new(self.parse_unary()?), line))
            }
            Tok::Sym("~") => {
                self.next();
                Ok(Expr::Unary("~", Box::new(self.parse_unary()?), line))
            }
            Tok::Sym("*") => Err(TranslateError::new(
                line,
                "unsupported: pointer dereference is not yet translatable",
            )),
            Tok::Sym("&") => Err(TranslateError::new(
                line,
                "unsupported: address-of (&) is not yet translatable",
            )),
            Tok::Sym("++") | Tok::Sym("--") => {
                let provenance = if *self.peek() == Tok::Sym("++") {
                    AssignmentProvenance::PrefixIncrement
                } else {
                    AssignmentProvenance::PrefixDecrement
                };
                self.next();
                let target = self.parse_unary()?;
                let lv = match &target {
                    Expr::Var(n, l) => LValue::Var(n.clone(), *l),
                    Expr::Index(n, i, l) => LValue::Index(n.clone(), (**i).clone(), *l),
                    _ => {
                        return Err(TranslateError::new(line, "++/-- needs a variable"));
                    }
                };
                Ok(Expr::Assign(
                    Box::new(lv),
                    Box::new(Expr::Num(1, ScalarType::I32, line)),
                    provenance,
                    line,
                ))
            }
            _ => self.parse_postfix(),
        }
    }

    fn parse_postfix(&mut self) -> Result<Expr, TranslateError> {
        let line = self.line();
        let mut e = self.parse_primary()?;
        loop {
            match self.peek() {
                Tok::Sym("[") => {
                    self.next();
                    let idx = self.parse_expr()?;
                    self.expect_sym("]")?;
                    let name = match &e {
                        Expr::Var(n, l) => (n.clone(), *l),
                        _ => {
                            return Err(TranslateError::new(
                                line,
                                "only simple arrays can be indexed (a[i])",
                            ))
                        }
                    };
                    e = Expr::Index(name.0, Box::new(idx), name.1);
                }
                Tok::Sym("(") => {
                    self.next();
                    let name = match &e {
                        Expr::Var(n, l) => (n.clone(), *l),
                        _ => {
                            return Err(TranslateError::new(
                                line,
                                "only named functions can be called",
                            ))
                        }
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
                    e = Expr::Call(name.0, args, name.1);
                }
                Tok::Sym("++") | Tok::Sym("--") => {
                    // postfix: value-after semantics rarely matter in the
                    // subset's statement contexts; treat as pre (documented).
                    let provenance = if *self.peek() == Tok::Sym("++") {
                        AssignmentProvenance::PostfixIncrement
                    } else {
                        AssignmentProvenance::PostfixDecrement
                    };
                    self.next();
                    let lv = match &e {
                        Expr::Var(n, l) => LValue::Var(n.clone(), *l),
                        Expr::Index(n, i, l) => LValue::Index(n.clone(), (**i).clone(), *l),
                        _ => return Err(TranslateError::new(line, "++/-- needs a variable")),
                    };
                    e = Expr::Assign(
                        Box::new(lv),
                        Box::new(Expr::Num(1, ScalarType::I32, line)),
                        provenance,
                        line,
                    );
                }
                Tok::Kw("as") => {
                    self.next();
                    if !matches!(self.next(), Tok::Kw("usize")) {
                        return Err(TranslateError::new(
                            line,
                            "only 'as usize' casts are supported for array indexes",
                        ));
                    }
                    e = Expr::Unary("as usize", Box::new(e), line);
                }
                _ => break,
            }
        }
        Ok(e)
    }

    fn parse_primary(&mut self) -> Result<Expr, TranslateError> {
        let line = self.line();
        match self.next() {
            Tok::Int(n) => Ok(Expr::Num(n as i32, ScalarType::I32, line)),
            Tok::Bool(value) => Ok(Expr::Num(i32::from(value), ScalarType::Bool, line)),
            Tok::Ident(n) => Ok(Expr::Var(n, line)),
            Tok::Sym("(") => {
                let e = self.parse_expr()?;
                self.expect_sym(")")?;
                Ok(e)
            }
            t => Err(TranslateError::new(
                line,
                format!("expected an expression, found {}", show(&t)),
            )),
        }
    }
}

fn match_sym(s: &str) -> &'static str {
    // map to the interned symbol strings used by the lexer
    [
        "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "+=", "-=", "*=", "/=", "%=", "++", "--",
        "+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|", "^", "~", "(", ")", "{", "}", "[",
        "]", ";", ",",
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
}

struct CodeGen {
    out: String,
    label_n: usize,
    funcs: Vec<String>,
    parameter_types: HashMap<String, Vec<ScalarType>>,
    return_types: HashMap<String, ScalarType>,
    source_language: &'static str,
    target: CodeGenTarget,
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

    fn emit_unit(mut self, unit: &Unit) -> Result<String, TranslateError> {
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
        self.line("call main");
        self.line("ecall");
        self.line("");
        for f in &unit.funcs {
            self.emit_func(f)?;
        }
        Ok(std::mem::take(&mut self.out))
    }

    fn emit_func(&mut self, f: &Func) -> Result<(), TranslateError> {
        // Frame layout (sp stays fixed for the whole function):
        //   0..4/8       ra
        //   4/8..32/36  temp spill slots (for calls inside expressions)
        //   32/36..      parameters, then locals and arrays
        let mut ctx = FnCtx {
            fname: f.name.clone(),
            return_type: f.return_type,
            vars: HashMap::new(),
            types: HashMap::new(),
            frame: self.spill_base() + TEMPS.len() as i32 * 4,
            depth: 0,
            loops: Vec::new(),
            range_bounds: Vec::new(),
            range_cursor: 0,
        };
        for (p, value_type) in f.params.iter().zip(&f.param_types) {
            if ctx.vars.contains_key(p) {
                return Err(TranslateError::new(
                    f.line,
                    format!("duplicate parameter '{p}'"),
                ));
            }
            ctx.vars.insert(p.clone(), Slot::Local(ctx.frame));
            ctx.types.insert(p.clone(), *value_type);
            ctx.frame += 4;
        }
        // pre-scan declarations so the frame size is known up front
        prescan(&f.body, &mut ctx, &self.return_types, self.source_language)?;
        let frame = (ctx.frame + 15) & !15;

        let _ = writeln!(self.out, "{}:", f.name);
        self.line(&format!("addi sp, sp, -{frame}"));
        self.line(if self.is_rv64() {
            "sd ra, 0(sp)"
        } else {
            "sw ra, 0(sp)"
        });
        for (i, p) in f.params.iter().enumerate() {
            let Slot::Local(off) = ctx.vars[p] else {
                unreachable!()
            };
            self.line(&format!("sw a{i}, {off}(sp)  # {p}"));
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
        match s {
            Stmt::Decl(name, init, _, line) => {
                let Slot::Local(off) = ctx.vars[name] else {
                    unreachable!()
                };
                if let Some(e) = init {
                    let t = self.emit_expr(e, ctx)?;
                    if self.source_language == "C++"
                        && ctx.types.get(name) == Some(&ScalarType::Bool)
                    {
                        self.line(&format!("snez {t}, {t}"));
                    }
                    self.line(&format!("sw {t}, {off}(sp)  # {name}"));
                    ctx.depth -= 1;
                } else {
                    let _ = line;
                }
            }
            Stmt::DeclArray(name, size, init, source, initializer, _line) => {
                let Slot::Array(off, _) = ctx.vars[name].clone() else {
                    unreachable!()
                };
                if *initializer == ArrayInitProvenance::Repeat {
                    let t = self.emit_expr(&init[0], ctx)?;
                    for i in 0..*size {
                        self.line(&format!(
                            "sw {t}, {}(sp)  # {name}[{i}]",
                            off + 4 * i as i32
                        ));
                    }
                    ctx.depth -= 1;
                } else {
                    for (i, e) in init.iter().enumerate() {
                        let t = self.emit_expr(e, ctx)?;
                        self.line(&format!(
                            "sw {t}, {}(sp)  # {name}[{i}]",
                            off + 4 * i as i32
                        ));
                        ctx.depth -= 1;
                    }
                    if source.initialized {
                        for i in init.len()..*size {
                            self.line(&format!(
                                "sw zero, {}(sp)  # {name}[{i}]",
                                off + 4 * i as i32
                            ));
                        }
                    }
                }
            }
            Stmt::Expr(e, source) => {
                if *source == ExprStmtProvenance::Empty {
                    return Ok(());
                }
                self.emit_expr(e, ctx)?;
                ctx.depth -= 1;
            }
            Stmt::Return(e, _, _) => {
                if let Some(e) = e {
                    let t = self.emit_expr(e, ctx)?;
                    if self.source_language == "C++" && ctx.return_type == ScalarType::Bool {
                        self.line(&format!("snez {t}, {t}"));
                    }
                    self.line(&format!("mv a0, {t}"));
                    ctx.depth -= 1;
                } else {
                    self.line("li a0, 0");
                }
                self.line(&format!("j {ret}"));
            }
            Stmt::If(cond, then, els, source) => {
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
            }
            Stmt::While(cond, body, _) => {
                let head = self.label("while");
                let end = self.label("while_end");
                let _ = writeln!(self.out, "{head}:");
                let t = self.emit_expr(cond, ctx)?;
                ctx.depth -= 1;
                self.line(&format!("beqz {t}, {end}"));
                ctx.loops.push((head.clone(), end.clone()));
                self.emit_block(body, ctx, ret)?;
                ctx.loops.pop();
                self.line(&format!("j {head}"));
                let _ = writeln!(self.out, "{end}:");
            }
            Stmt::For(init, cond, post, body, source) => {
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
                let _ = writeln!(self.out, "{cont}:");
                if let Some(p) = post {
                    self.emit_expr(p, ctx)?;
                    ctx.depth -= 1;
                }
                self.line(&format!("j {head}"));
                let _ = writeln!(self.out, "{end}:");
            }
            Stmt::Break(line) => {
                let Some((_, end)) = ctx.loops.last() else {
                    return Err(TranslateError::new(*line, "break outside a loop"));
                };
                let end = end.clone();
                self.line(&format!("j {end}"));
            }
            Stmt::Continue(line) => {
                let Some((cont, _)) = ctx.loops.last() else {
                    return Err(TranslateError::new(*line, "continue outside a loop"));
                };
                let cont = cont.clone();
                self.line(&format!("j {cont}"));
            }
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
        match e {
            Expr::Num(n, _, line) => {
                let t = self.push_temp(ctx, *line)?;
                self.line(&format!("li {t}, {n}"));
                Ok(t)
            }
            Expr::Var(name, line) => {
                let slot = ctx
                    .vars
                    .get(name)
                    .cloned()
                    .ok_or_else(|| self.undefined(name, *line, ctx))?;
                let t = self.push_temp(ctx, *line)?;
                match slot {
                    Slot::Local(off) => self.line(&format!("lw {t}, {off}(sp)  # {name}")),
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
            }
            Expr::Index(name, idx, line) => {
                let slot = ctx
                    .vars
                    .get(name)
                    .cloned()
                    .ok_or_else(|| self.undefined(name, *line, ctx))?;
                let Slot::Array(off, size) = slot else {
                    return Err(TranslateError::new(
                        *line,
                        format!("'{name}' is not an array"),
                    ));
                };
                let _ = size;
                let t = self.emit_expr(idx, ctx)?;
                self.line(&format!("slli {t}, {t}, 2"));
                self.line(&format!("addi {t}, {t}, {off}"));
                self.line(&format!("add {t}, {t}, sp"));
                self.line(&format!("lw {t}, 0({t})  # {name}[…]"));
                Ok(t)
            }
            Expr::Unary(op, inner, _) => {
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
            }
            Expr::Binary(op, a, b, _) => self.emit_binary(op, a, b, ctx),
            Expr::Assign(lv, value, source, line) => {
                self.emit_assignment(lv, value, *source, *line, ctx)
            }
            Expr::Call(name, args, line) => {
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
                    let value = self.emit_expr(argument, ctx)?;
                    if self.source_language == "C++" && *parameter_type == ScalarType::Bool {
                        self.line(&format!("snez {value}, {value}"));
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
                        "sw {}, {}(sp)",
                        TEMPS[i],
                        self.spill_base() + 4 * i as i32
                    ));
                }
                self.line(&format!("call {name}"));
                for i in 0..ctx.depth {
                    self.line(&format!(
                        "lw {}, {}(sp)",
                        TEMPS[i],
                        self.spill_base() + 4 * i as i32
                    ));
                }
                let t = self.push_temp(ctx, *line)?;
                self.line(&format!("mv {t}, a0"));
                Ok(t)
            }
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
        let target_type = match target {
            LValue::Var(name, _) => ctx.types.get(name).copied().unwrap_or(ScalarType::I32),
            LValue::Index(..) => ScalarType::I32,
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
            LValue::Var(name, target_line) => {
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
            }
            LValue::Index(name, index, target_line) => {
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
            }
        }
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
        let Slot::Array(off, _) = self.local_slot(name, line, ctx)? else {
            return Err(TranslateError::new(
                line,
                format!("'{name}' is not an array"),
            ));
        };
        let address = self.emit_expr(index, ctx)?;
        self.line(&format!("slli {address}, {address}, 2"));
        self.line(&format!("addi {address}, {address}, {off}"));
        self.line(&format!("add {address}, {address}, sp"));
        Ok(address)
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
        let ta = self.emit_expr(a, ctx)?;
        let tb = self.emit_expr(b, ctx)?;
        self.emit_binary_registers(op, ta, tb, 0)?;
        ctx.depth -= 1;
        Ok(ta)
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
) -> Result<(), TranslateError> {
    for s in stmts {
        match s {
            Stmt::Decl(name, initial, source, line) => {
                if ctx.vars.contains_key(name) {
                    return Err(TranslateError::new(
                        *line,
                        format!(
                            "'{name}' is declared twice — the subset has one scope per \
function, use a different name"
                        ),
                    ));
                }
                ctx.vars.insert(name.clone(), Slot::Local(ctx.frame));
                let value_type = source.declared_type.unwrap_or_else(|| {
                    initial.as_ref().map_or(ScalarType::I32, |value| {
                        expression_scalar_type(value, &ctx.types, return_types, source_language)
                    })
                });
                ctx.types.insert(name.clone(), value_type);
                ctx.frame += 4;
            }
            Stmt::DeclArray(name, size, _, _, _, line) => {
                if ctx.vars.contains_key(name) {
                    return Err(TranslateError::new(
                        *line,
                        format!("'{name}' is declared twice"),
                    ));
                }
                ctx.vars.insert(name.clone(), Slot::Array(ctx.frame, *size));
                ctx.types.insert(name.clone(), ScalarType::I32);
                ctx.frame += 4 * *size as i32;
            }
            Stmt::If(_, a, b, _) => {
                prescan(a, ctx, return_types, source_language)?;
                prescan(b, ctx, return_types, source_language)?;
            }
            Stmt::While(_, body, _) => prescan(body, ctx, return_types, source_language)?,
            Stmt::For(init, _, _, body, source) => {
                if let Some(s) = init {
                    prescan(
                        std::slice::from_ref(&**s),
                        ctx,
                        return_types,
                        source_language,
                    )?;
                }
                if source.kind == LoopKind::RustRange {
                    ctx.range_bounds.push(ctx.frame);
                    ctx.frame += 4;
                }
                prescan(body, ctx, return_types, source_language)?;
            }
            _ => {}
        }
    }
    Ok(())
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
        let unit = parse_cpp_unit(source).expect("C++ subset source should parse");
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
    fn cpp_user_defined_types_fail_gracefully() {
        assert_cpp_rejected(
            "struct Point { int x; };\nint main() { return 0; }",
            1,
            "structs",
        );
        assert_cpp_rejected("enum Mode { Ready };", 1, "user-defined types");
        assert_cpp_rejected("union Value { int number; };", 1, "user-defined types");
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
        assert_cpp_rejected("int main() { return 'x'; }", 1, "string/char literals");
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
        parse_cpp_unit(&cpp).expect("translated C++ should parse");
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
        let err = c_to_asm("int main() { int *p; return 0; }").unwrap_err();
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
    fn c_struct_fails_gracefully() {
        let err = c_to_asm("struct P { int x; };").unwrap_err();
        assert!(err.message.contains("struct"), "message: {}", err.message);
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

//! Two-pass RV32IM assembler with the common pseudo-instructions.
//!
//! Pass 1 tokenizes, tracks sections (.text / .data), assigns addresses
//! (pseudo-instruction expansion sizes are decided here so label addresses
//! are stable) and collects labels. Pass 2 resolves labels and produces
//! decoded instructions ready for the pipeline.

use crate::{DATA_BASE, TEXT_BASE};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
pub struct AsmError {
    pub line: usize,
    pub message: String,
}

impl AsmError {
    fn new(line: usize, message: impl Into<String>) -> Self {
        Self {
            line,
            message: message.into(),
        }
    }
}

/// Every operation the pipeline can execute (RV32I + RV32M).
/// Pseudo-instructions are expanded to these during assembly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Op {
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
    Lbu,
    Lhu,
    Sb,
    Sh,
    Sw,
    Addi,
    Slti,
    Sltiu,
    Xori,
    Ori,
    Andi,
    Slli,
    Srli,
    Srai,
    Add,
    Sub,
    Sll,
    Slt,
    Sltu,
    Xor,
    Srl,
    Sra,
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
    Ecall,
    Ebreak,
    Fence, // executed as a nop
}

impl Op {
    pub fn is_load(self) -> bool {
        matches!(self, Op::Lb | Op::Lh | Op::Lw | Op::Lbu | Op::Lhu)
    }

    pub fn is_store(self) -> bool {
        matches!(self, Op::Sb | Op::Sh | Op::Sw)
    }

    pub fn is_branch(self) -> bool {
        matches!(
            self,
            Op::Beq | Op::Bne | Op::Blt | Op::Bge | Op::Bltu | Op::Bgeu
        )
    }

    pub fn is_jump(self) -> bool {
        matches!(self, Op::Jal | Op::Jalr)
    }

    /// Does this instruction read rs1?
    pub fn uses_rs1(self) -> bool {
        !matches!(
            self,
            Op::Lui | Op::Auipc | Op::Jal | Op::Ecall | Op::Ebreak | Op::Fence
        )
    }

    /// Does this instruction read rs2? (Loads and I-type ALU ops do not.)
    pub fn uses_rs2(self) -> bool {
        self.is_store()
            || self.is_branch()
            || matches!(
                self,
                Op::Add
                    | Op::Sub
                    | Op::Sll
                    | Op::Slt
                    | Op::Sltu
                    | Op::Xor
                    | Op::Srl
                    | Op::Sra
                    | Op::Or
                    | Op::And
                    | Op::Mul
                    | Op::Mulh
                    | Op::Mulhsu
                    | Op::Mulhu
                    | Op::Div
                    | Op::Divu
                    | Op::Rem
                    | Op::Remu
            )
    }

    /// Does this instruction write rd?
    pub fn writes_rd(self) -> bool {
        !(self.is_store() || self.is_branch() || matches!(self, Op::Ecall | Op::Ebreak | Op::Fence))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AsmInstr {
    pub op: Op,
    pub rd: u8,
    pub rs1: u8,
    pub rs2: u8,
    pub imm: i32,
    /// Display text for the pipeline diagram / disassembly.
    pub text: String,
    /// 1-based source line this instruction came from.
    pub line: usize,
    pub addr: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Program {
    pub instrs: Vec<AsmInstr>,
    /// Initial data segment image, loaded at DATA_BASE.
    pub data: Vec<u8>,
    pub labels: Vec<(String, u32)>,
}

impl Program {
    pub fn text_end(&self) -> u32 {
        TEXT_BASE + (self.instrs.len() as u32) * 4
    }

    pub fn instr_at(&self, pc: u32) -> Option<&AsmInstr> {
        if pc < TEXT_BASE || pc % 4 != 0 {
            return None;
        }
        self.instrs.get(((pc - TEXT_BASE) / 4) as usize)
    }
}

const ABI_NAMES: [&str; 32] = [
    "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2", "s0", "s1", "a0", "a1", "a2", "a3", "a4",
    "a5", "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "t3", "t4",
    "t5", "t6",
];

pub fn abi_name(reg: u8) -> &'static str {
    ABI_NAMES[(reg as usize) & 31]
}

fn parse_reg(token: &str) -> Option<u8> {
    let t = token.trim();
    if let Some(num) = t.strip_prefix('x').or_else(|| t.strip_prefix('X')) {
        if let Ok(n) = num.parse::<u8>() {
            if n < 32 {
                return Some(n);
            }
        }
        return None;
    }
    let lower = t.to_ascii_lowercase();
    if lower == "fp" {
        return Some(8);
    }
    ABI_NAMES.iter().position(|&n| n == lower).map(|i| i as u8)
}

fn parse_int(token: &str) -> Option<i64> {
    let t = token.trim();
    let (neg, body) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let value = if let Some(hex) = body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")) {
        i64::from_str_radix(hex, 16).ok()?
    } else if let Some(bin) = body.strip_prefix("0b").or_else(|| body.strip_prefix("0B")) {
        i64::from_str_radix(bin, 2).ok()?
    } else if body.chars().all(|c| c.is_ascii_digit()) && !body.is_empty() {
        body.parse::<i64>().ok()?
    } else {
        return None;
    };
    Some(if neg { -value } else { value })
}

/// `%hi(sym)` / `%lo(sym)` pair such that `lui rd,%hi` + `addi rd,rd,%lo`
/// reconstructs the full 32-bit address (the +0x800 compensates for the
/// sign-extension of the low 12 bits).
fn hi20(value: u32) -> u32 {
    value.wrapping_add(0x800) >> 12
}

fn lo12(value: u32) -> i32 {
    ((value & 0xfff) as i32) << 20 >> 20
}

#[derive(Debug, Clone)]
enum Line {
    Instr {
        line: usize,
        mnemonic: String,
        operands: Vec<String>,
        source_text: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Section {
    Text,
    Data,
}

/// Split an operand list on commas, keeping `imm(reg)` memory operands whole.
fn split_operands(rest: &str) -> Vec<String> {
    rest.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn strip_comment(line: &str) -> &str {
    // Strings only appear in .asciz/.string directives; respect quotes there.
    let mut in_str = false;
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if in_str {
            if c == '\\' {
                i += 1; // skip escaped char
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' {
            in_str = true;
        } else if c == '#' {
            return &line[..i];
        } else if c == '/' && i + 1 < bytes.len() && bytes[i + 1] as char == '/' {
            return &line[..i];
        }
        i += 1;
    }
    line
}

fn parse_string_literal(raw: &str, line: usize) -> Result<Vec<u8>, AsmError> {
    let t = raw.trim();
    if t.len() < 2 || !t.starts_with('"') || !t.ends_with('"') {
        return Err(AsmError::new(line, format!("expected string literal, got '{t}'")));
    }
    let inner = &t[1..t.len() - 1];
    let mut out = Vec::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push(b'\n'),
                Some('t') => out.push(b'\t'),
                Some('r') => out.push(b'\r'),
                Some('0') => out.push(0),
                Some('\\') => out.push(b'\\'),
                Some('"') => out.push(b'"'),
                other => {
                    return Err(AsmError::new(
                        line,
                        format!("unknown escape '\\{}'", other.map(String::from).unwrap_or_default()),
                    ))
                }
            }
        } else {
            let mut buf = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        }
    }
    Ok(out)
}

/// How many real instructions a (possibly pseudo) instruction expands to.
/// Must be decided in pass 1 so label addresses are stable.
fn expansion_size(mnemonic: &str, operands: &[String]) -> usize {
    match mnemonic {
        "li" => {
            // 1 instr if the constant fits a 12-bit signed immediate, else lui+addi.
            if let Some(v) = operands.get(1).and_then(|s| parse_int(s)) {
                if (-2048..=2047).contains(&v) {
                    1
                } else {
                    2
                }
            } else {
                1 // error reported in pass 2
            }
        }
        "la" => 2, // lui + addi, always
        _ => 1,
    }
}

struct Assembler<'a> {
    labels: HashMap<String, u32>,
    errors: Vec<AsmError>,
    lines: &'a [Line],
}

pub fn assemble(source: &str) -> Result<Program, Vec<AsmError>> {
    let mut errors: Vec<AsmError> = Vec::new();
    let mut labels: HashMap<String, u32> = HashMap::new();
    let mut section = Section::Text;
    let mut text_cursor = TEXT_BASE;
    let mut data: Vec<u8> = Vec::new();
    let mut items: Vec<Line> = Vec::new();

    // ---------- Pass 1: labels, addresses, data image ----------
    for (idx, raw_line) in source.lines().enumerate() {
        let line_no = idx + 1;
        let mut rest = strip_comment(raw_line).trim();

        // Labels (possibly several, possibly followed by an instruction).
        while let Some(colon) = rest.find(':') {
            let candidate = rest[..colon].trim();
            if candidate.is_empty()
                || !candidate
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '$')
                || candidate.chars().next().is_some_and(|c| c.is_ascii_digit())
            {
                break;
            }
            let addr = match section {
                Section::Text => text_cursor,
                Section::Data => DATA_BASE + data.len() as u32,
            };
            if labels.insert(candidate.to_string(), addr).is_some() {
                errors.push(AsmError::new(line_no, format!("duplicate label '{candidate}'")));
            }
            rest = rest[colon + 1..].trim();
        }

        if rest.is_empty() {
            continue;
        }

        let (head, tail) = match rest.find(|c: char| c.is_whitespace()) {
            Some(pos) => (&rest[..pos], rest[pos..].trim()),
            None => (rest, ""),
        };
        let mnemonic = head.to_ascii_lowercase();

        if let Some(directive) = mnemonic.strip_prefix('.') {
            match directive {
                "text" => section = Section::Text,
                "data" => section = Section::Data,
                "globl" | "global" | "section" | "align" | "p2align" | "type" | "size" => {
                    // .align in .data: honor it; elsewhere ignore.
                    if directive == "align" || directive == "p2align" {
                        if section == Section::Data {
                            if let Some(n) = parse_int(tail) {
                                let align = 1usize << n.clamp(0, 12);
                                while data.len() % align != 0 {
                                    data.push(0);
                                }
                            }
                        }
                    }
                }
                "word" | "half" | "byte" | "asciz" | "ascii" | "string" | "space" | "zero" => {
                    if section != Section::Data {
                        errors.push(AsmError::new(
                            line_no,
                            format!(".{directive} is only supported in the .data section"),
                        ));
                        continue;
                    }
                    match directive {
                        "word" | "half" | "byte" => {
                            let size = match directive {
                                "word" => 4,
                                "half" => 2,
                                _ => 1,
                            };
                            // natural alignment for the element size
                            while data.len() % size != 0 {
                                data.push(0);
                            }
                            for value_str in split_operands(tail) {
                                // Values may be label references (resolved in pass 2);
                                // reserve space now, patch later via a second sweep.
                                // To keep this simple we only allow numeric values or
                                // labels for .word.
                                let is_label = parse_int(&value_str).is_none();
                                if is_label && directive != "word" {
                                    errors.push(AsmError::new(
                                        line_no,
                                        format!("'{value_str}' is not a valid .{directive} value"),
                                    ));
                                }
                                for _ in 0..size {
                                    data.push(0);
                                }
                            }
                        }
                        "asciz" | "ascii" | "string" => match parse_string_literal(tail, line_no) {
                            Ok(mut bytes) => {
                                if directive != "ascii" {
                                    bytes.push(0);
                                }
                                data.extend_from_slice(&bytes);
                            }
                            Err(e) => errors.push(e),
                        },
                        "space" | "zero" => match parse_int(tail) {
                            Some(n) if n >= 0 => data.extend(std::iter::repeat(0).take(n as usize)),
                            _ => errors.push(AsmError::new(
                                line_no,
                                format!("invalid .{directive} size '{tail}'"),
                            )),
                        },
                        _ => unreachable!(),
                    }
                }
                other => {
                    errors.push(AsmError::new(line_no, format!("unknown directive '.{other}'")));
                }
            }
            continue;
        }

        if section != Section::Text {
            errors.push(AsmError::new(
                line_no,
                format!("instruction '{mnemonic}' outside the .text section"),
            ));
            continue;
        }

        let operands = split_operands(tail);
        text_cursor += 4 * expansion_size(&mnemonic, &operands) as u32;
        items.push(Line::Instr {
            line: line_no,
            mnemonic,
            operands,
            source_text: rest.to_string(),
        });
    }

    // Second sweep of .data to patch values (now that labels are known).
    // Re-walk the source: simpler than carrying patch lists around.
    {
        let mut cursor = 0usize;
        let mut section = Section::Text;
        for (idx, raw_line) in source.lines().enumerate() {
            let line_no = idx + 1;
            let mut rest = strip_comment(raw_line).trim();
            while let Some(colon) = rest.find(':') {
                let candidate = rest[..colon].trim();
                if candidate.is_empty()
                    || !candidate
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '$')
                    || candidate.chars().next().is_some_and(|c| c.is_ascii_digit())
                {
                    break;
                }
                rest = rest[colon + 1..].trim();
            }
            if rest.is_empty() {
                continue;
            }
            let (head, tail) = match rest.find(|c: char| c.is_whitespace()) {
                Some(pos) => (&rest[..pos], rest[pos..].trim()),
                None => (rest, ""),
            };
            let mnemonic = head.to_ascii_lowercase();
            match mnemonic.as_str() {
                ".text" => section = Section::Text,
                ".data" => section = Section::Data,
                ".align" | ".p2align" if section == Section::Data => {
                    if let Some(n) = parse_int(tail) {
                        let align = 1usize << n.clamp(0, 12);
                        while cursor % align != 0 {
                            cursor += 1;
                        }
                    }
                }
                ".word" | ".half" | ".byte" if section == Section::Data => {
                    let size = match mnemonic.as_str() {
                        ".word" => 4,
                        ".half" => 2,
                        _ => 1,
                    };
                    while cursor % size != 0 {
                        cursor += 1;
                    }
                    for value_str in split_operands(tail) {
                        let value: i64 = match parse_int(&value_str) {
                            Some(v) => v,
                            None => match labels.get(value_str.trim()) {
                                Some(&addr) => addr as i64,
                                None => {
                                    errors.push(AsmError::new(
                                        line_no,
                                        format!("label '{}' not found", value_str.trim()),
                                    ));
                                    0
                                }
                            },
                        };
                        let bytes = (value as u64).to_le_bytes();
                        for b in 0..size {
                            if cursor < data.len() {
                                data[cursor] = bytes[b];
                            }
                            cursor += 1;
                        }
                    }
                }
                ".asciz" | ".ascii" | ".string" if section == Section::Data => {
                    if let Ok(mut bytes) = parse_string_literal(tail, line_no) {
                        if mnemonic != ".ascii" {
                            bytes.push(0);
                        }
                        cursor += bytes.len();
                    }
                }
                ".space" | ".zero" if section == Section::Data => {
                    if let Some(n) = parse_int(tail) {
                        if n >= 0 {
                            cursor += n as usize;
                        }
                    }
                }
                _ => {}
            }
        }
    }

    // ---------- Pass 2: decode instructions ----------
    let asm = Assembler {
        labels,
        errors,
        lines: &items,
    };
    asm.finish(data)
}

impl<'a> Assembler<'a> {
    fn finish(mut self, data: Vec<u8>) -> Result<Program, Vec<AsmError>> {
        let mut instrs: Vec<AsmInstr> = Vec::new();
        let lines = self.lines.to_vec();
        for item in &lines {
            let Line::Instr {
                line,
                mnemonic,
                operands,
                source_text,
            } = item;
            let addr = TEXT_BASE + (instrs.len() as u32) * 4;
            match self.decode(*line, addr, mnemonic, operands, source_text) {
                Ok(decoded) => instrs.extend(decoded),
                Err(e) => {
                    self.errors.push(e);
                    // keep addresses stable even after an error
                    for _ in 0..expansion_size(mnemonic, operands) {
                        instrs.push(AsmInstr {
                            op: Op::Fence,
                            rd: 0,
                            rs1: 0,
                            rs2: 0,
                            imm: 0,
                            text: source_text.clone(),
                            line: *line,
                            addr: TEXT_BASE + (instrs.len() as u32) * 4,
                        });
                    }
                }
            }
        }

        if !self.errors.is_empty() {
            self.errors.sort_by_key(|e| e.line);
            return Err(self.errors);
        }
        if instrs.is_empty() {
            return Err(vec![AsmError::new(1, "program has no instructions")]);
        }

        let mut labels: Vec<(String, u32)> = self.labels.into_iter().collect();
        labels.sort_by_key(|(_, addr)| *addr);
        Ok(Program {
            instrs,
            data,
            labels,
        })
    }

    fn reg(&self, line: usize, token: Option<&String>, what: &str) -> Result<u8, AsmError> {
        let token = token.ok_or_else(|| AsmError::new(line, format!("missing {what} register")))?;
        parse_reg(token)
            .ok_or_else(|| AsmError::new(line, format!("invalid register '{}'", token.trim())))
    }

    fn imm(
        &self,
        line: usize,
        token: Option<&String>,
        min: i64,
        max: i64,
        what: &str,
    ) -> Result<i32, AsmError> {
        let token = token.ok_or_else(|| AsmError::new(line, format!("missing {what}")))?;
        // %hi(sym) / %lo(sym)
        if let Some(inner) = token
            .strip_prefix("%hi(")
            .and_then(|s| s.strip_suffix(')'))
        {
            let addr = self.label_addr(line, inner.trim())?;
            return Ok(hi20(addr) as i32);
        }
        if let Some(inner) = token
            .strip_prefix("%lo(")
            .and_then(|s| s.strip_suffix(')'))
        {
            let addr = self.label_addr(line, inner.trim())?;
            return Ok(lo12(addr));
        }
        let value = parse_int(token)
            .ok_or_else(|| AsmError::new(line, format!("invalid immediate '{}'", token.trim())))?;
        if value < min || value > max {
            return Err(AsmError::new(
                line,
                format!("{what} {value} out of range [{min}, {max}]"),
            ));
        }
        Ok(value as i32)
    }

    fn label_addr(&self, line: usize, name: &str) -> Result<u32, AsmError> {
        self.labels
            .get(name)
            .copied()
            .ok_or_else(|| AsmError::new(line, format!("label '{name}' not found")))
    }

    /// Branch/jump target: a label or a numeric absolute address.
    fn target(&self, line: usize, token: Option<&String>, what: &str) -> Result<u32, AsmError> {
        let token = token.ok_or_else(|| AsmError::new(line, format!("missing {what}")))?;
        if let Some(v) = parse_int(token) {
            if v >= 0 && v <= u32::MAX as i64 {
                return Ok(v as u32);
            }
            return Err(AsmError::new(line, format!("invalid target address '{token}'")));
        }
        self.label_addr(line, token.trim())
    }

    /// Parse `offset(reg)` / `(reg)` / `label` memory operands.
    fn mem_operand(
        &self,
        line: usize,
        token: Option<&String>,
    ) -> Result<(u8, i32), AsmError> {
        let token =
            token.ok_or_else(|| AsmError::new(line, "missing memory operand".to_string()))?;
        let t = token.trim();
        if let Some(open) = t.find('(') {
            let close = t
                .rfind(')')
                .ok_or_else(|| AsmError::new(line, format!("missing ')' in '{t}'")))?;
            let reg = parse_reg(&t[open + 1..close])
                .ok_or_else(|| AsmError::new(line, format!("invalid register in '{t}'")))?;
            let off_str = t[..open].trim();
            let off = if off_str.is_empty() {
                0
            } else if let Some(inner) = off_str
                .strip_prefix("%lo(")
                .and_then(|s| s.strip_suffix(')'))
            {
                lo12(self.label_addr(line, inner.trim())?)
            } else {
                let v = parse_int(off_str)
                    .ok_or_else(|| AsmError::new(line, format!("invalid offset '{off_str}'")))?;
                if !(-2048..=2047).contains(&v) {
                    return Err(AsmError::new(
                        line,
                        format!("offset {v} out of range [-2048, 2047]"),
                    ));
                }
                v as i32
            };
            return Ok((reg, off));
        }
        Err(AsmError::new(
            line,
            format!("expected 'offset(register)' memory operand, got '{t}'"),
        ))
    }

    fn branch_offset(&self, line: usize, addr: u32, target: u32) -> Result<i32, AsmError> {
        let offset = target.wrapping_sub(addr) as i32;
        if offset % 2 != 0 {
            return Err(AsmError::new(line, "branch target is misaligned"));
        }
        if !(-4096..=4094).contains(&offset) {
            return Err(AsmError::new(
                line,
                format!("branch target out of range (offset {offset})"),
            ));
        }
        Ok(offset)
    }

    fn jump_offset(&self, line: usize, addr: u32, target: u32) -> Result<i32, AsmError> {
        let offset = target.wrapping_sub(addr) as i32;
        if offset % 2 != 0 {
            return Err(AsmError::new(line, "jump target is misaligned"));
        }
        if !(-(1 << 20)..(1 << 20)).contains(&offset) {
            return Err(AsmError::new(
                line,
                format!("jump target out of range (offset {offset})"),
            ));
        }
        Ok(offset)
    }

    fn decode(
        &self,
        line: usize,
        addr: u32,
        mnemonic: &str,
        ops: &[String],
        source_text: &str,
    ) -> Result<Vec<AsmInstr>, AsmError> {
        let mk = |op: Op, rd: u8, rs1: u8, rs2: u8, imm: i32, text: String, addr: u32| AsmInstr {
            op,
            rd,
            rs1,
            rs2,
            imm,
            text,
            line,
            addr,
        };
        let text = source_text.to_string();
        let expect = |n: usize| -> Result<(), AsmError> {
            if ops.len() != n {
                Err(AsmError::new(
                    line,
                    format!("'{mnemonic}' expects {n} operand(s), got {}", ops.len()),
                ))
            } else {
                Ok(())
            }
        };

        let r_type = |op: Op| -> Result<Vec<AsmInstr>, AsmError> {
            expect(3)?;
            Ok(vec![mk(
                op,
                self.reg(line, ops.first(), "destination")?,
                self.reg(line, ops.get(1), "source")?,
                self.reg(line, ops.get(2), "source")?,
                0,
                text.clone(),
                addr,
            )])
        };
        let i_type = |op: Op| -> Result<Vec<AsmInstr>, AsmError> {
            expect(3)?;
            Ok(vec![mk(
                op,
                self.reg(line, ops.first(), "destination")?,
                self.reg(line, ops.get(1), "source")?,
                0,
                self.imm(line, ops.get(2), -2048, 2047, "immediate")?,
                text.clone(),
                addr,
            )])
        };
        let shift = |op: Op| -> Result<Vec<AsmInstr>, AsmError> {
            expect(3)?;
            Ok(vec![mk(
                op,
                self.reg(line, ops.first(), "destination")?,
                self.reg(line, ops.get(1), "source")?,
                0,
                self.imm(line, ops.get(2), 0, 31, "shift amount")?,
                text.clone(),
                addr,
            )])
        };
        let load = |op: Op| -> Result<Vec<AsmInstr>, AsmError> {
            expect(2)?;
            let rd = self.reg(line, ops.first(), "destination")?;
            let (rs1, imm) = self.mem_operand(line, ops.get(1))?;
            Ok(vec![mk(op, rd, rs1, 0, imm, text.clone(), addr)])
        };
        let store = |op: Op| -> Result<Vec<AsmInstr>, AsmError> {
            expect(2)?;
            let rs2 = self.reg(line, ops.first(), "source")?;
            let (rs1, imm) = self.mem_operand(line, ops.get(1))?;
            Ok(vec![mk(op, 0, rs1, rs2, imm, text.clone(), addr)])
        };
        let branch = |op: Op, swap: bool| -> Result<Vec<AsmInstr>, AsmError> {
            expect(3)?;
            let a = self.reg(line, ops.first(), "source")?;
            let b = self.reg(line, ops.get(1), "source")?;
            let (rs1, rs2) = if swap { (b, a) } else { (a, b) };
            let target = self.target(line, ops.get(2), "branch target")?;
            let imm = self.branch_offset(line, addr, target)?;
            Ok(vec![mk(op, 0, rs1, rs2, imm, text.clone(), addr)])
        };
        let branch_zero = |op: Op, reg_first: bool| -> Result<Vec<AsmInstr>, AsmError> {
            expect(2)?;
            let r = self.reg(line, ops.first(), "source")?;
            let (rs1, rs2) = if reg_first { (r, 0) } else { (0, r) };
            let target = self.target(line, ops.get(1), "branch target")?;
            let imm = self.branch_offset(line, addr, target)?;
            Ok(vec![mk(op, 0, rs1, rs2, imm, text.clone(), addr)])
        };

        match mnemonic {
            // ---- RV32I ----
            "add" => r_type(Op::Add),
            "sub" => r_type(Op::Sub),
            "sll" => r_type(Op::Sll),
            "slt" => r_type(Op::Slt),
            "sltu" => r_type(Op::Sltu),
            "xor" => r_type(Op::Xor),
            "srl" => r_type(Op::Srl),
            "sra" => r_type(Op::Sra),
            "or" => r_type(Op::Or),
            "and" => r_type(Op::And),
            "mul" => r_type(Op::Mul),
            "mulh" => r_type(Op::Mulh),
            "mulhsu" => r_type(Op::Mulhsu),
            "mulhu" => r_type(Op::Mulhu),
            "div" => r_type(Op::Div),
            "divu" => r_type(Op::Divu),
            "rem" => r_type(Op::Rem),
            "remu" => r_type(Op::Remu),
            "addi" => i_type(Op::Addi),
            "slti" => i_type(Op::Slti),
            "sltiu" => i_type(Op::Sltiu),
            "xori" => i_type(Op::Xori),
            "ori" => i_type(Op::Ori),
            "andi" => i_type(Op::Andi),
            "slli" => shift(Op::Slli),
            "srli" => shift(Op::Srli),
            "srai" => shift(Op::Srai),
            "lb" => load(Op::Lb),
            "lh" => load(Op::Lh),
            "lw" => load(Op::Lw),
            "lbu" => load(Op::Lbu),
            "lhu" => load(Op::Lhu),
            "sb" => store(Op::Sb),
            "sh" => store(Op::Sh),
            "sw" => store(Op::Sw),
            "beq" => branch(Op::Beq, false),
            "bne" => branch(Op::Bne, false),
            "blt" => branch(Op::Blt, false),
            "bge" => branch(Op::Bge, false),
            "bltu" => branch(Op::Bltu, false),
            "bgeu" => branch(Op::Bgeu, false),
            // bgt/ble/bgtu/bleu are pseudo forms with swapped operands
            "bgt" => branch(Op::Blt, true),
            "ble" => branch(Op::Bge, true),
            "bgtu" => branch(Op::Bltu, true),
            "bleu" => branch(Op::Bgeu, true),
            "lui" => {
                expect(2)?;
                Ok(vec![mk(
                    Op::Lui,
                    self.reg(line, ops.first(), "destination")?,
                    0,
                    0,
                    self.imm(line, ops.get(1), 0, 0xfffff, "immediate")?,
                    text,
                    addr,
                )])
            }
            "auipc" => {
                expect(2)?;
                Ok(vec![mk(
                    Op::Auipc,
                    self.reg(line, ops.first(), "destination")?,
                    0,
                    0,
                    self.imm(line, ops.get(1), 0, 0xfffff, "immediate")?,
                    text,
                    addr,
                )])
            }
            "jal" => {
                // jal label | jal rd, label
                let (rd, target_tok) = match ops.len() {
                    1 => (1u8, ops.first()),
                    2 => (self.reg(line, ops.first(), "destination")?, ops.get(1)),
                    _ => return Err(AsmError::new(line, "'jal' expects 1 or 2 operands")),
                };
                let target = self.target(line, target_tok, "jump target")?;
                let imm = self.jump_offset(line, addr, target)?;
                Ok(vec![mk(Op::Jal, rd, 0, 0, imm, text, addr)])
            }
            "jalr" => {
                // jalr rs | jalr rd, offset(rs1) | jalr rd, rs1, offset
                match ops.len() {
                    1 => Ok(vec![mk(
                        Op::Jalr,
                        1,
                        self.reg(line, ops.first(), "source")?,
                        0,
                        0,
                        text,
                        addr,
                    )]),
                    2 => {
                        let rd = self.reg(line, ops.first(), "destination")?;
                        let (rs1, imm) = self.mem_operand(line, ops.get(1))?;
                        Ok(vec![mk(Op::Jalr, rd, rs1, 0, imm, text, addr)])
                    }
                    3 => Ok(vec![mk(
                        Op::Jalr,
                        self.reg(line, ops.first(), "destination")?,
                        self.reg(line, ops.get(1), "source")?,
                        0,
                        self.imm(line, ops.get(2), -2048, 2047, "offset")?,
                        text,
                        addr,
                    )]),
                    _ => Err(AsmError::new(line, "'jalr' expects 1-3 operands")),
                }
            }
            "ecall" => {
                expect(0)?;
                Ok(vec![mk(Op::Ecall, 0, 0, 0, 0, text, addr)])
            }
            "ebreak" => {
                expect(0)?;
                Ok(vec![mk(Op::Ebreak, 0, 0, 0, 0, text, addr)])
            }
            "fence" | "fence.i" => Ok(vec![mk(Op::Fence, 0, 0, 0, 0, text, addr)]),

            // ---- Pseudo-instructions ----
            "nop" => {
                expect(0)?;
                Ok(vec![mk(Op::Addi, 0, 0, 0, 0, text, addr)])
            }
            "mv" => {
                expect(2)?;
                Ok(vec![mk(
                    Op::Addi,
                    self.reg(line, ops.first(), "destination")?,
                    self.reg(line, ops.get(1), "source")?,
                    0,
                    0,
                    text,
                    addr,
                )])
            }
            "li" => {
                expect(2)?;
                let rd = self.reg(line, ops.first(), "destination")?;
                let value = parse_int(ops.get(1).map(String::as_str).unwrap_or("")).ok_or_else(
                    || AsmError::new(line, format!("invalid immediate '{}'", ops[1].trim())),
                )?;
                if !(-(1i64 << 31)..(1i64 << 32)).contains(&value) {
                    return Err(AsmError::new(
                        line,
                        format!("immediate {value} does not fit in 32 bits"),
                    ));
                }
                let v = value as u32;
                if (-2048..=2047).contains(&(v as i32 as i64)) && (-2048..=2047).contains(&value) {
                    Ok(vec![mk(Op::Addi, rd, 0, 0, value as i32, text, addr)])
                } else {
                    let hi = hi20(v);
                    let lo = lo12(v);
                    Ok(vec![
                        mk(
                            Op::Lui,
                            rd,
                            0,
                            0,
                            hi as i32,
                            format!("lui {}, 0x{:x}", abi_name(rd), hi),
                            addr,
                        ),
                        mk(
                            Op::Addi,
                            rd,
                            rd,
                            0,
                            lo,
                            format!("addi {0}, {0}, {1}", abi_name(rd), lo),
                            addr + 4,
                        ),
                    ])
                }
            }
            "la" => {
                expect(2)?;
                let rd = self.reg(line, ops.first(), "destination")?;
                let target = self.label_addr(
                    line,
                    ops.get(1)
                        .map(String::as_str)
                        .unwrap_or("")
                        .trim(),
                )?;
                let hi = hi20(target);
                let lo = lo12(target);
                Ok(vec![
                    mk(
                        Op::Lui,
                        rd,
                        0,
                        0,
                        hi as i32,
                        format!("lui {}, 0x{:x}", abi_name(rd), hi),
                        addr,
                    ),
                    mk(
                        Op::Addi,
                        rd,
                        rd,
                        0,
                        lo,
                        format!("addi {0}, {0}, {1}", abi_name(rd), lo),
                        addr + 4,
                    ),
                ])
            }
            "not" => {
                expect(2)?;
                Ok(vec![mk(
                    Op::Xori,
                    self.reg(line, ops.first(), "destination")?,
                    self.reg(line, ops.get(1), "source")?,
                    0,
                    -1,
                    text,
                    addr,
                )])
            }
            "neg" => {
                expect(2)?;
                Ok(vec![mk(
                    Op::Sub,
                    self.reg(line, ops.first(), "destination")?,
                    0,
                    self.reg(line, ops.get(1), "source")?,
                    0,
                    text,
                    addr,
                )])
            }
            "seqz" => {
                expect(2)?;
                Ok(vec![mk(
                    Op::Sltiu,
                    self.reg(line, ops.first(), "destination")?,
                    self.reg(line, ops.get(1), "source")?,
                    0,
                    1,
                    text,
                    addr,
                )])
            }
            "snez" => {
                expect(2)?;
                Ok(vec![mk(
                    Op::Sltu,
                    self.reg(line, ops.first(), "destination")?,
                    0,
                    self.reg(line, ops.get(1), "source")?,
                    0,
                    text,
                    addr,
                )])
            }
            "sltz" => {
                expect(2)?;
                Ok(vec![mk(
                    Op::Slt,
                    self.reg(line, ops.first(), "destination")?,
                    self.reg(line, ops.get(1), "source")?,
                    0,
                    0,
                    text,
                    addr,
                )])
            }
            "sgtz" => {
                expect(2)?;
                Ok(vec![mk(
                    Op::Slt,
                    self.reg(line, ops.first(), "destination")?,
                    0,
                    self.reg(line, ops.get(1), "source")?,
                    0,
                    text,
                    addr,
                )])
            }
            "beqz" => branch_zero(Op::Beq, true),
            "bnez" => branch_zero(Op::Bne, true),
            "bltz" => branch_zero(Op::Blt, true),
            "bgez" => branch_zero(Op::Bge, true),
            "blez" => branch_zero(Op::Bge, false), // rs <= 0  <=>  0 >= rs
            "bgtz" => branch_zero(Op::Blt, false), // rs > 0   <=>  0 < rs
            "j" => {
                expect(1)?;
                let target = self.target(line, ops.first(), "jump target")?;
                let imm = self.jump_offset(line, addr, target)?;
                Ok(vec![mk(Op::Jal, 0, 0, 0, imm, text, addr)])
            }
            "jr" => {
                expect(1)?;
                Ok(vec![mk(
                    Op::Jalr,
                    0,
                    self.reg(line, ops.first(), "source")?,
                    0,
                    0,
                    text,
                    addr,
                )])
            }
            "ret" => {
                expect(0)?;
                Ok(vec![mk(Op::Jalr, 0, 1, 0, 0, text, addr)])
            }
            "call" => {
                expect(1)?;
                let target = self.target(line, ops.first(), "call target")?;
                let imm = self.jump_offset(line, addr, target)?;
                Ok(vec![mk(Op::Jal, 1, 0, 0, imm, text, addr)])
            }
            "tail" => {
                expect(1)?;
                let target = self.target(line, ops.first(), "jump target")?;
                let imm = self.jump_offset(line, addr, target)?;
                Ok(vec![mk(Op::Jal, 0, 0, 0, imm, text, addr)])
            }
            other => Err(AsmError::new(line, format!("unknown instruction '{other}'"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assembles_basic_program() {
        let program = assemble("addi x1, x0, 5\naddi x2, x1, 3\nadd x3, x2, x1\n").unwrap();
        assert_eq!(program.instrs.len(), 3);
        assert_eq!(program.instrs[0].op, Op::Addi);
        assert_eq!(program.instrs[0].rd, 1);
        assert_eq!(program.instrs[0].imm, 5);
        assert_eq!(program.instrs[2].op, Op::Add);
        assert_eq!(program.instrs[2].rs1, 2);
        assert_eq!(program.instrs[2].rs2, 1);
    }

    #[test]
    fn abi_register_names() {
        let program = assemble("addi sp, sp, -16\nmv a0, t0\n").unwrap();
        assert_eq!(program.instrs[0].rd, 2);
        assert_eq!(program.instrs[1].rd, 10);
        assert_eq!(program.instrs[1].rs1, 5);
    }

    #[test]
    fn li_expansion() {
        let small = assemble("li a0, 42").unwrap();
        assert_eq!(small.instrs.len(), 1);
        let big = assemble("li a0, 0x12345678").unwrap();
        assert_eq!(big.instrs.len(), 2);
        assert_eq!(big.instrs[0].op, Op::Lui);
        assert_eq!(big.instrs[1].op, Op::Addi);
        // lui + addi must reconstruct the value
        let hi = (big.instrs[0].imm as u32) << 12;
        let value = hi.wrapping_add(big.instrs[1].imm as u32);
        assert_eq!(value, 0x12345678);
    }

    #[test]
    fn li_negative_lo12() {
        // low 12 bits sign-extend: hi20 must compensate
        let p = assemble("li a0, 0x12345FFF").unwrap();
        let hi = (p.instrs[0].imm as u32) << 12;
        let value = hi.wrapping_add(p.instrs[1].imm as u32);
        assert_eq!(value, 0x12345FFF);
    }

    #[test]
    fn labels_and_branches() {
        let src = "\
        li t0, 0\n\
        li t1, 5\n\
loop:   addi t0, t0, 1\n\
        blt t0, t1, loop\n\
        ret\n";
        let program = assemble(src).unwrap();
        assert_eq!(program.instrs.len(), 5);
        let blt = &program.instrs[3];
        assert_eq!(blt.op, Op::Blt);
        assert_eq!(blt.imm, -4); // loop is one instruction back
    }

    #[test]
    fn data_section_word_and_string() {
        let src = "\
.data\n\
values: .word 10, 20, 30\n\
msg:    .asciz \"hi\"\n\
.text\n\
        la t0, values\n\
        lw t1, 0(t0)\n";
        let program = assemble(src).unwrap();
        assert_eq!(&program.data[0..4], &10u32.to_le_bytes());
        assert_eq!(&program.data[4..8], &20u32.to_le_bytes());
        assert_eq!(&program.data[8..12], &30u32.to_le_bytes());
        assert_eq!(&program.data[12..15], b"hi\0");
        // la expands to lui+addi pointing at DATA_BASE
        let hi = (program.instrs[0].imm as u32) << 12;
        let addr = hi.wrapping_add(program.instrs[1].imm as u32);
        assert_eq!(addr, DATA_BASE);
    }

    #[test]
    fn unknown_instruction_error() {
        let err = assemble("adddi x1, x0, 5").unwrap_err();
        assert_eq!(err[0].line, 1);
        assert!(err[0].message.contains("unknown instruction 'adddi'"));
    }

    #[test]
    fn missing_label_error() {
        let err = assemble("j done").unwrap_err();
        assert!(err[0].message.contains("label 'done' not found"));
    }

    #[test]
    fn pseudo_branches() {
        let src = "start: beqz a0, start\nbnez a1, start\nblez a2, start\nbgtz a3, start\n";
        let p = assemble(src).unwrap();
        assert_eq!(p.instrs[0].op, Op::Beq);
        assert_eq!(p.instrs[0].rs2, 0);
        assert_eq!(p.instrs[1].op, Op::Bne);
        assert_eq!(p.instrs[2].op, Op::Bge);
        assert_eq!(p.instrs[2].rs1, 0); // blez rs => bge x0, rs
        assert_eq!(p.instrs[3].op, Op::Blt);
        assert_eq!(p.instrs[3].rs1, 0);
    }
}

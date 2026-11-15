//! Two-pass RV64IM assembler with the common pseudo-instructions.
//!
//! Pass 1 tokenizes, tracks sections (.text / .data), assigns addresses
//! (pseudo-instruction expansion sizes are decided here so label addresses
//! are stable) and collects labels. Pass 2 resolves labels and produces
//! decoded instructions ready for the pipeline.

use serde::Serialize;
use std::collections::HashMap;

pub const TEXT_BASE64: u64 = crate::TEXT_BASE as u64;
pub const DATA_BASE64: u64 = crate::DATA_BASE as u64;

#[derive(Debug, Clone, Serialize)]
pub struct AsmError64 {
    pub line: usize,
    pub message: String,
}

impl AsmError64 {
    fn new(line: usize, message: impl Into<String>) -> Self {
        Self {
            line,
            message: message.into(),
        }
    }
}

/// Every operation the pipeline can execute (RV64I + RV64M).
/// Pseudo-instructions are expanded to these during assembly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Op64 {
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
    Fence, // executed as a nop
}

impl Op64 {
    pub fn is_load(self) -> bool {
        matches!(
            self,
            Op64::Lb | Op64::Lh | Op64::Lw | Op64::Ld | Op64::Lbu | Op64::Lhu | Op64::Lwu
        )
    }

    pub fn is_store(self) -> bool {
        matches!(self, Op64::Sb | Op64::Sh | Op64::Sw | Op64::Sd)
    }

    pub fn is_branch(self) -> bool {
        matches!(
            self,
            Op64::Beq | Op64::Bne | Op64::Blt | Op64::Bge | Op64::Bltu | Op64::Bgeu
        )
    }

    pub fn is_jump(self) -> bool {
        matches!(self, Op64::Jal | Op64::Jalr)
    }

    /// Does this instruction read rs1?
    pub fn uses_rs1(self) -> bool {
        !matches!(
            self,
            Op64::Lui | Op64::Auipc | Op64::Jal | Op64::Ecall | Op64::Ebreak | Op64::Fence
        )
    }

    /// Does this instruction read rs2? (Loads and I-type ALU ops do not.)
    pub fn uses_rs2(self) -> bool {
        self.is_store()
            || self.is_branch()
            || matches!(
                self,
                Op64::Add
                    | Op64::Sub
                    | Op64::Addw
                    | Op64::Subw
                    | Op64::Sll
                    | Op64::Sllw
                    | Op64::Slt
                    | Op64::Sltu
                    | Op64::Xor
                    | Op64::Srl
                    | Op64::Sra
                    | Op64::Srlw
                    | Op64::Sraw
                    | Op64::Or
                    | Op64::And
                    | Op64::Mul
                    | Op64::Mulh
                    | Op64::Mulhsu
                    | Op64::Mulhu
                    | Op64::Div
                    | Op64::Divu
                    | Op64::Rem
                    | Op64::Remu
                    | Op64::Mulw
                    | Op64::Divw
                    | Op64::Divuw
                    | Op64::Remw
                    | Op64::Remuw
            )
    }

    /// Does this instruction write rd?
    pub fn writes_rd(self) -> bool {
        !(self.is_store()
            || self.is_branch()
            || matches!(self, Op64::Ecall | Op64::Ebreak | Op64::Fence))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AsmInstr64 {
    pub op: Op64,
    pub rd: u8,
    pub rs1: u8,
    pub rs2: u8,
    pub imm: i64,
    /// Display text for the pipeline diagram / disassembly.
    pub text: String,
    /// 1-based source line this instruction came from.
    pub line: usize,
    pub addr: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Program64 {
    pub instrs: Vec<AsmInstr64>,
    /// Initial data segment image, loaded at DATA_BASE64.
    pub data: Vec<u8>,
    pub labels: Vec<(String, u64)>,
}

impl Program64 {
    pub fn text_end(&self) -> u64 {
        TEXT_BASE64 + (self.instrs.len() as u64) * 4
    }

    pub fn instr_at(&self, pc: u64) -> Option<&AsmInstr64> {
        if pc % 4 != 0 {
            return None;
        }
        self.instrs.get(((pc - TEXT_BASE64) / 4) as usize)
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

fn parse_int(token: &str) -> Option<i128> {
    let t = token.trim();
    let (neg, body) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let value = if let Some(hex) = body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")) {
        i128::from_str_radix(hex, 16).ok()?
    } else if let Some(bin) = body.strip_prefix("0b").or_else(|| body.strip_prefix("0B")) {
        i128::from_str_radix(bin, 2).ok()?
    } else if body.chars().all(|c| c.is_ascii_digit()) && !body.is_empty() {
        body.parse::<i128>().ok()?
    } else {
        return None;
    };
    Some(if neg { -value } else { value })
}

fn canonical_i64(value: i128) -> Option<i64> {
    if (i64::MIN as i128..=u64::MAX as i128).contains(&value) {
        Some(value as u64 as i64)
    } else {
        None
    }
}

fn li_steps(value: i64) -> Vec<(Op64, i64)> {
    fn append(value: i64, out: &mut Vec<(Op64, i64)>) {
        if (-2048..=2047).contains(&value) {
            out.push((Op64::Addi, value));
            return;
        }
        let lo = (value << 52) >> 52;
        let upper = ((value as i128 - lo as i128) >> 12) as i64;
        append(upper, out);
        out.push((Op64::Slli, 12));
        if lo != 0 {
            out.push((Op64::Addi, lo));
        }
    }

    let mut out = Vec::new();
    append(value, &mut out);
    out
}

/// `%hi(sym)` / `%lo(sym)` pair such that `lui rd,%hi` + `addi rd,rd,%lo`
/// reconstructs the full 32-bit address (the +0x800 compensates for the
/// sign-extension of the low 12 bits).
fn hi20(value: u64) -> u64 {
    value.wrapping_add(0x800) >> 12
}

fn lo12(value: u64) -> i64 {
    ((value & 0xfff) as i64) << 20 >> 20
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

fn parse_string_literal(raw: &str, line: usize) -> Result<Vec<u8>, AsmError64> {
    let t = raw.trim();
    if t.len() < 2 || !t.starts_with('"') || !t.ends_with('"') {
        return Err(AsmError64::new(
            line,
            format!("expected string literal, got '{t}'"),
        ));
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
                    return Err(AsmError64::new(
                        line,
                        format!(
                            "unknown escape '\\{}'",
                            other.map(String::from).unwrap_or_default()
                        ),
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
        "li" => operands
            .get(1)
            .and_then(|s| parse_int(s))
            .and_then(canonical_i64)
            .map(|value| li_steps(value).len())
            .unwrap_or(1),
        "la" => 2, // lui + addi, always
        _ => 1,
    }
}

struct Assembler64<'a> {
    labels: HashMap<String, u64>,
    errors: Vec<AsmError64>,
    lines: &'a [Line],
}

pub fn assemble64(source: &str) -> Result<Program64, Vec<AsmError64>> {
    let mut errors: Vec<AsmError64> = Vec::new();
    let mut labels: HashMap<String, u64> = HashMap::new();
    let mut section = Section::Text;
    let mut text_cursor = TEXT_BASE64;
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
                Section::Data => DATA_BASE64 + data.len() as u64,
            };
            if labels.insert(candidate.to_string(), addr).is_some() {
                errors.push(AsmError64::new(
                    line_no,
                    format!("duplicate label '{candidate}'"),
                ));
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
                                let align = 1usize << n.clamp(0, 12) as u32;
                                while data.len() % align != 0 {
                                    data.push(0);
                                }
                            }
                        }
                    }
                }
                "dword" | "quad" | "word" | "half" | "byte" | "asciz" | "ascii" | "string"
                | "space" | "zero" => {
                    if section != Section::Data {
                        errors.push(AsmError64::new(
                            line_no,
                            format!(".{directive} is only supported in the .data section"),
                        ));
                        continue;
                    }
                    match directive {
                        "dword" | "quad" | "word" | "half" | "byte" => {
                            let size = match directive {
                                "dword" | "quad" => 8,
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
                                // labels for word-sized address directives.
                                let is_label = parse_int(&value_str).is_none();
                                if is_label && !matches!(directive, "word" | "dword" | "quad") {
                                    errors.push(AsmError64::new(
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
                            _ => errors.push(AsmError64::new(
                                line_no,
                                format!("invalid .{directive} size '{tail}'"),
                            )),
                        },
                        _ => unreachable!(),
                    }
                }
                other => {
                    errors.push(AsmError64::new(
                        line_no,
                        format!("unknown directive '.{other}'"),
                    ));
                }
            }
            continue;
        }

        if section != Section::Text {
            errors.push(AsmError64::new(
                line_no,
                format!("instruction '{mnemonic}' outside the .text section"),
            ));
            continue;
        }

        let operands = split_operands(tail);
        text_cursor += 4 * expansion_size(&mnemonic, &operands) as u64;
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
                        let align = 1usize << n.clamp(0, 12) as u32;
                        while cursor % align != 0 {
                            cursor += 1;
                        }
                    }
                }
                ".dword" | ".quad" | ".word" | ".half" | ".byte" if section == Section::Data => {
                    let size = match mnemonic.as_str() {
                        ".dword" | ".quad" => 8,
                        ".word" => 4,
                        ".half" => 2,
                        _ => 1,
                    };
                    while cursor % size != 0 {
                        cursor += 1;
                    }
                    for value_str in split_operands(tail) {
                        let value: i128 = match parse_int(&value_str) {
                            Some(v) => v,
                            None => match labels.get(value_str.trim()) {
                                Some(&addr) => addr as i128,
                                None => {
                                    errors.push(AsmError64::new(
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
    let asm = Assembler64 {
        labels,
        errors,
        lines: &items,
    };
    asm.finish(data)
}

impl<'a> Assembler64<'a> {
    fn finish(mut self, data: Vec<u8>) -> Result<Program64, Vec<AsmError64>> {
        let mut instrs: Vec<AsmInstr64> = Vec::new();
        let lines = self.lines.to_vec();
        for item in &lines {
            let Line::Instr {
                line,
                mnemonic,
                operands,
                source_text,
            } = item;
            let addr = TEXT_BASE64 + (instrs.len() as u64) * 4;
            match self.decode(*line, addr, mnemonic, operands, source_text) {
                Ok(decoded) => instrs.extend(decoded),
                Err(e) => {
                    self.errors.push(e);
                    // keep addresses stable even after an error
                    for _ in 0..expansion_size(mnemonic, operands) {
                        instrs.push(AsmInstr64 {
                            op: Op64::Fence,
                            rd: 0,
                            rs1: 0,
                            rs2: 0,
                            imm: 0,
                            text: source_text.clone(),
                            line: *line,
                            addr: TEXT_BASE64 + (instrs.len() as u64) * 4,
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
            return Err(vec![AsmError64::new(1, "program has no instructions")]);
        }

        let mut labels: Vec<(String, u64)> = self.labels.into_iter().collect();
        labels.sort_by_key(|(_, addr)| *addr);
        Ok(Program64 {
            instrs,
            data,
            labels,
        })
    }

    fn reg(&self, line: usize, token: Option<&String>, what: &str) -> Result<u8, AsmError64> {
        let token =
            token.ok_or_else(|| AsmError64::new(line, format!("missing {what} register")))?;
        parse_reg(token)
            .ok_or_else(|| AsmError64::new(line, format!("invalid register '{}'", token.trim())))
    }

    fn imm(
        &self,
        line: usize,
        token: Option<&String>,
        min: i64,
        max: i64,
        what: &str,
    ) -> Result<i64, AsmError64> {
        let token = token.ok_or_else(|| AsmError64::new(line, format!("missing {what}")))?;
        // %hi(sym) / %lo(sym)
        if let Some(inner) = token.strip_prefix("%hi(").and_then(|s| s.strip_suffix(')')) {
            let addr = self.label_addr(line, inner.trim())?;
            return Ok(hi20(addr) as i64);
        }
        if let Some(inner) = token.strip_prefix("%lo(").and_then(|s| s.strip_suffix(')')) {
            let addr = self.label_addr(line, inner.trim())?;
            return Ok(lo12(addr));
        }
        let value = parse_int(token).ok_or_else(|| {
            AsmError64::new(line, format!("invalid immediate '{}'", token.trim()))
        })?;
        if value < min as i128 || value > max as i128 {
            return Err(AsmError64::new(
                line,
                format!("{what} {value} out of range [{min}, {max}]"),
            ));
        }
        Ok(value as i64)
    }

    fn label_addr(&self, line: usize, name: &str) -> Result<u64, AsmError64> {
        self.labels
            .get(name)
            .copied()
            .ok_or_else(|| AsmError64::new(line, format!("label '{name}' not found")))
    }

    /// Branch/jump target: a label or a numeric absolute address.
    fn target(&self, line: usize, token: Option<&String>, what: &str) -> Result<u64, AsmError64> {
        let token = token.ok_or_else(|| AsmError64::new(line, format!("missing {what}")))?;
        if let Some(v) = parse_int(token) {
            if v >= 0 && v <= u64::MAX as i128 {
                return Ok(v as u64);
            }
            return Err(AsmError64::new(
                line,
                format!("invalid target address '{token}'"),
            ));
        }
        self.label_addr(line, token.trim())
    }

    /// Parse `offset(reg)` / `(reg)` / `label` memory operands.
    fn mem_operand(&self, line: usize, token: Option<&String>) -> Result<(u8, i64), AsmError64> {
        let token =
            token.ok_or_else(|| AsmError64::new(line, "missing memory operand".to_string()))?;
        let t = token.trim();
        if let Some(open) = t.find('(') {
            let close = t
                .rfind(')')
                .ok_or_else(|| AsmError64::new(line, format!("missing ')' in '{t}'")))?;
            let reg = parse_reg(&t[open + 1..close])
                .ok_or_else(|| AsmError64::new(line, format!("invalid register in '{t}'")))?;
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
                    .ok_or_else(|| AsmError64::new(line, format!("invalid offset '{off_str}'")))?;
                if !(-2048..=2047).contains(&v) {
                    return Err(AsmError64::new(
                        line,
                        format!("offset {v} out of range [-2048, 2047]"),
                    ));
                }
                v as i64
            };
            return Ok((reg, off));
        }
        Err(AsmError64::new(
            line,
            format!("expected 'offset(register)' memory operand, got '{t}'"),
        ))
    }

    fn branch_offset(&self, line: usize, addr: u64, target: u64) -> Result<i64, AsmError64> {
        let offset = target.wrapping_sub(addr) as i64;
        if offset % 2 != 0 {
            return Err(AsmError64::new(line, "branch target is misaligned"));
        }
        if !(-4096..=4094).contains(&offset) {
            return Err(AsmError64::new(
                line,
                format!("branch target out of range (offset {offset})"),
            ));
        }
        Ok(offset)
    }

    fn jump_offset(&self, line: usize, addr: u64, target: u64) -> Result<i64, AsmError64> {
        let offset = target.wrapping_sub(addr) as i64;
        if offset % 2 != 0 {
            return Err(AsmError64::new(line, "jump target is misaligned"));
        }
        if !(-(1 << 20)..(1 << 20)).contains(&offset) {
            return Err(AsmError64::new(
                line,
                format!("jump target out of range (offset {offset})"),
            ));
        }
        Ok(offset)
    }

    fn decode(
        &self,
        line: usize,
        addr: u64,
        mnemonic: &str,
        ops: &[String],
        source_text: &str,
    ) -> Result<Vec<AsmInstr64>, AsmError64> {
        let mk =
            |op: Op64, rd: u8, rs1: u8, rs2: u8, imm: i64, text: String, addr: u64| AsmInstr64 {
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
        let expect = |n: usize| -> Result<(), AsmError64> {
            if ops.len() != n {
                Err(AsmError64::new(
                    line,
                    format!("'{mnemonic}' expects {n} operand(s), got {}", ops.len()),
                ))
            } else {
                Ok(())
            }
        };

        let r_type = |op: Op64| -> Result<Vec<AsmInstr64>, AsmError64> {
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
        let i_type = |op: Op64| -> Result<Vec<AsmInstr64>, AsmError64> {
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
        let shift = |op: Op64| -> Result<Vec<AsmInstr64>, AsmError64> {
            expect(3)?;
            Ok(vec![mk(
                op,
                self.reg(line, ops.first(), "destination")?,
                self.reg(line, ops.get(1), "source")?,
                0,
                self.imm(line, ops.get(2), 0, 63, "shift amount")?,
                text.clone(),
                addr,
            )])
        };
        let shift_word = |op: Op64| -> Result<Vec<AsmInstr64>, AsmError64> {
            expect(3)?;
            Ok(vec![mk(
                op,
                self.reg(line, ops.first(), "destination")?,
                self.reg(line, ops.get(1), "source")?,
                0,
                self.imm(line, ops.get(2), 0, 31, "word shift amount")?,
                text.clone(),
                addr,
            )])
        };
        let load = |op: Op64| -> Result<Vec<AsmInstr64>, AsmError64> {
            expect(2)?;
            let rd = self.reg(line, ops.first(), "destination")?;
            let (rs1, imm) = self.mem_operand(line, ops.get(1))?;
            Ok(vec![mk(op, rd, rs1, 0, imm, text.clone(), addr)])
        };
        let store = |op: Op64| -> Result<Vec<AsmInstr64>, AsmError64> {
            expect(2)?;
            let rs2 = self.reg(line, ops.first(), "source")?;
            let (rs1, imm) = self.mem_operand(line, ops.get(1))?;
            Ok(vec![mk(op, 0, rs1, rs2, imm, text.clone(), addr)])
        };
        let branch = |op: Op64, swap: bool| -> Result<Vec<AsmInstr64>, AsmError64> {
            expect(3)?;
            let a = self.reg(line, ops.first(), "source")?;
            let b = self.reg(line, ops.get(1), "source")?;
            let (rs1, rs2) = if swap { (b, a) } else { (a, b) };
            let target = self.target(line, ops.get(2), "branch target")?;
            let imm = self.branch_offset(line, addr, target)?;
            Ok(vec![mk(op, 0, rs1, rs2, imm, text.clone(), addr)])
        };
        let branch_zero = |op: Op64, reg_first: bool| -> Result<Vec<AsmInstr64>, AsmError64> {
            expect(2)?;
            let r = self.reg(line, ops.first(), "source")?;
            let (rs1, rs2) = if reg_first { (r, 0) } else { (0, r) };
            let target = self.target(line, ops.get(1), "branch target")?;
            let imm = self.branch_offset(line, addr, target)?;
            Ok(vec![mk(op, 0, rs1, rs2, imm, text.clone(), addr)])
        };

        match mnemonic {
            // ---- RV64I ----
            "add" => r_type(Op64::Add),
            "sub" => r_type(Op64::Sub),
            "addw" => r_type(Op64::Addw),
            "subw" => r_type(Op64::Subw),
            "sll" => r_type(Op64::Sll),
            "sllw" => r_type(Op64::Sllw),
            "slt" => r_type(Op64::Slt),
            "sltu" => r_type(Op64::Sltu),
            "xor" => r_type(Op64::Xor),
            "srl" => r_type(Op64::Srl),
            "sra" => r_type(Op64::Sra),
            "srlw" => r_type(Op64::Srlw),
            "sraw" => r_type(Op64::Sraw),
            "or" => r_type(Op64::Or),
            "and" => r_type(Op64::And),
            "mul" => r_type(Op64::Mul),
            "mulh" => r_type(Op64::Mulh),
            "mulhsu" => r_type(Op64::Mulhsu),
            "mulhu" => r_type(Op64::Mulhu),
            "div" => r_type(Op64::Div),
            "divu" => r_type(Op64::Divu),
            "rem" => r_type(Op64::Rem),
            "remu" => r_type(Op64::Remu),
            "mulw" => r_type(Op64::Mulw),
            "divw" => r_type(Op64::Divw),
            "divuw" => r_type(Op64::Divuw),
            "remw" => r_type(Op64::Remw),
            "remuw" => r_type(Op64::Remuw),
            "addi" => i_type(Op64::Addi),
            "addiw" => i_type(Op64::Addiw),
            "slti" => i_type(Op64::Slti),
            "sltiu" => i_type(Op64::Sltiu),
            "xori" => i_type(Op64::Xori),
            "ori" => i_type(Op64::Ori),
            "andi" => i_type(Op64::Andi),
            "slli" => shift(Op64::Slli),
            "srli" => shift(Op64::Srli),
            "srai" => shift(Op64::Srai),
            "slliw" => shift_word(Op64::Slliw),
            "srliw" => shift_word(Op64::Srliw),
            "sraiw" => shift_word(Op64::Sraiw),
            "lb" => load(Op64::Lb),
            "lh" => load(Op64::Lh),
            "lw" => load(Op64::Lw),
            "ld" => load(Op64::Ld),
            "lwu" => load(Op64::Lwu),
            "lbu" => load(Op64::Lbu),
            "lhu" => load(Op64::Lhu),
            "sb" => store(Op64::Sb),
            "sh" => store(Op64::Sh),
            "sw" => store(Op64::Sw),
            "sd" => store(Op64::Sd),
            "beq" => branch(Op64::Beq, false),
            "bne" => branch(Op64::Bne, false),
            "blt" => branch(Op64::Blt, false),
            "bge" => branch(Op64::Bge, false),
            "bltu" => branch(Op64::Bltu, false),
            "bgeu" => branch(Op64::Bgeu, false),
            // bgt/ble/bgtu/bleu are pseudo forms with swapped operands
            "bgt" => branch(Op64::Blt, true),
            "ble" => branch(Op64::Bge, true),
            "bgtu" => branch(Op64::Bltu, true),
            "bleu" => branch(Op64::Bgeu, true),
            "lui" => {
                expect(2)?;
                Ok(vec![mk(
                    Op64::Lui,
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
                    Op64::Auipc,
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
                    _ => return Err(AsmError64::new(line, "'jal' expects 1 or 2 operands")),
                };
                let target = self.target(line, target_tok, "jump target")?;
                let imm = self.jump_offset(line, addr, target)?;
                Ok(vec![mk(Op64::Jal, rd, 0, 0, imm, text, addr)])
            }
            "jalr" => {
                // jalr rs | jalr rd, offset(rs1) | jalr rd, rs1, offset
                match ops.len() {
                    1 => Ok(vec![mk(
                        Op64::Jalr,
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
                        Ok(vec![mk(Op64::Jalr, rd, rs1, 0, imm, text, addr)])
                    }
                    3 => Ok(vec![mk(
                        Op64::Jalr,
                        self.reg(line, ops.first(), "destination")?,
                        self.reg(line, ops.get(1), "source")?,
                        0,
                        self.imm(line, ops.get(2), -2048, 2047, "offset")?,
                        text,
                        addr,
                    )]),
                    _ => Err(AsmError64::new(line, "'jalr' expects 1-3 operands")),
                }
            }
            "ecall" => {
                expect(0)?;
                Ok(vec![mk(Op64::Ecall, 0, 0, 0, 0, text, addr)])
            }
            "ebreak" => {
                expect(0)?;
                Ok(vec![mk(Op64::Ebreak, 0, 0, 0, 0, text, addr)])
            }
            "fence" | "fence.i" => Ok(vec![mk(Op64::Fence, 0, 0, 0, 0, text, addr)]),

            // ---- Pseudo-instructions ----
            "nop" => {
                expect(0)?;
                Ok(vec![mk(Op64::Addi, 0, 0, 0, 0, text, addr)])
            }
            "mv" => {
                expect(2)?;
                Ok(vec![mk(
                    Op64::Addi,
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
                let parsed =
                    parse_int(ops.get(1).map(String::as_str).unwrap_or("")).ok_or_else(|| {
                        AsmError64::new(line, format!("invalid immediate '{}'", ops[1].trim()))
                    })?;
                let value = canonical_i64(parsed).ok_or_else(|| {
                    AsmError64::new(line, format!("immediate {parsed} does not fit in 64 bits"))
                })?;
                let steps = li_steps(value);
                Ok(steps
                    .into_iter()
                    .enumerate()
                    .map(|(index, (op, imm))| {
                        let (rs1, rendered) = if op == Op64::Slli {
                            (rd, format!("slli {0}, {0}, {imm}", abi_name(rd)))
                        } else if index == 0 {
                            (0, format!("addi {}, zero, {imm}", abi_name(rd)))
                        } else {
                            (rd, format!("addi {0}, {0}, {imm}", abi_name(rd)))
                        };
                        mk(op, rd, rs1, 0, imm, rendered, addr + index as u64 * 4)
                    })
                    .collect())
            }
            "la" => {
                expect(2)?;
                let rd = self.reg(line, ops.first(), "destination")?;
                let target =
                    self.label_addr(line, ops.get(1).map(String::as_str).unwrap_or("").trim())?;
                let hi = hi20(target);
                let lo = lo12(target);
                Ok(vec![
                    mk(
                        Op64::Lui,
                        rd,
                        0,
                        0,
                        hi as i64,
                        format!("lui {}, 0x{:x}", abi_name(rd), hi),
                        addr,
                    ),
                    mk(
                        Op64::Addi,
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
                    Op64::Xori,
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
                    Op64::Sub,
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
                    Op64::Sltiu,
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
                    Op64::Sltu,
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
                    Op64::Slt,
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
                    Op64::Slt,
                    self.reg(line, ops.first(), "destination")?,
                    0,
                    self.reg(line, ops.get(1), "source")?,
                    0,
                    text,
                    addr,
                )])
            }
            "beqz" => branch_zero(Op64::Beq, true),
            "bnez" => branch_zero(Op64::Bne, true),
            "bltz" => branch_zero(Op64::Blt, true),
            "bgez" => branch_zero(Op64::Bge, true),
            "blez" => branch_zero(Op64::Bge, false), // rs <= 0  <=>  0 >= rs
            "bgtz" => branch_zero(Op64::Blt, false), // rs > 0   <=>  0 < rs
            "j" => {
                expect(1)?;
                let target = self.target(line, ops.first(), "jump target")?;
                let imm = self.jump_offset(line, addr, target)?;
                Ok(vec![mk(Op64::Jal, 0, 0, 0, imm, text, addr)])
            }
            "jr" => {
                expect(1)?;
                Ok(vec![mk(
                    Op64::Jalr,
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
                Ok(vec![mk(Op64::Jalr, 0, 1, 0, 0, text, addr)])
            }
            "call" => {
                expect(1)?;
                let target = self.target(line, ops.first(), "call target")?;
                let imm = self.jump_offset(line, addr, target)?;
                Ok(vec![mk(Op64::Jal, 1, 0, 0, imm, text, addr)])
            }
            "tail" => {
                expect(1)?;
                let target = self.target(line, ops.first(), "jump target")?;
                let imm = self.jump_offset(line, addr, target)?;
                Ok(vec![mk(Op64::Jal, 0, 0, 0, imm, text, addr)])
            }
            other => Err(AsmError64::new(
                line,
                format!("unknown instruction '{other}'"),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline64::Pipeline64;

    fn run_li(literal: &str) -> u64 {
        let program = assemble64(&format!("li a0, {literal}\necall\n")).unwrap();
        let mut pipeline = Pipeline64::new(program);
        assert!(pipeline.run(1_000));
        pipeline.registers()[10]
    }

    #[test]
    fn assembles_basic_program() {
        let program = assemble64("addi x1, x0, 5\naddi x2, x1, 3\nadd x3, x2, x1\n").unwrap();
        assert_eq!(program.instrs.len(), 3);
        assert_eq!(program.instrs[0].op, Op64::Addi);
        assert_eq!(program.instrs[0].rd, 1);
        assert_eq!(program.instrs[0].imm, 5);
        assert_eq!(program.instrs[2].op, Op64::Add);
        assert_eq!(program.instrs[2].rs1, 2);
        assert_eq!(program.instrs[2].rs2, 1);
    }

    #[test]
    fn abi_register_names() {
        let program = assemble64("addi sp, sp, -16\nmv a0, t0\n").unwrap();
        assert_eq!(program.instrs[0].rd, 2);
        assert_eq!(program.instrs[1].rd, 10);
        assert_eq!(program.instrs[1].rs1, 5);
    }

    #[test]
    fn li_expansion() {
        let small = assemble64("li a0, 42").unwrap();
        assert_eq!(small.instrs.len(), 1);
        let big = assemble64("li a0, 0x12345678").unwrap();
        assert!(big.instrs.len() > 1);
        assert_eq!(run_li("0x12345678"), 0x1234_5678);
    }

    #[test]
    fn li_negative_lo12() {
        assert_eq!(run_li("0x12345FFF"), 0x1234_5fff);
    }

    #[test]
    fn li_supports_full_64_bit_values() {
        assert_eq!(run_li("0x123456789abcdef0"), 0x1234_5678_9abc_def0);
        assert_eq!(run_li("0xffffffffffffffff"), u64::MAX);
        assert_eq!(run_li("-9223372036854775808"), i64::MIN as u64);
    }

    #[test]
    fn li_handles_signed_chunk_boundaries() {
        for value in [
            -2049i64,
            -2048,
            2047,
            2048,
            0x7ff_fffff,
            0x800_0000,
            0x7fff_ffff_ffff_ffff,
            i64::MIN,
        ] {
            assert_eq!(
                run_li(&value.to_string()),
                value as u64,
                "failed to materialize {value}"
            );
        }
    }

    #[test]
    fn rv64_specific_instructions_decode() {
        let p = assemble64(
            "ld x1, 0(x2)\nlwu x3, 4(x2)\nsd x1, 8(x2)\naddiw x4, x3, 1\n\
             slliw x5, x4, 31\naddw x6, x4, x5\nmulw x7, x6, x4\n",
        )
        .unwrap();
        let ops: Vec<_> = p.instrs.iter().map(|i| i.op).collect();
        assert_eq!(
            ops,
            vec![
                Op64::Ld,
                Op64::Lwu,
                Op64::Sd,
                Op64::Addiw,
                Op64::Slliw,
                Op64::Addw,
                Op64::Mulw,
            ]
        );
    }

    #[test]
    fn rv64_shift_immediate_accepts_63_but_word_shift_stops_at_31() {
        assert!(assemble64("slli x1, x2, 63").is_ok());
        assert!(assemble64("slli x1, x2, 64").is_err());
        assert!(assemble64("slliw x1, x2, 31").is_ok());
        assert!(assemble64("slliw x1, x2, 32").is_err());
    }

    #[test]
    fn labels_and_branches() {
        let src = "\
        li t0, 0\n\
        li t1, 5\n\
loop:   addi t0, t0, 1\n\
        blt t0, t1, loop\n\
        ret\n";
        let program = assemble64(src).unwrap();
        assert_eq!(program.instrs.len(), 5);
        let blt = &program.instrs[3];
        assert_eq!(blt.op, Op64::Blt);
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
        let program = assemble64(src).unwrap();
        assert_eq!(&program.data[0..4], &10u32.to_le_bytes());
        assert_eq!(&program.data[4..8], &20u32.to_le_bytes());
        assert_eq!(&program.data[8..12], &30u32.to_le_bytes());
        assert_eq!(&program.data[12..15], b"hi\0");
        // la expands to lui+addi pointing at DATA_BASE64
        let hi = (program.instrs[0].imm as u64) << 12;
        let addr = hi.wrapping_add(program.instrs[1].imm as u64);
        assert_eq!(addr, DATA_BASE64);
    }

    #[test]
    fn data_section_dword_and_quad() {
        let p =
            assemble64(".data\na: .dword 0x123456789abcdef0\nb: .quad -1\n.text\nld a0, 0(x0)\n")
                .unwrap();
        assert_eq!(&p.data[0..8], &0x1234_5678_9abc_def0u64.to_le_bytes());
        assert_eq!(&p.data[8..16], &u64::MAX.to_le_bytes());
    }

    #[test]
    fn unknown_instruction_error() {
        let err = assemble64("adddi x1, x0, 5").unwrap_err();
        assert_eq!(err[0].line, 1);
        assert!(err[0].message.contains("unknown instruction 'adddi'"));
    }

    #[test]
    fn missing_label_error() {
        let err = assemble64("j done").unwrap_err();
        assert!(err[0].message.contains("label 'done' not found"));
    }

    #[test]
    fn pseudo_branches() {
        let src = "start: beqz a0, start\nbnez a1, start\nblez a2, start\nbgtz a3, start\n";
        let p = assemble64(src).unwrap();
        assert_eq!(p.instrs[0].op, Op64::Beq);
        assert_eq!(p.instrs[0].rs2, 0);
        assert_eq!(p.instrs[1].op, Op64::Bne);
        assert_eq!(p.instrs[2].op, Op64::Bge);
        assert_eq!(p.instrs[2].rs1, 0); // blez rs => bge x0, rs
        assert_eq!(p.instrs[3].op, Op64::Blt);
        assert_eq!(p.instrs[3].rs1, 0);
    }
}

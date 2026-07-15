//! Assembly conversion between the RV32IM and RV64IM execution modes.
//!
//! Widening preserves RV32 register values as sign-extended 64-bit values.
//! Narrowing intentionally accepts only a statically recognizable 32-bit-safe
//! RV64 dialect. Both directions validate the source and generated assembly
//! with the real assemblers before returning output.

use crate::assembler::{assemble, Op, Program};
use crate::assembler64::{assemble64, Op64, Program64};
use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XlenConvertError {
    /// 1-based source line, or 0 for an internal target-validation failure.
    pub line: usize,
    pub message: String,
}

impl XlenConvertError {
    fn new(line: usize, message: impl Into<String>) -> Self {
        Self {
            line,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for XlenConvertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.line == 0 {
            f.write_str(&self.message)
        } else {
            write!(f, "line {}: {}", self.line, self.message)
        }
    }
}

impl std::error::Error for XlenConvertError {}

#[derive(Debug)]
struct SourceLine {
    line: usize,
    labels: Vec<String>,
    mnemonic: Option<String>,
    operands: Vec<String>,
    statement: String,
}

fn strip_comment(line: &str) -> &str {
    let mut in_string = false;
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let ch = bytes[index] as char;
        if in_string {
            if ch == '\\' {
                index += 1;
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
        } else if ch == '#'
            || (ch == '/' && index + 1 < bytes.len() && bytes[index + 1] as char == '/')
        {
            return &line[..index];
        }
        index += 1;
    }
    line
}

fn valid_label(candidate: &str) -> bool {
    !candidate.is_empty()
        && !candidate
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_digit())
        && candidate
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '$'))
}

fn split_operands(rest: &str) -> Vec<String> {
    rest.split(',')
        .map(str::trim)
        .filter(|operand| !operand.is_empty())
        .map(str::to_string)
        .collect()
}

fn parse_source(source: &str) -> Vec<SourceLine> {
    source
        .lines()
        .enumerate()
        .filter_map(|(index, raw)| {
            let mut rest = strip_comment(raw).trim();
            let mut labels = Vec::new();
            while let Some(colon) = rest.find(':') {
                let candidate = rest[..colon].trim();
                if !valid_label(candidate) {
                    break;
                }
                labels.push(candidate.to_string());
                rest = rest[colon + 1..].trim();
            }

            if rest.is_empty() {
                return (!labels.is_empty()).then_some(SourceLine {
                    line: index + 1,
                    labels,
                    mnemonic: None,
                    operands: Vec::new(),
                    statement: String::new(),
                });
            }

            let (head, tail) = match rest.find(|ch: char| ch.is_whitespace()) {
                Some(position) => (&rest[..position], rest[position..].trim()),
                None => (rest, ""),
            };
            Some(SourceLine {
                line: index + 1,
                labels,
                mnemonic: Some(head.to_ascii_lowercase()),
                operands: split_operands(tail),
                statement: rest.to_string(),
            })
        })
        .collect()
}

fn parse_integer(token: &str) -> Option<i128> {
    let token = token.trim();
    let (negative, body) = match token.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, token.strip_prefix('+').unwrap_or(token)),
    };
    let value = if let Some(hex) = body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")) {
        i128::from_str_radix(hex, 16).ok()?
    } else if let Some(binary) = body.strip_prefix("0b").or_else(|| body.strip_prefix("0B")) {
        i128::from_str_radix(binary, 2).ok()?
    } else if !body.is_empty() && body.chars().all(|ch| ch.is_ascii_digit()) {
        body.parse::<i128>().ok()?
    } else {
        return None;
    };
    Some(if negative { -value } else { value })
}

fn operand<'a>(line: &'a SourceLine, index: usize) -> Result<&'a str, XlenConvertError> {
    line.operands
        .get(index)
        .map(String::as_str)
        .ok_or_else(|| XlenConvertError::new(line.line, "missing instruction operand"))
}

fn render_instruction(mnemonic: &str, operands: &[String]) -> String {
    if operands.is_empty() {
        mnemonic.to_string()
    } else {
        format!("{mnemonic} {}", operands.join(", "))
    }
}

fn emit_labels(output: &mut String, labels: &[String]) {
    for label in labels {
        let _ = writeln!(output, "{label}:");
    }
}

fn branch_target<'a>(mnemonic: &str, operands: &'a [String]) -> Option<&'a str> {
    match mnemonic {
        "beq" | "bne" | "blt" | "bge" | "bltu" | "bgeu" | "bgt" | "ble" | "bgtu" | "bleu" => {
            operands.get(2).map(String::as_str)
        }
        "beqz" | "bnez" | "bltz" | "bgez" | "blez" | "bgtz" => operands.get(1).map(String::as_str),
        "jal" => operands.last().map(String::as_str),
        "j" | "call" | "tail" => operands.first().map(String::as_str),
        _ => None,
    }
}

fn reject_numeric_control_target(line: &SourceLine) -> Result<(), XlenConvertError> {
    let Some(mnemonic) = line.mnemonic.as_deref() else {
        return Ok(());
    };
    if let Some(target) = branch_target(mnemonic, &line.operands) {
        if parse_integer(target).is_some() {
            return Err(XlenConvertError::new(
                line.line,
                "numeric branch and jump targets are not conversion-safe; use a label",
            ));
        }
    }
    Ok(())
}

fn first_source_error32(errors: Vec<crate::assembler::AsmError>) -> XlenConvertError {
    let error = &errors[0];
    XlenConvertError::new(
        error.line,
        format!("RV32 assembly error: {}", error.message),
    )
}

fn first_source_error64(errors: Vec<crate::assembler64::AsmError64>) -> XlenConvertError {
    let error = &errors[0];
    XlenConvertError::new(
        error.line,
        format!("RV64 assembly error: {}", error.message),
    )
}

fn validate_generated64(output: String) -> Result<String, XlenConvertError> {
    assemble64(&output).map_err(|errors| {
        let error = &errors[0];
        XlenConvertError::new(
            0,
            format!(
                "generated RV64 assembly failed validation at output line {}: {}",
                error.line, error.message
            ),
        )
    })?;
    Ok(output)
}

fn validate_generated32(output: String) -> Result<String, XlenConvertError> {
    assemble(&output).map_err(|errors| {
        let error = &errors[0];
        XlenConvertError::new(
            0,
            format!(
                "generated RV32 assembly failed validation at output line {}: {}",
                error.line, error.message
            ),
        )
    })?;
    Ok(output)
}

fn unused_scratch(program: &Program) -> Option<u8> {
    let mut used = [false; 32];
    used[0] = true;
    used[1] = true;
    used[2] = true;
    for instruction in &program.instrs {
        used[instruction.rd as usize] = true;
        used[instruction.rs1 as usize] = true;
        used[instruction.rs2 as usize] = true;
    }
    (3u8..32).rev().find(|register| !used[*register as usize])
}

fn requires_widen_scratch(program: &Program) -> Option<usize> {
    program
        .instrs
        .iter()
        .find(|instruction| instruction.rd != 0 && matches!(instruction.op, Op::Mulhsu | Op::Mulhu))
        .map(|instruction| instruction.line)
}

fn canonical_rv32_literal(line: &SourceLine) -> Result<String, XlenConvertError> {
    let value = parse_integer(operand(line, 1)?).ok_or_else(|| {
        XlenConvertError::new(
            line.line,
            "li requires a numeric literal for XLEN conversion",
        )
    })?;
    if !(i32::MIN as i128..=u32::MAX as i128).contains(&value) {
        return Err(XlenConvertError::new(
            line.line,
            format!("RV32 li value {value} is outside the 32-bit bit-pattern range"),
        ));
    }
    Ok((value as u32 as i32).to_string())
}

fn rv32_auipc_value(program: &Program, line: usize) -> Result<(u8, i32), XlenConvertError> {
    let instruction = program
        .instrs
        .iter()
        .find(|instruction| instruction.line == line && instruction.op == Op::Auipc)
        .ok_or_else(|| XlenConvertError::new(line, "could not resolve auipc during conversion"))?;
    let value = instruction
        .addr
        .wrapping_add((instruction.imm as u32) << 12);
    Ok((instruction.rd, value as i32))
}

fn rv64_auipc_value(program: &Program64, line: usize) -> Result<(u8, i32), XlenConvertError> {
    let instruction = program
        .instrs
        .iter()
        .find(|instruction| instruction.line == line && instruction.op == Op64::Auipc)
        .ok_or_else(|| XlenConvertError::new(line, "could not resolve auipc during conversion"))?;
    let offset = ((instruction.imm as u64) << 12) as u32 as i32 as i64 as u64;
    let value = instruction.addr.wrapping_add(offset);
    Ok((instruction.rd, value as u32 as i32))
}

/// Convert RV32IM source into RV64IM while retaining RV32 wraparound and
/// signed-register behavior.
pub fn rv32_to_rv64(source: &str) -> Result<String, XlenConvertError> {
    let program = assemble(source).map_err(first_source_error32)?;
    let scratch_line = requires_widen_scratch(&program);
    let scratch = if let Some(line) = scratch_line {
        Some(unused_scratch(&program).ok_or_else(|| {
            XlenConvertError::new(
                line,
                "mulhsu/mulhu conversion needs one register unused by the source program",
            )
        })?)
    } else {
        None
    };

    let mut output = String::from(
        "# Converted by StudyRISCV: RV32IM to RV64IM\n\
         # RV64 word operations preserve RV32 wraparound and signed values.\n",
    );
    for line in parse_source(source) {
        reject_numeric_control_target(&line)?;
        emit_labels(&mut output, &line.labels);
        let Some(mnemonic) = line.mnemonic.as_deref() else {
            continue;
        };
        if mnemonic.starts_with('.') {
            let _ = writeln!(output, "{}", line.statement);
            continue;
        }

        let emit = |output: &mut String, op: &str, operands: &[String]| {
            let _ = writeln!(output, "{}", render_instruction(op, operands));
        };
        match mnemonic {
            "add" => emit(&mut output, "addw", &line.operands),
            "sub" => emit(&mut output, "subw", &line.operands),
            "sll" => emit(&mut output, "sllw", &line.operands),
            "srl" => emit(&mut output, "srlw", &line.operands),
            "sra" => emit(&mut output, "sraw", &line.operands),
            "mul" => emit(&mut output, "mulw", &line.operands),
            "div" => emit(&mut output, "divw", &line.operands),
            "divu" => emit(&mut output, "divuw", &line.operands),
            "rem" => emit(&mut output, "remw", &line.operands),
            "remu" => emit(&mut output, "remuw", &line.operands),
            "addi" => emit(&mut output, "addiw", &line.operands),
            "slli" => emit(&mut output, "slliw", &line.operands),
            "srli" => emit(&mut output, "srliw", &line.operands),
            "srai" => emit(&mut output, "sraiw", &line.operands),
            "and" | "or" | "xor" | "andi" | "ori" | "xori" => {
                emit(&mut output, mnemonic, &line.operands);
                let rd = operand(&line, 0)?;
                let extension = vec![rd.to_string(), rd.to_string(), "0".to_string()];
                emit(&mut output, "addiw", &extension);
            }
            "mulh" => {
                emit(&mut output, "mul", &line.operands);
                let rd = operand(&line, 0)?;
                let shift = vec![rd.to_string(), rd.to_string(), "32".to_string()];
                emit(&mut output, "srai", &shift);
            }
            "mulhsu" => {
                let rd = operand(&line, 0)?;
                if rd == "x0" || rd == "zero" {
                    emit(&mut output, "mul", &line.operands);
                    continue;
                }
                let rs1 = operand(&line, 1)?;
                let rs2 = operand(&line, 2)?;
                let temp = format!("x{}", scratch.expect("scratch established"));
                emit(
                    &mut output,
                    "slli",
                    &[temp.clone(), rs2.to_string(), "32".to_string()],
                );
                emit(
                    &mut output,
                    "srli",
                    &[temp.clone(), temp.clone(), "32".to_string()],
                );
                emit(
                    &mut output,
                    "mul",
                    &[rd.to_string(), rs1.to_string(), temp.clone()],
                );
                emit(
                    &mut output,
                    "srai",
                    &[rd.to_string(), rd.to_string(), "32".to_string()],
                );
                emit(
                    &mut output,
                    "addiw",
                    &[temp.clone(), "x0".to_string(), "0".to_string()],
                );
            }
            "mulhu" => {
                let rd = operand(&line, 0)?;
                if rd == "x0" || rd == "zero" {
                    emit(&mut output, "mul", &line.operands);
                    continue;
                }
                let rs1 = operand(&line, 1)?;
                let rs2 = operand(&line, 2)?;
                let temp = format!("x{}", scratch.expect("scratch established"));
                emit(
                    &mut output,
                    "slli",
                    &[temp.clone(), rs1.to_string(), "32".to_string()],
                );
                emit(
                    &mut output,
                    "srli",
                    &[temp.clone(), temp.clone(), "32".to_string()],
                );
                emit(
                    &mut output,
                    "slli",
                    &[rd.to_string(), rs2.to_string(), "32".to_string()],
                );
                emit(
                    &mut output,
                    "srli",
                    &[rd.to_string(), rd.to_string(), "32".to_string()],
                );
                emit(
                    &mut output,
                    "mul",
                    &[rd.to_string(), temp.clone(), rd.to_string()],
                );
                emit(
                    &mut output,
                    "srli",
                    &[rd.to_string(), rd.to_string(), "32".to_string()],
                );
                emit(
                    &mut output,
                    "addiw",
                    &[rd.to_string(), rd.to_string(), "0".to_string()],
                );
                emit(
                    &mut output,
                    "addiw",
                    &[temp.clone(), "x0".to_string(), "0".to_string()],
                );
            }
            "li" => {
                let converted = vec![
                    operand(&line, 0)?.to_string(),
                    canonical_rv32_literal(&line)?,
                ];
                emit(&mut output, "li", &converted);
            }
            "neg" => {
                let converted = vec![
                    operand(&line, 0)?.to_string(),
                    "x0".to_string(),
                    operand(&line, 1)?.to_string(),
                ];
                emit(&mut output, "subw", &converted);
            }
            "auipc" => {
                let (rd, value) = rv32_auipc_value(&program, line.line)?;
                emit(&mut output, "li", &[format!("x{rd}"), value.to_string()]);
            }
            "lui" | "jal" | "jalr" | "beq" | "bne" | "blt" | "bge" | "bltu" | "bgeu" | "lb"
            | "lh" | "lw" | "lbu" | "lhu" | "sb" | "sh" | "sw" | "slti" | "sltiu" | "slt"
            | "sltu" | "ecall" | "ebreak" | "fence" | "fence.i" | "nop" | "mv" | "la" | "not"
            | "seqz" | "snez" | "sltz" | "sgtz" | "bgt" | "ble" | "bgtu" | "bleu" | "beqz"
            | "bnez" | "bltz" | "bgez" | "blez" | "bgtz" | "j" | "jr" | "ret" | "call" | "tail" => {
                emit(&mut output, mnemonic, &line.operands)
            }
            _ => {
                return Err(XlenConvertError::new(
                    line.line,
                    format!("'{mnemonic}' is not supported by RV32 to RV64 conversion"),
                ))
            }
        }
    }
    validate_generated64(output)
}

fn narrow_rejection(line: &SourceLine, reason: &str) -> XlenConvertError {
    XlenConvertError::new(
        line.line,
        format!(
            "{} cannot be narrowed safely: {reason}",
            line.mnemonic.as_deref().unwrap_or("instruction")
        ),
    )
}

fn narrow_li_literal(line: &SourceLine) -> Result<String, XlenConvertError> {
    let value = parse_integer(operand(line, 1)?).ok_or_else(|| {
        XlenConvertError::new(
            line.line,
            "li requires a numeric literal for XLEN conversion",
        )
    })?;
    if !(i64::MIN as i128..=u64::MAX as i128).contains(&value) {
        return Err(XlenConvertError::new(
            line.line,
            format!("li value {value} does not fit an RV64 register"),
        ));
    }
    let canonical = value as u64 as i64;
    if !(i32::MIN as i64..=i32::MAX as i64).contains(&canonical) {
        return Err(XlenConvertError::new(
            line.line,
            format!(
                "li value {value} is not a sign-extended 32-bit value; use an equivalent signed or 64-bit sign-extended literal"
            ),
        ));
    }
    Ok((canonical as i32).to_string())
}

/// Convert the strict 32-bit-safe RV64IM dialect into RV32IM.
pub fn rv64_to_rv32(source: &str) -> Result<String, XlenConvertError> {
    let program = assemble64(source).map_err(first_source_error64)?;
    let mut output = String::from(
        "# Converted by StudyRISCV: RV64IM to RV32IM\n\
         # The source passed strict 32-bit-safe narrowing validation.\n",
    );
    for line in parse_source(source) {
        reject_numeric_control_target(&line)?;
        emit_labels(&mut output, &line.labels);
        let Some(mnemonic) = line.mnemonic.as_deref() else {
            continue;
        };
        if mnemonic.starts_with('.') {
            if matches!(mnemonic, ".dword" | ".quad") {
                return Err(narrow_rejection(
                    &line,
                    "use .word data and narrow load/store instructions",
                ));
            }
            let _ = writeln!(output, "{}", line.statement);
            continue;
        }

        let emit = |output: &mut String, op: &str, operands: &[String]| {
            let _ = writeln!(output, "{}", render_instruction(op, operands));
        };
        match mnemonic {
            "addiw" => emit(&mut output, "addi", &line.operands),
            "slliw" => emit(&mut output, "slli", &line.operands),
            "srliw" => emit(&mut output, "srli", &line.operands),
            "sraiw" => emit(&mut output, "srai", &line.operands),
            "addw" => emit(&mut output, "add", &line.operands),
            "subw" => emit(&mut output, "sub", &line.operands),
            "sllw" => emit(&mut output, "sll", &line.operands),
            "srlw" => emit(&mut output, "srl", &line.operands),
            "sraw" => emit(&mut output, "sra", &line.operands),
            "mulw" => emit(&mut output, "mul", &line.operands),
            "divw" => emit(&mut output, "div", &line.operands),
            "divuw" => emit(&mut output, "divu", &line.operands),
            "remw" => emit(&mut output, "rem", &line.operands),
            "remuw" => emit(&mut output, "remu", &line.operands),
            "li" => {
                let converted = vec![operand(&line, 0)?.to_string(), narrow_li_literal(&line)?];
                emit(&mut output, "li", &converted);
            }
            "auipc" => {
                let (rd, value) = rv64_auipc_value(&program, line.line)?;
                emit(&mut output, "li", &[format!("x{rd}"), value.to_string()]);
            }
            "ld" | "sd" => {
                return Err(narrow_rejection(
                    &line,
                    "64-bit memory transfers have no RV32 equivalent; use lw/sw",
                ))
            }
            "lwu" => {
                return Err(narrow_rejection(
                    &line,
                    "zero-extension above bit 31 is observable; use lw for a signed 32-bit value",
                ))
            }
            "addi" => {
                return Err(narrow_rejection(
                    &line,
                    "use addiw to declare 32-bit wraparound intent",
                ))
            }
            "add" | "sub" => {
                return Err(narrow_rejection(
                    &line,
                    "use the corresponding addw/subw operation",
                ))
            }
            "slli" | "srli" | "srai" => {
                return Err(narrow_rejection(
                    &line,
                    "use the corresponding word-immediate shift",
                ))
            }
            "sll" | "srl" | "sra" => {
                return Err(narrow_rejection(
                    &line,
                    "use the corresponding word register shift",
                ))
            }
            "mul" | "div" | "divu" | "rem" | "remu" => {
                return Err(narrow_rejection(
                    &line,
                    "use the corresponding RV64M word operation",
                ))
            }
            "mulh" | "mulhsu" | "mulhu" => {
                return Err(narrow_rejection(
                    &line,
                    "the high half of a 64-bit product has no RV32 equivalent",
                ))
            }
            "neg" => {
                return Err(narrow_rejection(
                    &line,
                    "write subw rd, x0, rs to declare 32-bit negation",
                ))
            }
            "lui" | "jal" | "jalr" | "beq" | "bne" | "blt" | "bge" | "bltu" | "bgeu" | "lb"
            | "lh" | "lw" | "lbu" | "lhu" | "sb" | "sh" | "sw" | "slti" | "sltiu" | "slt"
            | "sltu" | "xor" | "or" | "and" | "xori" | "ori" | "andi" | "ecall" | "ebreak"
            | "fence" | "fence.i" | "nop" | "mv" | "la" | "not" | "seqz" | "snez" | "sltz"
            | "sgtz" | "bgt" | "ble" | "bgtu" | "bleu" | "beqz" | "bnez" | "bltz" | "bgez"
            | "blez" | "bgtz" | "j" | "jr" | "ret" | "call" | "tail" => {
                emit(&mut output, mnemonic, &line.operands)
            }
            _ => {
                return Err(XlenConvertError::new(
                    line.line,
                    format!("'{mnemonic}' is not supported by RV64 to RV32 conversion"),
                ))
            }
        }
    }
    validate_generated32(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widening_maps_wraparound_and_word_operations() {
        let converted = rv32_to_rv64(
            "start: add x1, x2, x3\naddi x4, x1, -1\nsrl x5, x4, x2\ndiv x6, x5, x3\n",
        )
        .unwrap();
        assert!(converted.contains("start:\naddw x1, x2, x3"));
        assert!(converted.contains("addiw x4, x1, -1"));
        assert!(converted.contains("srlw x5, x4, x2"));
        assert!(converted.contains("divw x6, x5, x3"));
        assert!(assemble64(&converted).is_ok());
    }

    #[test]
    fn widening_canonicalizes_literals_and_bitwise_results() {
        let converted = rv32_to_rv64("li x1, 0xffffffff\nxori x2, x1, 7\n").unwrap();
        assert!(converted.contains("li x1, -1"));
        assert!(converted.contains("xori x2, x1, 7\naddiw x2, x2, 0"));
    }

    #[test]
    fn widening_expands_high_multiply_forms() {
        let converted = rv32_to_rv64(
            "li x1, -2\nli x2, 0xffffffff\nmulh x3, x1, x2\nmulhsu x4, x1, x2\nmulhu x5, x1, x2\n",
        )
        .unwrap();
        assert!(converted.contains("mul x3, x1, x2\nsrai x3, x3, 32"));
        assert!(converted.contains("mul x4, x1, x31\nsrai x4, x4, 32"));
        assert!(converted.contains("mul x5, x31, x5\nsrli x5, x5, 32"));
        assert!(converted.contains("srli x5, x5, 32\naddiw x5, x5, 0"));
        assert!(converted.contains("addiw x31, x0, 0"));
    }

    #[test]
    fn widening_rewrites_auipc_to_original_value() {
        let converted = rv32_to_rv64("nop\nauipc x5, 0x80000\n").unwrap();
        assert!(converted.contains("li x5, -2147483644"));
    }

    #[test]
    fn widening_reports_when_no_scratch_register_is_available() {
        let mut source = String::new();
        for register in 3..32 {
            let _ = writeln!(source, "mv x{register}, x0");
        }
        source.push_str("mulhu x3, x4, x5\n");
        let error = rv32_to_rv64(&source).unwrap_err();
        assert_eq!(error.line, 30);
        assert!(error.message.contains("one register unused"));
    }

    #[test]
    fn numeric_control_targets_are_rejected() {
        let error = rv32_to_rv64("jal x1, 8\n").unwrap_err();
        assert_eq!(error.line, 1);
        assert!(error.message.contains("use a label"));
    }

    #[test]
    fn narrowing_maps_word_operations() {
        let converted =
            rv64_to_rv32("addiw x1, x2, 1\naddw x3, x1, x2\nsraiw x4, x3, 7\ndivuw x5, x4, x2\n")
                .unwrap();
        assert!(converted.contains("addi x1, x2, 1"));
        assert!(converted.contains("add x3, x1, x2"));
        assert!(converted.contains("srai x4, x3, 7"));
        assert!(converted.contains("divu x5, x4, x2"));
        assert!(assemble(&converted).is_ok());
    }

    #[test]
    fn narrowing_rejects_wide_memory_and_literals() {
        let memory = rv64_to_rv32("ld x1, 0(x2)\n").unwrap_err();
        assert_eq!(memory.line, 1);
        assert!(memory.message.contains("lw/sw"));

        let literal = rv64_to_rv32("li x1, 0xffffffff\n").unwrap_err();
        assert_eq!(literal.line, 1);
        assert!(literal.message.contains("not a sign-extended 32-bit value"));

        let sign_extended = rv64_to_rv32("li x1, 0xffffffffffffffff\n").unwrap();
        assert!(sign_extended.contains("li x1, -1"));
    }

    #[test]
    fn narrowing_rejects_ambiguous_full_width_arithmetic() {
        let error = rv64_to_rv32("add x1, x2, x3\n").unwrap_err();
        assert_eq!(error.line, 1);
        assert!(error.message.contains("addw/subw"));
    }

    #[test]
    fn narrowing_preserves_labels_and_data() {
        let converted = rv64_to_rv32(
            ".data\nvalue: .word 9\n.text\nla x1, value\nlw x2, 0(x1)\nbeqz x2, done\naddiw x2, x2, 1\ndone: ecall\n",
        )
        .unwrap();
        assert!(converted.contains("value:\n.word 9"));
        assert!(converted.contains("beqz x2, done"));
        assert!(converted.contains("done:\necall"));
    }
}

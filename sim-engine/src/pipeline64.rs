//! Classic 5-stage RV64IM pipeline (Patterson & Hennessy style).
//!
//! Explicit IF/ID, ID/EX, EX/MEM and MEM/WB pipeline registers, full
//! EX/MEM -> EX and MEM/WB -> EX forwarding, a precisely-scoped load-use
//! stall, and a 2-bit dynamic branch predictor with a small direct-mapped
//! BTB. Branches (and jumps) resolve in EX, so a misprediction squashes the
//! two younger instructions (IF and ID) — a 2-cycle penalty.

use crate::assembler64::{abi_name, Op64, Program64, DATA_BASE64, TEXT_BASE64};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};

const DATA_SIZE64: u64 = crate::DATA_SIZE as u64;
const STACK_LIMIT64: u64 = crate::STACK_LIMIT as u64;
/// RV64 uses the same stack region as RV32 with an ABI-aligned initial SP.
pub const STACK_TOP64: u64 = 0x7fff_fff0;

const BTB_SIZE: usize = 16;
const HISTORY_CAP: usize = 10_000; // step-back depth
const LOG_CAP: usize = 1_000; // execution log ring buffer

// ---------------------------------------------------------------------------
// Pipeline64 registers
// ---------------------------------------------------------------------------

/// A pipeline register slot: empty (nothing fetched / drained), a bubble
/// (inserted by a stall or flush), or a real in-flight instruction.
#[derive(Debug, Clone)]
enum Slot<T> {
    Empty,
    Bubble(BubbleKind),
    Inst(T),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum BubbleKind {
    /// Load-use stall; carries a human-readable cause for the UI.
    Stall(String),
    /// Squashed by a branch/jump misprediction.
    Flush,
}

impl<T> Slot<T> {
    fn is_empty(&self) -> bool {
        matches!(self, Slot::Empty)
    }
    fn inst(&self) -> Option<&T> {
        match self {
            Slot::Inst(t) => Some(t),
            _ => None,
        }
    }
}

/// IF/ID: the fetched instruction plus the prediction made at fetch time.
#[derive(Debug, Clone)]
struct IfId {
    index: usize, // into program.instrs
    pc: u64,
    predicted_taken: bool,
    predicted_target: u64,
}

/// ID/EX: decoded instruction, register-file reads, immediate, and the
/// control info EX/MEM/WB need. `rs*_val` may be superseded by forwarding.
#[derive(Debug, Clone)]
struct IdEx {
    index: usize,
    pc: u64,
    op: Op64,
    rd: u8,
    rs1: u8,
    rs2: u8,
    rs1_val: u64,
    rs2_val: u64,
    imm: i64,
    predicted_taken: bool,
    predicted_target: u64,
}

/// EX/MEM: ALU result (or branch outcome already applied), store data.
#[derive(Debug, Clone)]
struct ExMem {
    index: usize,
    pc: u64,
    op: Op64,
    rd: u8,
    alu: u64,
    store_val: u64,
}

/// MEM/WB: value to commit to the register file.
#[derive(Debug, Clone)]
struct MemWb {
    index: usize,
    pc: u64,
    op: Op64,
    rd: u8,
    value: u64,
    /// Memory write performed in MEM (for the execution log).
    mem_write: Option<(u64, u64, u64)>, // (addr, before, after) word-ish view
}

// ---------------------------------------------------------------------------
// Branch predictor: 2-bit saturating counters + direct-mapped BTB
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default)]
struct BtbEntry {
    valid: bool,
    tag_pc: u64,
    target: u64,
    /// 2-bit saturating counter: 0/1 predict not-taken, 2/3 predict taken.
    counter: u8,
}

fn btb_index(pc: u64) -> usize {
    ((pc >> 2) as usize) % BTB_SIZE
}

// ---------------------------------------------------------------------------
// Snapshot types (serialized to the browser UI and the CLI)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StageState {
    Empty,
    Normal,
    Stall,
    Flush,
}

#[derive(Debug, Clone, Serialize)]
pub struct StageView {
    pub name: &'static str,
    pub state: StageState,
    pub text: Option<String>,
    pub pc: Option<u64>,
    pub line: Option<usize>,
    /// Extra annotation, e.g. the stall cause.
    pub detail: Option<String>,
}

impl StageView {
    fn empty(name: &'static str) -> Self {
        Self {
            name,
            state: StageState::Empty,
            text: None,
            pc: None,
            line: None,
            detail: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ForwardView {
    /// "exmem" or "memwb"
    pub from: &'static str,
    /// ABI name of the forwarded register.
    pub reg: String,
    /// "rs1" or "rs2"
    pub operand: &'static str,
    pub value: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlushView {
    pub stage: &'static str,
    pub text: String,
    pub pc: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PredictorView {
    pub pc: u64,
    pub text: String,
    pub stage: &'static str,
    pub predicted_taken: bool,
    pub counter: u8,
    /// Filled in once the branch resolves in EX this cycle.
    pub actual_taken: Option<bool>,
    pub mispredicted: Option<bool>,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Stats {
    pub cycles: u64,
    pub instructions: u64,
    pub stalls: u64,
    pub flushes: u64,
    pub branches: u64,
    pub mispredictions: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegWrite {
    pub reg: u8,
    pub name: String,
    pub before: u64,
    pub after: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub seq: u64,
    pub cycle: u64,
    /// "instr" | "status" | "success" | "error"
    pub kind: &'static str,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HaltInfo {
    /// "complete" for a clean exit, "error" for a trap/cap.
    pub kind: &'static str,
    pub message: String,
}

/// Everything the UI needs to draw one cycle.
#[derive(Debug, Clone, Serialize, Default)]
pub struct CycleView {
    pub forwards: Vec<ForwardView>,
    pub flushed: Vec<FlushView>,
    pub stall: Option<String>,
    pub predictor: Option<PredictorView>,
    pub reg_writes: Vec<RegWrite>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub cycle: u64,
    pub pc: u64,
    pub halted: bool,
    pub halt: Option<HaltInfo>,
    pub stages: Vec<StageView>,
    pub view: CycleView,
    pub registers: Vec<u64>,
    pub stats: Stats,
    pub log: Vec<LogLine>,
    pub can_step_back: bool,
}

// ---------------------------------------------------------------------------
// Step-back history
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Undo {
    pc: u64,
    if_id: Slot<IfId>,
    id_ex: Slot<IdEx>,
    ex_mem: Slot<ExMem>,
    mem_wb: Slot<MemWb>,
    btb: [BtbEntry; BTB_SIZE],
    halted: bool,
    halt: Option<HaltInfo>,
    stats: Stats,
    cycle: u64,
    reg_changes: Vec<(u8, u64)>,         // (reg, old value)
    mem_changes: Vec<(u64, Option<u8>)>, // (addr, old byte; None = was unset)
    log_added: usize,
    last_view: CycleView,
    last_stages: Vec<StageView>,
}

// ---------------------------------------------------------------------------
// The pipeline itself
// ---------------------------------------------------------------------------

pub struct Pipeline64 {
    program: Program64,
    regs: [u64; 32],
    mem: HashMap<u64, u8>,
    pc: u64,
    if_id: Slot<IfId>,
    id_ex: Slot<IdEx>,
    ex_mem: Slot<ExMem>,
    mem_wb: Slot<MemWb>,
    btb: [BtbEntry; BTB_SIZE],
    halted: bool,
    halt: Option<HaltInfo>,
    stats: Stats,
    cycle: u64,
    log: VecDeque<LogLine>,
    log_seq: u64,
    history: VecDeque<Undo>,
    last_view: CycleView,
    last_stages: Vec<StageView>,
}

impl Pipeline64 {
    pub fn new(program: Program64) -> Self {
        let mut p = Self {
            program,
            regs: [0; 32],
            mem: HashMap::new(),
            pc: TEXT_BASE64,
            if_id: Slot::Empty,
            id_ex: Slot::Empty,
            ex_mem: Slot::Empty,
            mem_wb: Slot::Empty,
            btb: [BtbEntry::default(); BTB_SIZE],
            halted: false,
            halt: None,
            stats: Stats::default(),
            cycle: 0,
            log: VecDeque::new(),
            log_seq: 0,
            history: VecDeque::new(),
            last_view: CycleView::default(),
            last_stages: Vec::new(),
        };
        p.reset();
        p
    }

    pub fn reset(&mut self) {
        self.regs = [0; 32];
        self.regs[2] = STACK_TOP64; // sp
        self.mem.clear();
        for (i, b) in self.program.data.iter().enumerate() {
            if *b != 0 {
                self.mem.insert(DATA_BASE64 + i as u64, *b);
            }
        }
        self.pc = TEXT_BASE64;
        self.if_id = Slot::Empty;
        self.id_ex = Slot::Empty;
        self.ex_mem = Slot::Empty;
        self.mem_wb = Slot::Empty;
        self.btb = [BtbEntry::default(); BTB_SIZE];
        self.halted = false;
        self.halt = None;
        self.stats = Stats::default();
        self.cycle = 0;
        self.log.clear();
        self.log_seq = 0;
        self.history.clear();
        self.last_view = CycleView::default();
        self.last_stages = (0..5)
            .map(|i| StageView::empty(Self::stage_name(i)))
            .collect();
    }

    pub fn program(&self) -> &Program64 {
        &self.program
    }

    pub fn halted(&self) -> bool {
        self.halted
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }

    pub fn registers(&self) -> [u64; 32] {
        self.regs
    }

    pub fn read_memory(&self, addr: u64, len: usize) -> Vec<u8> {
        (0..len)
            .map(|i| {
                self.mem
                    .get(&addr.wrapping_add(i as u64))
                    .copied()
                    .unwrap_or(0)
            })
            .collect()
    }

    fn stage_name(i: usize) -> &'static str {
        ["IF", "ID", "EX", "MEM", "WB"][i]
    }

    fn push_log(&mut self, kind: &'static str, text: String, added: &mut usize) {
        self.log.push_back(LogLine {
            seq: self.log_seq,
            cycle: self.cycle,
            kind,
            text,
        });
        self.log_seq += 1;
        *added += 1;
        while self.log.len() > LOG_CAP {
            self.log.pop_front();
            // popped lines can't be restored by step-back; acceptable for a
            // 1000-line scrollback.
        }
    }

    // -- memory helpers ----------------------------------------------------

    fn mem_region_ok(addr: u64, len: u64) -> bool {
        let end = match addr.checked_add(len - 1) {
            Some(e) => e,
            None => return false,
        };
        (addr >= DATA_BASE64 && end < DATA_BASE64 + DATA_SIZE64)
            || (addr >= STACK_LIMIT64 && end <= STACK_TOP64 + 7)
    }

    fn read_mem(&self, addr: u64, len: u64, line: usize) -> Result<u64, HaltInfo> {
        // Misaligned accesses trap (a valid RV64I implementation choice, and
        // the more educational one).
        if addr % len != 0 {
            return Err(HaltInfo {
                kind: "error",
                message: format!("line {line}: misaligned load: address 0x{addr:08x} (requires {len}-byte alignment)"),
            });
        }
        if !Self::mem_region_ok(addr, len) {
            return Err(HaltInfo {
                kind: "error",
                message: format!("line {line}: memory access out of bounds: address 0x{addr:08x}"),
            });
        }
        let mut v: u64 = 0;
        for i in 0..len {
            v |= (self.mem.get(&(addr + i)).copied().unwrap_or(0) as u64) << (8 * i);
        }
        Ok(v)
    }

    fn write_mem(
        &mut self,
        addr: u64,
        len: u64,
        value: u64,
        line: usize,
        mem_changes: &mut Vec<(u64, Option<u8>)>,
    ) -> Result<(u64, u64), HaltInfo> {
        if addr % len != 0 {
            return Err(HaltInfo {
                kind: "error",
                message: format!("line {line}: misaligned store: address 0x{addr:08x} (requires {len}-byte alignment)"),
            });
        }
        if !Self::mem_region_ok(addr, len) {
            return Err(HaltInfo {
                kind: "error",
                message: format!("line {line}: memory access out of bounds: address 0x{addr:08x}"),
            });
        }
        let mut before: u64 = 0;
        for i in 0..len {
            before |= (self.mem.get(&(addr + i)).copied().unwrap_or(0) as u64) << (8 * i);
        }
        for i in 0..len {
            let a = addr + i;
            let old = self.mem.get(&a).copied();
            mem_changes.push((a, old));
            let byte = ((value >> (8 * i)) & 0xff) as u8;
            if byte == 0 {
                self.mem.remove(&a);
            } else {
                self.mem.insert(a, byte);
            }
        }
        Ok((before, value & (u64::MAX >> (64 - 8 * len.min(8)))))
    }

    // -- ALU ---------------------------------------------------------------

    fn alu(op: Op64, a: u64, b: u64, imm: i64, pc: u64) -> u64 {
        let ia = a as i64;
        let sext32 = |value: u64| value as u32 as i32 as i64 as u64;
        match op {
            Op64::Add => a.wrapping_add(b),
            Op64::Sub => a.wrapping_sub(b),
            Op64::Addw => sext32(a.wrapping_add(b)),
            Op64::Subw => sext32(a.wrapping_sub(b)),
            Op64::Sll => a.wrapping_shl((b & 63) as u32),
            Op64::Sllw => sext32((a as u32).wrapping_shl((b & 31) as u32) as u64),
            Op64::Slt => ((ia) < (b as i64)) as u64,
            Op64::Sltu => (a < b) as u64,
            Op64::Xor => a ^ b,
            Op64::Srl => a.wrapping_shr((b & 63) as u32),
            Op64::Sra => (ia >> (b & 63)) as u64,
            Op64::Srlw => sext32(((a as u32) >> (b & 31)) as u64),
            Op64::Sraw => sext32(((a as u32 as i32) >> (b & 31)) as u32 as u64),
            Op64::Or => a | b,
            Op64::And => a & b,
            Op64::Mul => a.wrapping_mul(b),
            Op64::Mulh => (((ia as i128) * (b as i64 as i128)) >> 64) as u64,
            Op64::Mulhsu => (((ia as i128) * (b as i128)) >> 64) as u64,
            Op64::Mulhu => (((a as u128) * (b as u128)) >> 64) as u64,
            Op64::Mulw => sext32((a as u32).wrapping_mul(b as u32) as u64),
            // RV64M division by zero does NOT trap: the spec defines the
            // results (div -> -1, rem -> dividend; overflow div -> MIN).
            Op64::Div => {
                let ib = b as i64;
                if ib == 0 {
                    u64::MAX
                } else if ia == i64::MIN && ib == -1 {
                    i64::MIN as u64
                } else {
                    (ia / ib) as u64
                }
            }
            Op64::Divu => {
                if b == 0 {
                    u64::MAX
                } else {
                    a / b
                }
            }
            Op64::Rem => {
                let ib = b as i64;
                if ib == 0 {
                    a
                } else if ia == i64::MIN && ib == -1 {
                    0
                } else {
                    (ia % ib) as u64
                }
            }
            Op64::Remu => {
                if b == 0 {
                    a
                } else {
                    a % b
                }
            }
            Op64::Divw => {
                let lhs = a as u32 as i32;
                let rhs = b as u32 as i32;
                let value = if rhs == 0 {
                    -1
                } else if lhs == i32::MIN && rhs == -1 {
                    i32::MIN
                } else {
                    lhs / rhs
                };
                value as i64 as u64
            }
            Op64::Divuw => {
                let lhs = a as u32;
                let rhs = b as u32;
                sext32(if rhs == 0 { u32::MAX } else { lhs / rhs } as u64)
            }
            Op64::Remw => {
                let lhs = a as u32 as i32;
                let rhs = b as u32 as i32;
                let value = if rhs == 0 {
                    lhs
                } else if lhs == i32::MIN && rhs == -1 {
                    0
                } else {
                    lhs % rhs
                };
                value as i64 as u64
            }
            Op64::Remuw => {
                let lhs = a as u32;
                let rhs = b as u32;
                sext32(if rhs == 0 { lhs } else { lhs % rhs } as u64)
            }
            Op64::Addi => a.wrapping_add(imm as u64),
            Op64::Addiw => sext32(a.wrapping_add(imm as u64)),
            Op64::Slti => ((ia) < imm) as u64,
            Op64::Sltiu => (a < imm as u64) as u64,
            Op64::Xori => a ^ imm as u64,
            Op64::Ori => a | imm as u64,
            Op64::Andi => a & imm as u64,
            Op64::Slli => a.wrapping_shl(((imm as u64) & 63) as u32),
            Op64::Srli => a.wrapping_shr(((imm as u64) & 63) as u32),
            Op64::Srai => (ia >> ((imm as u64) & 63)) as u64,
            Op64::Slliw => sext32((a as u32).wrapping_shl(((imm as u64) & 31) as u32) as u64),
            Op64::Srliw => sext32(((a as u32) >> ((imm as u64) & 31)) as u64),
            Op64::Sraiw => sext32(((a as u32 as i32) >> ((imm as u64) & 31)) as u32 as u64),
            Op64::Lui => ((imm as u64) << 12) as u32 as i32 as i64 as u64,
            Op64::Auipc => pc.wrapping_add(((imm as u64) << 12) as u32 as i32 as i64 as u64),
            // loads/stores: effective address
            _ if op.is_load() || op.is_store() => a.wrapping_add(imm as u64),
            // jal/jalr link value is handled by the caller
            _ => 0,
        }
    }

    fn branch_taken(op: Op64, a: u64, b: u64) -> bool {
        match op {
            Op64::Beq => a == b,
            Op64::Bne => a != b,
            Op64::Blt => (a as i64) < (b as i64),
            Op64::Bge => (a as i64) >= (b as i64),
            Op64::Bltu => a < b,
            Op64::Bgeu => a >= b,
            _ => false,
        }
    }

    /// True while an ecall/ebreak is in flight anywhere in the pipeline:
    /// fetch pauses so the program can drain. If the ecall turns out to be
    /// on a mispredicted path and gets flushed, this re-evaluates to false
    /// and fetch resumes on its own.
    fn exit_in_flight(&self) -> bool {
        let is_exit = |op: Op64| matches!(op, Op64::Ecall | Op64::Ebreak);
        self.if_id
            .inst()
            .map(|f| is_exit(self.program.instrs[f.index].op))
            .unwrap_or(false)
            || self.id_ex.inst().map(|d| is_exit(d.op)).unwrap_or(false)
            || self.ex_mem.inst().map(|e| is_exit(e.op)).unwrap_or(false)
            || self.mem_wb.inst().map(|m| is_exit(m.op)).unwrap_or(false)
    }

    // -----------------------------------------------------------------------
    // One cycle
    // -----------------------------------------------------------------------

    pub fn step_cycle(&mut self) {
        if self.halted {
            return;
        }

        // Latch values at the start of the cycle: every stage reads these,
        // writes go to the "new" latches. This models the simultaneous
        // clock-edge update of real pipeline registers.
        let old_if_id = self.if_id.clone();
        let old_id_ex = self.id_ex.clone();
        let old_ex_mem = self.ex_mem.clone();
        let old_mem_wb = self.mem_wb.clone();

        let mut undo = Undo {
            pc: self.pc,
            if_id: old_if_id.clone(),
            id_ex: old_id_ex.clone(),
            ex_mem: old_ex_mem.clone(),
            mem_wb: old_mem_wb.clone(),
            btb: self.btb,
            halted: self.halted,
            halt: self.halt.clone(),
            stats: self.stats,
            cycle: self.cycle,
            reg_changes: Vec::new(),
            mem_changes: Vec::new(),
            log_added: 0,
            last_view: std::mem::take(&mut self.last_view),
            last_stages: std::mem::take(&mut self.last_stages),
        };

        self.cycle += 1;
        self.stats.cycles += 1;

        let mut view = CycleView::default();
        let mut stages: Vec<StageView> = (0..5)
            .map(|i| StageView::empty(Self::stage_name(i)))
            .collect();
        let mut log_added = 0usize;

        // ---------- WB: commit the register file, retire ----------
        match &old_mem_wb {
            Slot::Inst(wb) => {
                let instr = &self.program.instrs[wb.index];
                stages[4] = StageView {
                    name: "WB",
                    state: StageState::Normal,
                    text: Some(instr.text.clone()),
                    pc: Some(wb.pc),
                    line: Some(instr.line),
                    detail: None,
                };
                self.stats.instructions += 1;

                let mut delta = String::new();
                if wb.op.writes_rd() && wb.rd != 0 {
                    let before = self.regs[wb.rd as usize];
                    if before != wb.value {
                        undo.reg_changes.push((wb.rd, before));
                        self.regs[wb.rd as usize] = wb.value;
                    }
                    view.reg_writes.push(RegWrite {
                        reg: wb.rd,
                        name: abi_name(wb.rd).to_string(),
                        before,
                        after: wb.value,
                    });
                    // Log voice matches the marketing terminal: "x5: 0 -> 7".
                    delta = format!("  x{}: {} -> {}", wb.rd, before as i64, wb.value as i64);
                } else if let Some((addr, before, after)) = wb.mem_write {
                    delta = format!("  mem[0x{addr:08x}]: {} -> {}", before as i64, after as i64);
                }
                let text = format!("{}{}", instr.text, delta);
                self.push_log("instr", text, &mut log_added);

                // ecall/ebreak retire => program done
                match wb.op {
                    Op64::Ecall => {
                        self.halted = true;
                        self.halt = Some(HaltInfo {
                            kind: "complete",
                            message: "program complete (ecall)".to_string(),
                        });
                    }
                    Op64::Ebreak => {
                        self.halted = true;
                        self.halt = Some(HaltInfo {
                            kind: "complete",
                            message: "breakpoint (ebreak)".to_string(),
                        });
                    }
                    _ => {}
                }
            }
            Slot::Bubble(kind) => {
                stages[4] = StageView {
                    name: "WB",
                    state: if *kind == BubbleKind::Flush {
                        StageState::Flush
                    } else {
                        StageState::Stall
                    },
                    text: None,
                    pc: None,
                    line: None,
                    detail: None,
                };
            }
            Slot::Empty => {}
        }

        // ---------- MEM: data memory access ----------
        let mut trap: Option<HaltInfo> = None;
        let new_mem_wb: Slot<MemWb> = match &old_ex_mem {
            Slot::Inst(ex) => {
                let instr = &self.program.instrs[ex.index];
                stages[3] = StageView {
                    name: "MEM",
                    state: StageState::Normal,
                    text: Some(instr.text.clone()),
                    pc: Some(ex.pc),
                    line: Some(instr.line),
                    detail: None,
                };
                let mut value = ex.alu;
                let mut mem_write = None;
                if ex.op.is_load() {
                    let len = match ex.op {
                        Op64::Lb | Op64::Lbu => 1,
                        Op64::Lh | Op64::Lhu => 2,
                        Op64::Lw | Op64::Lwu => 4,
                        Op64::Ld => 8,
                        _ => unreachable!(),
                    };
                    match self.read_mem(ex.alu, len, instr.line) {
                        Ok(raw) => {
                            value = match ex.op {
                                Op64::Lb => raw as u8 as i8 as i64 as u64,
                                Op64::Lh => raw as u16 as i16 as i64 as u64,
                                Op64::Lw => raw as u32 as i32 as i64 as u64,
                                _ => raw,
                            };
                        }
                        Err(e) => {
                            trap = Some(e);
                            value = 0;
                        }
                    }
                } else if ex.op.is_store() {
                    let len = match ex.op {
                        Op64::Sb => 1,
                        Op64::Sh => 2,
                        Op64::Sw => 4,
                        Op64::Sd => 8,
                        _ => unreachable!(),
                    };
                    match self.write_mem(
                        ex.alu,
                        len,
                        ex.store_val,
                        instr.line,
                        &mut undo.mem_changes,
                    ) {
                        Ok((before, after)) => mem_write = Some((ex.alu, before, after)),
                        Err(e) => trap = Some(e),
                    }
                }
                Slot::Inst(MemWb {
                    index: ex.index,
                    pc: ex.pc,
                    op: ex.op,
                    rd: ex.rd,
                    value,
                    mem_write,
                })
            }
            Slot::Bubble(kind) => {
                stages[3] = StageView {
                    name: "MEM",
                    state: if *kind == BubbleKind::Flush {
                        StageState::Flush
                    } else {
                        StageState::Stall
                    },
                    text: None,
                    pc: None,
                    line: None,
                    detail: Some(match kind {
                        BubbleKind::Stall(_) => "bubble".to_string(),
                        BubbleKind::Flush => "flushed".to_string(),
                    }),
                };
                Slot::Bubble(kind.clone())
            }
            Slot::Empty => Slot::Empty,
        };

        // ---------- EX: ALU, forwarding, branch resolution ----------
        // flush_to = Some(correct pc) when EX detects a misprediction.
        let mut flush_to: Option<u64> = None;
        let new_ex_mem: Slot<ExMem> = match &old_id_ex {
            Slot::Inst(id) => {
                let instr = &self.program.instrs[id.index];
                stages[2] = StageView {
                    name: "EX",
                    state: StageState::Normal,
                    text: Some(instr.text.clone()),
                    pc: Some(id.pc),
                    line: Some(instr.line),
                    detail: None,
                };

                // Forwarding muxes. Priority matters: EX/MEM holds the MORE
                // RECENT value than MEM/WB, so it must win when both match
                // (e.g. add x1,..; add x1,x1,..; add ..,x1 — the second
                // add's result is the one the third needs). Getting this
                // backwards silently corrupts back-to-back dependent ops.
                // Loads are excluded from EX/MEM forwarding: their value
                // doesn't exist until MEM completes — that gap is exactly
                // what the load-use stall covers.
                let mut a = id.rs1_val;
                let mut b = id.rs2_val;
                let forward =
                    |reg: u8, operand: &'static str, val: &mut u64, view: &mut CycleView| -> bool {
                        if reg == 0 {
                            return false;
                        }
                        if let Slot::Inst(ex) = &old_ex_mem {
                            if ex.op.writes_rd() && !ex.op.is_load() && ex.rd == reg {
                                *val = ex.alu;
                                view.forwards.push(ForwardView {
                                    from: "exmem",
                                    reg: format!("x{reg}"),
                                    operand,
                                    value: *val,
                                });
                                return true;
                            }
                        }
                        if let Slot::Inst(wb) = &old_mem_wb {
                            if wb.op.writes_rd() && wb.rd == reg {
                                *val = wb.value;
                                view.forwards.push(ForwardView {
                                    from: "memwb",
                                    reg: format!("x{reg}"),
                                    operand,
                                    value: *val,
                                });
                                return true;
                            }
                        }
                        false
                    };
                if instr.op.uses_rs1() {
                    forward(id.rs1, "rs1", &mut a, &mut view);
                }
                if instr.op.uses_rs2() {
                    forward(id.rs2, "rs2", &mut b, &mut view);
                }

                let mut alu = Self::alu(id.op, a, b, id.imm, id.pc);
                let store_val = b;

                // Branch / jump resolution (in EX — standard for the classic
                // 5-stage datapath). Mispredict => flush IF and ID: 2-cycle
                // penalty.
                if id.op.is_branch() || id.op.is_jump() {
                    self.stats.branches += 1;
                    let (actual_taken, actual_target) = match id.op {
                        Op64::Jal => (true, id.pc.wrapping_add(id.imm as u64)),
                        Op64::Jalr => (true, a.wrapping_add(id.imm as u64) & !1u64),
                        _ => (
                            Self::branch_taken(id.op, a, b),
                            id.pc.wrapping_add(id.imm as u64),
                        ),
                    };
                    if id.op.is_jump() {
                        alu = id.pc.wrapping_add(4); // link value
                    }

                    let correct_next = if actual_taken {
                        actual_target
                    } else {
                        id.pc.wrapping_add(4)
                    };
                    let predicted_next = if id.predicted_taken {
                        id.predicted_target
                    } else {
                        id.pc.wrapping_add(4)
                    };
                    let mispredicted = predicted_next != correct_next;

                    // Update the predictor/BTB with the true outcome.
                    let idx = btb_index(id.pc);
                    let entry = &mut self.btb[idx];
                    if actual_taken {
                        if entry.valid && entry.tag_pc == id.pc {
                            entry.counter = (entry.counter + 1).min(3);
                            entry.target = actual_target;
                        } else {
                            *entry = BtbEntry {
                                valid: true,
                                tag_pc: id.pc,
                                target: actual_target,
                                counter: 2, // start weakly-taken
                            };
                        }
                    } else if entry.valid && entry.tag_pc == id.pc {
                        entry.counter = entry.counter.saturating_sub(1);
                    }

                    view.predictor = Some(PredictorView {
                        pc: id.pc,
                        text: instr.text.clone(),
                        stage: "EX",
                        predicted_taken: id.predicted_taken,
                        counter: self.btb[idx].counter,
                        actual_taken: Some(actual_taken),
                        mispredicted: Some(mispredicted),
                    });

                    if mispredicted {
                        if correct_next % 4 != 0 {
                            trap = Some(HaltInfo {
                                kind: "error",
                                message: format!(
                                    "line {}: misaligned jump target 0x{correct_next:08x}",
                                    instr.line
                                ),
                            });
                        }
                        flush_to = Some(correct_next);
                        self.stats.mispredictions += 1;
                    }
                } else if id.predicted_taken {
                    // BTB alias predicted "taken" for a non-branch (can only
                    // happen if program layout changed under us): recover.
                    flush_to = Some(id.pc.wrapping_add(4));
                }

                Slot::Inst(ExMem {
                    index: id.index,
                    pc: id.pc,
                    op: id.op,
                    rd: id.rd,
                    alu,
                    store_val,
                })
            }
            Slot::Bubble(kind) => {
                stages[2] = StageView {
                    name: "EX",
                    state: if *kind == BubbleKind::Flush {
                        StageState::Flush
                    } else {
                        StageState::Stall
                    },
                    text: None,
                    pc: None,
                    line: None,
                    detail: Some(match kind {
                        BubbleKind::Stall(reason) => reason.clone(),
                        BubbleKind::Flush => "flushed".to_string(),
                    }),
                };
                Slot::Bubble(kind.clone())
            }
            Slot::Empty => Slot::Empty,
        };

        // ---------- ID: decode, register read, hazard detection ----------
        // The register file is written by WB in the first half of the cycle
        // and read by ID in the second half (we committed WB above), so a
        // 3-instruction gap needs no forwarding path.
        let mut stall = false;
        let mut new_id_ex: Slot<IdEx> = Slot::Empty;
        match &old_if_id {
            Slot::Inst(fetched) => {
                let instr = &self.program.instrs[fetched.index];
                stages[1] = StageView {
                    name: "ID",
                    state: StageState::Normal,
                    text: Some(instr.text.clone()),
                    pc: Some(fetched.pc),
                    line: Some(instr.line),
                    detail: None,
                };

                if flush_to.is_some() {
                    // Squashed: it was fetched down the wrong path.
                    stages[1].state = StageState::Flush;
                    view.flushed.push(FlushView {
                        stage: "ID",
                        text: instr.text.clone(),
                        pc: fetched.pc,
                    });
                    self.stats.flushes += 1;
                    new_id_ex = Slot::Bubble(BubbleKind::Flush);
                } else {
                    // Load-use hazard — the ONE case forwarding cannot cover:
                    // the instruction in EX is a load whose result this
                    // instruction needs. Note the producing instruction must
                    // be a LOAD; an ALU producer forwards from EX/MEM with no
                    // stall. Over-stalling here would hide how much
                    // forwarding actually buys.
                    if let Slot::Inst(prev) = &old_id_ex {
                        if prev.op.is_load() && prev.rd != 0 {
                            let needs = (instr.op.uses_rs1() && instr.rs1 == prev.rd)
                                || (instr.op.uses_rs2() && instr.rs2 == prev.rd);
                            if needs {
                                stall = true;
                                let reason = format!(
                                    "load-use hazard: waiting for x{} from '{}'",
                                    prev.rd, self.program.instrs[prev.index].text
                                );
                                stages[1].detail = Some(reason.clone());
                                view.stall = Some(reason.clone());
                                self.stats.stalls += 1;
                                new_id_ex = Slot::Bubble(BubbleKind::Stall(reason));
                            }
                        }
                    }
                    if !stall {
                        new_id_ex = Slot::Inst(IdEx {
                            index: fetched.index,
                            pc: fetched.pc,
                            op: instr.op,
                            rd: instr.rd,
                            rs1: instr.rs1,
                            rs2: instr.rs2,
                            rs1_val: self.regs[instr.rs1 as usize],
                            rs2_val: self.regs[instr.rs2 as usize],
                            imm: instr.imm,
                            predicted_taken: fetched.predicted_taken,
                            predicted_target: fetched.predicted_target,
                        });
                    }
                }
            }
            Slot::Bubble(kind) => {
                stages[1] = StageView {
                    name: "ID",
                    state: if *kind == BubbleKind::Flush {
                        StageState::Flush
                    } else {
                        StageState::Stall
                    },
                    text: None,
                    pc: None,
                    line: None,
                    detail: Some(match kind {
                        BubbleKind::Stall(_) => "bubble".to_string(),
                        BubbleKind::Flush => "flushed".to_string(),
                    }),
                };
                new_id_ex = Slot::Bubble(kind.clone());
            }
            Slot::Empty => {}
        }

        // ---------- IF: fetch + branch prediction ----------
        let mut new_if_id: Slot<IfId> = Slot::Empty;
        let mut new_pc = self.pc;
        if let Some(target) = flush_to {
            // The instruction being fetched this cycle is squashed too.
            if let Some(instr) = self.program.instr_at(self.pc) {
                stages[0] = StageView {
                    name: "IF",
                    state: StageState::Flush,
                    text: Some(instr.text.clone()),
                    pc: Some(self.pc),
                    line: Some(instr.line),
                    detail: None,
                };
                view.flushed.push(FlushView {
                    stage: "IF",
                    text: instr.text.clone(),
                    pc: self.pc,
                });
                self.stats.flushes += 1;
            }
            new_if_id = Slot::Bubble(BubbleKind::Flush);
            new_pc = target;
        } else if stall {
            // Hold PC and IF/ID: the same instruction re-fetches next cycle.
            if let Some(instr) = self.program.instr_at(self.pc) {
                stages[0] = StageView {
                    name: "IF",
                    state: StageState::Normal,
                    text: Some(instr.text.clone()),
                    pc: Some(self.pc),
                    line: Some(instr.line),
                    detail: Some("held (stall)".to_string()),
                };
            }
            new_if_id = old_if_id.clone();
        } else if !self.exit_in_flight() {
            if let Some(instr) = self.program.instr_at(self.pc) {
                let index = ((self.pc - TEXT_BASE64) / 4) as usize;
                stages[0] = StageView {
                    name: "IF",
                    state: StageState::Normal,
                    text: Some(instr.text.clone()),
                    pc: Some(self.pc),
                    line: Some(instr.line),
                    detail: None,
                };
                // Consult the branch predictor (2-bit counters + BTB).
                let entry = self.btb[btb_index(self.pc)];
                let predicted_taken = entry.valid && entry.tag_pc == self.pc && entry.counter >= 2;
                let predicted_target = if predicted_taken { entry.target } else { 0 };
                if predicted_taken {
                    stages[0].detail = Some(format!("predicted taken -> 0x{predicted_target:08x}"));
                }
                new_if_id = Slot::Inst(IfId {
                    index,
                    pc: self.pc,
                    predicted_taken,
                    predicted_target,
                });
                new_pc = if predicted_taken {
                    predicted_target
                } else {
                    self.pc.wrapping_add(4)
                };
            }
        }

        // A branch sitting in IF or ID that was predicted taken is worth
        // surfacing even before it resolves.
        if view.predictor.is_none() {
            if let Slot::Inst(f) = &new_if_id {
                let instr = &self.program.instrs[f.index];
                if instr.op.is_branch() || instr.op.is_jump() {
                    let entry = self.btb[btb_index(f.pc)];
                    view.predictor = Some(PredictorView {
                        pc: f.pc,
                        text: instr.text.clone(),
                        stage: "IF",
                        predicted_taken: f.predicted_taken,
                        counter: if entry.valid && entry.tag_pc == f.pc {
                            entry.counter
                        } else {
                            0
                        },
                        actual_taken: None,
                        mispredicted: None,
                    });
                }
            }
        }

        // ---------- latch update ----------
        self.mem_wb = new_mem_wb;
        self.ex_mem = new_ex_mem;
        self.id_ex = new_id_ex;
        self.if_id = new_if_id;
        self.pc = new_pc;

        // ---------- halt conditions ----------
        if let Some(t) = trap {
            self.halted = true;
            self.push_log("error", format!("✗ {}", t.message), &mut log_added);
            self.halt = Some(t);
        } else if self.halted {
            // clean exit via ecall/ebreak (set in WB above)
            let msg = self
                .halt
                .as_ref()
                .map(|h| h.message.clone())
                .unwrap_or_default();
            self.push_log("success", format!("✓ {msg}"), &mut log_added);
        } else if self.if_id.is_empty()
            && self.id_ex.is_empty()
            && self.ex_mem.is_empty()
            && self.mem_wb.is_empty()
            && self.program.instr_at(self.pc).is_none()
        {
            // Ran off the end of .text and the pipeline has fully drained.
            self.halted = true;
            self.halt = Some(HaltInfo {
                kind: "complete",
                message: "program complete".to_string(),
            });
            self.push_log("success", "✓ program complete".to_string(), &mut log_added);
        }

        undo.log_added = log_added;
        self.history.push_back(undo);
        while self.history.len() > HISTORY_CAP {
            self.history.pop_front();
        }

        self.last_view = view;
        self.last_stages = stages;
    }

    /// Undo exactly one cycle. Returns false if there is no history left.
    pub fn step_back(&mut self) -> bool {
        let Some(undo) = self.history.pop_back() else {
            return false;
        };
        self.pc = undo.pc;
        self.if_id = undo.if_id;
        self.id_ex = undo.id_ex;
        self.ex_mem = undo.ex_mem;
        self.mem_wb = undo.mem_wb;
        self.btb = undo.btb;
        self.halted = undo.halted;
        self.halt = undo.halt;
        self.stats = undo.stats;
        self.cycle = undo.cycle;
        for (reg, old) in undo.reg_changes.into_iter().rev() {
            self.regs[reg as usize] = old;
        }
        for (addr, old) in undo.mem_changes.into_iter().rev() {
            match old {
                Some(b) => {
                    self.mem.insert(addr, b);
                }
                None => {
                    self.mem.remove(&addr);
                }
            }
        }
        for _ in 0..undo.log_added {
            self.log.pop_back();
            self.log_seq = self.log_seq.saturating_sub(1);
        }
        self.last_view = undo.last_view;
        self.last_stages = undo.last_stages;
        true
    }

    /// Run until halted or `max_cycles` total cycles have executed.
    /// Returns true if the program halted on its own.
    pub fn run(&mut self, max_cycles: u64) -> bool {
        while !self.halted {
            if self.stats.cycles >= max_cycles {
                let mut log_added = 0usize;
                let msg = format!(
                    "execution halted: exceeded {max_cycles} cycles (possible infinite loop)"
                );
                self.push_log("error", format!("✗ {msg}"), &mut log_added);
                self.halted = true;
                self.halt = Some(HaltInfo {
                    kind: "error",
                    message: msg,
                });
                return false;
            }
            self.step_cycle();
        }
        true
    }

    /// Log lines with seq >= `since` (for streaming CLI output).
    pub fn log_since(&self, since: u64) -> Vec<LogLine> {
        self.log
            .iter()
            .filter(|l| l.seq >= since)
            .cloned()
            .collect()
    }

    pub fn log_seq(&self) -> u64 {
        self.log_seq
    }

    pub fn snapshot(&self) -> Snapshot {
        let stages = if self.last_stages.is_empty() {
            (0..5)
                .map(|i| StageView::empty(Self::stage_name(i)))
                .collect()
        } else {
            self.last_stages.clone()
        };
        Snapshot {
            cycle: self.cycle,
            pc: self.pc,
            halted: self.halted,
            halt: self.halt.clone(),
            stages,
            view: self.last_view.clone(),
            registers: self.regs.to_vec(),
            stats: self.stats,
            log: self.log.iter().cloned().collect(),
            can_step_back: !self.history.is_empty(),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests — including the three mandated self-verification programs.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembler64::assemble64;

    fn run_program(src: &str) -> Pipeline64 {
        let program = assemble64(src).expect("program should assemble64");
        let mut p = Pipeline64::new(program);
        assert!(p.run(100_000), "program did not complete: {:?}", p.halt);
        p
    }

    /// Self-verification program 1: back-to-back dependencies.
    /// Correct forwarding => correct values AND zero stalls.
    #[test]
    fn forwarding_stress_no_stalls() {
        let p = run_program("addi x1, x0, 5\naddi x2, x1, 3\nadd x3, x2, x1\n");
        assert_eq!(p.regs[1], 5);
        assert_eq!(p.regs[2], 8);
        assert_eq!(p.regs[3], 13);
        assert_eq!(p.stats.stalls, 0, "forwarding must cover ALU->ALU deps");
        assert_eq!(p.stats.instructions, 3);
        // 3 instructions through a 5-stage pipe: 5 + (3-1) = 7 cycles,
        // +1 drain-detection cycle.
        assert!(
            p.stats.cycles <= 8,
            "unexpected cycle count {}",
            p.stats.cycles
        );
    }

    /// Triple-dependency chain: EX/MEM must take priority over MEM/WB.
    #[test]
    fn forwarding_priority_exmem_wins() {
        let p = run_program(
            "addi x2, x0, 10\naddi x4, x0, 1\naddi x6, x0, 2\n\
             add x1, x2, x0\nadd x1, x1, x4\nadd x5, x1, x6\n",
        );
        // x1 = 10, then x1 = 11, then x5 = 11 + 2 = 13.
        // If MEM/WB (stale x1=10) wrongly won, x5 would be 12.
        assert_eq!(p.regs[1], 11);
        assert_eq!(p.regs[5], 13);
        assert_eq!(p.stats.stalls, 0);
    }

    /// Self-verification program 2: load-use hazard.
    /// Exactly ONE stall — not zero, not two.
    #[test]
    fn load_use_hazard_single_stall() {
        let src = "\
.data\nvalue: .dword 0x100000000\n.text\n\
addi x4, x0, 1\nla x2, value\nld x1, 0(x2)\nadd x3, x1, x4\n";
        let p = run_program(src);
        assert_eq!(p.regs[1], 0x1_0000_0000);
        assert_eq!(p.regs[3], 0x1_0000_0001);
        assert_eq!(p.stats.stalls, 1, "load-use must stall exactly once");
    }

    /// A load whose consumer is 2 instructions later needs NO stall
    /// (MEM/WB forwarding covers it) — guards against over-stalling.
    #[test]
    fn load_with_gap_does_not_stall() {
        let src = "\
.data\nvalue: .dword 0x100000007\n.text\n\
la x2, value\nld x1, 0(x2)\naddi x5, x0, 100\nadd x3, x1, x1\n";
        let p = run_program(src);
        assert_eq!(p.regs[3], 0x2_0000_000e);
        assert_eq!(p.regs[5], 100);
        assert_eq!(
            p.stats.stalls, 0,
            "one-instruction gap is covered by MEM/WB forwarding"
        );
    }

    /// Squashed instructions must have no side effects.
    /// Self-verification program 3: branch misprediction.
    #[test]
    fn branch_misprediction_flush_and_correct_state() {
        // 3-iteration countdown loop. First encounter of the backward branch
        // is predicted not-taken (cold BTB) => mispredict. It then learns.
        // Final iteration falls through; predictor says taken => mispredict.
        let src = "\
addi x1, x0, 3\naddi x2, x0, 0\n\
loop: addi x2, x2, 1\naddi x1, x1, -1\nbne x1, x0, loop\n\
addi x3, x0, 99\n";
        let p = run_program(src);
        assert_eq!(p.regs[1], 0);
        assert_eq!(p.regs[2], 3, "loop must run exactly 3 times");
        assert_eq!(p.regs[3], 99);
        assert!(
            p.stats.mispredictions >= 1,
            "cold predictor must miss at least once"
        );
        // 2-cycle penalty: every mispredict squashes exactly 2 instructions
        // ... unless fetch had already run off the end of .text (then only
        // the ID-stage instruction exists to squash).
        assert!(
            p.stats.flushes <= p.stats.mispredictions * 2,
            "at most 2 squashed instructions per mispredict"
        );
        assert!(p.stats.flushes >= p.stats.mispredictions);
        // With a 2-bit predictor + BTB the middle iteration should be
        // predicted correctly: 3 branch executions, expect exactly 2 misses.
        assert_eq!(p.stats.branches, 3);
        assert_eq!(p.stats.mispredictions, 2);
    }

    /// Wrong-path instructions must not write registers or memory.
    #[test]
    fn squashed_instructions_have_no_side_effects() {
        // beq is taken; the two instructions after it are fetched
        // speculatively (predict not-taken on cold BTB) and must be squashed.
        let src = "\
addi x5, x0, 1\n\
beq x0, x0, skip\n\
addi x6, x0, 111\n\
addi x7, x0, 222\n\
skip: addi x8, x0, 8\n";
        let p = run_program(src);
        assert_eq!(p.regs[5], 1);
        assert_eq!(p.regs[6], 0, "squashed instruction wrote x6");
        assert_eq!(p.regs[7], 0, "squashed instruction wrote x7");
        assert_eq!(p.regs[8], 8);
        assert_eq!(p.stats.mispredictions, 1);
        assert_eq!(
            p.stats.flushes, 2,
            "unconditional-taken beq squashes IF and ID"
        );
    }

    #[test]
    fn predictor_learns_loop_branch() {
        // 10 iterations: cold miss on iteration 1, final-exit miss on
        // iteration 10, iterations 2-9 predicted correctly.
        let src = "\
addi x1, x0, 10\n\
loop: addi x1, x1, -1\nbne x1, x0, loop\n";
        let p = run_program(src);
        assert_eq!(p.regs[1], 0);
        assert_eq!(p.stats.branches, 10);
        assert_eq!(
            p.stats.mispredictions, 2,
            "2-bit predictor: only first + last miss"
        );
    }

    #[test]
    fn store_then_load_roundtrip() {
        let src = "\
.data\nbuf: .space 8\n.text\n\
la x2, buf\nli x3, 0x123456789abcdef0\nsd x3, 0(x2)\nld x4, 0(x2)\naddi x5, x4, 1\n";
        let p = run_program(src);
        assert_eq!(p.regs[4], 0x1234_5678_9abc_def0);
        assert_eq!(p.regs[5], 0x1234_5678_9abc_def1);
    }

    #[test]
    fn div_by_zero_follows_spec() {
        let src = "\
addi x1, x0, 7\naddi x2, x0, 0\n\
div x3, x1, x2\ndivu x4, x1, x2\nrem x5, x1, x2\nremu x6, x1, x2\n";
        let p = run_program(src);
        assert_eq!(p.regs[3], u64::MAX); // div by zero => -1
        assert_eq!(p.regs[4], u64::MAX);
        assert_eq!(p.regs[5], 7); // rem by zero => dividend
        assert_eq!(p.regs[6], 7);
    }

    #[test]
    fn div_overflow_follows_spec() {
        let src = "\
li x1, -9223372036854775808\naddi x2, x0, -1\ndiv x3, x1, x2\nrem x4, x1, x2\n";
        let p = run_program(src);
        assert_eq!(p.regs[3], i64::MIN as u64);
        assert_eq!(p.regs[4], 0);
    }

    #[test]
    fn word_loads_sign_and_zero_extend() {
        let src = "\
.data\nvalue: .word 0x80000000\n.text\n\
la x1, value\nlw x2, 0(x1)\nlwu x3, 0(x1)\n";
        let p = run_program(src);
        assert_eq!(p.regs[2], 0xffff_ffff_8000_0000);
        assert_eq!(p.regs[3], 0x0000_0000_8000_0000);
    }

    #[test]
    fn rv64_word_operations_sign_extend() {
        let src = "\
li x1, 0x7fffffff\naddiw x2, x1, 1\n\
addi x3, x0, 1\nslliw x4, x3, 31\n\
addw x5, x1, x3\nsubw x6, x0, x3\n\
li x7, 0xffffffff80000000\nsraiw x8, x7, 31\nsrliw x9, x7, 31\n";
        let p = run_program(src);
        assert_eq!(p.regs[2], 0xffff_ffff_8000_0000);
        assert_eq!(p.regs[4], 0xffff_ffff_8000_0000);
        assert_eq!(p.regs[5], 0xffff_ffff_8000_0000);
        assert_eq!(p.regs[6], u64::MAX);
        assert_eq!(p.regs[8], u64::MAX);
        assert_eq!(p.regs[9], 1);
    }

    #[test]
    fn rv64_shifts_use_six_bit_amounts() {
        let src = "\
addi x1, x0, 1\nslli x2, x1, 63\nsrai x3, x2, 63\nsrli x4, x2, 63\n";
        let p = run_program(src);
        assert_eq!(p.regs[2], 0x8000_0000_0000_0000);
        assert_eq!(p.regs[3], u64::MAX);
        assert_eq!(p.regs[4], 1);
    }

    #[test]
    fn rv64_multiply_high_variants_use_full_width() {
        let src = "\
li x1, -1\naddi x2, x0, 2\n\
mulh x3, x1, x2\nmulhsu x4, x1, x2\nmulhu x5, x1, x2\n";
        let p = run_program(src);
        assert_eq!(p.regs[3], u64::MAX);
        assert_eq!(p.regs[4], u64::MAX);
        assert_eq!(p.regs[5], 1);
    }

    #[test]
    fn rv64_u_type_results_are_sign_extended() {
        let p = run_program("lui x1, 0x80000\nauipc x2, 0x80000\n");
        assert_eq!(p.regs[1], 0xffff_ffff_8000_0000);
        assert_eq!(p.regs[2], 4u64.wrapping_add(0xffff_ffff_8000_0000));
    }

    #[test]
    fn rv64m_word_division_and_remainder_sign_extend() {
        let src = "\
li x1, 0x80000000\naddi x2, x0, -1\n\
divw x3, x1, x2\nremw x4, x1, x2\n\
divuw x5, x1, x0\nremuw x6, x1, x0\n";
        let p = run_program(src);
        assert_eq!(p.regs[3], 0xffff_ffff_8000_0000);
        assert_eq!(p.regs[4], 0);
        assert_eq!(p.regs[5], u64::MAX);
        assert_eq!(p.regs[6], 0xffff_ffff_8000_0000);
    }

    #[test]
    fn out_of_bounds_memory_is_recoverable_error() {
        let src = "li x1, 0x20000000\nlw x2, 0(x1)\n";
        let program = assemble64(src).unwrap();
        let mut p = Pipeline64::new(program);
        p.run(1000);
        assert!(p.halted);
        let halt = p.halt.clone().unwrap();
        assert_eq!(halt.kind, "error");
        assert!(halt.message.contains("out of bounds"), "{}", halt.message);
        assert!(halt.message.contains("0x20000000"));
    }

    #[test]
    fn misaligned_access_traps() {
        let src = "la x1, w\nlw x2, 1(x1)\n.data\nw: .word 5\n";
        let program = assemble64(src).unwrap();
        let mut p = Pipeline64::new(program);
        p.run(1000);
        assert!(p.halted);
        assert!(p.halt.clone().unwrap().message.contains("misaligned"));
    }

    #[test]
    fn cycle_cap_halts_infinite_loop() {
        let src = "loop: j loop\n";
        let program = assemble64(src).unwrap();
        let mut p = Pipeline64::new(program);
        let clean = p.run(5000);
        assert!(!clean);
        assert!(p.halted);
        assert!(p
            .halt
            .clone()
            .unwrap()
            .message
            .contains("possible infinite loop"));
    }

    #[test]
    fn ecall_halts_cleanly() {
        let src = "addi a0, x0, 42\necall\n";
        let p = run_program(src);
        assert_eq!(p.regs[10], 42);
        assert_eq!(p.halt.clone().unwrap().kind, "complete");
    }

    #[test]
    fn function_call_and_return() {
        let src = "\
addi a0, x0, 5\n\
call double\n\
add s0, a0, x0\n\
ecall\n\
double: add a0, a0, a0\n\
ret\n";
        let p = run_program(src);
        assert_eq!(p.regs[8], 10);
    }

    #[test]
    fn step_back_restores_state() {
        let program = assemble64("addi x1, x0, 5\naddi x3, x1, 3\n").unwrap();
        let mut p = Pipeline64::new(program);
        for _ in 0..6 {
            p.step_cycle();
        }
        let regs_after = p.regs;
        let cycle_after = p.cycle;
        assert_eq!(regs_after[1], 5);
        // undo everything
        while p.step_back() {}
        assert_eq!(p.cycle, 0);
        assert_eq!(p.regs[1], 0);
        assert_eq!(p.regs[3], 0);
        assert_eq!(
            p.regs[2], STACK_TOP64,
            "sp must return to its initial value"
        );
        // replay must reach the identical state
        for _ in 0..6 {
            p.step_cycle();
        }
        assert_eq!(p.regs, regs_after);
        assert_eq!(p.cycle, cycle_after);
    }

    #[test]
    fn stack_push_pop() {
        let src = "\
addi sp, sp, -16\nli t0, 0x10000004d\nsd t0, 0(sp)\nsd t0, 8(sp)\n\
ld t1, 8(sp)\naddi sp, sp, 16\n";
        let p = run_program(src);
        assert_eq!(p.regs[6], 0x1_0000_004d);
        assert_eq!(p.regs[2], STACK_TOP64);
    }

    #[test]
    fn snapshot_shape_is_stable() {
        let program = assemble64("addi x1, x0, 1\n").unwrap();
        let mut p = Pipeline64::new(program);
        let snap = p.snapshot();
        assert_eq!(snap.stages.len(), 5);
        assert_eq!(snap.registers.len(), 32);
        assert!(!snap.halted);
        p.step_cycle();
        let snap = p.snapshot();
        assert_eq!(snap.stages[0].state, StageState::Normal);
        assert_eq!(snap.stages[0].text.as_deref(), Some("addi x1, x0, 1"));
    }
}

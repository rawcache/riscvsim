//! Enums, structs, unions and typedefs for the C and C++ front ends.
//!
//! The parser lowers them into constructs the code generator already
//! compiles, so every later pass stays unchanged:
//!
//! * An enumerator is its constant value; an enum variable is an `int`.
//! * A struct or union object lives in a byte array aligned to the
//!   record's alignment (locals sit in the stack frame, globals in `.data`).
//! * `s.m` and `p->m` become `*(T *)((char *)&s + offset)`, with the
//!   offsets of a member chain (`a.b.c.d`) folded into one constant.
//! * A pointer to a struct is a `char *` in the generated code; arithmetic
//!   on it is scaled by the struct size here.
//! * `a = b` on structs (and every struct copy below) calls one small
//!   generated helper, `__struct_copy(to, from, bytes)`, which copies every
//!   byte, padding included, and returns `to`.
//!
//! Internal calling convention for structs passed and returned by value
//! (scalars keep the RISC-V psABI exactly):
//!
//! * Argument: the caller copies the struct into a temporary in its own
//!   frame and passes the copy's address in the argument's integer
//!   register. The callee reads and writes that copy directly.
//! * Result: the caller passes the address of a result temporary in its
//!   own frame as a hidden first argument in `a0` (the visible arguments
//!   move up to `a1`..`a6`). The callee copies the returned value there
//!   and returns the same address in `a0`.
//!
//! While parsing, an expression whose type involves a struct is wrapped in
//! a marker call (a name no source text can spell) that records its type;
//! `strip_marks` removes every marker before the tree-depth check runs.

use super::{
    c_type_name, cast_target, pointer_cast_op, show, AssignmentProvenance, BindingOrigin,
    BindingProvenance, ArrayInitProvenance, Expr, Func, FunctionOrigin, FunctionPrototype, Global,
    GlobalInit, IntTy, LValue, ParsedFunction, Parser, ScalarType, Stmt, Tok, TranslateError,
    Unit, C_CAST_OPS, MAX_POINTER_DEPTH,
};
use std::collections::HashMap;

/// Name of the generated struct copy helper.
pub(super) const COPY_HELPER: &str = "__struct_copy";
/// Hidden first parameter of a function that returns a struct.
const RESULT_PARAM: &str = "__result";
/// Marker calls start with this character, which identifiers cannot contain.
const MARK: char = '\u{1}';
/// Largest struct, union or array of them, in bytes.
const MAX_RECORD_BYTES: usize = crate::limits::MAX_STRUCT_BYTES;

const COPY_HELPER_SOURCE: &str = "unsigned char *__struct_copy(unsigned char *to, unsigned char *from, unsigned long n) {
    unsigned char *start = to;
    while (n != 0) { *to = *from; to = to + 1; from = from + 1; n = n - 1; }
    return start;
}";

/// A source-level type: a scalar the code generator knows, or a struct or
/// union (by index) behind `depth` pointers (0 is the object itself).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CTy {
    Scalar(ScalarType),
    Rec(usize, u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mark {
    /// A struct object (depth 0, the expression is its address) or a
    /// pointer to one.
    Rec(usize, u8),
    /// An array of `len` elements (the expression points at the first).
    Array(CTy, usize),
}

#[derive(Debug, Clone)]
struct Member {
    name: String,
    ty: CTy,
    len: Option<usize>,
    offset: usize,
}

#[derive(Debug, Clone)]
struct Record {
    kind: &'static str,
    tag: Option<String>,
    members: Vec<Member>,
    size: usize,
    align: usize,
    complete: bool,
    /// Struct nesting depth (a record with only scalar members is 1).
    depth: usize,
}

#[derive(Debug, Clone)]
enum Entry {
    Var { ty: CTy, len: Option<usize>, global: bool, indirect: bool },
    Enumerator(i64),
    Type(CTy),
}

#[derive(Debug, Clone, Copy)]
enum Tag {
    Rec(usize),
    Enum,
}

#[derive(Default)]
struct Scope {
    names: HashMap<String, Entry>,
    tags: HashMap<String, Tag>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Sig {
    params: Vec<CTy>,
    ret: CTy,
    line: usize,
}

impl Sig {
    fn has_records(&self) -> bool {
        self.params.iter().chain(std::iter::once(&self.ret)).any(|t| matches!(t, CTy::Rec(..)))
    }
}

/// What a top-level or statement-level declaration produced.
pub(super) enum Declared {
    Nothing,
    Stmt(Stmt),
    Function(ParsedFunction),
}

/// One initialized piece of an object: its byte offset, what it holds and
/// the source value.
struct Leaf {
    offset: usize,
    kind: LeafKind,
    value: Expr,
    line: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LeafKind {
    Scalar(ScalarType),
    /// A pointer to a struct (record, depth).
    Ptr(usize, u8),
    /// A whole struct copied from another struct value.
    Copy(usize),
}

/// A parsed `{ ... }` initializer, before it is matched to a type.
enum Init {
    List(Vec<(Option<Designator>, Init)>, usize),
    Value(Expr, usize),
    Str(Vec<u8>, usize),
}

enum Designator {
    Member(String, usize),
    Index(i64, usize),
}

/// The subobjects of an aggregate being initialized.
struct FillPlan {
    ty: CTy,
    len: Option<usize>,
    base: usize,
    braced: bool,
    /// (type, array length, offset, name) of each struct/union member
    members: Vec<(CTy, Option<usize>, usize, String)>,
    is_union: bool,
    count: usize,
    elem_size: usize,
}

/// What one initializer item needs next.
enum Step<'a> {
    Stop,
    Done,
    /// a braced list for a nested aggregate
    Sub { ty: CTy, len: Option<usize>, offset: usize, items: &'a [(Option<Designator>, Init)], line: usize },
    /// brace elision: the following items fill a nested aggregate
    Elide { ty: CTy, len: Option<usize>, offset: usize, line: usize },
}

pub(super) struct RecordState {
    /// Target register width: decides `long` and pointer sizes.
    pub(super) xlen: u8,
    /// First line using an enum, struct, union or typedef, and the keyword.
    pub(super) first_use: Option<(usize, &'static str)>,
    /// Statements to place right after the declaration being parsed.
    pub(super) pending: Vec<Stmt>,
    records: Vec<Record>,
    scopes: Vec<Scope>,
    marks: Vec<(Mark, String)>,
    sigs: HashMap<String, Sig>,
    /// Temporaries of the function being parsed (declared at its top).
    hoisted: Vec<Stmt>,
    globals: Vec<Global>,
    /// The function being parsed: its name and source return type.
    function: Option<(String, CTy)>,
    uses_copy: bool,
    early_calls: Vec<(String, usize)>,
    temps: usize,
}

impl Default for RecordState {
    fn default() -> Self {
        Self {
            xlen: 32,
            first_use: None,
            pending: Vec::new(),
            records: Vec::new(),
            scopes: vec![Scope::default()],
            marks: Vec::new(),
            sigs: HashMap::new(),
            hoisted: Vec::new(),
            globals: Vec::new(),
            function: None,
            uses_copy: false,
            early_calls: Vec::new(),
            temps: 0,
        }
    }
}

fn err(line: usize, message: impl Into<String>) -> TranslateError {
    TranslateError::new(line, message)
}

fn ulong() -> ScalarType {
    ScalarType::Int(IntTy { bits: IntTy::LONG, signed: false })
}

fn uchar() -> ScalarType {
    ScalarType::Int(IntTy { bits: 8, signed: false })
}

fn num(n: i64, line: usize) -> Expr {
    Expr::Num(n, ScalarType::I32, line)
}

fn deref(e: Expr, line: usize) -> Expr {
    Expr::Unary("*", Box::new(e), line)
}

fn align_up(n: usize, align: usize) -> usize {
    n.div_ceil(align.max(1)) * align.max(1)
}

/// The value of a constant integer expression, if it is one.
pub(super) fn const_value(e: &Expr) -> Option<i64> {
    match e {
        Expr::Num(n, _, _) => Some(*n),
        Expr::Unary("-", inner, _) => const_value(inner).map(i64::wrapping_neg),
        Expr::Unary("~", inner, _) => const_value(inner).map(|v| !v),
        Expr::Unary("+", inner, _) => const_value(inner),
        Expr::Unary("!", inner, _) => const_value(inner).map(|v| i64::from(v == 0)),
        Expr::Unary(op, inner, _) if cast_target(op).is_some_and(|t| !t.is_ptr()) => const_value(inner),
        Expr::Binary(op, a, b, _) => {
            let (a, b) = (const_value(a)?, const_value(b)?);
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
                "==" => i64::from(a == b),
                "!=" => i64::from(a != b),
                "<" => i64::from(a < b),
                "<=" => i64::from(a <= b),
                ">" => i64::from(a > b),
                ">=" => i64::from(a >= b),
                "&&" => i64::from(a != 0 && b != 0),
                "||" => i64::from(a != 0 || b != 0),
                _ => return None,
            })
        }
        _ => None,
    }
}

/// Edit distance, for "did you mean" on member names.
fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut prev = row[0];
        row[0] = i;
        for j in 1..=b.len() {
            let cur = row[j];
            row[j] = (row[j] + 1).min(row[j - 1] + 1).min(prev + usize::from(a[i - 1] != b[j - 1]));
            prev = cur;
        }
    }
    row[b.len()]
}

/// The error for translating enums, structs and unions to another source
/// language (they compile to assembly only).
pub(super) fn reject_user_types(unit: &Unit, from: &str, to: &str) -> Result<(), TranslateError> {
    match unit.user_types {
        Some((line, keyword)) => Err(err(
            line,
            format!(
                "unsupported: enums, structs, unions and typedefs ('{keyword}' here) compile to RISC-V assembly, \
                 but translating them from {from} to {to} is not supported yet; translate this program to \
                 assembly, or check the {to} subset list for what translates"
            ),
        )),
        None => Ok(()),
    }
}

impl RecordState {
    fn lookup(&self, name: &str) -> Option<&Entry> {
        self.scopes.iter().rev().find_map(|s| s.names.get(name))
    }

    fn lookup_tag(&self, tag: &str) -> Option<Tag> {
        self.scopes.iter().rev().find_map(|s| s.tags.get(tag).copied())
    }

    /// Move the statements waiting after a declaration into `into`.
    #[inline(never)]
    pub(super) fn take_pending(&mut self, into: &mut Vec<Stmt>) {
        if !self.pending.is_empty() {
            into.append(&mut self.pending);
        }
    }

    #[inline(never)]
    pub(super) fn push_scope(&mut self) {
        self.scopes.push(Scope::default());
    }

    #[inline(never)]
    pub(super) fn pop_scope(&mut self) {
        if self.scopes.len() > 1 {
            self.scopes.pop();
        }
    }

    pub(super) fn is_type_name(&self, name: &str) -> bool {
        matches!(self.lookup(name), Some(Entry::Type(_)))
    }

    pub(super) fn enumerator(&self, name: &str) -> Option<i64> {
        match self.lookup(name) {
            Some(Entry::Enumerator(v)) => Some(*v),
            _ => None,
        }
    }

    /// Record a plain (non-struct) variable so it shadows outer names.
    pub(super) fn declare_scalar(&mut self, name: &str, value_type: Option<ScalarType>, len: Option<usize>) {
        let ty = CTy::Scalar(value_type.unwrap_or(ScalarType::I32));
        let global = self.scopes.len() == 1;
        if let Some(scope) = self.scopes.last_mut() {
            scope.names.insert(name.to_string(), Entry::Var { ty, len, global, indirect: false });
        }
    }

    fn use_keyword(&mut self, line: usize, keyword: &'static str) {
        if self.first_use.is_none() {
            self.first_use = Some((line, keyword));
        }
    }

    fn pointer_bytes(&self) -> usize {
        usize::from(self.xlen / 8)
    }

    fn scalar_size(&self, t: ScalarType) -> usize {
        match t {
            ScalarType::I32 => 4,
            ScalarType::Bool | ScalarType::Unit => 1,
            ScalarType::Int(IntTy { bits: IntTy::LONG, .. }) | ScalarType::Ptr(..) => self.pointer_bytes(),
            ScalarType::Int(IntTy { bits, .. }) => usize::from(bits / 8),
        }
    }

    fn size_align(&self, ty: CTy) -> (usize, usize) {
        match ty {
            CTy::Scalar(t) => {
                let s = self.scalar_size(t);
                (s, s)
            }
            CTy::Rec(_, d) if d > 0 => (self.pointer_bytes(), self.pointer_bytes()),
            CTy::Rec(id, _) => (self.records[id].size, self.records[id].align),
        }
    }

    fn type_name(&self, ty: CTy) -> String {
        match ty {
            CTy::Scalar(t) => c_type_name(t).trim_end().to_string(),
            CTy::Rec(id, d) => {
                let r = &self.records[id];
                let base = match &r.tag {
                    Some(tag) => format!("{} {tag}", r.kind),
                    None => format!("unnamed {}", r.kind),
                };
                if d == 0 {
                    base
                } else {
                    format!("{base} {}", "*".repeat(usize::from(d)))
                }
            }
        }
    }

    /// The generated-code type of a source type.
    fn lowered(ty: CTy) -> ScalarType {
        match ty {
            CTy::Scalar(t) => t,
            CTy::Rec(_, d) => ScalarType::Ptr(IntTy { bits: 8, signed: false }, d.max(1)),
        }
    }

    /// The unsigned type whose size is `align` bytes: the element type of
    /// a local struct's backing array, so zeroing it takes few stores.
    fn word(align: usize) -> ScalarType {
        match align {
            1 => uchar(),
            2 => ScalarType::Int(IntTy { bits: 16, signed: false }),
            4 => ScalarType::Int(IntTy { bits: 32, signed: false }),
            _ => ulong(),
        }
    }
}

impl Parser {
    fn is_cpp(&self) -> bool {
        !self.pointers
    }

    fn tok_at(&self, k: usize) -> &Tok {
        &self.toks[(self.pos + k).min(self.toks.len() - 1)].tok
    }

    /// Does a struct, union, enum, typedef or type name start at token `k`?
    #[inline(never)]
    pub(super) fn record_type_at(&self, k: usize) -> bool {
        match self.tok_at(k) {
            Tok::Kw("struct" | "union" | "enum" | "typedef") => true,
            Tok::Ident(name) => self.rec.is_type_name(name),
            _ => false,
        }
    }

    // -- markers ----------------------------------------------------------

    fn mark(&mut self, mark: Mark, inner: Expr, hint: &str, line: usize) -> Expr {
        let index = self.rec.marks.len();
        self.rec.marks.push((mark, hint.to_string()));
        Expr::Call(format!("{MARK}{index}"), vec![inner], line)
    }

    fn mark_index(e: &Expr) -> Option<usize> {
        match e {
            Expr::Call(name, args, _) if name.starts_with(MARK) && args.len() == 1 => name[MARK.len_utf8()..].parse().ok(),
            _ => None,
        }
    }

    fn mark_of(&self, e: &Expr) -> Option<Mark> {
        Self::mark_index(e).map(|i| self.rec.marks[i].0)
    }

    fn hint_of(&self, e: &Expr) -> String {
        match Self::mark_index(e) {
            Some(i) => self.rec.marks[i].1.clone(),
            None => match e {
                Expr::Var(name, _) | Expr::Index(name, _, _) | Expr::Call(name, _, _) => name.clone(),
                _ => String::new(),
            },
        }
    }

    pub(super) fn is_marked(&self, e: &Expr) -> bool {
        Self::mark_index(e).is_some()
    }

    fn inner(e: Expr) -> Expr {
        match e {
            Expr::Call(name, mut args, _) if name.starts_with(MARK) && args.len() == 1 => args.pop().unwrap_or(Expr::Num(0, ScalarType::I32, 0)),
            other => other,
        }
    }

    /// An array decays to a pointer to its first element.
    fn decay(mark: Mark) -> Option<Mark> {
        match mark {
            Mark::Array(CTy::Rec(id, d), _) => Some(Mark::Rec(id, d + 1)),
            Mark::Array(CTy::Scalar(_), _) => None,
            other => Some(other),
        }
    }

    /// The source type of an expression, when the parser can tell.
    fn type_hint(&self, e: &Expr) -> Option<CTy> {
        if let Some(mark) = self.mark_of(e) {
            return match Self::decay(mark) {
                Some(Mark::Rec(id, d)) => Some(CTy::Rec(id, d)),
                _ => None,
            };
        }
        match e {
            Expr::Num(_, t, _) => Some(CTy::Scalar(*t)),
            Expr::Var(name, _) => match self.rec.lookup(name) {
                Some(Entry::Var { ty: CTy::Scalar(t), len: None, .. }) => Some(CTy::Scalar(*t)),
                _ => None,
            },
            Expr::Unary(op, _, _) => cast_target(op).map(CTy::Scalar),
            Expr::Call(name, _, _) => self.rec.sigs.get(name).map(|s| s.ret),
            _ => None,
        }
    }

    fn record_size(&self, id: usize, line: usize, hint: &str) -> Result<usize, TranslateError> {
        let r = &self.rec.records[id];
        if !r.complete {
            return Err(self.incomplete(id, line, hint));
        }
        Ok(r.size)
    }

    fn incomplete(&self, id: usize, line: usize, hint: &str) -> TranslateError {
        let name = self.rec.type_name(CTy::Rec(id, 0));
        let shown = if hint.is_empty() { self.tag_token(id) } else { hint.to_string() };
        err(
            line,
            format!(
                "'{shown}' needs {name}, which is not complete here: its members are not known yet, so it can \
                 only be used through a pointer, like {name} *p; define it with its members first"
            ),
        )
    }

    // -- types --------------------------------------------------------------

    /// A type specifier: `struct T { ... }`, `union T`, `enum E { ... }`, a
    /// typedef name, or a plain C type keyword.
    ///
    /// Nested struct definitions recurse through here, so the recursive
    /// path (this, `parse_record`, `parse_members`) keeps small frames and
    /// does its real work in helpers.
    pub(super) fn parse_type_spec(&mut self) -> Result<CTy, TranslateError> {
        let kind = match self.peek() {
            Tok::Kw(kind @ ("struct" | "union")) => *kind,
            _ => return self.parse_simple_type_spec(),
        };
        self.enter()?;
        let (id, line) = self.record_head(kind)?;
        if line > 0 {
            let members = self.parse_members(id, kind, line)?;
            self.layout(id, members, line)?;
        }
        self.leave();
        Ok(CTy::Rec(id, 0))
    }

    #[inline(never)]
    fn parse_simple_type_spec(&mut self) -> Result<CTy, TranslateError> {
        let line = self.line();
        match self.peek().clone() {
            Tok::Kw("enum") => self.parse_enum(line),
            Tok::Ident(name) if self.rec.is_type_name(&name) => {
                self.next();
                match self.rec.lookup(&name) {
                    Some(Entry::Type(ty)) => Ok(*ty),
                    _ => Err(err(line, format!("'{name}' is not a type"))),
                }
            }
            Tok::Kw("void") => {
                self.next();
                Ok(CTy::Scalar(ScalarType::Unit))
            }
            Tok::Kw("bool") => {
                self.next();
                Ok(CTy::Scalar(ScalarType::Bool))
            }
            Tok::Kw(k) if super::c_int_type(k).is_some() => {
                self.next();
                Ok(CTy::Scalar(super::c_int_type(k).unwrap_or(ScalarType::I32)))
            }
            other => Err(err(line, format!("expected a type, found {}", show(&other)))),
        }
    }

    /// `*`s after a type.
    fn parse_stars(&mut self, base: CTy, line: usize) -> Result<CTy, TranslateError> {
        let mut ty = base;
        while *self.peek() == Tok::Sym("*") {
            if self.is_cpp() {
                return Err(err(line, "unsupported: pointers like '*' are not yet translatable in C++; use a struct variable and '.'"));
            }
            self.next();
            self.mark_memory(line);
            ty = match ty {
                CTy::Rec(id, d) if d < MAX_POINTER_DEPTH => CTy::Rec(id, d + 1),
                CTy::Rec(..) => return Err(err(line, format!("unsupported: pointers deeper than {MAX_POINTER_DEPTH} levels"))),
                CTy::Scalar(t) => CTy::Scalar(t.pointer_to().ok_or_else(|| {
                    err(
                        line,
                        if t.is_ptr() {
                            format!("unsupported: pointers deeper than {MAX_POINTER_DEPTH} levels")
                        } else {
                            "unsupported: pointers to bool; point to an integer type".to_string()
                        },
                    )
                })?),
            };
        }
        Ok(ty)
    }

    /// `struct T`, `union T {`: the record, and the line of its `{` when a
    /// member list follows (0 when it does not).
    #[inline(never)]
    fn record_head(&mut self, kind: &'static str) -> Result<(usize, usize), TranslateError> {
        let line = self.line();
        self.next();
        self.rec.use_keyword(line, kind);
        self.mark_memory(line);
        let tag = match self.peek().clone() {
            Tok::Ident(name) => {
                self.next();
                Some(name)
            }
            _ => None,
        };
        if *self.peek() != Tok::Sym("{") {
            let Some(tag) = tag else {
                return Err(err(line, format!("expected a name or {{ after '{kind}', found {}", show(self.peek()))));
            };
            if let Some(found) = self.rec.lookup_tag(&tag) {
                return self.tag_kind(found, kind, &tag, line).map(|ty| (Self::record_id(ty), 0));
            }
            // first mention: an incomplete type, completed later
            let id = self.new_record(kind, Some(tag.clone()));
            if let Some(scope) = self.rec.scopes.last_mut() {
                scope.tags.insert(tag, Tag::Rec(id));
            }
            return Ok((id, 0));
        }
        let id = match &tag {
            Some(name) => match self.rec.scopes.last().and_then(|s| s.tags.get(name)).copied() {
                Some(Tag::Rec(id)) if !self.rec.records[id].complete && self.rec.records[id].kind == kind => id,
                Some(Tag::Rec(id)) if self.rec.records[id].kind == kind => {
                    return Err(err(line, format!("'{name}' is defined twice in the same scope (as a {kind}); give one of them another name")));
                }
                Some(found) => return self.tag_kind(found, kind, name, line).map(|ty| (Self::record_id(ty), 0)),
                None => {
                    let id = self.new_record(kind, Some(name.clone()));
                    if let Some(scope) = self.rec.scopes.last_mut() {
                        scope.tags.insert(name.clone(), Tag::Rec(id));
                    }
                    id
                }
            },
            None => self.new_record(kind, None),
        };
        if self.is_cpp() {
            if let Some(name) = &tag {
                // C++: the tag is also a type name (`Point p;`).
                if let Some(scope) = self.rec.scopes.last_mut() {
                    scope.names.entry(name.clone()).or_insert(Entry::Type(CTy::Rec(id, 0)));
                }
            }
        }
        self.next(); // {
        Ok((id, line.max(1)))
    }

    fn record_id(ty: CTy) -> usize {
        match ty {
            CTy::Rec(id, _) => id,
            CTy::Scalar(_) => 0,
        }
    }

    fn tag_kind(&self, found: Tag, kind: &str, tag: &str, line: usize) -> Result<CTy, TranslateError> {
        match found {
            Tag::Rec(id) if self.rec.records[id].kind == kind => Ok(CTy::Rec(id, 0)),
            Tag::Rec(id) => Err(err(
                line,
                format!("'{tag}' was declared as a {}, so write '{} {tag}'", self.rec.records[id].kind, self.rec.records[id].kind),
            )),
            Tag::Enum => Err(err(line, format!("'{tag}' was declared as an enum, so write 'enum {tag}'"))),
        }
    }

    fn new_record(&mut self, kind: &'static str, tag: Option<String>) -> usize {
        self.rec.records.push(Record { kind, tag, members: Vec::new(), size: 0, align: 1, complete: false, depth: 1 });
        self.rec.records.len() - 1
    }

    fn parse_members(&mut self, id: usize, kind: &'static str, line: usize) -> Result<Vec<Member>, TranslateError> {
        let mut members: Vec<Member> = Vec::new();
        while self.member_ahead(kind, line)? {
            let mline = self.line();
            let anonymous = match self.peek() {
                Tok::Kw(k @ ("struct" | "union")) if *self.peek2() == Tok::Sym("{") => Some(*k),
                _ => None,
            };
            let base = self.parse_type_spec()?;
            self.member_declarators(id, kind, base, anonymous, mline, &mut members)?;
        }
        Ok(members)
    }

    /// Skip stray `;`s; false at the closing `}` (consumed).
    #[inline(never)]
    fn member_ahead(&mut self, kind: &'static str, line: usize) -> Result<bool, TranslateError> {
        loop {
            match self.peek() {
                Tok::Sym("}") => {
                    self.next();
                    return Ok(false);
                }
                Tok::Eof => return Err(err(line, format!("missing '}}' at the end of this {kind}"))),
                Tok::Sym(";") => {
                    self.next();
                }
                _ => return Ok(true),
            }
        }
    }

    /// `a, *b, c[4];` after a member's base type.
    #[inline(never)]
    fn member_declarators(
        &mut self,
        id: usize,
        kind: &'static str,
        base: CTy,
        anonymous: Option<&'static str>,
        mline: usize,
        members: &mut Vec<Member>,
    ) -> Result<(), TranslateError> {
        if self.eat_sym(";") {
            if let Some(keyword) = anonymous {
                return Err(err(
                    mline,
                    format!(
                        "unsupported: anonymous struct and union members; this '{keyword}' needs a member name, \
                         like {keyword} {{ int a; }} inner;"
                    ),
                ));
            }
            return Ok(()); // a nested type declaration, no member
        }
        loop {
            let ty = self.parse_stars(base, mline)?;
            if *self.peek() == Tok::Sym("(") {
                let shown = match self.tok_at(2) {
                    Tok::Ident(n) => n.clone(),
                    _ => "(".to_string(),
                };
                return Err(err(
                    mline,
                    format!(
                        "unsupported: function pointers inside structs ('{shown}'); call a named function instead, \
                         or store a number and pick the function with a switch"
                    ),
                ));
            }
            let name = match self.next() {
                Tok::Ident(n) => n,
                t => return Err(err(mline, format!("expected a member name, found {}", show(&t)))),
            };
            if *self.peek() == Tok::Sym(":") {
                return Err(err(
                    mline,
                    format!(
                        "unsupported: bit-fields ('{name}' has a : width); use a whole integer member and pick \
                         the bits out with & and >>"
                    ),
                ));
            }
            let len = if self.eat_sym("[") {
                if *self.peek() == Tok::Sym("]") {
                    return Err(err(
                        mline,
                        format!(
                            "unsupported: flexible array members like '{name}[]'; give the array a fixed size, \
                             like '{name}[8]'"
                        ),
                    ));
                }
                let n = self.parse_array_size(mline)?;
                self.expect_sym("]")?;
                if *self.peek() == Tok::Sym("[") {
                    return Err(err(
                        mline,
                        format!(
                            "unsupported: arrays of arrays ('{name}' has two sizes); use one array and index it \
                             with row * width + column"
                        ),
                    ));
                }
                Some(n)
            } else {
                None
            };
            if let CTy::Rec(inner, 0) = ty {
                if inner == id {
                    return Err(err(
                        mline,
                        format!(
                            "'{name}' would put a whole {} inside itself; use a pointer, like '{} *{name};'",
                            self.rec.type_name(ty),
                            self.rec.type_name(ty)
                        ),
                    ));
                }
            }
            self.check_object_type(ty, &name, mline, true)?;
            if members.iter().any(|m| m.name == name) {
                return Err(err(mline, format!("'{name}' is already a member of this {kind}; give each member its own name")));
            }
            members.push(Member { name, ty, len, offset: 0 });
            if self.eat_sym(",") {
                continue;
            }
            self.expect_sym(";")?;
            break;
        }
        Ok(())
    }

    /// Can a variable or member have this type?
    fn check_object_type(&self, ty: CTy, name: &str, line: usize, member: bool) -> Result<(), TranslateError> {
        match ty {
            CTy::Scalar(ScalarType::Unit) => Err(err(
                line,
                format!("'{name}' cannot have type void; use an integer type, or 'void *' for an opaque pointer"),
            )),
            CTy::Scalar(ScalarType::Bool) if member => Err(err(
                line,
                format!("unsupported: bool members like '{name}'; use an int member that holds 0 or 1"),
            )),
            CTy::Scalar(ScalarType::Int(IntTy { bits: 64, .. })) if self.rec.xlen == 32 => Err(err(
                line,
                format!(
                    "unsupported on RV32: '{name}' is a 64-bit integer, and 64-bit arithmetic on RV32 register \
                     pairs is not implemented yet; translate for RV64, or use a 32-bit type"
                ),
            )),
            CTy::Scalar(t) if member && t.is_ptr() && t.pointer_to().is_none() => Err(err(
                line,
                format!("unsupported: pointer members deeper than {} levels ('{name}')", MAX_POINTER_DEPTH - 1),
            )),
            CTy::Rec(_, d) if member && d >= MAX_POINTER_DEPTH => Err(err(
                line,
                format!("unsupported: pointer members deeper than {} levels ('{name}')", MAX_POINTER_DEPTH - 1),
            )),
            CTy::Rec(id, 0) if !self.rec.records[id].complete => Err(err(
                line,
                format!(
                    "'{name}' needs the members of '{}', which is not complete here; use a pointer, like '{} *{name}', \
                     or define the type with its members first",
                    self.rec.type_name(ty),
                    self.rec.type_name(ty)
                ),
            )),
            _ => Ok(()),
        }
    }

    fn layout(&mut self, id: usize, mut members: Vec<Member>, line: usize) -> Result<(), TranslateError> {
        let kind = self.rec.records[id].kind;
        if members.is_empty() {
            return Err(err(line, format!("this '{kind}' has no members; a {kind} needs at least one, like {kind} {{ int x; }}")));
        }
        let mut offset = 0usize;
        let mut size = 0usize;
        let mut align = 1usize;
        let mut depth = 1usize;
        for m in &mut members {
            let (s, a) = self.rec.size_align(m.ty);
            let total = s.saturating_mul(m.len.unwrap_or(1));
            align = align.max(a);
            if let CTy::Rec(inner, 0) = m.ty {
                depth = depth.max(self.rec.records[inner].depth + 1);
            }
            if kind == "union" {
                m.offset = 0;
                size = size.max(total);
            } else {
                m.offset = align_up(offset, a);
                offset = m.offset.saturating_add(total);
                size = offset;
            }
        }
        let size = align_up(size, align);
        let name = self.tag_token(id);
        if depth > crate::limits::MAX_NESTING_DEPTH {
            return Err(err(line, crate::limits::nesting_message(&format!("'{name}' (structs and unions inside each other)"))));
        }
        if size > MAX_RECORD_BYTES {
            return Err(err(line, format!("'{name}' is too large: {size} bytes, but the limit is {MAX_RECORD_BYTES} bytes")));
        }
        let record = &mut self.rec.records[id];
        record.members = members;
        record.size = size;
        record.align = align;
        record.depth = depth;
        record.complete = true;
        Ok(())
    }

    fn parse_enum(&mut self, line: usize) -> Result<CTy, TranslateError> {
        self.next();
        self.rec.use_keyword(line, "enum");
        let tag = match self.peek().clone() {
            Tok::Ident(name) => {
                self.next();
                Some(name)
            }
            _ => None,
        };
        if !self.eat_sym("{") {
            let Some(tag) = tag else {
                return Err(err(line, format!("expected a name or {{ after 'enum', found {}", show(self.peek()))));
            };
            return match self.rec.lookup_tag(&tag) {
                Some(Tag::Enum) => Ok(CTy::Scalar(ScalarType::I32)),
                Some(found) => self.tag_kind(found, "enum", &tag, line),
                None => Err(err(
                    line,
                    format!("'{tag}' is not a declared enum here; define it first, like enum {tag} {{ A, B }};"),
                )),
            };
        }
        if let Some(name) = &tag {
            if self.rec.scopes.last().is_some_and(|s| s.tags.contains_key(name)) {
                return Err(err(line, format!("'{name}' is defined twice in the same scope (as an enum); give one of them another name")));
            }
            if let Some(scope) = self.rec.scopes.last_mut() {
                scope.tags.insert(name.clone(), Tag::Enum);
                if !self.pointers {
                    scope.names.entry(name.clone()).or_insert(Entry::Type(CTy::Scalar(ScalarType::I32)));
                }
            }
        }
        self.enter()?;
        let result = self.parse_enumerators(line);
        self.leave();
        result?;
        Ok(CTy::Scalar(ScalarType::I32))
    }

    fn parse_enumerators(&mut self, line: usize) -> Result<(), TranslateError> {
        let mut next = 0i64;
        let mut count = 0usize;
        loop {
            let eline = self.line();
            let name = match self.next() {
                Tok::Sym("}") if count > 0 => return Ok(()),
                Tok::Ident(n) => n,
                Tok::Eof => return Err(err(line, "missing '}' at the end of this enum")),
                t => return Err(err(eline, format!("expected an enumerator name, found {}", show(&t)))),
            };
            let value = if self.eat_sym("=") {
                let e = self.parse_binary(0)?;
                const_value(&e).ok_or_else(|| {
                    err(eline, format!("the value of '{name}' must be a constant number, like 4 or A + 1"))
                })?
            } else {
                next
            };
            if i32::try_from(value).is_err() {
                return Err(err(eline, format!("the value of '{name}' does not fit in an int: {value}")));
            }
            if self.rec.scopes.last().is_some_and(|s| s.names.contains_key(&name)) {
                return Err(err(
                    eline,
                    format!("'{name}' is already defined in this scope; each enumerator needs its own name"),
                ));
            }
            if let Some(scope) = self.rec.scopes.last_mut() {
                scope.names.insert(name, Entry::Enumerator(value));
            }
            next = value.wrapping_add(1);
            count += 1;
            if self.eat_sym(",") {
                continue;
            }
            self.expect_sym("}")?;
            return Ok(());
        }
    }

    /// A constant array size between 1 and 4096 (a number, an enumerator
    /// or a constant expression of them).
    #[inline(never)]
    pub(super) fn parse_array_size(&mut self, line: usize) -> Result<usize, TranslateError> {
        let e = self.parse_binary(0)?;
        match const_value(&e) {
            Some(n) if (1..=4096).contains(&n) => Ok(n as usize),
            Some(n) => Err(err(line, format!("array size must be a constant between 1 and 4096, but '{n}' is not"))),
            None => {
                let shown = Self::first_name(&e).map(|n| format!(" ('{n}' is not a constant)")).unwrap_or_default();
                Err(err(
                    line,
                    format!(
                        "unsupported: variable-length arrays{shown}; the array size must be a constant between 1 \
                         and 4096, like 8 or an enum value"
                    ),
                ))
            }
        }
    }

    /// The first variable named in an expression.
    fn first_name(e: &Expr) -> Option<String> {
        let mut work = vec![e];
        while let Some(e) = work.pop() {
            match e {
                Expr::Var(n, _) | Expr::Index(n, _, _) => return Some(n.clone()),
                Expr::Unary(_, a, _) => work.push(a),
                Expr::Binary(_, a, b, _) => {
                    work.push(b);
                    work.push(a);
                }
                Expr::Call(n, _, _) if !n.starts_with(MARK) => return Some(n.clone()),
                Expr::Call(_, args, _) => work.extend(args.iter()),
                _ => {}
            }
        }
        None
    }

    /// The tag of a record (or its keyword when it has none): a token that
    /// appears in the source, for the error caret.
    fn tag_token(&self, id: usize) -> String {
        let r = &self.rec.records[id];
        r.tag.clone().unwrap_or_else(|| r.kind.to_string())
    }

    fn parse_typedef(&mut self, line: usize) -> Result<(), TranslateError> {
        self.next();
        self.rec.use_keyword(line, "typedef");
        let base = self.parse_type_spec()?;
        loop {
            let ty = self.parse_stars(base, line)?;
            if *self.peek() == Tok::Sym("(") {
                return Err(err(line, "unsupported: function pointer typedefs ('typedef' with (*name)); call named functions directly"));
            }
            let name = match self.next() {
                Tok::Ident(n) => n,
                t => return Err(err(line, format!("expected a name for the typedef, found {}", show(&t)))),
            };
            if *self.peek() == Tok::Sym("[") {
                return Err(err(
                    line,
                    format!("unsupported: array typedefs ('{name}' has a size); put the array inside a struct instead"),
                ));
            }
            match self.rec.scopes.last().and_then(|s| s.names.get(&name)) {
                Some(Entry::Type(old)) if *old == ty => {}
                Some(_) => {
                    return Err(err(line, format!("'{name}' is already defined in this scope; give the typedef another name")));
                }
                None => {}
            }
            if let Some(scope) = self.rec.scopes.last_mut() {
                scope.names.insert(name, Entry::Type(ty));
            }
            if !self.eat_sym(",") {
                break;
            }
        }
        self.expect_sym(";")
    }

    // -- declarations ---------------------------------------------------------

    /// A declaration that starts with struct, union, enum, typedef or a
    /// typedef name: a type, variable or (at the top level) function.
    #[inline(never)]
    pub(super) fn parse_record_declaration(&mut self, top_level: bool) -> Result<Declared, TranslateError> {
        let line = self.line();
        if *self.peek() == Tok::Kw("typedef") {
            self.parse_typedef(line)?;
            return Ok(Declared::Nothing);
        }
        let base = self.parse_type_spec()?;
        if self.eat_sym(";") {
            return Ok(Declared::Nothing);
        }
        let ty = self.parse_stars(base, line)?;
        if *self.peek() == Tok::Sym("(") && *self.peek2() == Tok::Sym("*") {
            return Err(err(line, "unsupported: function pointers & pointers to arrays; use a plain pointer such as int *p"));
        }
        let name = match self.next() {
            Tok::Ident(n) => n,
            t => return Err(err(line, format!("expected variable name, found {}", show(&t)))),
        };
        if *self.peek() == Tok::Sym("(") {
            if !top_level {
                return Err(err(line, format!("'{name}' looks like a function; define functions outside other functions")));
            }
            return Ok(Declared::Function(self.parse_function_rest(ty, name, line)?));
        }
        let global = top_level;
        let statement = match ty {
            CTy::Scalar(t) => {
                if t == ScalarType::Unit {
                    return Err(err(
                        line,
                        "a variable cannot have type void; use an integer type, or 'void *' for an opaque pointer",
                    ));
                }
                self.parse_decl_named(Some(t), false, name, line)?
            }
            CTy::Rec(_, 0) => match self.parse_record_object(ty, name, global, line)? {
                Some(statement) => statement,
                None => return Ok(Declared::Nothing),
            },
            CTy::Rec(id, d) => self.parse_record_pointer_decl(id, d, name, global, line)?,
        };
        Ok(Declared::Stmt(statement))
    }

    /// `struct T *p = ...;` or `struct T *ptrs[N] = {...};`
    fn parse_record_pointer_decl(
        &mut self,
        id: usize,
        d: u8,
        name: String,
        global: bool,
        line: usize,
    ) -> Result<Stmt, TranslateError> {
        let ty = CTy::Rec(id, d);
        let lowered = RecordState::lowered(ty);
        let binding = |initialized: bool| BindingProvenance {
            declared_type: Some(lowered),
            mutable: false,
            initialized,
            origin: BindingOrigin::Local,
        };
        if self.eat_sym("[") {
            let size = self.parse_array_size(line)?;
            self.expect_sym("]")?;
            self.declare_record_var(&name, ty, Some(size), global, false);
            let mut init = Vec::new();
            let initialized = self.eat_sym("=");
            if initialized {
                self.expect_sym("{")?;
                while !self.eat_sym("}") {
                    let value = self.parse_assign()?;
                    let value = self.pointer_value(value, id, d, &name, line, global)?;
                    init.push(value);
                    if !self.eat_sym(",") {
                        self.expect_sym("}")?;
                        break;
                    }
                }
                if init.len() > size {
                    return Err(err(line, "too many array initializers"));
                }
            }
            self.end_declarator(line)?;
            return Ok(Stmt::DeclArray(
                name,
                size,
                init,
                binding(initialized),
                if initialized { ArrayInitProvenance::List } else { ArrayInitProvenance::Absent },
                line,
            ));
        }
        self.declare_record_var(&name, ty, None, global, false);
        let init = if self.eat_sym("=") {
            let value = self.parse_assign()?;
            Some(self.pointer_value(value, id, d, &name, line, global)?)
        } else {
            None
        };
        self.end_declarator(line)?;
        let initialized = init.is_some();
        Ok(Stmt::Decl(name, init, binding(initialized), line))
    }

    fn end_declarator(&mut self, line: usize) -> Result<(), TranslateError> {
        if self.eat_sym(",") {
            return Err(err(line, "one declaration per line, please (int a; int b; …)"));
        }
        self.expect_sym(";")
    }

    fn declare_record_var(&mut self, name: &str, ty: CTy, len: Option<usize>, global: bool, indirect: bool) {
        if let Some(scope) = self.rec.scopes.last_mut() {
            scope.names.insert(name.to_string(), Entry::Var { ty, len, global, indirect });
        }
    }

    /// A value stored into a struct pointer: it must be the same pointer
    /// type, `void *` or 0. Globals need a constant address.
    fn pointer_value(
        &mut self,
        value: Expr,
        id: usize,
        d: u8,
        target: &str,
        line: usize,
        global: bool,
    ) -> Result<Expr, TranslateError> {
        self.check_pointer_value(&value, CTy::Rec(id, d), target, line)?;
        let value = Self::inner(value);
        if !global || matches!(value, Expr::Num(0, _, _)) {
            return Ok(value);
        }
        match Self::address_root(&value) {
            Some((root, 0)) => Ok(Expr::Var(root, line)),
            _ => Err(err(
                line,
                format!("global '{target}' can only start as 0 or the address of a whole global, like &pool or pool"),
            )),
        }
    }

    /// `(char *)g`, `g` or `&g` (+ constant offset): the global and offset.
    fn address_root(e: &Expr) -> Option<(String, i64)> {
        match e {
            Expr::Var(name, _) => Some((name.clone(), 0)),
            Expr::Unary("&", inner, _) => match &**inner {
                Expr::Var(name, _) => Some((name.clone(), 0)),
                _ => None,
            },
            Expr::Unary(op, inner, _) if op.ends_with("*)") => Self::address_root(inner),
            Expr::Binary("+", a, b, _) => match &**b {
                Expr::Num(k, _, _) => Self::address_root(a).map(|(n, o)| (n, o + k)),
                _ => None,
            },
            _ => None,
        }
    }

    fn check_pointer_value(&self, value: &Expr, target_ty: CTy, target: &str, line: usize) -> Result<(), TranslateError> {
        if matches!(value, Expr::Num(0, _, _)) {
            return Ok(());
        }
        let found = self.type_hint(value);
        let ok = match found {
            None => true,
            Some(t) if t == target_ty => true,
            Some(CTy::Scalar(t)) => t.is_void_ptr(),
            Some(_) => false,
        };
        if ok {
            return Ok(());
        }
        let found = found.map(|t| self.rec.type_name(t)).unwrap_or_default();
        Err(err(
            line,
            format!(
                "'{target}' is a {}, but this value is a {found}; use a value of the same type, or cast it, \
                 like ({})",
                self.rec.type_name(target_ty),
                self.rec.type_name(target_ty)
            ),
        ))
    }

    /// A struct value where a number or plain pointer is stored: refuse it
    /// clearly instead of letting a generated pointer type leak into an
    /// error message.
    #[inline(never)]
    pub(super) fn check_store(&self, target: Option<ScalarType>, value: &Expr, name: &str, line: usize) -> Result<(), TranslateError> {
        let Some(mark) = self.mark_of(value) else { return Ok(()) };
        let hint = self.hint_of(value);
        match Self::decay(mark) {
            Some(Mark::Rec(id, 0)) => Err(self.struct_as_value(id, &hint, line)),
            Some(Mark::Rec(id, d)) => match target {
                Some(t) if t.is_void_ptr() => Ok(()),
                Some(t) => Err(err(
                    line,
                    format!(
                        "'{}' is a {}, but '{name}' is a {}; use a value of the right type, or write a cast",
                        if hint.is_empty() { name.to_string() } else { hint },
                        self.rec.type_name(CTy::Rec(id, d)),
                        c_type_name(t).trim_end()
                    ),
                )),
                None => Ok(()),
            },
            _ => Ok(()),
        }
    }

    fn struct_as_value(&self, id: usize, hint: &str, line: usize) -> TranslateError {
        let first = self.rec.records[id].members.first().map(|m| m.name.clone()).unwrap_or_else(|| "x".into());
        let name = self.rec.type_name(CTy::Rec(id, 0));
        if hint.is_empty() {
            return err(line, format!("this {name} value cannot be used as a number here; use one of its members, like .{first}"));
        }
        err(
            line,
            format!(
                "'{hint}' is a {name}, which cannot be used as a number here; use one of its members, like {hint}.{first}"
            ),
        )
    }

    /// The address of a struct variable's storage, as `char *`.
    fn object_address(&self, name: &str, line: usize) -> Expr {
        let var = Expr::Var(name.to_string(), line);
        match self.rec.lookup(name) {
            Some(Entry::Var { ty: CTy::Rec(id, 0), global: false, indirect: false, .. })
                if RecordState::word(self.rec.records[*id].align) != uchar() =>
            {
                Expr::Unary(pointer_cast_op(ScalarType::Ptr(IntTy { bits: 8, signed: false }, 1)).unwrap_or("(char *)"), Box::new(var), line)
            }
            _ => var,
        }
    }

    /// `struct T s;`, `struct T s = {...};`, `struct T s = other;`,
    /// `struct T a[N] = {...};`. Locals become an aligned byte array plus
    /// stores; globals become an initialized data image.
    fn parse_record_object(&mut self, ty: CTy, name: String, global: bool, line: usize) -> Result<Option<Stmt>, TranslateError> {
        let CTy::Rec(id, _) = ty else { return Ok(None) };
        if global && self.is_cpp() {
            return Err(err(line, "unsupported: global variables are not translatable; declare locals inside a function"));
        }
        let mut len = None;
        let mut open = false;
        if self.eat_sym("[") {
            if *self.peek() == Tok::Sym("]") && *self.peek2() == Tok::Sym("=") {
                open = true;
            } else {
                len = Some(self.parse_array_size(line)?);
            }
            self.expect_sym("]")?;
        }
        self.check_object_type(ty, &name, line, false)?;
        let size = self.rec.records[id].size;
        let align = self.rec.records[id].align;
        let mut leaves = Vec::new();
        let initialized = self.eat_sym("=");
        if initialized {
            let init = self.parse_init()?;
            let count = self.fill_top(ty, len, open, init, &mut leaves, line)?;
            if open {
                len = Some(count);
            }
        } else if open {
            return Err(err(line, "array size must be a constant between 1 and 4096"));
        }
        self.end_declarator(line)?;
        let bytes = size.saturating_mul(len.unwrap_or(1));
        if bytes > MAX_RECORD_BYTES {
            return Err(err(line, format!("'{name}' is too large: {bytes} bytes, but the limit is {MAX_RECORD_BYTES} bytes")));
        }
        self.declare_record_var(&name, ty, len, global, false);
        if global {
            let init = self.global_image(&leaves, bytes)?;
            self.rec.globals.push(Global {
                name,
                value_type: uchar(),
                len: Some(bytes),
                init,
                readonly: false,
                line,
                align,
            });
            return Ok(None);
        }
        let word = RecordState::word(align);
        let words = bytes / align;
        let base = self.object_address(&name, line);
        for leaf in leaves {
            let statement = self.leaf_store(base.clone(), leaf)?;
            self.rec.pending.push(statement);
        }
        Ok(Some(Stmt::DeclArray(
            name,
            words,
            Vec::new(),
            BindingProvenance { declared_type: Some(word), mutable: false, initialized, origin: BindingOrigin::Local },
            if initialized { ArrayInitProvenance::List } else { ArrayInitProvenance::Absent },
            line,
        )))
    }

    /// The store a local initializer leaf becomes.
    fn leaf_store(&mut self, base: Expr, leaf: Leaf) -> Result<Stmt, TranslateError> {
        let line = leaf.line;
        let at = self.offset(base, leaf.offset as i64, line);
        let e = match leaf.kind {
            LeafKind::Copy(id) => {
                let size = self.rec.records[id].size;
                self.copy_call(at, Self::inner(leaf.value), size, line)
            }
            LeafKind::Scalar(t) => {
                self.check_store(Some(t), &leaf.value, "this member", line)?;
                let target = self.scalar_place(at, t, line)?;
                let lv = Parser::to_lvalue(&target).ok_or_else(|| err(line, "internal: member store"))?;
                Expr::Assign(Box::new(lv), Box::new(leaf.value), AssignmentProvenance::Simple, line)
            }
            LeafKind::Ptr(id, d) => {
                self.check_pointer_value(&leaf.value, CTy::Rec(id, d), "this member", line)?;
                let target = self.pointer_place(at, d, line);
                let lv = Parser::to_lvalue(&target).ok_or_else(|| err(line, "internal: member store"))?;
                Expr::Assign(Box::new(lv), Box::new(Self::inner(leaf.value)), AssignmentProvenance::Simple, line)
            }
        };
        Ok(Stmt::Expr(e, super::ExprStmtProvenance::Expression))
    }

    /// The data image of a global struct: one `Int` per byte, an `Addr`
    /// for a pointer-sized slot that holds an address.
    fn global_image(&mut self, leaves: &[Leaf], bytes: usize) -> Result<Vec<GlobalInit>, TranslateError> {
        let pointer = self.rec.pointer_bytes();
        let mut image: Vec<Option<GlobalInit>> = vec![Some(GlobalInit::Int(0)); bytes];
        let mut last = 0usize;
        for leaf in leaves {
            let line = leaf.line;
            let (size, value) = match leaf.kind {
                LeafKind::Copy(_) => {
                    let hint = self.hint_of(&leaf.value);
                    return Err(err(
                        line,
                        format!("a global struct cannot start as a copy of '{hint}'; spell out its values in braces instead"),
                    ));
                }
                LeafKind::Scalar(t) => {
                    let size = self.rec.scalar_size(t);
                    match const_value(&leaf.value) {
                        Some(v) if !t.is_ptr() || v == 0 => (size, Ok(v)),
                        _ if t.is_ptr() => (size, Err(self.global_address(&leaf.value, line)?)),
                        _ => {
                            return Err(err(
                                line,
                                "global initializers must be constants: a number, a string, &global or a global array name",
                            ))
                        }
                    }
                }
                LeafKind::Ptr(id, d) => {
                    self.check_pointer_value(&leaf.value, CTy::Rec(id, d), "this member", line)?;
                    match const_value(&leaf.value) {
                        Some(0) => (pointer, Ok(0)),
                        _ => (pointer, Err(self.global_address(&Self::inner(leaf.value.clone()), line)?)),
                    }
                }
            };
            let end = leaf.offset + size;
            if end > image.len() {
                continue;
            }
            match value {
                Ok(v) => {
                    for (k, slot) in image[leaf.offset..end].iter_mut().enumerate() {
                        *slot = Some(GlobalInit::Int((v >> (8 * k)) & 0xff));
                    }
                }
                Err(target) => {
                    image[leaf.offset] = Some(GlobalInit::Addr(target));
                    for slot in &mut image[leaf.offset + 1..end] {
                        *slot = None;
                    }
                }
            }
            last = last.max(end);
        }
        image.truncate(last);
        Ok(image.into_iter().flatten().collect())
    }

    fn global_address(&self, value: &Expr, line: usize) -> Result<String, TranslateError> {
        match Self::address_root(&Self::inner(value.clone())) {
            Some((root, 0)) => Ok(root),
            _ => {
                let shown = Self::first_name(&Self::inner(value.clone())).unwrap_or_else(|| "&".into());
                Err(err(
                    line,
                    format!(
                        "'{shown}' cannot start a global pointer: it can only start as 0, a string, or the address \
                         of a whole global, like &pool or pool"
                    ),
                ))
            }
        }
    }

    // -- initializers -------------------------------------------------------

    /// An initializer: a value, a string, or `{ ... }` (recursive, with
    /// small frames; the leaf and designator work lives in helpers).
    fn parse_init(&mut self) -> Result<Init, TranslateError> {
        if *self.peek() != Tok::Sym("{") {
            return self.parse_init_leaf();
        }
        let iline = self.line();
        self.next();
        self.enter()?;
        let mut items = Vec::new();
        while !self.eat_sym("}") {
            let designator = self.parse_designator()?;
            let item = self.parse_init()?;
            items.push((designator, item));
            if !self.eat_sym(",") {
                self.expect_sym("}")?;
                break;
            }
        }
        self.leave();
        Ok(Init::List(items, iline))
    }

    #[inline(never)]
    fn parse_init_leaf(&mut self) -> Result<Init, TranslateError> {
        let iline = self.line();
        match self.peek().clone() {
            Tok::Str(bytes) if matches!(self.peek2(), Tok::Sym("," | "}" | ";")) => {
                self.next();
                Ok(Init::Str(bytes, iline))
            }
            _ => Ok(Init::Value(self.parse_assign()?, iline)),
        }
    }

    /// `.member =` or `[index] =` before an initializer item, if any.
    #[inline(never)]
    fn parse_designator(&mut self) -> Result<Option<Designator>, TranslateError> {
        let dline = self.line();
        if self.eat_sym(".") {
            let name = match self.next() {
                Tok::Ident(n) => n,
                t => return Err(err(dline, format!("expected a member name after '.', found {}", show(&t)))),
            };
            if matches!(self.peek(), Tok::Sym("." | "[")) {
                return Err(err(
                    dline,
                    format!("unsupported: nested designators ('{name}' is followed by another . or [); write .{name} = {{ .x = ... }} instead"),
                ));
            }
            self.expect_sym("=")?;
            return Ok(Some(Designator::Member(name, dline)));
        }
        if *self.peek() != Tok::Sym("[") {
            return Ok(None);
        }
        self.next();
        let e = self.parse_binary(0)?;
        let index = const_value(&e).ok_or_else(|| err(dline, "'[' designators need a constant index, like [2] = 5"))?;
        self.expect_sym("]")?;
        if matches!(self.peek(), Tok::Sym("." | "[")) {
            return Err(err(dline, "unsupported: nested designators ('[' followed by another . or [); write [1] = { .x = ... } instead"));
        }
        self.expect_sym("=")?;
        Ok(Some(Designator::Index(index, dline)))
    }

    /// Match a whole initializer to the declared object. Returns the
    /// number of array elements it set (for `T a[] = {...}`).
    fn fill_top(
        &mut self,
        ty: CTy,
        len: Option<usize>,
        open: bool,
        init: Init,
        out: &mut Vec<Leaf>,
        line: usize,
    ) -> Result<usize, TranslateError> {
        match (len, open) {
            (None, false) => {
                if let Init::Value(value, vline) = init {
                    // a struct value: copied (fill_value checks the type)
                    return self.fill_value(ty, 0, value, vline, out);
                }
                let Init::List(items, lline) = init else {
                    return Err(err(line, format!("'=' needs the values of a {} in braces, like {{ 1, 2 }}", self.rec.type_name(ty))));
                };
                let mut pos = 0;
                self.fill_list(ty, None, 0, &items, &mut pos, true, out, lline)?;
                if pos < items.len() {
                    return Err(self.too_many(ty, lline));
                }
                Ok(1)
            }
            _ => {
                let Init::List(items, lline) = init else {
                    return Err(err(line, "'=' needs the values of an array in braces, like { {1, 2}, {3, 4} }"));
                };
                let mut pos = 0;
                let count = self.fill_list(ty, Some(len.unwrap_or(usize::MAX)), 0, &items, &mut pos, true, out, lline)?;
                if pos < items.len() {
                    return Err(err(lline, "too many array initializers"));
                }
                if open && count == 0 {
                    return Err(err(line, "array size must be a constant between 1 and 4096"));
                }
                if count > 4096 {
                    return Err(err(line, "array size must be a constant between 1 and 4096"));
                }
                Ok(count)
            }
        }
    }

    fn fill_value(&mut self, ty: CTy, offset: usize, value: Expr, line: usize, out: &mut Vec<Leaf>) -> Result<usize, TranslateError> {
        match ty {
            CTy::Rec(id, 0) => {
                if self.mark_of(&value) != Some(Mark::Rec(id, 0)) {
                    let hint = self.hint_of(&value);
                    let shown = if hint.is_empty() { self.tag_token(id) } else { hint };
                    return Err(err(
                        line,
                        format!(
                            "'{shown}' is not a {}; write its members in braces, like {{ 1, 2 }}",
                            self.rec.type_name(ty)
                        ),
                    ));
                }
                out.push(Leaf { offset, kind: LeafKind::Copy(id), value, line });
            }
            CTy::Rec(id, d) => out.push(Leaf { offset, kind: LeafKind::Ptr(id, d), value, line }),
            CTy::Scalar(t) => out.push(Leaf { offset, kind: LeafKind::Scalar(t), value, line }),
        }
        Ok(1)
    }

    /// Fill an aggregate (a struct/union when `len` is None, else an array
    /// of `len` elements of `ty`) from `items[*pos..]`. `braced`: the
    /// items are exactly this aggregate's list (designators allowed);
    /// otherwise brace elision takes only as many items as it needs.
    /// Returns the number of array elements touched. Recursive, so the
    /// per-item work lives in `fill_step`.
    #[allow(clippy::too_many_arguments)]
    fn fill_list(
        &mut self,
        ty: CTy,
        len: Option<usize>,
        base: usize,
        items: &[(Option<Designator>, Init)],
        pos: &mut usize,
        braced: bool,
        out: &mut Vec<Leaf>,
        line: usize,
    ) -> Result<usize, TranslateError> {
        self.enter()?;
        let plan = self.fill_plan(ty, len, base, braced, line)?;
        let mut cursor = 0usize;
        let mut touched = 0usize;
        while *pos < items.len() {
            match self.fill_step(&plan, items, pos, &mut cursor, out)? {
                Step::Stop => break,
                Step::Done => {}
                Step::Sub { ty, len, offset, items: sub, line } => {
                    let mut sub_pos = 0;
                    self.fill_list(ty, len, offset, sub, &mut sub_pos, true, out, line)?;
                    if sub_pos < sub.len() {
                        return Err(self.too_many(ty, line));
                    }
                }
                Step::Elide { ty, len, offset, line } => {
                    let mut sub_pos = *pos;
                    self.fill_list(ty, len, offset, items, &mut sub_pos, false, out, line)?;
                    *pos = sub_pos;
                }
            }
            cursor += 1;
            touched = touched.max(cursor);
            if !braced && cursor >= plan.count {
                break;
            }
        }
        self.leave();
        Ok(touched)
    }

    #[inline(never)]
    fn too_many(&self, ty: CTy, line: usize) -> TranslateError {
        match ty {
            CTy::Rec(id, 0) => err(line, format!("too many initializers for '{}' ({})", self.tag_token(id), self.rec.type_name(ty))),
            _ => err(line, "too many initializers for one member"),
        }
    }

    /// The subobjects of an aggregate, in order.
    #[inline(never)]
    fn fill_plan(&self, ty: CTy, len: Option<usize>, base: usize, braced: bool, line: usize) -> Result<FillPlan, TranslateError> {
        let (elem_size, _) = self.rec.size_align(ty);
        let members: Vec<(CTy, Option<usize>, usize, String)> = match (len, ty) {
            (None, CTy::Rec(id, 0)) => {
                self.record_size(id, line, "")?;
                self.rec.records[id].members.iter().map(|m| (m.ty, m.len, m.offset, m.name.clone())).collect()
            }
            _ => Vec::new(),
        };
        let is_union = matches!((len, ty), (None, CTy::Rec(id, 0)) if self.rec.records[id].kind == "union");
        let count = match len {
            Some(n) => n,
            None if is_union => 1,
            None => members.len(),
        };
        Ok(FillPlan { ty, len, base, braced, members, is_union, count, elem_size })
    }

    /// Handle the item at `*pos` for subobject `*cursor`: store a leaf, or
    /// say which nested aggregate the caller must fill.
    #[inline(never)]
    fn fill_step<'a>(
        &mut self,
        plan: &FillPlan,
        items: &'a [(Option<Designator>, Init)],
        pos: &mut usize,
        cursor: &mut usize,
        out: &mut Vec<Leaf>,
    ) -> Result<Step<'a>, TranslateError> {
        let (designator, item) = &items[*pos];
        if let Some(d) = designator {
            if !plan.braced && *pos > 0 {
                return Ok(Step::Stop); // a designator belongs to the enclosing braces
            }
            *cursor = match (d, plan.len) {
                (Designator::Member(name, dline), None) => {
                    let found = plan.members.iter().position(|m| m.3 == *name);
                    found.ok_or_else(|| self.no_member(plan.ty, name, *dline))?
                }
                (Designator::Index(i, dline), Some(n)) => {
                    if *i < 0 || *i as usize >= n {
                        return Err(err(*dline, format!("'{i}' is outside the array in this [{i}] = designator")));
                    }
                    *i as usize
                }
                (Designator::Member(name, dline), Some(_)) => {
                    return Err(err(*dline, format!("'{name}' names a member, but this is an array; use [index] = instead")))
                }
                (Designator::Index(_, dline), None) => {
                    return Err(err(*dline, "'[' designators are for arrays, but this is a struct; use .member = instead".to_string()))
                }
            };
        } else if *cursor >= plan.count || (plan.is_union && *cursor > 0) {
            return Ok(Step::Stop);
        }
        let (sub_ty, sub_len, sub_off) = match plan.len {
            Some(_) => (plan.ty, None, plan.base + *cursor * plan.elem_size),
            None => {
                let m = &plan.members[*cursor];
                (m.0, m.1, plan.base + m.2)
            }
        };
        let aggregate = sub_len.is_some() || matches!(sub_ty, CTy::Rec(_, 0));
        match item {
            Init::List(sub_items, lline) if aggregate => {
                *pos += 1;
                return Ok(Step::Sub { ty: sub_ty, len: sub_len, offset: sub_off, items: sub_items, line: *lline });
            }
            Init::List(sub_items, lline) => {
                // braces around a single value: `{ 5 }`
                *pos += 1;
                match sub_items.as_slice() {
                    [(None, Init::Value(value, vline))] => {
                        self.fill_value(sub_ty, sub_off, value.clone(), *vline, out)?;
                    }
                    [] => {}
                    _ => return Err(err(*lline, "'{' holds too many values for one member")),
                }
            }
            Init::Str(bytes, sline) => {
                *pos += 1;
                match (sub_ty, sub_len) {
                    (CTy::Scalar(t), Some(n)) if self.rec.scalar_size(t) == 1 && !t.is_ptr() => {
                        if bytes.len() > n {
                            return Err(err(*sline, format!("'\"{}\"' is longer than the array it initializes ({n} bytes)", String::from_utf8_lossy(bytes))));
                        }
                        for (k, b) in bytes.iter().enumerate() {
                            out.push(Leaf { offset: sub_off + k, kind: LeafKind::Scalar(uchar()), value: num(i64::from(*b), *sline), line: *sline });
                        }
                    }
                    (CTy::Scalar(t), None) if t.is_ptr() => {
                        let value = self.string_literal(bytes.clone(), *sline);
                        out.push(Leaf { offset: sub_off, kind: LeafKind::Scalar(t), value, line: *sline });
                    }
                    _ => return Err(err(*sline, format!("'\"{}\"' can only initialize a char array or a char pointer", String::from_utf8_lossy(bytes)))),
                }
            }
            Init::Value(value, vline) => {
                let whole_struct = matches!(sub_ty, CTy::Rec(id, 0) if sub_len.is_none() && self.mark_of(value) == Some(Mark::Rec(id, 0)));
                if aggregate && !whole_struct {
                    // brace elision: the next values fill this member
                    return Ok(Step::Elide { ty: sub_ty, len: sub_len, offset: sub_off, line: *vline });
                }
                *pos += 1;
                self.fill_value(sub_ty, sub_off, value.clone(), *vline, out)?;
            }
        }
        Ok(Step::Done)
    }

    fn no_member(&self, ty: CTy, name: &str, line: usize) -> TranslateError {
        let CTy::Rec(id, _) = ty else {
            return err(line, format!("'{name}' is not a member"));
        };
        let record = &self.rec.records[id];
        let best = record
            .members
            .iter()
            .map(|m| (distance(&m.name, name), &m.name))
            // one letter off is no hint for one-letter names
            .filter(|(d, _)| *d <= 2 && *d < name.chars().count())
            .min();
        let suggestion = match best {
            Some((_, m)) => format!("; did you mean '{m}'?"),
            None => {
                let names: Vec<&str> = record.members.iter().map(|m| m.name.as_str()).take(6).collect();
                format!("; its members are {}", names.join(", "))
            }
        };
        err(line, format!("'{name}' is not a member of {}{suggestion}", self.rec.type_name(CTy::Rec(id, 0))))
    }

    // -- expressions ----------------------------------------------------------

    /// An identifier in an expression.
    #[inline(never)]
    pub(super) fn name_expr(&mut self, name: String, line: usize) -> Result<Expr, TranslateError> {
        let entry = match self.rec.lookup(&name) {
            None | Some(Entry::Var { ty: CTy::Scalar(_), .. }) => return Ok(Expr::Var(name, line)),
            Some(entry) => entry.clone(),
        };
        match entry {
            Entry::Enumerator(v) => Ok(num(v, line)),
            Entry::Type(_) => Err(err(line, format!("'{name}' is a type name, so it cannot be used as a value here"))),
            Entry::Var { ty: CTy::Rec(id, d), len, indirect, .. } => {
                let e = match (len, d, indirect) {
                    (_, 0, false) => self.object_address(&name, line),
                    _ => Expr::Var(name.clone(), line),
                };
                Ok(match len {
                    Some(n) => self.mark(Mark::Array(CTy::Rec(id, d), n), e, &name, line),
                    None => self.mark(Mark::Rec(id, d), e, &name, line),
                })
            }
            Entry::Var { .. } => Ok(Expr::Var(name, line)),
        }
    }

    /// `base + offset` on a `char *`, folding constant offsets.
    fn offset(&self, base: Expr, off: i64, line: usize) -> Expr {
        if off == 0 {
            return base;
        }
        if let Expr::Binary("+", a, b, l) = &base {
            if let Expr::Num(k, t, _) = &**b {
                if *t == ScalarType::I32 && !self.is_marked(a) {
                    return Expr::Binary("+", a.clone(), Box::new(num(k + off, line)), *l);
                }
            }
        }
        Expr::Binary("+", Box::new(base), Box::new(num(off, line)), line)
    }

    fn cast_to(t: ScalarType, e: Expr, line: usize) -> Result<Expr, TranslateError> {
        let op = pointer_cast_op(t).ok_or_else(|| err(line, "unsupported: this pointer type is too deep"))?;
        Ok(Expr::Unary(op, Box::new(e), line))
    }

    /// The scalar of type `t` at `addr` (a `char *`), as an lvalue.
    fn scalar_place(&self, addr: Expr, t: ScalarType, line: usize) -> Result<Expr, TranslateError> {
        if t == uchar() {
            return Ok(deref(addr, line));
        }
        let pointer = t.pointer_to().ok_or_else(|| err(line, "unsupported: this member type cannot be accessed"))?;
        Ok(deref(Self::cast_to(pointer, addr, line)?, line))
    }

    /// The struct pointer (depth `d`) stored at `addr`, as an lvalue.
    fn pointer_place(&self, addr: Expr, d: u8, line: usize) -> Expr {
        let t = ScalarType::Ptr(IntTy { bits: 8, signed: false }, d + 1);
        match Self::cast_to(t, addr.clone(), line) {
            Ok(cast) => deref(cast, line),
            Err(_) => deref(addr, line),
        }
    }

    /// `s.m` / `p->m`.
    #[inline(never)]
    pub(super) fn member_suffix(&mut self, e: Expr, line: usize) -> Result<Expr, TranslateError> {
        let arrow = self.next() == Tok::Sym("->");
        let op = if arrow { "->" } else { "." };
        let field = match self.next() {
            Tok::Ident(n) => n,
            t => return Err(err(line, format!("expected a member name after '{op}', found {}", show(&t)))),
        };
        let hint = self.hint_of(&e);
        let shown = if hint.is_empty() { field.clone() } else { hint.clone() };
        let id = match (self.mark_of(&e), arrow) {
            (Some(Mark::Rec(id, 0)), false) | (Some(Mark::Rec(id, 1)), true) => id,
            (Some(Mark::Array(CTy::Rec(id, 0), _)), true) => id,
            (Some(Mark::Rec(id, 0)), true) => {
                return Err(err(
                    line,
                    format!("'{shown}' is a {}, not a pointer, so use '.': {shown}.{field}", self.rec.type_name(CTy::Rec(id, 0))),
                ))
            }
            (Some(Mark::Rec(id, 1)), false) => {
                return Err(err(
                    line,
                    format!("'{shown}' is a pointer to {}, so use '->': {shown}->{field}", self.rec.type_name(CTy::Rec(id, 0))),
                ))
            }
            _ if arrow => {
                return Err(err(line, format!("'->' needs a pointer to a struct or union on its left, like p->{field}")));
            }
            _ => {
                return Err(err(line, format!("'.' needs a struct or union on its left, like s.{field}")));
            }
        };
        if !self.rec.records[id].complete {
            return Err(self.incomplete(id, line, &shown));
        }
        let Some(member) = self.rec.records[id].members.iter().find(|m| m.name == field).cloned() else {
            return Err(self.no_member(CTy::Rec(id, 0), &field, line));
        };
        let addr = self.offset(Self::inner(e), member.offset as i64, line);
        let hint = if hint.is_empty() { field } else { format!("{hint}{op}{}", member.name) };
        self.member_value(addr, member.ty, member.len, &hint, line)
    }

    fn member_value(&mut self, addr: Expr, ty: CTy, len: Option<usize>, hint: &str, line: usize) -> Result<Expr, TranslateError> {
        Ok(match (ty, len) {
            (CTy::Scalar(t), None) => self.scalar_place(addr, t, line)?,
            (CTy::Scalar(t), Some(n)) => {
                let pointer = if t == uchar() {
                    addr
                } else {
                    Self::cast_to(t.pointer_to().unwrap_or(t), addr, line)?
                };
                self.mark(Mark::Array(ty, n), pointer, hint, line)
            }
            (CTy::Rec(id, 0), None) => self.mark(Mark::Rec(id, 0), addr, hint, line),
            (CTy::Rec(_, 0), Some(n)) => self.mark(Mark::Array(ty, n), addr, hint, line),
            (CTy::Rec(id, d), None) => {
                let place = self.pointer_place(addr, d, line);
                self.mark(Mark::Rec(id, d), place, hint, line)
            }
            (CTy::Rec(id, d), Some(n)) => {
                let pointer = Self::cast_to(ScalarType::Ptr(IntTy { bits: 8, signed: false }, d + 1), addr, line)?;
                self.mark(Mark::Array(CTy::Rec(id, d), n), pointer, hint, line)
            }
        })
    }

    /// `e[i]` where `e` is an array or pointer involving a struct.
    #[inline(never)]
    pub(super) fn index_record(&mut self, base: Expr, index: Expr, line: usize) -> Result<Expr, TranslateError> {
        if !self.is_marked(&base) {
            // `s.name[i]`, `p->items[i]`: a pointer stored in a member
            if self.is_member_place(&base) {
                return Ok(deref(Expr::Binary("+", Box::new(base), Box::new(index), line), line));
            }
            return Err(err(line, "only simple arrays can be indexed (a[i])"));
        }
        let hint = self.hint_of(&base);
        let elem = match self.mark_of(&base) {
            Some(Mark::Array(elem, _)) => elem,
            Some(Mark::Rec(id, d)) if d > 0 => CTy::Rec(id, d - 1),
            Some(Mark::Rec(id, _)) => {
                return Err(err(line, format!("'{hint}' is a {}, so it cannot be indexed with [ ]", self.rec.type_name(CTy::Rec(id, 0)))));
            }
            None => return Err(err(line, "only simple arrays can be indexed (a[i])")),
        };
        self.check_store(None, &index, &hint, line)?;
        let pointer = Self::inner(base);
        let hint = format!("{hint}[]");
        self.element(pointer, elem, index, &hint, line)
    }

    fn element(&mut self, pointer: Expr, elem: CTy, index: Expr, hint: &str, line: usize) -> Result<Expr, TranslateError> {
        Ok(match elem {
            CTy::Scalar(_) => deref(Expr::Binary("+", Box::new(pointer), Box::new(index), line), line),
            CTy::Rec(id, 0) => {
                let size = self.record_size(id, line, hint)?;
                let at = match const_value(&index) {
                    Some(k) => self.offset(pointer, k.wrapping_mul(size as i64), line),
                    None => Expr::Binary(
                        "+",
                        Box::new(pointer),
                        Box::new(Expr::Binary("*", Box::new(index), Box::new(num(size as i64, line)), line)),
                        line,
                    ),
                };
                self.mark(Mark::Rec(id, 0), at, hint, line)
            }
            CTy::Rec(id, d) => {
                let e = match pointer {
                    Expr::Var(name, l) => Expr::Index(name, Box::new(index), l),
                    other => deref(Expr::Binary("+", Box::new(other), Box::new(index), line), line),
                };
                self.mark(Mark::Rec(id, d), e, hint, line)
            }
        })
    }

    /// Binary operators with a struct pointer operand: `p + n`, `p - q`.
    #[inline(never)]
    pub(super) fn record_binary(&mut self, op: &'static str, a: Expr, b: Expr, line: usize) -> Result<Expr, TranslateError> {
        if !self.is_marked(&a) && !self.is_marked(&b) {
            return Ok(Expr::Binary(op, Box::new(a), Box::new(b), line));
        }
        let (ma, mb) = (self.mark_of(&a).and_then(Self::decay), self.mark_of(&b).and_then(Self::decay));
        if !matches!(op, "+" | "-") {
            for (m, e) in [(ma, &a), (mb, &b)] {
                if let Some(Mark::Rec(id, 0)) = m {
                    return Err(self.struct_as_value(id, &self.hint_of(e), line));
                }
            }
            return Ok(Expr::Binary(op, Box::new(a), Box::new(b), line));
        }
        let hint = self.hint_of(if ma.is_some() { &a } else { &b });
        match (ma, mb) {
            (Some(Mark::Rec(id, 0)), _) | (_, Some(Mark::Rec(id, 0))) => Err(self.struct_as_value(id, &hint, line)),
            (Some(Mark::Rec(id, d)), None) => {
                let step = self.scaled(b, id, d, line, &hint)?;
                let e = Expr::Binary(op, Box::new(Self::inner(a)), Box::new(step), line);
                Ok(self.mark(Mark::Rec(id, d), e, &hint, line))
            }
            (None, Some(Mark::Rec(id, d))) if op == "+" => {
                let step = self.scaled(a, id, d, line, &hint)?;
                let e = Expr::Binary(op, Box::new(Self::inner(b)), Box::new(step), line);
                Ok(self.mark(Mark::Rec(id, d), e, &hint, line))
            }
            (Some(Mark::Rec(i1, d1)), Some(Mark::Rec(i2, d2))) if op == "-" => {
                if (i1, d1) != (i2, d2) {
                    return Err(err(
                        line,
                        format!(
                            "'{hint}' cannot be subtracted from a pointer of another type ({} and {})",
                            self.rec.type_name(CTy::Rec(i1, d1)),
                            self.rec.type_name(CTy::Rec(i2, d2))
                        ),
                    ));
                }
                let diff = Expr::Binary("-", Box::new(Self::inner(a)), Box::new(Self::inner(b)), line);
                if d1 > 1 {
                    return Ok(diff);
                }
                let size = self.record_size(i1, line, &hint)?;
                Ok(Expr::Binary("/", Box::new(diff), Box::new(num(size as i64, line)), line))
            }
            _ => Ok(Expr::Binary(op, Box::new(a), Box::new(b), line)),
        }
    }

    /// An integer step for a struct pointer: times the struct size at
    /// depth 1 (deeper pointers step by a pointer, which codegen scales).
    fn scaled(&self, n: Expr, id: usize, d: u8, line: usize, hint: &str) -> Result<Expr, TranslateError> {
        if self.is_marked(&n) {
            return Err(err(line, format!("invalid pointer arithmetic with '{hint}': only a pointer and an integer can be added")));
        }
        if d > 1 {
            return Ok(n);
        }
        let size = self.record_size(id, line, hint)? as i64;
        Ok(match const_value(&n) {
            Some(k) => num(k.wrapping_mul(size), line),
            None if size == 1 => n,
            None => Expr::Binary("*", Box::new(n), Box::new(num(size, line)), line),
        })
    }

    /// Unary `&` and `*` (C only).
    #[inline(never)]
    pub(super) fn pointer_unary(&mut self, op: &'static str, operand: Expr, line: usize) -> Result<Expr, TranslateError> {
        let hint = self.hint_of(&operand);
        match (op, self.mark_of(&operand)) {
            ("&", None) => match operand {
                // `&s.x`, `&p->x`, `&a[i].x`: the member's address
                Expr::Unary("*", inner, _) if self.is_member_address(&inner) => Ok(*inner),
                other => Ok(Expr::Unary(op, Box::new(other), line)),
            },
            ("&", Some(Mark::Rec(id, 0))) => {
                let address = Self::inner(operand);
                Ok(self.mark(Mark::Rec(id, 1), address, &hint, line))
            }
            ("&", Some(Mark::Rec(id, d))) => {
                if d >= MAX_POINTER_DEPTH {
                    return Err(err(line, format!("unsupported: pointers deeper than {MAX_POINTER_DEPTH} levels")));
                }
                let e = match Self::inner(operand) {
                    Expr::Unary("*", inner, _) => *inner,
                    other => Expr::Unary("&", Box::new(other), line),
                };
                Ok(self.mark(Mark::Rec(id, d + 1), e, &hint, line))
            }
            ("&", Some(Mark::Array(..))) => Err(err(
                line,
                format!("unsupported: pointers to arrays ('&{hint}'); use '{hint}' itself, which already points at its first element"),
            )),
            ("*", Some(Mark::Rec(id, 0))) => Err(err(
                line,
                format!("'{hint}' is a {}, not a pointer, so it cannot be dereferenced with *", self.rec.type_name(CTy::Rec(id, 0))),
            )),
            ("*", Some(Mark::Rec(id, 1))) => {
                let address = Self::inner(operand);
                Ok(self.mark(Mark::Rec(id, 0), address, &hint, line))
            }
            ("*", Some(Mark::Rec(id, d))) => {
                let e = deref(Self::inner(operand), line);
                Ok(self.mark(Mark::Rec(id, d - 1), e, &hint, line))
            }
            ("*", Some(Mark::Array(elem, _))) => {
                let pointer = Self::inner(operand);
                self.element(pointer, elem, num(0, line), &hint, line)
            }
            _ => Ok(Expr::Unary(op, Box::new(operand), line)),
        }
    }

    /// Is `e` a member read built here (`*(T *)(address)`)?
    #[inline(never)]
    pub(super) fn is_member_place(&self, e: &Expr) -> bool {
        matches!(e, Expr::Unary("*", inner, _) if self.is_member_address(inner))
    }

    /// Is `e` a member address built here (a pointer cast of a `char *`)?
    fn is_member_address(&self, e: &Expr) -> bool {
        match e {
            Expr::Unary(op, inner, _) if op.ends_with("*)") => {
                matches!(&**inner, Expr::Binary("+", ..)) || self.is_marked(inner) || matches!(&**inner, Expr::Unary(..) | Expr::Var(..))
            }
            _ => false,
        }
    }

    /// `p++`, `--p` on a struct pointer.
    #[inline(never)]
    pub(super) fn record_increment(&mut self, e: Expr, provenance: AssignmentProvenance, line: usize) -> Result<Expr, TranslateError> {
        let hint = self.hint_of(&e);
        match self.mark_of(&e) {
            Some(Mark::Rec(id, d)) if d > 0 => {
                let step = if d == 1 { self.record_size(id, line, &hint)? as i64 } else { 1 };
                let lv = Parser::to_lvalue(&Self::inner(e)).ok_or_else(|| err(line, "++/-- needs a variable"))?;
                let assign = Expr::Assign(Box::new(lv), Box::new(num(step, line)), provenance, line);
                Ok(self.mark(Mark::Rec(id, d), assign, &hint, line))
            }
            Some(Mark::Rec(id, _)) => Err(err(
                line,
                format!("++ and -- need a number or a pointer, but '{hint}' is a {}", self.rec.type_name(CTy::Rec(id, 0))),
            )),
            _ => Err(err(line, "++/-- needs a variable")),
        }
    }

    /// `lhs op rhs` where `lhs` involves a struct: a struct copy, or a
    /// struct pointer update.
    #[inline(never)]
    pub(super) fn record_assignment(&mut self, lhs: Expr, provenance: AssignmentProvenance, line: usize) -> Result<Expr, TranslateError> {
        self.enter()?;
        let rhs = self.parse_assign()?;
        self.leave();
        self.finish_record_assignment(lhs, rhs, provenance, line)
    }

    #[inline(never)]
    fn finish_record_assignment(&mut self, lhs: Expr, rhs: Expr, provenance: AssignmentProvenance, line: usize) -> Result<Expr, TranslateError> {
        let hint = self.hint_of(&lhs);
        match self.mark_of(&lhs) {
            Some(Mark::Rec(id, 0)) => {
                if provenance != AssignmentProvenance::Simple {
                    return Err(err(
                        line,
                        format!("'{hint}' is a whole {}; only '=' copies a struct, other operators need a member", self.rec.type_name(CTy::Rec(id, 0))),
                    ));
                }
                if self.mark_of(&rhs) != Some(Mark::Rec(id, 0)) {
                    let found = self.type_hint(&rhs).map(|t| self.rec.type_name(t)).unwrap_or_else(|| "number".into());
                    return Err(err(
                        line,
                        format!(
                            "'{hint}' is a {}, so it can only be assigned another {} (this value is a {found})",
                            self.rec.type_name(CTy::Rec(id, 0)),
                            self.rec.type_name(CTy::Rec(id, 0))
                        ),
                    ));
                }
                let size = self.record_size(id, line, &hint)?;
                let copy = self.copy_call(Self::inner(lhs), Self::inner(rhs), size, line);
                Ok(self.mark(Mark::Rec(id, 0), copy, &hint, line))
            }
            Some(Mark::Rec(id, d)) => {
                let target = Self::inner(lhs);
                let lv = Parser::to_lvalue(&target).ok_or_else(|| {
                    err(line, "left side of '=' must be a variable, array element, member or *pointer")
                })?;
                let value = match provenance {
                    AssignmentProvenance::Simple => {
                        self.check_pointer_value(&rhs, CTy::Rec(id, d), &hint, line)?;
                        Self::inner(rhs)
                    }
                    // already scaled: codegen scales by the element size,
                    // which is 1 for the `char *` a struct pointer becomes
                    AssignmentProvenance::Compound("+" | "-") => self.scaled(rhs, id, d, line, &hint)?,
                    _ => {
                        return Err(err(line, "invalid pointer arithmetic: only p += n, p -= n, p++ and p-- update a pointer"));
                    }
                };
                let assign = Expr::Assign(Box::new(lv), Box::new(value), provenance, line);
                Ok(self.mark(Mark::Rec(id, d), assign, &hint, line))
            }
            Some(Mark::Array(..)) => Err(err(line, format!("cannot assign to array '{hint}' as a whole"))),
            None => Err(err(line, "left side of '=' must be a variable, array element, member or *pointer")),
        }
    }

    /// `lhs = rhs` for a plain target: a struct value on the right is an
    /// error, a struct pointer must suit the target.
    #[inline(never)]
    pub(super) fn finish_assignment(
        &mut self,
        lhs: &Expr,
        lv: LValue,
        rhs: Expr,
        provenance: AssignmentProvenance,
        line: usize,
    ) -> Result<Expr, TranslateError> {
        if self.is_marked(&rhs) {
            let name = match lhs {
                Expr::Var(name, _) => name.clone(),
                _ => "the left side".to_string(),
            };
            self.check_store(self.lvalue_hint(lhs), &rhs, &name, line)?;
        }
        Ok(Expr::Assign(Box::new(lv), Box::new(rhs), provenance, line))
    }

    /// The type of a scalar assignment target the parser knows.
    #[inline(never)]
    pub(super) fn lvalue_hint(&self, lhs: &Expr) -> Option<ScalarType> {
        match lhs {
            Expr::Var(name, _) => match self.rec.lookup(name) {
                Some(Entry::Var { ty: CTy::Scalar(t), len: None, .. }) => Some(*t),
                _ => None,
            },
            _ => None,
        }
    }

    fn copy_call(&mut self, to: Expr, from: Expr, size: usize, line: usize) -> Expr {
        self.rec.uses_copy = true;
        Expr::Call(COPY_HELPER.to_string(), vec![to, from, num(size as i64, line)], line)
    }

    /// A fresh struct temporary in the current function's frame; its
    /// address.
    fn temporary(&mut self, id: usize, line: usize) -> Result<Expr, TranslateError> {
        self.rec.temps += 1;
        let name = format!("__tmp{}", self.rec.temps);
        let size = self.record_size(id, line, "")?;
        let align = self.rec.records[id].align;
        self.rec.hoisted.push(Stmt::DeclArray(
            name.clone(),
            size / align,
            Vec::new(),
            BindingProvenance { declared_type: Some(RecordState::word(align)), mutable: false, initialized: false, origin: BindingOrigin::Local },
            ArrayInitProvenance::Absent,
            line,
        ));
        let var = Expr::Var(name, line);
        Ok(if RecordState::word(align) == uchar() {
            var
        } else {
            Self::cast_to(ScalarType::Ptr(IntTy { bits: 8, signed: false }, 1), var, line)?
        })
    }

    /// A call `name(args)`: structs by value go through the internal
    /// convention described at the top of this file.
    #[inline(never)]
    pub(super) fn finish_call(&mut self, name: String, args: Vec<Expr>, line: usize) -> Result<Expr, TranslateError> {
        let Some(sig) = self.rec.sigs.get(&name).cloned() else {
            if let Some(i) = args.iter().position(|a| matches!(self.mark_of(a), Some(Mark::Rec(_, 0)))) {
                return Err(err(
                    line,
                    format!(
                        "'{name}' is called with a struct (argument {}), but it is not declared yet; define '{name}' \
                         above this call, or add a prototype for it",
                        i + 1
                    ),
                ));
            }
            if !self.rec.records.is_empty() {
                self.rec.early_calls.push((name.clone(), line));
            }
            return Ok(Expr::Call(name, args, line));
        };
        if !sig.has_records() {
            for (arg, param) in args.iter().zip(&sig.params) {
                if let CTy::Scalar(t) = param {
                    self.check_store(Some(*t), arg, &format!("{name}()'s parameter"), line)?;
                }
            }
            return Ok(Expr::Call(name, args, line));
        }
        if args.len() != sig.params.len() {
            return Err(err(
                line,
                format!("function '{name}' expects {} arguments, but {} were provided", sig.params.len(), args.len()),
            ));
        }
        let mut lowered = Vec::with_capacity(args.len() + 1);
        if let CTy::Rec(id, 0) = sig.ret {
            lowered.push(self.temporary(id, line)?);
        }
        for (i, (arg, param)) in args.into_iter().zip(&sig.params).enumerate() {
            let what = format!("argument {} of '{name}'", i + 1);
            match *param {
                CTy::Rec(id, 0) => {
                    if self.mark_of(&arg) != Some(Mark::Rec(id, 0)) {
                        return Err(err(
                            line,
                            format!("{what} must be a {}", self.rec.type_name(CTy::Rec(id, 0))),
                        ));
                    }
                    let size = self.record_size(id, line, &name)?;
                    let copy = self.temporary(id, line)?;
                    lowered.push(self.copy_call(copy, Self::inner(arg), size, line));
                }
                CTy::Rec(id, d) => {
                    self.check_pointer_value(&arg, CTy::Rec(id, d), &name, line)?;
                    lowered.push(Self::inner(arg));
                }
                CTy::Scalar(t) => {
                    self.check_store(Some(t), &arg, &what, line)?;
                    lowered.push(arg);
                }
            }
        }
        let call = Expr::Call(name.clone(), lowered, line);
        Ok(match sig.ret {
            CTy::Rec(id, d) => self.mark(Mark::Rec(id, d), call, &name, line),
            CTy::Scalar(_) => call,
        })
    }

    /// `return e;` in the current function.
    #[inline(never)]
    pub(super) fn lower_return(&mut self, value: Option<Expr>, line: usize) -> Result<Option<Expr>, TranslateError> {
        let Some((function, ret)) = self.rec.function.clone() else { return Ok(value) };
        match (ret, value) {
            (CTy::Rec(_, 0), None) => Err(err(
                line,
                format!("'{function}' must return a value: it returns a {}, so write 'return value;'", self.rec.type_name(ret)),
            )),
            (CTy::Rec(id, 0), Some(value)) => {
                if self.mark_of(&value) != Some(Mark::Rec(id, 0)) {
                    return Err(err(
                        line,
                        format!("'{function}' returns a {}, but this value is not one", self.rec.type_name(ret)),
                    ));
                }
                let size = self.record_size(id, line, &function)?;
                let to = Expr::Var(RESULT_PARAM.to_string(), line);
                Ok(Some(self.copy_call(to, Self::inner(value), size, line)))
            }
            (CTy::Rec(id, d), Some(value)) => {
                self.check_pointer_value(&value, CTy::Rec(id, d), &function, line)?;
                Ok(Some(Self::inner(value)))
            }
            (CTy::Scalar(t), Some(value)) => {
                self.check_store(Some(t), &value, &function, line)?;
                Ok(Some(value))
            }
            (_, None) => Ok(None),
        }
    }

    /// `(struct T *)e`, `(Typedef)e`.
    #[inline(never)]
    pub(super) fn record_cast(&mut self, line: usize) -> Result<Expr, TranslateError> {
        self.next(); // (
        let base = self.parse_type_spec()?;
        let ty = self.parse_stars(base, line)?;
        if !self.eat_sym(")") {
            return Err(err(line, format!("expected ')' after the type in a cast, found {}", show(self.peek()))));
        }
        let operand = self.parse_unary_operand()?;
        match ty {
            CTy::Rec(id, 0) => Err(err(
                line,
                format!(
                    "cannot cast to '{}' itself ({}): a cast can only make a number or a pointer",
                    self.tag_token(id),
                    self.rec.type_name(ty)
                ),
            )),
            CTy::Rec(id, d) => {
                let hint = self.hint_of(&operand);
                if let Some(Mark::Rec(other, 0)) = self.mark_of(&operand) {
                    return Err(self.struct_as_value(other, &hint, line));
                }
                let cast = Self::cast_to(RecordState::lowered(ty), Self::inner(operand), line)?;
                Ok(self.mark(Mark::Rec(id, d), cast, &hint, line))
            }
            CTy::Scalar(t) => {
                if let Some(Mark::Rec(other, 0)) = self.mark_of(&operand) {
                    return Err(self.struct_as_value(other, &self.hint_of(&operand), line));
                }
                let op = if t.is_ptr() {
                    pointer_cast_op(t)
                } else {
                    C_CAST_OPS.iter().find(|(k, _)| super::c_int_type(k) == Some(t)).map(|(_, op)| *op)
                };
                let op = op.ok_or_else(|| err(line, format!("unsupported: casts to '{}'", c_type_name(t).trim_end())))?;
                Ok(Expr::Unary(op, Box::new(Self::inner(operand)), line))
            }
        }
    }

    /// `sizeof(struct T)`, `sizeof(Typedef *)`.
    #[inline(never)]
    pub(super) fn record_sizeof_type(&mut self, line: usize) -> Result<Expr, TranslateError> {
        self.next(); // (
        let base = self.parse_type_spec()?;
        let ty = self.parse_stars(base, line)?;
        self.expect_sym(")")?;
        let size = match ty {
            CTy::Rec(id, 0) => self.record_size(id, line, "")?,
            CTy::Scalar(ScalarType::Unit) => return Err(err(line, "sizeof('void') has no meaning; use sizeof on a real type")),
            other => self.rec.size_align(other).0,
        };
        Ok(Expr::Num(size as i64, ulong(), line))
    }

    /// `sizeof e` for an expression involving a struct.
    #[inline(never)]
    pub(super) fn record_sizeof_expr(&mut self, e: Expr, line: usize) -> Result<Expr, TranslateError> {
        let size = match self.mark_of(&e) {
            None => return Ok(Expr::Unary("sizeof", Box::new(e), line)),
            Some(Mark::Rec(id, 0)) => self.record_size(id, line, &self.hint_of(&e))?,
            Some(Mark::Rec(..)) => self.rec.pointer_bytes(),
            Some(Mark::Array(elem, n)) => {
                let s = match elem {
                    CTy::Rec(id, 0) => self.record_size(id, line, &self.hint_of(&e))?,
                    other => self.rec.size_align(other).0,
                };
                s * n
            }
        };
        Ok(Expr::Num(size as i64, ulong(), line))
    }

    // -- functions ----------------------------------------------------------

    /// After `type name`: the parameter list and the body or `;`.
    pub(super) fn parse_function_rest(&mut self, ret: CTy, name: String, line: usize) -> Result<ParsedFunction, TranslateError> {
        if name == "main" && ret != CTy::Scalar(ScalarType::I32) {
            return Err(err(line, "main() must return int"));
        }
        if let CTy::Rec(id, 0) = ret {
            self.record_size(id, line, &name)?;
        }
        self.expect_sym("(")?;
        let mut params: Vec<String> = Vec::new();
        let mut types: Vec<CTy> = Vec::new();
        let mut lines = Vec::new();
        if *self.peek() == Tok::Kw("void") && *self.peek2() == Tok::Sym(")") {
            self.next(); // `f(void)`: no parameters
        }
        if !self.eat_sym(")") {
            loop {
                let pline = self.line();
                let ty = if self.record_type_at(0) {
                    if *self.peek() == Tok::Kw("typedef") {
                        return Err(err(pline, "'typedef' cannot appear in a parameter list"));
                    }
                    let base = self.parse_type_spec()?;
                    self.parse_stars(base, pline)?
                } else {
                    let base = match self.next() {
                        Tok::Kw(k) if super::c_int_type(k).is_some() => super::c_int_type(k).unwrap_or(ScalarType::I32),
                        Tok::Kw("bool") => ScalarType::Bool,
                        Tok::Kw("void") if self.pointers && *self.peek() == Tok::Sym("*") => ScalarType::Unit,
                        token => {
                            return Err(err(
                                self.line(),
                                format!("parameters must be 'int name' or 'bool name', found {}", show(&token)),
                            ))
                        }
                    };
                    let l = self.line();
                    CTy::Scalar(self.parse_pointer_suffix(base, l, "pointer parameters")?)
                };
                if ty == CTy::Scalar(ScalarType::Unit) {
                    return Err(err(pline, "a parameter cannot have type 'void'"));
                }
                if let CTy::Rec(id, 0) = ty {
                    self.record_size(id, pline, "")?;
                }
                let parameter_line = self.line();
                match self.next() {
                    Tok::Ident(p) => {
                        if *self.peek() == Tok::Sym("[") {
                            return Err(err(
                                parameter_line,
                                format!("unsupported: array parameters ('{p}' has [ ]); write a pointer parameter, like int *{p}"),
                            ));
                        }
                        params.push(p);
                        types.push(ty);
                        lines.push(parameter_line);
                    }
                    t => return Err(err(self.line(), format!("expected parameter name, found {}", show(&t)))),
                }
                if self.eat_sym(")") {
                    break;
                }
                self.expect_sym(",")?;
            }
        }
        let hidden = usize::from(matches!(ret, CTy::Rec(_, 0)));
        if params.len() + hidden > 7 {
            return Err(err(
                line,
                if hidden == 1 {
                    "unsupported: more than 6 parameters in a function that returns a struct (the struct result \
                     takes one of the 7 argument registers)"
                } else {
                    "unsupported: more than 7 parameters"
                },
            ));
        }
        if name == "main" && !params.is_empty() {
            return Err(err(line, "main() cannot take parameters in the simulator entry model"));
        }
        let sig = Sig { params: types.clone(), ret, line };
        if let Some(previous) = self.rec.sigs.get(&name) {
            if (previous.has_records() || sig.has_records()) && (previous.params != sig.params || previous.ret != sig.ret) {
                return Err(err(
                    line,
                    format!(
                        "'{name}' is declared with different types here than on line {}; make the declarations match",
                        previous.line
                    ),
                ));
            }
        }
        if sig.has_records() {
            if let Some((_, first)) = self.rec.early_calls.iter().find(|(n, _)| *n == name) {
                return Err(err(
                    *first,
                    format!(
                        "'{name}' takes or returns a struct, so it must be declared before its first use; \
                         move '{name}' above this call, or add a prototype"
                    ),
                ));
            }
        }
        if !self.rec.sigs.contains_key(&name) || sig.has_records() {
            self.rec.sigs.insert(name.clone(), sig);
        }
        let mut lowered_params = params.clone();
        let mut lowered_types: Vec<ScalarType> = types.iter().map(|t| RecordState::lowered(*t)).collect();
        let mut lowered_lines = lines.clone();
        if hidden == 1 {
            lowered_params.insert(0, RESULT_PARAM.to_string());
            lowered_types.insert(0, ScalarType::Ptr(IntTy { bits: 8, signed: false }, 1));
            lowered_lines.insert(0, line);
        }
        let return_type = match ret {
            CTy::Rec(_, d) => ScalarType::Ptr(IntTy { bits: 8, signed: false }, d.max(1)),
            CTy::Scalar(t) => t,
        };
        if hidden == 1 || types.iter().any(|t| matches!(t, CTy::Rec(_, 0))) {
            self.mark_memory(line);
        }
        if self.eat_sym(";") {
            return Ok(ParsedFunction::Prototype(FunctionPrototype {
                name,
                parameters: lowered_params,
                parameter_types: lowered_types,
                return_type,
                line,
            }));
        }
        self.expect_sym("{")?;
        self.rec.push_scope();
        for (p, t) in params.iter().zip(&types) {
            match t {
                CTy::Scalar(s) => self.rec.declare_scalar(p, Some(*s), None),
                CTy::Rec(..) => self.declare_record_var(p, *t, None, false, matches!(t, CTy::Rec(_, 0))),
            }
        }
        let outer = self.rec.function.replace((name.clone(), ret));
        let hoisted = std::mem::take(&mut self.rec.hoisted);
        let body = self.parse_block_body();
        let mut temps = std::mem::replace(&mut self.rec.hoisted, hoisted);
        self.rec.function = outer;
        self.rec.pop_scope();
        let mut body = body?;
        if !temps.is_empty() {
            temps.append(&mut body);
            body = temps;
        }
        Ok(ParsedFunction::Definition(Func {
            name,
            params: lowered_params,
            param_mutability: vec![false; params.len() + hidden],
            param_types: lowered_types,
            param_lines: lowered_lines,
            return_type,
            origin: FunctionOrigin::Explicit,
            body,
            line,
        }))
    }

    /// A prototype without a body is defined by hand-written assembly,
    /// which follows the psABI; the internal struct-by-value convention
    /// would not match it, so such a prototype must use pointers.
    pub(super) fn check_external_prototypes(&self, funcs: &[Func], prototypes: &[FunctionPrototype]) -> Result<(), TranslateError> {
        for prototype in prototypes {
            if funcs.iter().any(|f| f.name == prototype.name) {
                continue;
            }
            let Some(sig) = self.rec.sigs.get(&prototype.name) else { continue };
            if sig.params.iter().chain(std::iter::once(&sig.ret)).any(|t| matches!(t, CTy::Rec(_, 0))) {
                return Err(err(
                    prototype.line,
                    format!(
                        "'{}' has no body here, so hand-written assembly must define it, and assembly cannot take \
                         or return a struct by value; pass a pointer to the struct instead",
                        prototype.name
                    ),
                ));
            }
        }
        Ok(())
    }

    /// Temporaries made outside any function (statements of a program
    /// without main()).
    pub(super) fn take_hoisted(&mut self) -> Vec<Stmt> {
        std::mem::take(&mut self.rec.hoisted)
    }

    pub(super) fn take_record_globals(&mut self) -> Vec<Global> {
        std::mem::take(&mut self.rec.globals)
    }

    /// The struct copy helper, when the program copies structs.
    pub(super) fn copy_helper(&self) -> Result<Option<Func>, TranslateError> {
        if !self.rec.uses_copy {
            return Ok(None);
        }
        let mut tokens = super::lex(COPY_HELPER_SOURCE)?;
        for t in &mut tokens {
            t.line = 0; // generated code belongs to no source line
        }
        let mut parser = Parser::new_c(tokens);
        match parser.parse_func()? {
            ParsedFunction::Definition(f) => Ok(Some(f)),
            ParsedFunction::Prototype(_) => Ok(None),
        }
    }

    // -- the marker sweep -----------------------------------------------------

    /// Remove every marker from the parsed functions. A struct value left
    /// where a number is needed is an error.
    pub(super) fn strip_marks(&self, funcs: &mut [Func]) -> Result<(), TranslateError> {
        if self.rec.marks.is_empty() {
            return Ok(());
        }
        for f in funcs {
            self.strip_stmts(&mut f.body)?;
        }
        Ok(())
    }

    fn strip_stmts(&self, stmts: &mut [Stmt]) -> Result<(), TranslateError> {
        for s in stmts {
            match s {
                Stmt::Decl(_, Some(e), _, _) | Stmt::Return(Some(e), _, _) => self.strip_expr(e, false)?,
                Stmt::Expr(e, _) => self.strip_expr(e, true)?,
                Stmt::DeclArray(_, _, init, _, _, _) => init.iter_mut().try_for_each(|e| self.strip_expr(e, false))?,
                Stmt::If(c, a, b, _) => {
                    self.strip_expr(c, false)?;
                    self.strip_stmts(a)?;
                    self.strip_stmts(b)?;
                }
                Stmt::While(c, body, _) => {
                    self.strip_expr(c, false)?;
                    self.strip_stmts(body)?;
                }
                Stmt::For(init, c, step, body, _) => {
                    if let Some(init) = init {
                        self.strip_stmts(std::slice::from_mut(&mut **init))?;
                    }
                    if let Some(c) = c {
                        self.strip_expr(c, false)?;
                    }
                    if let Some(step) = step {
                        self.strip_expr(step, true)?;
                    }
                    self.strip_stmts(body)?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Iterative, so deep expression trees cannot exhaust the stack.
    fn strip_expr(&self, e: &mut Expr, statement: bool) -> Result<(), TranslateError> {
        let mut work: Vec<(&mut Expr, bool)> = vec![(e, statement)];
        while let Some((e, top)) = work.pop() {
            while let Some(i) = Self::mark_index(e) {
                let (mark, hint) = &self.rec.marks[i];
                if let (Mark::Rec(id, 0), false) = (mark, top) {
                    return Err(self.struct_as_value(*id, hint, super::expr_line(e)));
                }
                let inner = match e {
                    Expr::Call(_, args, _) => args.pop(),
                    _ => None,
                };
                if let Some(inner) = inner {
                    *e = inner;
                }
            }
            match e {
                Expr::Num(..) | Expr::Var(..) => {}
                Expr::Index(_, i, _) | Expr::Unary(_, i, _) => work.push((i, false)),
                Expr::Binary(_, a, b, _) => {
                    work.push((a, false));
                    work.push((b, false));
                }
                Expr::Assign(target, value, _, _) => {
                    match &mut **target {
                        LValue::Index(_, i, _) | LValue::Deref(i, _) => work.push((i, false)),
                        LValue::Var(..) => {}
                    }
                    work.push((value, false));
                }
                Expr::Call(_, args, _) => work.extend(args.iter_mut().map(|a| (a, false))),
            }
        }
        Ok(())
    }
}

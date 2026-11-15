use super::{
    lex, parse_cpp_unit, parse_rust_unit, ArrayInitProvenance, BindingOrigin, Expr, Func,
    FunctionOrigin, LValue, LoopKind, Parser, ReturnProvenance, ScalarType, Stmt, TranslateError,
    Unit,
};
#[cfg(test)]
use super::{AssignmentProvenance, BodyForm, ElseForm, ExprStmtProvenance, IfOrigin};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HirLanguage {
    C,
    Cpp,
    Rust,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HirType {
    I32,
    Bool,
    Unit,
}

impl From<ScalarType> for HirType {
    fn from(value: ScalarType) -> Self {
        match value {
            ScalarType::I32 => Self::I32,
            ScalarType::Bool => Self::Bool,
            ScalarType::Unit => Self::Unit,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HirBindingKind {
    Parameter,
    Local,
    RangeIterator,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HirTypeAnnotation {
    Explicit,
    Inferred,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HirBinding {
    pub name: String,
    pub value_type: HirType,
    pub mutable: bool,
    pub initialized: bool,
    pub array_len: Option<usize>,
    pub array_initializer: Option<ArrayInitProvenance>,
    pub kind: HirBindingKind,
    pub annotation: HirTypeAnnotation,
    pub line: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HirLoopKind {
    CFor,
    RustRange,
    While,
    RustLoop,
}

impl From<LoopKind> for HirLoopKind {
    fn from(value: LoopKind) -> Self {
        match value {
            LoopKind::CFor => Self::CFor,
            LoopKind::RustRange => Self::RustRange,
            LoopKind::While => Self::While,
            LoopKind::RustLoop => Self::RustLoop,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HirLoop {
    pub kind: HirLoopKind,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HirFunction {
    pub name: String,
    pub return_type: HirType,
    pub bindings: Vec<HirBinding>,
    pub loops: Vec<HirLoop>,
    pub returns: Vec<HirReturn>,
    pub origin: FunctionOrigin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HirReturn {
    pub source: ReturnProvenance,
    pub line: usize,
}

pub(super) struct TypedHir {
    pub language: HirLanguage,
    pub ast: Unit,
    pub functions: Vec<HirFunction>,
}

pub(super) fn typed_hir_from_c(source: &str) -> Result<TypedHir, TranslateError> {
    let tokens = lex(source)?;
    let mut parser = Parser::new(tokens);
    Ok(build_hir(HirLanguage::C, parser.parse_unit()?))
}

pub(super) fn typed_hir_from_rust(source: &str) -> Result<TypedHir, TranslateError> {
    Ok(build_hir(HirLanguage::Rust, parse_rust_unit(source)?))
}

pub(super) fn typed_hir_from_cpp(source: &str) -> Result<TypedHir, TranslateError> {
    Ok(build_hir(HirLanguage::Cpp, parse_cpp_unit(source)?))
}

fn infers_mutability(language: HirLanguage) -> bool {
    matches!(language, HirLanguage::C | HirLanguage::Cpp)
}

fn build_hir(language: HirLanguage, unit: Unit) -> TypedHir {
    let return_types = unit
        .funcs
        .iter()
        .map(|function| (function.name.clone(), function.return_type.into()))
        .collect::<HashMap<_, _>>();
    let functions = unit
        .funcs
        .iter()
        .map(|function| build_function(language, function, &return_types))
        .collect();
    TypedHir {
        language,
        ast: unit,
        functions,
    }
}

struct PendingBinding {
    name: String,
    value_type: HirType,
    mutable: bool,
    initialized: bool,
    array_len: Option<usize>,
    array_initializer: Option<ArrayInitProvenance>,
    kind: HirBindingKind,
    annotation: HirTypeAnnotation,
    line: usize,
}

#[derive(Default)]
struct AstAnalysis {
    bindings: Vec<PendingBinding>,
    loops: Vec<HirLoop>,
    returns: Vec<HirReturn>,
    mutations: HashSet<String>,
    types: HashMap<String, HirType>,
}

fn build_function(
    language: HirLanguage,
    function: &Func,
    return_types: &HashMap<String, HirType>,
) -> HirFunction {
    let mut analysis = AstAnalysis::default();
    for (name, value_type) in function.params.iter().zip(&function.param_types) {
        analysis.types.insert(name.clone(), (*value_type).into());
    }
    analyze_statements(language, &function.body, return_types, &mut analysis);

    let mut bindings = function
        .params
        .iter()
        .zip(&function.param_types)
        .zip(&function.param_mutability)
        .zip(&function.param_lines)
        .map(|(((name, value_type), source_mutable), line)| HirBinding {
            name: name.clone(),
            value_type: (*value_type).into(),
            mutable: if infers_mutability(language) {
                analysis.mutations.contains(name)
            } else {
                *source_mutable
            },
            initialized: true,
            array_len: None,
            array_initializer: None,
            kind: HirBindingKind::Parameter,
            annotation: HirTypeAnnotation::Explicit,
            line: *line,
        })
        .collect::<Vec<_>>();
    bindings.extend(analysis.bindings.into_iter().map(|binding| HirBinding {
        name: binding.name.clone(),
        value_type: binding.value_type,
        mutable: if infers_mutability(language) {
            analysis.mutations.contains(&binding.name)
        } else {
            binding.mutable
        },
        initialized: binding.initialized,
        array_len: binding.array_len,
        array_initializer: binding.array_initializer,
        kind: binding.kind,
        annotation: binding.annotation,
        line: binding.line,
    }));
    HirFunction {
        name: function.name.clone(),
        return_type: function.return_type.into(),
        bindings,
        loops: analysis.loops,
        returns: analysis.returns,
        origin: function.origin,
    }
}

fn analyze_statements(
    language: HirLanguage,
    statements: &[Stmt],
    return_types: &HashMap<String, HirType>,
    analysis: &mut AstAnalysis,
) {
    for statement in statements {
        match statement {
            Stmt::Decl(name, initial, source, line) => {
                let value_type = source
                    .declared_type
                    .map(Into::into)
                    .or_else(|| {
                        initial
                            .as_ref()
                            .map(|value| infer_type(language, value, &analysis.types, return_types))
                    })
                    .unwrap_or(HirType::I32);
                analysis.bindings.push(PendingBinding {
                    name: name.clone(),
                    value_type,
                    mutable: source.mutable,
                    initialized: source.initialized,
                    array_len: None,
                    array_initializer: None,
                    kind: match source.origin {
                        BindingOrigin::Local => HirBindingKind::Local,
                        BindingOrigin::RangeIterator => HirBindingKind::RangeIterator,
                    },
                    annotation: if source.declared_type.is_some() {
                        HirTypeAnnotation::Explicit
                    } else {
                        HirTypeAnnotation::Inferred
                    },
                    line: *line,
                });
                analysis.types.insert(name.clone(), value_type);
                initial
                    .iter()
                    .for_each(|value| analyze_expression(value, analysis));
            }
            Stmt::DeclArray(name, size, initial, source, initializer, line) => {
                analysis.bindings.push(PendingBinding {
                    name: name.clone(),
                    value_type: HirType::I32,
                    mutable: source.mutable,
                    initialized: source.initialized,
                    array_len: Some(*size),
                    array_initializer: Some(*initializer),
                    kind: HirBindingKind::Local,
                    annotation: if source.declared_type.is_some() {
                        HirTypeAnnotation::Explicit
                    } else {
                        HirTypeAnnotation::Inferred
                    },
                    line: *line,
                });
                analysis.types.insert(name.clone(), HirType::I32);
                initial
                    .iter()
                    .for_each(|value| analyze_expression(value, analysis));
            }
            Stmt::Expr(expression, _) => {
                analyze_expression(expression, analysis);
            }
            Stmt::Return(value, source, line) => {
                analysis.returns.push(HirReturn {
                    source: *source,
                    line: *line,
                });
                value
                    .iter()
                    .for_each(|expression| analyze_expression(expression, analysis));
            }
            Stmt::If(condition, then_body, else_body, _) => {
                analyze_expression(condition, analysis);
                analyze_statements(language, then_body, return_types, analysis);
                analyze_statements(language, else_body, return_types, analysis);
            }
            Stmt::While(condition, body, source) => {
                analysis.loops.push(HirLoop {
                    kind: source.kind.into(),
                    line: source.line,
                });
                analyze_expression(condition, analysis);
                analyze_statements(language, body, return_types, analysis);
            }
            Stmt::For(initial, condition, post, body, source) => {
                analysis.loops.push(HirLoop {
                    kind: source.kind.into(),
                    line: source.line,
                });
                if let Some(initial) = initial {
                    analyze_statements(
                        language,
                        std::slice::from_ref(&**initial),
                        return_types,
                        analysis,
                    );
                }
                condition
                    .iter()
                    .for_each(|value| analyze_expression(value, analysis));
                post.iter()
                    .for_each(|value| analyze_expression(value, analysis));
                analyze_statements(language, body, return_types, analysis);
            }
            _ => {}
        }
    }
}

fn analyze_expression(expression: &Expr, analysis: &mut AstAnalysis) {
    match expression {
        Expr::Assign(target, value, _, _) => {
            let name = match &**target {
                LValue::Var(name, _) => name,
                LValue::Index(name, index, _) => {
                    analyze_expression(index, analysis);
                    name
                }
            };
            analysis.mutations.insert(name.clone());
            analyze_expression(value, analysis);
        }
        Expr::Index(_, index, _) | Expr::Unary(_, index, _) => analyze_expression(index, analysis),
        Expr::Binary(_, left, right, _) => {
            analyze_expression(left, analysis);
            analyze_expression(right, analysis);
        }
        Expr::Call(_, arguments, _) => {
            arguments
                .iter()
                .for_each(|value| analyze_expression(value, analysis));
        }
        Expr::Num(_, _, _) | Expr::Var(_, _) => {}
    }
}

fn infer_type(
    language: HirLanguage,
    expression: &Expr,
    bindings: &HashMap<String, HirType>,
    return_types: &HashMap<String, HirType>,
) -> HirType {
    match expression {
        Expr::Num(_, value_type, _) => (*value_type).into(),
        Expr::Var(name, _) => bindings.get(name).copied().unwrap_or(HirType::I32),
        Expr::Index(_, _, _) => HirType::I32,
        Expr::Unary("!", _, _) if language == HirLanguage::Cpp => HirType::Bool,
        Expr::Unary("!", value, _) if language == HirLanguage::Rust => {
            infer_type(language, value, bindings, return_types)
        }
        Expr::Unary(_, _, _) => HirType::I32,
        Expr::Binary(operator, left, right, _)
            if matches!(language, HirLanguage::Rust | HirLanguage::Cpp)
                && matches!(
                    *operator,
                    "&&" | "||" | "==" | "!=" | "<" | "<=" | ">" | ">="
                ) =>
        {
            HirType::Bool
        }
        Expr::Binary("&" | "|" | "^", left, right, _)
            if language == HirLanguage::Rust
                && infer_type(language, left, bindings, return_types) == HirType::Bool
                && infer_type(language, right, bindings, return_types) == HirType::Bool =>
        {
            HirType::Bool
        }
        Expr::Binary(_, _, _, _) => HirType::I32,
        Expr::Assign(target, _, _, _) if infers_mutability(language) => match &**target {
            LValue::Var(name, _) | LValue::Index(name, _, _) => {
                bindings.get(name).copied().unwrap_or(HirType::I32)
            }
        },
        Expr::Assign(_, _, _, _) => HirType::Unit,
        Expr::Call(name, _, _) => return_types.get(name).copied().unwrap_or(HirType::I32),
    }
}

fn expression_line(expression: &Expr) -> usize {
    match expression {
        Expr::Var(_, line) | Expr::Index(_, _, line) | Expr::Call(_, _, line) => *line,
        Expr::Assign(_, _, _, line)
        | Expr::Unary(_, _, line)
        | Expr::Binary(_, _, _, line)
        | Expr::Num(_, _, line) => *line,
    }
}

fn statement_line(statement: &Stmt) -> usize {
    match statement {
        Stmt::Decl(_, _, _, line)
        | Stmt::DeclArray(_, _, _, _, _, line)
        | Stmt::Return(_, _, line)
        | Stmt::Break(line)
        | Stmt::Continue(line) => *line,
        Stmt::Expr(expression, _) => expression_line(expression),
        Stmt::If(_, _, _, source) => source.line,
        Stmt::While(_, _, source) | Stmt::For(_, _, _, _, source) => source.line,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn function<'a>(hir: &'a TypedHir, name: &str) -> &'a HirFunction {
        hir.functions
            .iter()
            .find(|function| function.name == name)
            .unwrap()
    }

    fn binding<'a>(function: &'a HirFunction, name: &str) -> &'a HirBinding {
        function
            .bindings
            .iter()
            .find(|binding| binding.name == name)
            .unwrap()
    }

    #[test]
    fn c_hir_infers_mutability_and_initialization() {
        let hir = typed_hir_from_c(
            "int helper(int fixed, int changed) {
                int stable = 3;
                int total = 0;
                int pending;
                int values[2] = {1, 2};
                changed += stable;
                total = changed;
                values[0] = total;
                return fixed + values[0];
            }
            int main() { return helper(1, 2); }",
        )
        .unwrap();
        let helper = function(&hir, "helper");
        assert!(!binding(helper, "fixed").mutable);
        assert!(binding(helper, "changed").mutable);
        assert!(!binding(helper, "stable").mutable);
        assert!(binding(helper, "total").mutable);
        assert!(!binding(helper, "pending").initialized);
        assert!(binding(helper, "values").initialized);
        assert!(binding(helper, "values").mutable);
        assert_eq!(binding(helper, "values").array_len, Some(2));
    }

    #[test]
    fn rust_hir_preserves_explicit_types_mutability_and_returns() {
        let hir = typed_hir_from_rust(
            "fn classify(mut input: i32, ready: bool) -> bool {
                let stable: i32 = 3;
                let mut count: i32 = input;
                let flag: bool = ready;
                count += 1;
                return flag && count > stable;
            }
            fn main() -> i32 { return 0; }",
        )
        .unwrap();
        let classify = function(&hir, "classify");
        assert_eq!(classify.return_type, HirType::Bool);
        assert!(binding(classify, "input").mutable);
        assert_eq!(binding(classify, "ready").value_type, HirType::Bool);
        assert_eq!(binding(classify, "stable").value_type, HirType::I32);
        assert!(binding(classify, "count").mutable);
        assert!(!binding(classify, "flag").mutable);
        assert_eq!(binding(classify, "flag").value_type, HirType::Bool);
        assert!(classify.bindings.iter().all(|binding| binding.initialized));
    }

    #[test]
    fn cpp_hir_preserves_bool_signatures_and_expression_types() {
        let hir = typed_hir_from_cpp(
            "bool classify(bool enabled, int value) {
                bool explicit_flag = value;
                auto literal_flag = true;
                auto comparison_flag = value > 0;
                auto logical_flag = enabled and comparison_flag;
                auto integer = value + literal_flag;
                return logical_flag;
            }
            int main() { return classify(true, 7); }",
        )
        .unwrap();
        assert_eq!(hir.language, HirLanguage::Cpp);
        let classify = function(&hir, "classify");
        assert_eq!(classify.return_type, HirType::Bool);
        assert_eq!(binding(classify, "enabled").value_type, HirType::Bool);
        assert_eq!(binding(classify, "value").value_type, HirType::I32);
        assert_eq!(binding(classify, "explicit_flag").value_type, HirType::Bool);
        assert_eq!(binding(classify, "literal_flag").value_type, HirType::Bool);
        assert_eq!(
            binding(classify, "comparison_flag").value_type,
            HirType::Bool
        );
        assert_eq!(binding(classify, "logical_flag").value_type, HirType::Bool);
        assert_eq!(binding(classify, "integer").value_type, HirType::I32);
    }

    #[test]
    fn cpp_hir_infers_mutability_without_changing_declared_type() {
        let hir = typed_hir_from_cpp(
            "int main() {
                bool stable = true;
                auto changed = false;
                changed = 7;
                return stable + changed;
            }",
        )
        .unwrap();
        let main = function(&hir, "main");
        assert!(!binding(main, "stable").mutable);
        assert!(binding(main, "changed").mutable);
        assert_eq!(binding(main, "stable").value_type, HirType::Bool);
        assert_eq!(binding(main, "changed").value_type, HirType::Bool);
        assert_eq!(
            binding(main, "stable").annotation,
            HirTypeAnnotation::Explicit
        );
        assert_eq!(
            binding(main, "changed").annotation,
            HirTypeAnnotation::Inferred
        );
    }

    #[test]
    fn cpp_hir_distinguishes_bool_and_int_assignment_result_types() {
        let hir = typed_hir_from_cpp(
            "int main() {
                bool flag = false;
                int count = 0;
                auto flag_result = (flag = 7);
                auto count_result = (count = 7);
                return flag_result + count_result;
            }",
        )
        .unwrap();
        let main = function(&hir, "main");
        assert_eq!(binding(main, "flag_result").value_type, HirType::Bool);
        assert_eq!(binding(main, "count_result").value_type, HirType::I32);
    }

    #[test]
    fn cpp_hir_distinguishes_logical_and_bitwise_not_result_types() {
        let hir = typed_hir_from_cpp(
            "int main() {
                auto logical = !7;
                auto bitwise = ~7;
                return logical + bitwise;
            }",
        )
        .unwrap();
        let main = function(&hir, "main");
        assert_eq!(binding(main, "logical").value_type, HirType::Bool);
        assert_eq!(binding(main, "bitwise").value_type, HirType::I32);
    }

    #[test]
    fn hir_distinguishes_c_for_and_rust_range_loops() {
        let c = typed_hir_from_c(
            "int main() { int sum = 0; for (int i = 0; i < 3; i++) sum += i; while (sum < 5) sum++; return sum; }",
        )
        .unwrap();
        assert_eq!(
            function(&c, "main")
                .loops
                .iter()
                .map(|item| item.kind)
                .collect::<Vec<_>>(),
            vec![HirLoopKind::CFor, HirLoopKind::While]
        );

        let rust = typed_hir_from_rust(
            "fn main() -> i32 { let mut sum = 0; for i in 0..3 { sum += i; } loop { break; } return sum; }",
        )
        .unwrap();
        let main = function(&rust, "main");
        assert_eq!(
            main.loops.iter().map(|item| item.kind).collect::<Vec<_>>(),
            vec![HirLoopKind::RustRange, HirLoopKind::RustLoop]
        );
        let iterator = binding(main, "i");
        assert_eq!(iterator.kind, HirBindingKind::RangeIterator);
        assert!(!iterator.mutable);
        assert!(iterator.initialized);
        assert_eq!(rust.language, HirLanguage::Rust);
        assert_eq!(rust.ast.funcs.len(), 1);
    }

    #[test]
    fn hir_distinguishes_true_literal_from_integer_one() {
        let hir = typed_hir_from_rust(
            "fn main() -> i32 { let flag = true; let count = 1; if flag { return count; } return 0; }",
        )
        .unwrap();
        let main = function(&hir, "main");
        assert_eq!(binding(main, "flag").value_type, HirType::Bool);
        assert_eq!(binding(main, "count").value_type, HirType::I32);
        assert_ne!(
            binding(main, "flag").value_type,
            binding(main, "count").value_type
        );
    }

    #[test]
    fn hir_distinguishes_boolean_not_from_integer_not() {
        let hir = typed_hir_from_rust(
            "fn main() -> i32 { let flag = !true; let mask = !1; if flag { return mask; } return 0; }",
        )
        .unwrap();
        let main = function(&hir, "main");
        assert_eq!(binding(main, "flag").value_type, HirType::Bool);
        assert_eq!(binding(main, "mask").value_type, HirType::I32);
        assert_ne!(
            binding(main, "flag").value_type,
            binding(main, "mask").value_type
        );
    }

    #[test]
    fn hir_distinguishes_while_true_from_loop() {
        let hir = typed_hir_from_rust(
            "fn main() -> i32 { while true { break; } loop { break; } return 0; }",
        )
        .unwrap();
        assert_eq!(
            function(&hir, "main")
                .loops
                .iter()
                .map(|item| item.kind)
                .collect::<Vec<_>>(),
            vec![HirLoopKind::While, HirLoopKind::RustLoop]
        );
    }

    #[test]
    fn hir_distinguishes_missing_from_empty_array_initializer() {
        let hir = typed_hir_from_c("int main() { int missing[2]; int empty[2] = {}; return 0; }")
            .unwrap();
        let main = function(&hir, "main");
        assert!(!binding(main, "missing").initialized);
        assert!(binding(main, "empty").initialized);
        assert_ne!(
            binding(main, "missing").initialized,
            binding(main, "empty").initialized
        );
    }

    #[test]
    fn hir_distinguishes_plain_block_from_constant_if() {
        let hir = typed_hir_from_c(
            "int main() { { int first = 1; } if (1) { int second = 2; } return 0; }",
        )
        .unwrap();
        let body = &hir.ast.funcs[0].body;
        let Stmt::If(_, _, _, block_source) = &body[0] else {
            panic!("plain block did not lower to a block statement");
        };
        let Stmt::If(_, _, _, if_source) = &body[1] else {
            panic!("constant if did not lower to an if statement");
        };
        assert_eq!(block_source.origin, super::IfOrigin::PlainBlock);
        assert_eq!(if_source.origin, super::IfOrigin::Conditional);
        assert_ne!(block_source.origin, if_source.origin);
    }

    #[test]
    fn hir_distinguishes_repeat_from_list_array_initializers() {
        let hir = typed_hir_from_rust(
            "fn main() -> i32 { let repeated = [3; 2]; let listed = [3, 3]; return 0; }",
        )
        .unwrap();
        let body = &hir.ast.funcs[0].body;
        let Stmt::DeclArray(_, _, repeat_values, _, repeat_source, _) = &body[0] else {
            panic!("repeat array missing");
        };
        let Stmt::DeclArray(_, _, list_values, _, list_source, _) = &body[1] else {
            panic!("list array missing");
        };
        assert_eq!(*repeat_source, ArrayInitProvenance::Repeat);
        assert_eq!(*list_source, ArrayInitProvenance::List);
        assert_eq!(repeat_values.len(), 1);
        assert_eq!(list_values.len(), 2);
    }

    #[test]
    fn hir_distinguishes_all_assignment_source_forms() {
        let hir = typed_hir_from_c(
            "int main() { int x = 1; x = x + 1; x += 1; x -= 1; x *= 2; x /= 2; x %= 3; ++x; x++; --x; x--; return x; }",
        )
        .unwrap();
        let forms = hir.ast.funcs[0].body[1..11]
            .iter()
            .map(|statement| match statement {
                Stmt::Expr(Expr::Assign(_, _, source, _), _) => *source,
                _ => panic!("expected assignment statement"),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            forms,
            vec![
                super::AssignmentProvenance::Simple,
                super::AssignmentProvenance::Compound("+"),
                super::AssignmentProvenance::Compound("-"),
                super::AssignmentProvenance::Compound("*"),
                super::AssignmentProvenance::Compound("/"),
                super::AssignmentProvenance::Compound("%"),
                super::AssignmentProvenance::PrefixIncrement,
                super::AssignmentProvenance::PostfixIncrement,
                super::AssignmentProvenance::PrefixDecrement,
                super::AssignmentProvenance::PostfixDecrement,
            ]
        );
    }

    #[test]
    fn hir_retains_c_function_prototypes() {
        let hir = typed_hir_from_c(
            "int helper(int value); int main() { return helper(3); } int helper(int value) { return value; }",
        )
        .unwrap();
        assert_eq!(hir.ast.prototypes.len(), 1);
        assert_eq!(hir.ast.prototypes[0].name, "helper");
        assert_eq!(hir.ast.prototypes[0].parameters, vec!["value"]);
    }

    #[test]
    fn hir_distinguishes_empty_statement_from_zero_expression() {
        let hir = typed_hir_from_c("int main() { ; 0; return 0; }").unwrap();
        let body = &hir.ast.funcs[0].body;
        let Stmt::Expr(_, empty_source) = &body[0] else {
            panic!("empty statement missing");
        };
        let Stmt::Expr(_, expression_source) = &body[1] else {
            panic!("zero expression statement missing");
        };
        assert_eq!(*empty_source, super::ExprStmtProvenance::Empty);
        assert_eq!(*expression_source, super::ExprStmtProvenance::Expression);
    }

    #[test]
    fn hir_distinguishes_tail_return_from_explicit_return() {
        let hir = typed_hir_from_rust("fn main() -> i32 { if true { return 1; } 2 }").unwrap();
        let body = &hir.ast.funcs[0].body;
        let Stmt::If(_, then_body, _, _) = &body[0] else {
            panic!("if statement missing");
        };
        let Stmt::Return(_, explicit, _) = &then_body[0] else {
            panic!("explicit return missing");
        };
        let Stmt::Return(_, tail, _) = &body[1] else {
            panic!("tail return missing");
        };
        assert_eq!(*explicit, super::ReturnProvenance::Explicit);
        assert_eq!(*tail, super::ReturnProvenance::Tail);
    }

    #[test]
    fn hir_distinguishes_synthetic_from_explicit_main() {
        let synthetic = typed_hir_from_c("int value = 3; return value;").unwrap();
        let explicit = typed_hir_from_c("int main() { int value = 3; return value; }").unwrap();
        assert_eq!(
            function(&synthetic, "main").origin,
            FunctionOrigin::SyntheticMain
        );
        assert_eq!(function(&explicit, "main").origin, FunctionOrigin::Explicit);
    }

    #[test]
    fn hir_distinguishes_explicit_from_inferred_type_annotations() {
        let hir = typed_hir_from_rust(
            "fn main() -> i32 { let inferred = 1; let explicit: i32 = 2; return inferred + explicit; }",
        )
        .unwrap();
        let main = function(&hir, "main");
        assert_eq!(
            binding(main, "inferred").annotation,
            HirTypeAnnotation::Inferred
        );
        assert_eq!(
            binding(main, "explicit").annotation,
            HirTypeAnnotation::Explicit
        );
    }

    #[test]
    fn hir_retains_body_and_else_if_source_forms() {
        let hir = typed_hir_from_c(
            "int main() { int x = 0; if (x) x = 1; else if (1) { x = 2; } while (x) x--; return x; }",
        )
        .unwrap();
        let body = &hir.ast.funcs[0].body;
        let Stmt::If(_, _, _, if_source) = &body[1] else {
            panic!("if statement missing");
        };
        let Stmt::While(_, _, loop_source) = &body[2] else {
            panic!("while statement missing");
        };
        assert_eq!(if_source.then_body, super::BodyForm::SingleStatement);
        assert_eq!(if_source.else_body, Some(super::ElseForm::ElseIf));
        assert_eq!(loop_source.body, super::BodyForm::SingleStatement);
    }

    #[test]
    fn hir_retains_parameter_and_expression_source_lines() {
        let hir = typed_hir_from_c(
            "int helper(\nint value) {\nint total = value;\ntotal = total +\n1;\nreturn total;\n}\nint main() { return helper(2); }",
        )
        .unwrap();
        let helper = function(&hir, "helper");
        assert_eq!(binding(helper, "value").line, 2);
        assert_eq!(binding(helper, "total").line, 3);
        let Stmt::Expr(Expr::Assign(_, value, _, assignment_line), _) = &hir.ast.funcs[0].body[1]
        else {
            panic!("assignment missing");
        };
        let Expr::Binary(_, _, _, binary_line) = &**value else {
            panic!("binary expression missing");
        };
        assert_eq!(*assignment_line, 4);
        assert_eq!(*binary_line, 4);
    }
}

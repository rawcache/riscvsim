use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy)]
pub(super) enum IdentifierTarget {
    C,
    Cpp,
    Rust,
}

pub(super) fn identifier_map<'a>(
    names: impl IntoIterator<Item = &'a str>,
    target: IdentifierTarget,
) -> HashMap<String, String> {
    let names = names.into_iter().map(str::to_string).collect::<Vec<_>>();
    let source_names = names.iter().cloned().collect::<HashSet<_>>();
    let mut used = HashSet::new();
    let mut mapped = HashMap::new();

    for name in names {
        if mapped.contains_key(&name) {
            continue;
        }
        let target_name = if !is_reserved(target, &name) && used.insert(name.clone()) {
            name.clone()
        } else {
            let prefix = match target {
                IdentifierTarget::Rust => "__riscvsim_",
                IdentifierTarget::C | IdentifierTarget::Cpp => "riscvsim_",
            };
            let base = format!("{prefix}{name}");
            let mut suffix = 0usize;
            loop {
                let candidate = if suffix == 0 {
                    base.clone()
                } else {
                    format!("{base}_{suffix}")
                };
                suffix += 1;
                if !is_reserved(target, &candidate)
                    && !source_names.contains(&candidate)
                    && used.insert(candidate.clone())
                {
                    break candidate;
                }
            }
        };
        mapped.insert(name, target_name);
    }
    mapped
}

fn is_reserved(target: IdentifierTarget, name: &str) -> bool {
    match target {
        IdentifierTarget::C => C_RESERVED.contains(&name),
        IdentifierTarget::Cpp => CPP_RESERVED.contains(&name),
        IdentifierTarget::Rust => RUST_RESERVED.contains(&name),
    }
}

const C_RESERVED: &[&str] = &[
    "_Alignas",
    "_Alignof",
    "_Atomic",
    "_Bool",
    "_Complex",
    "_Generic",
    "_Imaginary",
    "_Noreturn",
    "_Static_assert",
    "_Thread_local",
    "alignas",
    "alignof",
    "auto",
    "bool",
    "break",
    "case",
    "char",
    "const",
    "constexpr",
    "continue",
    "default",
    "do",
    "double",
    "else",
    "enum",
    "extern",
    "false",
    "float",
    "for",
    "goto",
    "if",
    "inline",
    "int",
    "long",
    "nullptr",
    "register",
    "restrict",
    "return",
    "short",
    "signed",
    "sizeof",
    "static",
    "static_assert",
    "struct",
    "switch",
    "thread_local",
    "true",
    "typedef",
    "typeof",
    "typeof_unqual",
    "union",
    "unsigned",
    "void",
    "volatile",
    "while",
];

const CPP_RESERVED: &[&str] = &[
    "alignas",
    "alignof",
    "and",
    "and_eq",
    "asm",
    "auto",
    "bitand",
    "bitor",
    "bool",
    "break",
    "case",
    "catch",
    "char",
    "char8_t",
    "char16_t",
    "char32_t",
    "class",
    "compl",
    "concept",
    "const",
    "consteval",
    "constexpr",
    "constinit",
    "const_cast",
    "continue",
    "co_await",
    "co_return",
    "co_yield",
    "decltype",
    "default",
    "delete",
    "do",
    "double",
    "dynamic_cast",
    "else",
    "enum",
    "explicit",
    "export",
    "extern",
    "false",
    "float",
    "for",
    "friend",
    "goto",
    "if",
    "inline",
    "int",
    "long",
    "mutable",
    "namespace",
    "new",
    "noexcept",
    "not",
    "not_eq",
    "nullptr",
    "operator",
    "or",
    "or_eq",
    "private",
    "protected",
    "public",
    "register",
    "reinterpret_cast",
    "requires",
    "return",
    "short",
    "signed",
    "sizeof",
    "static",
    "static_assert",
    "static_cast",
    "struct",
    "switch",
    "template",
    "this",
    "thread_local",
    "throw",
    "true",
    "try",
    "typedef",
    "typeid",
    "typename",
    "union",
    "unsigned",
    "using",
    "virtual",
    "void",
    "volatile",
    "wchar_t",
    "while",
    "xor",
    "xor_eq",
];

const RUST_RESERVED: &[&str] = &[
    "Self",
    "abstract",
    "as",
    "async",
    "await",
    "become",
    "bool",
    "box",
    "break",
    "const",
    "continue",
    "crate",
    "do",
    "dyn",
    "else",
    "enum",
    "extern",
    "false",
    "final",
    "fn",
    "for",
    "gen",
    "i32",
    "if",
    "impl",
    "in",
    "let",
    "loop",
    "macro",
    "macro_rules",
    "match",
    "mod",
    "move",
    "mut",
    "override",
    "priv",
    "pub",
    "raw",
    "ref",
    "return",
    "self",
    "static",
    "struct",
    "super",
    "trait",
    "true",
    "try",
    "type",
    "typeof",
    "union",
    "unsafe",
    "unsized",
    "use",
    "virtual",
    "where",
    "while",
    "yield",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_each_targets_keywords_and_avoids_source_collisions() {
        for (target, keyword) in [
            (IdentifierTarget::C, "auto"),
            (IdentifierTarget::Cpp, "and"),
            (IdentifierTarget::Rust, "mut"),
        ] {
            let collision = match target {
                IdentifierTarget::Rust => format!("__riscvsim_{keyword}"),
                IdentifierTarget::C | IdentifierTarget::Cpp => format!("riscvsim_{keyword}"),
            };
            let mapped = identifier_map([keyword, collision.as_str(), "value"], target);
            assert_ne!(mapped[keyword], keyword);
            assert_ne!(mapped[keyword], collision);
            assert_eq!(mapped["value"], "value");
            assert_eq!(mapped.values().collect::<HashSet<_>>().len(), 3);
        }
    }
}

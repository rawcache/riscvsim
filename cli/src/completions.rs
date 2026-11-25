//! `riscvsim completions bash|zsh|fish`: completion scripts generated from
//! the same command table the argument parser uses (see `CLI` in main.rs).

/// What the generators need to know about one command.
pub struct Cmd<'a> {
    pub name: &'a str,
    pub about: &'a str,
    /// (flag, takes a value, values to offer)
    pub flags: Vec<(&'a str, bool, &'a [&'a str])>,
    /// "file", "sample", "shell" or "" for nothing.
    pub operand: &'a str,
}

pub const SHELLS: &[&str] = &["bash", "zsh", "fish"];

fn quote_single(s: &str) -> String {
    s.replace('\'', "'\\''")
}

pub fn bash(cmds: &[Cmd], samples: &[&str]) -> String {
    let names: Vec<&str> = cmds.iter().map(|c| c.name).collect();
    let mut s = String::from("# riscvsim completion for bash. Load it with:\n#   source <(riscvsim completions bash)\n_riscvsim() {\n");
    s.push_str("    local cur prev cmd opts\n    cur=\"${COMP_WORDS[COMP_CWORD]}\"\n    prev=\"${COMP_WORDS[COMP_CWORD-1]}\"\n");
    s.push_str(&format!(
        "    if [ \"$COMP_CWORD\" -eq 1 ]; then\n        COMPREPLY=( $(compgen -W \"{} help --help --version --no-color\" -- \"$cur\") )\n        return\n    fi\n",
        names.join(" ")
    ));
    s.push_str("    cmd=\"${COMP_WORDS[1]}\"\n    case \"$prev\" in\n");
    let mut seen: Vec<&str> = Vec::new();
    for c in cmds {
        for (flag, _, values) in &c.flags {
            if !values.is_empty() && !seen.contains(flag) {
                seen.push(flag);
                s.push_str(&format!("        {flag}) COMPREPLY=( $(compgen -W \"{}\" -- \"$cur\") ); return ;;\n", values.join(" ")));
            }
        }
    }
    s.push_str("    esac\n    case \"$cmd\" in\n");
    for c in cmds {
        let flags: Vec<&str> = c.flags.iter().map(|f| f.0).collect();
        let words = match c.operand {
            "sample" => samples.join(" "),
            "shell" => SHELLS.join(" "),
            _ => String::new(),
        };
        s.push_str(&format!("        {}) opts=\"{} --help\"; words=\"{}\" ;;\n", c.name, flags.join(" "), words));
    }
    s.push_str("        *) return ;;\n    esac\n");
    s.push_str("    if [[ \"$cur\" == -* ]]; then\n        COMPREPLY=( $(compgen -W \"$opts\" -- \"$cur\") )\n    elif [ -n \"$words\" ]; then\n        COMPREPLY=( $(compgen -W \"$words\" -- \"$cur\") )\n    else\n        COMPREPLY=( $(compgen -f -- \"$cur\") )\n    fi\n}\ncomplete -o default -F _riscvsim riscvsim\n");
    s
}

pub fn zsh(cmds: &[Cmd], samples: &[&str]) -> String {
    let mut s = String::from("#compdef riscvsim\n# riscvsim completion for zsh. Load it with:\n#   source <(riscvsim completions zsh)\n_riscvsim() {\n    local -a commands\n    commands=(\n");
    for c in cmds {
        s.push_str(&format!("        '{}:{}'\n", c.name, quote_single(c.about)));
    }
    s.push_str("    )\n    if (( CURRENT == 2 )); then\n        _describe 'command' commands\n        return\n    fi\n    local cmd=$words[2]\n    shift words\n    (( CURRENT-- ))\n    case $cmd in\n");
    for c in cmds {
        let mut args: Vec<String> = c
            .flags
            .iter()
            .map(|(flag, takes, values)| {
                if !*takes {
                    format!("'{flag}[]'")
                } else if values.is_empty() {
                    format!("'{flag}=[]:value:'")
                } else {
                    format!("'{flag}=[]:value:({})'", values.join(" "))
                }
            })
            .collect();
        match c.operand {
            "file" => args.push("'*:file:_files'".into()),
            "sample" => args.push(format!("'1:sample:({})'", samples.join(" "))),
            "shell" => args.push(format!("'1:shell:({})'", SHELLS.join(" "))),
            _ => {}
        }
        s.push_str(&format!("        {}) _arguments {} ;;\n", c.name, args.join(" ")));
    }
    s.push_str("    esac\n}\nif [ \"$funcstack[1]\" = \"_riscvsim\" ]; then\n    _riscvsim \"$@\"\nelse\n    compdef _riscvsim riscvsim\nfi\n");
    s
}

pub fn fish(cmds: &[Cmd], samples: &[&str]) -> String {
    let names: Vec<&str> = cmds.iter().map(|c| c.name).collect();
    let mut s = String::from("# riscvsim completion for fish. Load it with:\n#   riscvsim completions fish | source\ncomplete -c riscvsim -f\n");
    for c in cmds {
        s.push_str(&format!(
            "complete -c riscvsim -n 'not __fish_seen_subcommand_from {}' -a {} -d '{}'\n",
            names.join(" "),
            c.name,
            quote_single(c.about)
        ));
    }
    for c in cmds {
        let when = format!("-n '__fish_seen_subcommand_from {}'", c.name);
        for (flag, takes, values) in &c.flags {
            let opt = match flag.strip_prefix("--") {
                Some(long) => format!("-l {long}"),
                None => format!("-s {}", flag.trim_start_matches('-')),
            };
            let req = if *takes { " -r" } else { "" };
            let vals = if values.is_empty() { String::new() } else { format!(" -a '{}'", values.join(" ")) };
            s.push_str(&format!("complete -c riscvsim {when} {opt}{req}{vals}\n"));
        }
        match c.operand {
            "file" => s.push_str(&format!("complete -c riscvsim {when} -F\n")),
            "sample" => s.push_str(&format!("complete -c riscvsim {when} -a '{}'\n", samples.join(" "))),
            "shell" => s.push_str(&format!("complete -c riscvsim {when} -a '{}'\n", SHELLS.join(" "))),
            _ => {}
        }
    }
    s
}

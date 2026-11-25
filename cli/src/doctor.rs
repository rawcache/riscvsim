use crate::term::{self, Paint};
use crate::update;
use std::collections::HashSet;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

pub const QUICK_INSTALL_COMMAND: &str = "curl -fsSL https://studyriscv.com/install.sh | sh";

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum InstallMethod {
    Homebrew,
    QuickStart,
    Source,
    Manual,
}

impl InstallMethod {
    pub fn label(self) -> &'static str {
        match self {
            Self::Homebrew => "Homebrew",
            Self::QuickStart => "curl quick-start installer",
            Self::Source => "source build",
            Self::Manual => "manual or system install",
        }
    }
}

impl fmt::Display for InstallMethod {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

#[derive(Clone, Debug)]
pub struct ExecutableCopy {
    pub visible_path: PathBuf,
    pub resolved_path: PathBuf,
    pub version: String,
    pub install_method: InstallMethod,
}

#[derive(Clone, Debug)]
pub struct Inspection {
    pub active_path: Option<PathBuf>,
    pub active_resolved: Option<PathBuf>,
    pub copies: Vec<ExecutableCopy>,
}

impl Inspection {
    pub fn active_method(&self) -> InstallMethod {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        match (&self.active_path, &self.active_resolved) {
            (Some(path), Some(resolved)) => {
                classify_install_method(path, resolved, home.as_deref())
            }
            (Some(path), None) => classify_install_method(path, path, home.as_deref()),
            _ => InstallMethod::Manual,
        }
    }
}

pub fn inspect() -> Inspection {
    let active_path = std::env::current_exe().ok();
    let active_resolved = active_path.as_deref().map(resolve_path);
    Inspection {
        active_path,
        active_resolved,
        copies: path_copies(),
    }
}

pub fn active_install_method() -> InstallMethod {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let Ok(path) = std::env::current_exe() else {
        return InstallMethod::Manual;
    };
    let resolved = resolve_path(&path);
    classify_install_method(&path, &resolved, home.as_deref())
}

pub fn run(local_version: &str) -> ExitCode {
    let p = Paint::new();
    let term = TermInfo::detect();
    for line in render_report(local_version, update::latest_release_tag_cached(), &inspect(), &term, &p) {
        println!("{line}");
    }
    ExitCode::SUCCESS
}

/// Plain lines for the interactive session's `/doctor`.
pub fn report_lines(local_version: &str, latest: Result<String, String>) -> Vec<String> {
    let p = Paint::fixed(false, term::unicode());
    render_report(local_version, latest, &inspect(), &TermInfo::detect(), &p)
}

/// What the terminal check looks at, gathered once so rendering stays pure.
pub struct TermInfo {
    pub color: bool,
    pub no_color_env: bool,
    pub unicode: bool,
    pub dumb: bool,
    pub width: usize,
    pub stdout_tty: bool,
    pub curl: bool,
}

impl TermInfo {
    fn detect() -> Self {
        Self {
            color: term::Stream::Stdout.is_tty() && term::color_allowed(),
            no_color_env: std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty()),
            unicode: term::unicode(),
            dumb: std::env::var("TERM").is_ok_and(|t| t == "dumb"),
            width: term::width(),
            stdout_tty: term::Stream::Stdout.is_tty(),
            curl: on_path("curl"),
        }
    }
}

fn on_path(name: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|dir| {
            dir.join(name).is_file() || (cfg!(windows) && dir.join(format!("{name}.exe")).is_file())
        })
    })
}

enum Check {
    Ok(String, Vec<String>),
    Warn { what: String, fix: Vec<String> },
}

fn update_command(method: InstallMethod) -> String {
    match method {
        InstallMethod::Homebrew => "brew upgrade riscvsim".into(),
        InstallMethod::QuickStart => QUICK_INSTALL_COMMAND.into(),
        InstallMethod::Source => "git pull, then cargo build --release in cli/".into(),
        InstallMethod::Manual => format!("reinstall with: {QUICK_INSTALL_COMMAND}"),
    }
}

/// Pure rendering of a doctor report, split out so tests can supply a
/// synthetic PATH inspection and terminal.
fn render_report(
    local_version: &str,
    latest: Result<String, String>,
    inspection: &Inspection,
    term: &TermInfo,
    p: &Paint,
) -> Vec<String> {
    let mut checks = Vec::new();
    let method = inspection.active_method();

    // 1. The running executable.
    let location = match (&inspection.active_path, &inspection.active_resolved) {
        (Some(path), Some(resolved)) if path != resolved => {
            vec![path.display().to_string(), format!("-> {}", resolved.display())]
        }
        (Some(path), _) => vec![path.display().to_string()],
        (None, _) => vec!["location unknown".into()],
    };
    checks.push(Check::Ok(format!("riscvsim v{local_version}, {method}"), location));

    // 2. PATH.
    let active = inspection.active_resolved.as_ref();
    match inspection.copies.as_slice() {
        [] => {
            let dir = inspection
                .active_path
                .as_ref()
                .and_then(|p| p.parent())
                .map(|d| d.display().to_string())
                .unwrap_or_else(|| "the install directory".into());
            checks.push(Check::Warn {
                what: "riscvsim is not on your PATH, so the shell cannot find it by name".into(),
                fix: vec![format!("add it to PATH: export PATH=\"{dir}:$PATH\" (in your shell profile)")],
            });
        }
        [only] => {
            if active.is_some_and(|a| *a != only.resolved_path) {
                checks.push(Check::Warn {
                    what: format!(
                        "the shell runs {} ({}), not this copy",
                        only.visible_path.display(),
                        only.version
                    ),
                    fix: vec!["run that copy, or put this one's directory first in PATH".into()],
                });
            } else {
                checks.push(Check::Ok("on PATH".into(), vec![only.visible_path.display().to_string()]));
            }
        }
        [first, ..] => {
            let mut fix = vec![format!(
                "keep one copy; the shell uses {} and ignores the rest:",
                first.visible_path.display()
            )];
            for (i, copy) in inspection.copies.iter().enumerate() {
                fix.push(format!(
                    "  {} {} ({}, {})",
                    if i == 0 { "used   " } else { "ignored" },
                    copy.visible_path.display(),
                    copy.version,
                    copy.install_method
                ));
            }
            let methods: HashSet<InstallMethod> = inspection.copies.iter().map(|c| c.install_method).collect();
            if methods.contains(&InstallMethod::Homebrew) {
                fix.push("remove the Homebrew copy: brew uninstall riscvsim".into());
            }
            if methods.contains(&InstallMethod::QuickStart) {
                fix.push("remove the quick-start copy: rm ~/.local/bin/riscvsim".into());
            }
            checks.push(Check::Warn {
                what: format!("{} riscvsim executables are on PATH", inspection.copies.len()),
                fix,
            });
        }
    }

    // 3. Updates.
    match latest {
        Ok(latest) if update::version_newer(&latest, local_version) => checks.push(Check::Warn {
            what: format!("update available: v{local_version} -> {latest}"),
            fix: vec![format!("update: {}", update_command(method))],
        }),
        Ok(latest) => checks.push(Check::Ok(format!("up to date (latest release {latest})"), vec![])),
        Err(e) if e == update::NO_RELEASE_SOURCE => checks.push(Check::Ok(
            "update checks are off in builds made from source".into(),
            vec![],
        )),
        Err(_) if !term.curl => checks.push(Check::Warn {
            what: "curl was not found, so update checks are off".into(),
            fix: vec!["install curl, then run riscvsim doctor again".into()],
        }),
        Err(_) => checks.push(Check::Warn {
            what: "could not reach GitHub to check for updates".into(),
            fix: vec![
                "check your internet connection, then run riscvsim doctor again".into(),
                "(everything else works offline)".into(),
            ],
        }),
    }

    // 4. Terminal.
    if term.dumb {
        checks.push(Check::Warn {
            what: "TERM=dumb: the interactive simulator (riscvsim tui) needs a full terminal".into(),
            fix: vec!["use a terminal emulator, or riscvsim run for plain output".into()],
        });
    } else if !term.unicode {
        checks.push(Check::Warn {
            what: "the locale is not UTF-8, so symbols fall back to ASCII".into(),
            fix: vec!["set a UTF-8 locale, e.g. export LANG=en_US.UTF-8".into()],
        });
    } else if term.stdout_tty && term.width < 72 {
        checks.push(Check::Warn {
            what: format!("the terminal is {} columns wide; riscvsim tui needs 72", term.width),
            fix: vec!["make the window wider".into()],
        });
    } else {
        let color = if term.color {
            "color"
        } else if term.no_color_env {
            "no color (NO_COLOR is set)"
        } else {
            "no color (not a terminal)"
        };
        let size = if term.stdout_tty { format!(", {} columns", term.width) } else { String::new() };
        checks.push(Check::Ok(format!("terminal: {color}, UTF-8{size}"), vec![]));
    }

    // Render.
    let width = term.width.max(60);
    let mut lines = vec![p.bold("riscvsim doctor"), String::new()];
    let mut warnings = 0;
    for check in &checks {
        let (mark, text, fix) = match check {
            Check::Ok(text, _) => (p.ok_mark(), text, &[][..]),
            Check::Warn { what, fix } => {
                warnings += 1;
                (p.warn_mark(), what, fix.as_slice())
            }
        };
        let indent = if p.unicode { 4 } else { 7 };
        let mark_pad = indent - 2 - crate::term::visible_width(&mark);
        for (i, line) in crate::term::wrap(text, width.saturating_sub(indent)).iter().enumerate() {
            if i == 0 {
                lines.push(format!("  {mark}{}{line}", " ".repeat(mark_pad)));
            } else {
                lines.push(format!("{}{line}", " ".repeat(indent)));
            }
        }
        if let Check::Ok(_, details) = check {
            for d in details {
                lines.push(format!("{}{}", " ".repeat(indent), p.gray(d)));
            }
        }
        for (i, f) in fix.iter().enumerate() {
            let lead = if i == 0 { format!("{} ", p.status("fix:")) } else { "     ".into() };
            let text = if f.starts_with("  ") { p.gray(f.trim_start()) } else { f.clone() };
            let extra = if f.starts_with("  ") { "  " } else { "" };
            lines.push(format!("{}{lead}{extra}{text}", " ".repeat(indent)));
        }
    }
    lines.push(String::new());
    lines.push(if warnings == 0 {
        p.success("Everything looks good.")
    } else {
        p.warn(&format!(
            "{warnings} thing{} to look at; each has a fix above.",
            if warnings == 1 { "" } else { "s" }
        ))
    });
    lines
}

fn path_copies() -> Vec<ExecutableCopy> {
    let Some(path_value) = std::env::var_os("PATH") else {
        return Vec::new();
    };
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut seen = HashSet::new();
    let mut copies = Vec::new();

    for directory in std::env::split_paths(&path_value) {
        let visible_path = directory.join(executable_name());
        if !visible_path.is_file() || !seen.insert(visible_path.clone()) {
            continue;
        }
        let resolved_path = resolve_path(&visible_path);
        copies.push(ExecutableCopy {
            version: executable_version(&visible_path),
            install_method: classify_install_method(&visible_path, &resolved_path, home.as_deref()),
            visible_path,
            resolved_path,
        });
    }

    copies
}

#[cfg(windows)]
fn executable_name() -> &'static str {
    "riscvsim.exe"
}

#[cfg(not(windows))]
fn executable_name() -> &'static str {
    "riscvsim"
}

fn resolve_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn executable_version(path: &Path) -> String {
    match Command::new(path).arg("--version").output() {
        Ok(output) if output.status.success() => {
            // Newer versions print a longer friendly line; keep "riscvsim X.Y.Z".
            let text = String::from_utf8_lossy(&output.stdout);
            let version = text.lines().next().unwrap_or("").split_whitespace().take(2).collect::<Vec<_>>().join(" ");
            if version.is_empty() {
                "unknown (empty --version output)".into()
            } else {
                version
            }
        }
        Ok(output) => format!("unknown (--version exited with {})", output.status),
        Err(error) => format!("unknown ({error})"),
    }
}

fn classify_install_method(
    visible_path: &Path,
    resolved_path: &Path,
    home: Option<&Path>,
) -> InstallMethod {
    let visible = visible_path.to_string_lossy().to_ascii_lowercase();
    let resolved = resolved_path.to_string_lossy().to_ascii_lowercase();
    if visible.contains("/homebrew/")
        || resolved.contains("/homebrew/")
        || visible.contains("/.linuxbrew/")
        || resolved.contains("/.linuxbrew/")
    {
        return InstallMethod::Homebrew;
    }
    if let Some(home) = home {
        if visible_path.starts_with(home.join(".local/bin"))
            || resolved_path.starts_with(home.join(".local/bin"))
        {
            return InstallMethod::QuickStart;
        }
    }
    if visible.contains("/target/debug/")
        || visible.contains("/target/release/")
        || resolved.contains("/target/debug/")
        || resolved.contains("/target/release/")
    {
        return InstallMethod::Source;
    }
    InstallMethod::Manual
}

#[cfg(test)]
mod tests {
    use super::{
        classify_install_method, render_report, ExecutableCopy, InstallMethod, Inspection, TermInfo,
    };
    use crate::term::Paint;
    use std::path::{Path, PathBuf};

    fn copy(path: &str, resolved: &str, method: InstallMethod) -> ExecutableCopy {
        ExecutableCopy {
            visible_path: PathBuf::from(path),
            resolved_path: PathBuf::from(resolved),
            version: "riscvsim 0.1.0".into(),
            install_method: method,
        }
    }

    #[test]
    fn reports_homebrew_and_quick_start_copies_and_path_shadowing() {
        let inspection = Inspection {
            active_path: Some(PathBuf::from("/opt/example-home/.local/bin/riscvsim")),
            active_resolved: Some(PathBuf::from("/opt/example-home/.local/bin/riscvsim")),
            copies: vec![
                copy(
                    "/opt/example-home/.local/bin/riscvsim",
                    "/opt/example-home/.local/bin/riscvsim",
                    InstallMethod::QuickStart,
                ),
                copy(
                    "/opt/homebrew/bin/riscvsim",
                    "/opt/homebrew/Cellar/riscvsim/0.1.0/bin/riscvsim",
                    InstallMethod::Homebrew,
                ),
            ],
        };
        let lines = render_report("0.1.0", Err("offline".into()), &inspection, &good_term(), &Paint::fixed(false, true));
        let text = lines.join("\n");
        assert!(text.contains("2 riscvsim executables are on PATH"), "{text}");
        assert!(text.contains("used    /opt/example-home/.local/bin/riscvsim (riscvsim 0.1.0, curl quick-start installer)"), "{text}");
        assert!(text.contains("ignored /opt/homebrew/bin/riscvsim (riscvsim 0.1.0, Homebrew)"), "{text}");
        assert!(text.contains("remove the Homebrew copy: brew uninstall riscvsim"));
        assert!(text.contains("remove the quick-start copy: rm ~/.local/bin/riscvsim"));
        // Offline: a warning with a fix, never a crash or a silent gap.
        assert!(text.contains("could not reach GitHub to check for updates"));
        assert!(text.contains("2 things to look at; each has a fix above."));
        // Every warning is followed by a fix line.
        let warn_lines: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| l.starts_with("  !")).map(|(i, _)| i).collect();
        for i in warn_lines {
            assert!(lines[i + 1..].iter().take_while(|l| !l.starts_with("  ")).count() == 0);
            assert!(lines[i + 1..].iter().find(|l| l.trim_start().starts_with("fix:")).is_some());
        }
    }

    fn good_term() -> TermInfo {
        TermInfo { color: false, no_color_env: false, unicode: true, dumb: false, width: 80, stdout_tty: false, curl: true }
    }

    #[test]
    fn snapshot_healthy_report() {
        let inspection = Inspection {
            active_path: Some(PathBuf::from("/opt/homebrew/bin/riscvsim")),
            active_resolved: Some(PathBuf::from("/opt/homebrew/Cellar/riscvsim/0.2.0/bin/riscvsim")),
            copies: vec![copy("/opt/homebrew/bin/riscvsim", "/opt/homebrew/Cellar/riscvsim/0.2.0/bin/riscvsim", InstallMethod::Homebrew)],
        };
        let lines = render_report("0.2.0", Ok("v0.2.0".into()), &inspection, &good_term(), &Paint::fixed(false, true));
        assert_eq!(
            lines.join("\n"),
            "riscvsim doctor\n\n  \
             ✓ riscvsim v0.2.0, Homebrew\n    \
             /opt/homebrew/bin/riscvsim\n    \
             -> /opt/homebrew/Cellar/riscvsim/0.2.0/bin/riscvsim\n  \
             ✓ on PATH\n    \
             /opt/homebrew/bin/riscvsim\n  \
             ✓ up to date (latest release v0.2.0)\n  \
             ✓ terminal: no color (not a terminal), UTF-8\n\n\
             Everything looks good."
        );
    }

    #[test]
    fn update_and_ascii_terminal() {
        let inspection = Inspection {
            active_path: Some(PathBuf::from("/opt/homebrew/bin/riscvsim")),
            active_resolved: Some(PathBuf::from("/opt/homebrew/bin/riscvsim")),
            copies: vec![copy("/opt/homebrew/bin/riscvsim", "/opt/homebrew/bin/riscvsim", InstallMethod::Homebrew)],
        };
        let mut t = good_term();
        t.unicode = false;
        let lines = render_report("0.1.0", Ok("v0.3.0".into()), &inspection, &t, &Paint::fixed(false, false));
        let text = lines.join("\n");
        assert!(text.is_ascii(), "{text}");
        assert!(text.contains("[!]  update available: v0.1.0 -> v0.3.0"), "{text}");
        assert!(text.contains("fix: update: brew upgrade riscvsim"), "{text}");
        assert!(text.contains("fix: set a UTF-8 locale"), "{text}");
    }

    #[test]
    fn identifies_homebrew_symlink_target() {
        assert_eq!(
            classify_install_method(
                Path::new("/opt/homebrew/bin/riscvsim"),
                Path::new("/opt/homebrew/Cellar/riscvsim/0.1.0/bin/riscvsim"),
                Some(Path::new("/opt/example-home")),
            ),
            InstallMethod::Homebrew
        );
    }

    #[test]
    fn identifies_quick_start_location() {
        assert_eq!(
            classify_install_method(
                Path::new("/opt/example-home/.local/bin/riscvsim"),
                Path::new("/opt/example-home/.local/bin/riscvsim"),
                Some(Path::new("/opt/example-home")),
            ),
            InstallMethod::QuickStart
        );
    }
}

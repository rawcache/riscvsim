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
    for line in report_lines(local_version, update::latest_release_tag_cached()) {
        println!("{line}");
    }
    ExitCode::SUCCESS
}

pub fn report_lines(local_version: &str, latest: Result<String, String>) -> Vec<String> {
    let inspection = inspect();
    let mut lines = vec!["riscvsim doctor".to_string(), String::new()];

    match (&inspection.active_path, &inspection.active_resolved) {
        (Some(path), Some(resolved)) if path != resolved => {
            lines.push(format!("Active executable: {}", path.display()));
            lines.push(format!("  resolves to: {}", resolved.display()));
        }
        (Some(path), _) => lines.push(format!("Active executable: {}", path.display())),
        (None, _) => lines.push("Active executable: unavailable".into()),
    }
    lines.push(format!("Active version: v{local_version}"));
    lines.push(format!(
        "Active install method: {}",
        inspection.active_method()
    ));
    lines.push(String::new());

    if inspection.copies.is_empty() {
        lines.push("PATH-visible copies: none".into());
        lines.push("  The active process may have been launched by an absolute path.".into());
    } else {
        lines.push(format!("PATH-visible copies: {}", inspection.copies.len()));
        for (index, copy) in inspection.copies.iter().enumerate() {
            let selected = if index == 0 { " [shell-selected]" } else { "" };
            lines.push(format!("  {}{selected}", copy.visible_path.display()));
            lines.push(format!("    resolves to: {}", copy.resolved_path.display()));
            lines.push(format!("    version: {}", copy.version));
            lines.push(format!(
                "    likely install method: {}",
                copy.install_method
            ));
        }
    }

    lines.push(String::new());
    match latest {
        Ok(latest) => {
            lines.push(format!("Latest published release: {latest}"));
            if update::version_newer(&latest, local_version) {
                lines.push(format!(
                    "Status: update available (active version is v{local_version})"
                ));
            } else {
                lines.push(
                    "Status: active version matches or is newer than the latest published release"
                        .into(),
                );
            }
        }
        Err(_) => {
            lines.pop();
        }
    }

    let methods: HashSet<InstallMethod> = inspection
        .copies
        .iter()
        .map(|copy| copy.install_method)
        .chain(std::iter::once(inspection.active_method()))
        .collect();
    lines.push(String::new());
    lines.push("Update instructions:".into());
    if methods.contains(&InstallMethod::Homebrew) {
        lines.push("  Homebrew: brew upgrade riscvsim".into());
    }
    if methods.contains(&InstallMethod::QuickStart) {
        lines.push(format!("  Quick start: {QUICK_INSTALL_COMMAND}"));
    }
    if methods.contains(&InstallMethod::Source) {
        lines.push("  Source build: pull the source repository and rebuild the CLI".into());
    }
    if methods.contains(&InstallMethod::Manual)
        && !methods.contains(&InstallMethod::Homebrew)
        && !methods.contains(&InstallMethod::QuickStart)
        && !methods.contains(&InstallMethod::Source)
    {
        lines.push("  Manual install: use the update process for the active binary".into());
    }

    if inspection.copies.len() > 1 {
        lines.push(String::new());
        lines.push("Warning: multiple riscvsim executables are visible in PATH.".into());
        if let Some(selected) = inspection.copies.first() {
            lines.push(format!(
                "Your shell selects {} first; it shadows the copies listed after it.",
                selected.visible_path.display()
            ));
        }
        if methods.contains(&InstallMethod::Homebrew)
            && methods.contains(&InstallMethod::QuickStart)
        {
            lines.push(
                "Maintaining both Homebrew and quick-start copies is unnecessary. Remove the unused copy:"
                    .into(),
            );
            lines.push("  Homebrew: brew uninstall riscvsim".into());
            lines.push("  Quick start: rm ~/.local/bin/riscvsim".into());
        }
    }

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
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
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
    use super::{classify_install_method, InstallMethod};
    use std::path::Path;

    #[test]
    fn identifies_homebrew_symlink_target() {
        assert_eq!(
            classify_install_method(
                Path::new("/opt/homebrew/bin/riscvsim"),
                Path::new("/opt/homebrew/Cellar/riscvsim/0.1.0/bin/riscvsim"),
                Some(Path::new("/Users/test")),
            ),
            InstallMethod::Homebrew
        );
    }

    #[test]
    fn identifies_quick_start_location() {
        assert_eq!(
            classify_install_method(
                Path::new("/Users/test/.local/bin/riscvsim"),
                Path::new("/Users/test/.local/bin/riscvsim"),
                Some(Path::new("/Users/test")),
            ),
            InstallMethod::QuickStart
        );
    }
}

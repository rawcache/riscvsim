//! The release workflow must never overwrite a release, must keep write
//! access to the jobs that need it, and must say what the CHANGELOG says.
//! Skips cleanly when the files are not in this checkout.

use std::path::PathBuf;

fn repo_file(rel: &str) -> Option<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(rel);
    let text = std::fs::read_to_string(&path).ok();
    if text.is_none() {
        eprintln!("note: {rel} not found; skipping");
    }
    text
}

#[test]
fn release_never_overwrites_and_starts_read_only() {
    let Some(wf) = repo_file(".github/workflows/release.yml") else { return };
    let code: Vec<&str> = wf.lines().filter(|l| !l.trim_start().starts_with('#')).collect();
    assert!(!code.iter().any(|l| l.contains("--clobber")), "assets must never be replaced");
    assert!(wf.contains("\npermissions:\n  contents: read\n"), "read-only by default");
    assert!(wf.contains("gh release view \"$TAG\""), "preflight looks for an existing release");
    assert!(wf.contains("gh release create \"$TAG\""), "create fails if the release exists");
    assert!(wf.contains("tags: [\"v[0-9]*\"]"), "version tags only");
    for target in ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-unknown-linux-gnu"] {
        assert!(wf.contains(target), "{target}");
    }
    for line in code.iter().filter(|l| l.contains("uses:")) {
        assert!(line.contains("actions/checkout@"), "only actions/checkout: {line}");
    }
    assert!(wf.contains("${{ github.repository }}"), "the owner comes from the run, not the file");
    // write access appears only in jobs that write to the release
    let writes = wf.matches("contents: write").count();
    assert_eq!(writes, 3, "create, build and publish");
}

#[test]
fn changelog_describes_the_workflow_that_exists() {
    let (Some(wf), Some(log)) = (repo_file(".github/workflows/release.yml"), repo_file("CHANGELOG.md")) else { return };
    let flat = log.split_whitespace().collect::<Vec<_>>().join(" ");
    for phrase in [
        "checks that no release exists for the tag",
        "the tag matches the CLI version",
        "macOS (arm64, x86_64) and Linux (x86_64)",
        "a checksum-verifying `install.sh`",
        "fails instead of replacing an existing release or asset",
    ] {
        assert!(flat.contains(phrase), "CHANGELOG should say: {phrase}");
    }
    assert!(wf.contains("SHA256SUMS") && wf.contains("install.sh") && wf.contains("--draft=false"));
    assert!(wf.contains("cli/Cargo.toml"), "the version check reads the CLI version");
    for gone in ["Session 1", "Session 2", "Session 3", "Session 4"] {
        assert!(!log.contains(gone), "no internal headings: {gone}");
    }
    assert!(log.contains("## [Unreleased]") && log.contains("## [0.2.0]") && log.contains("## [0.1.0]"));
}

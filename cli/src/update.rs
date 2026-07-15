use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};

const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/rawcache/riscvsim/releases/latest";
const CACHE_TTL_SECONDS: u64 = 60 * 60;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseStatus {
    pub latest: String,
    pub update_available: bool,
}

pub type StatusSlot = Arc<Mutex<Option<ReleaseStatus>>>;

#[derive(Deserialize)]
struct LatestRelease {
    tag_name: String,
}

#[derive(Deserialize, Serialize)]
struct UpdateCache {
    checked_at: u64,
    latest: String,
}

pub struct UpdateCheck {
    handle: Option<JoinHandle<Option<ReleaseStatus>>>,
}

impl UpdateCheck {
    pub fn finish(mut self) -> Option<ReleaseStatus> {
        self.handle.take()?.join().ok().flatten()
    }
}

/// Start the invocation-level check alongside the command's normal work.
/// Failures remain internal, and the worker has a 300 ms network ceiling.
pub fn spawn_check(local_version: &'static str) -> UpdateCheck {
    if std::env::var_os("RISCVSIM_NO_UPDATE_CHECK").is_some() {
        return UpdateCheck { handle: None };
    }
    UpdateCheck {
        handle: Some(std::thread::spawn(move || {
            release_status(local_version).ok()
        })),
    }
}

/// Populate a TUI-owned status slot without blocking rendering.
pub fn spawn_status_check(local_version: &'static str, slot: StatusSlot) {
    if std::env::var_os("RISCVSIM_NO_UPDATE_CHECK").is_some() {
        return;
    }
    std::thread::spawn(move || {
        let Ok(status) = release_status(local_version) else {
            return;
        };
        if let Ok(mut guard) = slot.lock() {
            *guard = Some(status);
        }
    });
}

pub fn release_status(local_version: &str) -> Result<ReleaseStatus, String> {
    let latest = latest_release_tag_cached()?;
    Ok(ReleaseStatus {
        update_available: version_newer(&latest, local_version),
        latest,
    })
}

/// Return a fresh-enough latest release. Current-version results avoid a
/// network request for one hour; update results remain visible on every run.
pub fn latest_release_tag_cached() -> Result<String, String> {
    if let Some(cache) = read_fresh_cache() {
        return Ok(cache.latest);
    }
    let latest = fetch_latest_release_tag()?;
    write_cache(&latest);
    Ok(latest)
}

/// Fetch the published release with a hard 300 ms timeout. Doctor, the TUI,
/// and invocation checks all reach GitHub through this single function.
pub fn fetch_latest_release_tag() -> Result<String, String> {
    let output = Command::new("curl")
        .args([
            "-sf",
            "--connect-timeout",
            "0.3",
            "-m",
            "0.3",
            "-H",
            "Accept: application/vnd.github+json",
            LATEST_RELEASE_URL,
        ])
        .output()
        .map_err(|error| format!("could not run curl: {error}"))?;

    if !output.status.success() {
        return Err(format!("release lookup failed with {}", output.status));
    }

    parse_latest_release(&output.stdout)
}

fn cache_path() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("XDG_CACHE_HOME") {
        return Some(PathBuf::from(root).join("riscvsim/update-check.json"));
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".cache/riscvsim/update-check.json"))
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn read_fresh_cache() -> Option<UpdateCache> {
    let body = std::fs::read(cache_path()?).ok()?;
    let cache: UpdateCache = serde_json::from_slice(&body).ok()?;
    if now_seconds().saturating_sub(cache.checked_at) < CACHE_TTL_SECONDS {
        Some(cache)
    } else {
        None
    }
}

fn write_cache(latest: &str) {
    let Some(path) = cache_path() else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let cache = UpdateCache {
        checked_at: now_seconds(),
        latest: latest.to_string(),
    };
    let Ok(body) = serde_json::to_vec(&cache) else {
        return;
    };
    let temporary = path.with_extension("tmp");
    if std::fs::write(&temporary, body).is_ok() {
        let _ = std::fs::rename(temporary, path);
    }
}

fn parse_latest_release(body: &[u8]) -> Result<String, String> {
    let release: LatestRelease = serde_json::from_slice(body)
        .map_err(|error| format!("invalid release response: {error}"))?;
    let tag = release.tag_name.trim();
    if tag.is_empty() {
        return Err("release response did not include a tag".into());
    }
    Ok(tag.to_string())
}

/// Compare version strings numerically. A leading `v` and suffixes such as
/// `-rc1` are ignored for the numeric comparison.
pub fn version_newer(remote: &str, local: &str) -> bool {
    let parse = |version: &str| -> Vec<u64> {
        version
            .trim_start_matches('v')
            .split('.')
            .map(|part| {
                part.chars()
                    .take_while(|character| character.is_ascii_digit())
                    .collect::<String>()
            })
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (remote, local) = (parse(remote), parse(local));
    for index in 0..remote.len().max(local.len()) {
        let remote_part = remote.get(index).copied().unwrap_or(0);
        let local_part = local.get(index).copied().unwrap_or(0);
        if remote_part != local_part {
            return remote_part > local_part;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::{parse_latest_release, version_newer};

    #[test]
    fn parses_latest_release_tag() {
        let body = br#"{"tag_name":"v0.2.0","name":"riscvsim 0.2.0"}"#;
        assert_eq!(parse_latest_release(body).unwrap(), "v0.2.0");
    }

    #[test]
    fn rejects_missing_release_tag() {
        assert!(parse_latest_release(br#"{"name":"missing"}"#).is_err());
    }

    #[test]
    fn compares_numeric_versions() {
        assert!(version_newer("v0.2.0", "0.1.9"));
        assert!(version_newer("v1.0.1", "1.0.0"));
        assert!(!version_newer("v0.1.0", "0.1.0"));
        assert!(!version_newer("v0.1.0", "0.2.0"));
    }
}

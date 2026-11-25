//! Minimal localhost HTTP server for `riscvsim serve`.
//!
//! Hand-rolled on std::net so the binary stays dependency-light and fully
//! self-contained. The session (assembled program + pipeline state) lives in
//! memory only — when this process exits, the session is gone.

use crate::Paint;
use sim_engine::{assemble, Pipeline};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

/// The simulator UI. cli/web/index.html is a generated asset (the hosted
/// studyriscv.com/simulator/ page in remote mode); do not edit it by hand.
const INDEX_HTML: &str = include_str!("../web/index.html");

struct State {
    source: String,
    pipeline: Pipeline,
}

/// The ports `serve` tries when none is given: 4200, then the next ten.
pub const DEFAULT_PORTS: std::ops::Range<u16> = 4200..4211;

/// How `riscvsim serve` should behave.
pub struct ServeOpts {
    /// The port the user asked for with --port, if any.
    pub port: Option<u16>,
    /// Open the page in the default browser (only on a real terminal).
    pub open: bool,
    /// Log each request (-v).
    pub verbose: bool,
}

/// The result of finding a port to listen on.
pub struct Bound {
    pub listener: TcpListener,
    pub port: u16,
    /// Set when the first default port was busy and another one was used.
    pub moved_from: Option<u16>,
}

/// Why `serve` could not listen.
#[derive(Debug, PartialEq, Eq)]
pub enum BindError {
    /// The port the user asked for is in use; `suggest` is a free one.
    Busy { port: u16, suggest: Option<u16> },
    /// None of the default ports were free.
    AllBusy { first: u16, last: u16 },
    /// The port could not be used for another reason (for example a
    /// privileged port).
    Denied { port: u16 },
}

impl BindError {
    /// Plain-English message and a next step, for diag-style output.
    pub fn explain(&self) -> (String, String) {
        match self {
            BindError::Busy { port, suggest } => (
                format!("port {port} is already in use by another program"),
                match suggest {
                    Some(free) => format!("try another port: riscvsim serve --port {free}"),
                    None => "leave out --port and riscvsim picks a free one".into(),
                },
            ),
            BindError::AllBusy { first, last } => (
                format!("ports {first} to {last} are all in use"),
                "choose one yourself: riscvsim serve --port 8080".into(),
            ),
            BindError::Denied { port } => (
                format!("this system does not allow listening on port {port}"),
                "pick a port above 1024: riscvsim serve --port 8080".into(),
            ),
        }
    }
}

/// Bind to the loopback interface only, so nothing outside this computer
/// can reach the session.
fn listen(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
}

/// Find a port: exactly the requested one, or the first free default.
pub fn bind(requested: Option<u16>, defaults: std::ops::Range<u16>) -> Result<Bound, BindError> {
    if let Some(port) = requested {
        return match listen(port) {
            Ok(listener) => Ok(Bound { listener, port, moved_from: None }),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Err(BindError::Denied { port }),
            Err(_) => Err(BindError::Busy { port, suggest: free_port_near(port) }),
        };
    }
    let first = defaults.start;
    let last = defaults.end.saturating_sub(1);
    for port in defaults {
        if let Ok(listener) = listen(port) {
            let moved_from = (port != first).then_some(first);
            return Ok(Bound { listener, port, moved_from });
        }
    }
    Err(BindError::AllBusy { first, last })
}

fn free_port_near(port: u16) -> Option<u16> {
    (1..=20u16)
        .filter_map(|d| port.checked_add(d))
        .find(|p| listen(*p).is_ok())
}

/// The friendly panel printed once the server is listening.
pub fn panel(p: &Paint, label: &str, instructions: usize, port: u16, moved_from: Option<u16>, opening: bool) -> Vec<String> {
    let mut lines = vec![String::new(), p.heading("serve"), String::new()];
    lines.push(format!(
        "  {} {} {} {}",
        p.ok_mark(),
        p.bold(label),
        p.dot(),
        crate::run::plural(instructions as u64, "instruction")
    ));
    if let Some(busy) = moved_from {
        lines.push(format!("  {} port {busy} was busy, so this uses {port} instead", p.warn_mark()));
    }
    lines.push(format!(
        "  {} {}{}",
        p.status(p.chevron()),
        p.bold(&format!("http://127.0.0.1:{port}/")),
        if opening { p.gray("  opening your browser...") } else { String::new() }
    ));
    lines.push(String::new());
    lines.push(format!("  {}", p.gray("Only this computer can see it. The session lives in memory.")));
    lines.push(format!("  Press {} to stop.", p.status("Ctrl-C")));
    lines
}

/// Open `url` with the platform's standard opener, quietly. Any failure is
/// ignored: the address is already on screen.
fn open_browser(url: &str) {
    use std::process::{Command, Stdio};
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(url);
        c
    } else if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", url]);
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    let _ = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}

pub fn serve(
    source: String,
    pipeline: Pipeline,
    label: &str,
    opts: &ServeOpts,
    paint: Paint,
) -> Result<(), BindError> {
    let bound = bind(opts.port, DEFAULT_PORTS)?;
    let port = bound.port;
    let opening = opts.open;
    for line in panel(&paint, label, pipeline.program().instrs.len(), port, bound.moved_from, opening) {
        println!("{line}");
    }
    let _ = std::io::stdout().flush();
    if opening {
        open_browser(&format!("http://127.0.0.1:{port}/"));
    }

    crate::progress::catch_interrupt();
    let listener = bound.listener;
    // Poll so Ctrl-C is noticed promptly without a signal-unsafe exit.
    let _ = listener.set_nonblocking(true);
    let state = Arc::new(Mutex::new(State { source, pipeline }));
    let paint = Arc::new(paint);
    let verbose = opts.verbose;

    loop {
        if crate::progress::interrupted() {
            println!();
            println!("  {} Stopped the server. See you next time.", paint.ok_mark());
            return Ok(());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let state = Arc::clone(&state);
                let paint = Arc::clone(&paint);
                std::thread::spawn(move || {
                    let _ = handle_connection(stream, &state, &paint, verbose);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    }
}

fn handle_connection(
    mut stream: TcpStream,
    state: &Mutex<State>,
    paint: &Paint,
    verbose: bool,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();

    let mut content_length = 0usize;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header)?;
        let header = header.trim();
        if header.is_empty() {
            break;
        }
        if let Some(value) = header
            .to_ascii_lowercase()
            .strip_prefix("content-length:")
            .map(str::trim)
            .and_then(|v| v.parse::<usize>().ok())
        {
            content_length = value.min(1 << 20);
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }
    let body = String::from_utf8_lossy(&body).to_string();

    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };

    let (status, content_type, payload) = route(&method, &path, &query, &body, state);
    if verbose {
        println!("  {}", paint.gray(&format!("{method} {path} {}", status.split(' ').next().unwrap_or(status))));
    }

    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    stream.write_all(response.as_bytes())?;
    stream.write_all(payload.as_bytes())?;
    Ok(())
}

fn listing_json(pipeline: &Pipeline) -> serde_json::Value {
    serde_json::Value::Array(
        pipeline
            .program()
            .instrs
            .iter()
            .map(|i| {
                serde_json::json!({
                    "addr": i.addr,
                    "text": i.text,
                    "line": i.line,
                })
            })
            .collect(),
    )
}

fn query_param(query: &str, key: &str) -> Option<u64> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        if k == key {
            v.parse::<u64>().ok()
        } else {
            None
        }
    })
}

fn route(
    method: &str,
    path: &str,
    query: &str,
    body: &str,
    state: &Mutex<State>,
) -> (&'static str, &'static str, String) {
    const OK: &str = "200 OK";
    const JSON: &str = "application/json";

    match (method, path) {
        ("GET", "/") | ("GET", "/index.html") => (OK, "text/html; charset=utf-8", INDEX_HTML.to_string()),
        ("GET", "/api/session") => {
            let guard = state.lock().unwrap();
            (
                OK,
                JSON,
                serde_json::json!({
                    "source": guard.source,
                    "listing": listing_json(&guard.pipeline),
                })
                .to_string(),
            )
        }
        ("GET", "/api/snapshot") => {
            let guard = state.lock().unwrap();
            (OK, JSON, snapshot_json(&guard.pipeline))
        }
        ("POST", "/api/step") => {
            let cycles = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v.get("cycles").and_then(|c| c.as_u64()))
                .unwrap_or(1)
                .min(100_000);
            let mut guard = state.lock().unwrap();
            for _ in 0..cycles {
                if guard.pipeline.halted() {
                    break;
                }
                guard.pipeline.step_cycle();
            }
            (OK, JSON, snapshot_json(&guard.pipeline))
        }
        ("POST", "/api/step_back") => {
            let mut guard = state.lock().unwrap();
            guard.pipeline.step_back();
            (OK, JSON, snapshot_json(&guard.pipeline))
        }
        ("POST", "/api/reset") => {
            let mut guard = state.lock().unwrap();
            guard.pipeline.reset();
            (OK, JSON, snapshot_json(&guard.pipeline))
        }
        ("POST", "/api/assemble") => {
            let source = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| {
                    v.get("source")
                        .and_then(|s| s.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_default();
            match assemble(&source) {
                Ok(program) => {
                    let mut guard = state.lock().unwrap();
                    guard.pipeline = Pipeline::new(program);
                    guard.source = source;
                    (
                        OK,
                        JSON,
                        serde_json::json!({
                            "ok": true,
                            "listing": listing_json(&guard.pipeline),
                        })
                        .to_string(),
                    )
                }
                Err(errors) => (
                    OK,
                    JSON,
                    serde_json::json!({ "ok": false, "errors": errors }).to_string(),
                ),
            }
        }
        ("GET", "/api/memory") => {
            let addr = query_param(query, "addr").unwrap_or(0) as u32;
            let len = query_param(query, "len").unwrap_or(0).min(4096) as usize;
            let guard = state.lock().unwrap();
            let bytes = guard.pipeline.read_memory(addr, len);
            (OK, JSON, serde_json::json!({ "bytes": bytes }).to_string())
        }
        _ => (
            "404 Not Found",
            JSON,
            r#"{"error":"not found"}"#.to_string(),
        ),
    }
}

fn snapshot_json(pipeline: &Pipeline) -> String {
    serde_json::to_string(&pipeline.snapshot()).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    static PORTS: Mutex<()> = Mutex::new(());

    fn free_range(len: u16) -> std::ops::Range<u16> {
        // Find `len` consecutive free ports high up, away from the defaults.
        for start in (42000u16..60000).step_by(37) {
            if (start..start + len).all(|p| listen(p).is_ok()) {
                return start..start + len;
            }
        }
        panic!("no free port range");
    }

    #[test]
    fn binds_to_loopback_only() {
        let _guard = PORTS.lock().unwrap_or_else(|e| e.into_inner());
        let bound = bind(None, free_range(3)).expect("bind");
        let addr = bound.listener.local_addr().unwrap();
        assert!(addr.ip().is_loopback(), "{addr}");
        assert_eq!(addr.ip(), std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
    }

    #[test]
    fn busy_default_port_moves_to_the_next_and_says_so() {
        let _guard = PORTS.lock().unwrap_or_else(|e| e.into_inner());
        let range = free_range(3);
        let _hold = listen(range.start).unwrap();
        let bound = bind(None, range.clone()).expect("bind");
        assert_eq!(bound.port, range.start + 1);
        assert_eq!(bound.moved_from, Some(range.start));
    }

    #[test]
    fn busy_requested_port_is_explained_with_a_free_suggestion() {
        let _guard = PORTS.lock().unwrap_or_else(|e| e.into_inner());
        let range = free_range(3);
        let _hold = listen(range.start).unwrap();
        let err = bind(Some(range.start), DEFAULT_PORTS).err().expect("must fail");
        let BindError::Busy { port, suggest } = err else { panic!("wrong error") };
        assert_eq!(port, range.start);
        assert!(suggest.is_some_and(|s| s > port));
        let (what, next) = BindError::Busy { port: 8080, suggest: Some(8081) }.explain();
        assert_eq!(what, "port 8080 is already in use by another program");
        assert_eq!(next, "try another port: riscvsim serve --port 8081");
    }

    #[test]
    fn all_default_ports_busy() {
        let _guard = PORTS.lock().unwrap_or_else(|e| e.into_inner());
        let range = free_range(2);
        let _a = listen(range.start).unwrap();
        let _b = listen(range.start + 1).unwrap();
        assert!(matches!(bind(None, range), Err(BindError::AllBusy { .. })));
    }

    #[test]
    fn panel_snapshot_plain() {
        let p = Paint::fixed(false, true);
        assert_eq!(
            panel(&p, "add.s", 5, 4201, Some(4200), true).join("\n"),
            "\n  riscvsim › serve\n\n  \
             ✓ add.s · 5 instructions\n  \
             ! port 4200 was busy, so this uses 4201 instead\n  \
             › http://127.0.0.1:4201/  opening your browser...\n\n  \
             Only this computer can see it. The session lives in memory.\n  \
             Press Ctrl-C to stop."
        );
        let ascii = panel(&Paint::fixed(false, false), "add.s", 1, 4200, None, false).join("\n");
        assert!(ascii.is_ascii(), "{ascii}");
        assert!(ascii.contains("  riscvsim > serve"));
        assert!(ascii.contains("  > http://127.0.0.1:4200/\n"));
    }

    #[test]
    fn panel_snapshot_color() {
        let p = Paint::fixed(true, true);
        let text = panel(&p, "add.s", 5, 4200, None, false).join("\n");
        assert!(text.contains("\x1b[36m›\x1b[0m"), "{text:?}");
        assert!(text.contains("\x1b[32m✓\x1b[0m"));
        assert!(text.contains("\x1b[36mCtrl-C\x1b[0m"));
        for line in text.lines() {
            assert!(crate::term::visible_width(line) <= 78, "{line}");
        }
    }
}

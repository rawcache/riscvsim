//! `riscvsim serve`: the panel, port handling, the embedded page, Ctrl-C.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn spawn(args: &[&str]) -> Child {
    Command::new(env!("CARGO_BIN_EXE_riscvsim"))
        .args(args)
        .env_remove("CLICOLOR_FORCE")
        .env("RISCVSIM_NO_UPDATE_CHECK", "1")
        .env("RISCVSIM_NO_OPEN", "1")
        .env("NO_COLOR", "1")
        .env("LANG", "en_US.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn riscvsim")
}

/// A free port no other test in this run will get. (Asking the system for
/// port 0 and releasing it let two parallel tests receive the same port.)
fn free_port() -> u16 {
    use std::sync::atomic::{AtomicU16, Ordering};
    static NEXT: AtomicU16 = AtomicU16::new(0);
    // Stay below 49152, where the system picks ports for outgoing
    // connections (the tests' own requests among them).
    let base = 20_000 + (std::process::id() % 1000) * 20;
    loop {
        let port = (base + u32::from(NEXT.fetch_add(1, Ordering::Relaxed)) % 2_000) as u16;
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
}

/// Read stdout lines until the address line shows up; return all lines read.
fn read_until_address(child: &mut Child) -> Vec<String> {
    let out = child.stdout.take().unwrap();
    let mut reader = BufReader::new(out);
    let mut lines = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let done = line.contains("Ctrl-C");
        lines.push(line.trim_end().to_string());
        if done {
            break;
        }
    }
    child.stdout = None;
    // Keep draining so the server never blocks on a full pipe.
    std::thread::spawn(move || {
        let mut sink = String::new();
        let _ = reader.read_to_string(&mut sink);
    });
    lines
}

fn get(port: u16, path: &str) -> String {
    let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    write!(s, "GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
    let mut body = String::new();
    s.read_to_string(&mut body).unwrap();
    body
}

fn stop(child: &mut Child) -> (i32, String) {
    let _ = Command::new("kill").args(["-INT", &child.id().to_string()]).status();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                let _ = e.read_to_string(&mut err);
            }
            return (status.code().unwrap_or(-1), err);
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("serve did not stop on Ctrl-C");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn serves_a_sample_with_a_friendly_panel_and_stops_on_ctrl_c() {
    let port = free_port();
    let started = Instant::now();
    let mut child = spawn(&["serve", "--port", &port.to_string(), "--no-open"]);
    let lines = read_until_address(&mut child);
    let ready = started.elapsed();
    let text = lines.join("\n");
    assert!(text.contains("  riscvsim › serve"), "{text}");
    assert!(text.contains(&format!("› http://127.0.0.1:{port}/")), "{text}");
    assert!(!text.contains("opening your browser"), "{text}");
    assert!(text.contains("Press Ctrl-C to stop."), "{text}");
    assert!(!text.contains('\x1b'));
    // Generous bound for loaded CI machines; the real figure is reported.
    assert!(ready < Duration::from_millis(1500), "took {ready:?}");

    // Requests are quiet by default.
    let session = get(port, "/api/session");
    assert!(session.starts_with("HTTP/1.1 200"), "{session}");

    let (code, _) = stop(&mut child);
    #[cfg(unix)]
    assert_eq!(code, 0);
    let _ = code;
}

#[test]
fn busy_requested_port_is_explained() {
    let hold = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = hold.local_addr().unwrap().port();
    let out = Command::new(env!("CARGO_BIN_EXE_riscvsim"))
        .args(["serve", "--port", &port.to_string(), "--no-open"])
        .env("NO_COLOR", "1")
        .env("RISCVSIM_NO_UPDATE_CHECK", "1")
        .output()
        .unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(1), "{err}");
    assert!(err.contains(&format!("error: port {port} is already in use by another program")), "{err}");
    assert!(err.contains("try another port: riscvsim serve --port "), "{err}");
    drop(hold);
}

#[test]
fn embedded_page_is_served_when_present() {
    let page = Path::new(env!("CARGO_MANIFEST_DIR")).join("web/index.html");
    let Ok(expected) = std::fs::read_to_string(&page) else {
        eprintln!("skipped: cli/web/index.html is not present in this checkout");
        return;
    };
    assert!(expected.len() > 1000, "the embedded page looks empty");
    assert!(expected.contains("<html"), "not an HTML page");
    let port = free_port();
    let mut child = spawn(&["serve", "--port", &port.to_string(), "--no-open"]);
    let _ = read_until_address(&mut child);
    let response = get(port, "/");
    let _ = stop(&mut child);
    assert!(response.starts_with("HTTP/1.1 200"), "{}", &response[..80.min(response.len())]);
    assert!(response.ends_with(&expected), "served page differs from cli/web/index.html");
}

#[test]
fn verbose_logs_requests() {
    let port = free_port();
    let mut child = spawn(&["serve", "--port", &port.to_string(), "--no-open", "-v"]);
    let out = child.stdout.take().unwrap();
    let mut reader = BufReader::new(out);
    let mut line = String::new();
    while reader.read_line(&mut line).unwrap_or(0) > 0 && !line.contains("Ctrl-C") {}
    let _ = get(port, "/api/snapshot");
    let mut logged = String::new();
    let _ = reader.read_line(&mut logged);
    let _ = stop(&mut child);
    assert_eq!(logged.trim(), "GET /api/snapshot 200");
}

fn post(port: u16, path: &str, body: &str) -> String {
    let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    write!(
        s,
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut text = String::new();
    s.read_to_string(&mut text).unwrap();
    text
}

fn json_body(response: &str) -> serde_json::Value {
    let body = response.split("\r\n\r\n").nth(1).expect("a body");
    serde_json::from_str(body).expect("json")
}

/// Serve `source` (written to a temp file) with extra args; return the
/// session JSON, a snapshot after 6 cycles, and the panel.
fn serve_session(name: &str, source: &str, extra: &[&str]) -> (serde_json::Value, serde_json::Value, String) {
    let dir = std::env::temp_dir().join(format!("riscvsim-serve-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(format!("{name}.s"));
    std::fs::write(&file, source).unwrap();
    let port = free_port();
    let port_s = port.to_string();
    let mut args = vec!["serve", file.to_str().unwrap(), "--port", &port_s, "--no-open"];
    args.extend_from_slice(extra);
    let mut child = spawn(&args);
    let panel = read_until_address(&mut child).join("\n");
    let session = json_body(&get(port, "/api/session"));
    let snap = json_body(&post(port, "/api/step", r#"{"cycles":6}"#));
    let (code, _) = stop(&mut child);
    assert_eq!(code, 0);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), source, "the user's file is never changed");
    let _ = std::fs::remove_dir_all(&dir);
    (session, snap, panel)
}

const RV64_PROGRAM: &str = "addi x5, x0, 1\nslli x5, x5, 40\naddi x6, x5, 5\n";

#[test]
fn rv32_session_stays_rv32() {
    let (session, snap, panel) = serve_session("rv32", "addi x5, x0, 5\naddi x6, x5, 3\n", &[]);
    assert_eq!(session["xlen"], 32);
    assert_eq!(session["source"], "addi x5, x0, 5\naddi x6, x5, 3\n");
    assert!(session["listing"][0]["addr"].is_u64());
    assert!(snap["registers"][5].is_u64(), "RV32 values stay numbers: {snap}");
    assert!(!panel.contains("RV64"), "{panel}");
}

#[test]
fn xlen_64_opens_in_the_page_as_rv64() {
    let (session, snap, panel) = serve_session("rv64", RV64_PROGRAM, &["--xlen=64"]);
    assert!(panel.contains("rv64.s · RV64 · 3 instructions"), "{panel}");
    assert_eq!(session["xlen"], 64);
    let source = session["source"].as_str().unwrap();
    assert_eq!(source, format!("# xlen=64\n{RV64_PROGRAM}"), "the page reads the marker");
    // listing lines match the source the page shows (the marker is line 1)
    assert_eq!(session["listing"][0]["line"], 2);
    assert_eq!(session["listing"][0]["addr"], "0x0000000000000000");
    assert_eq!(snap["xlen"], 64);
    assert_eq!(snap["registers"][5], "0x0000010000000000", "{snap}");
    assert!(snap["pc"].as_str().is_some_and(|pc| pc.len() == 18));
}

#[test]
fn marker_line_alone_means_rv64_and_is_not_doubled() {
    let marked = format!("# xlen=64\n{RV64_PROGRAM}");
    let (session, snap, _) = serve_session("marked", &marked, &[]);
    assert_eq!(session["xlen"], 64);
    assert_eq!(session["source"], marked.as_str());
    assert_eq!(snap["registers"][5], "0x0000010000000000");
}

#[test]
fn rv64_program_without_the_flag_explains_what_to_do() {
    let dir = std::env::temp_dir().join(format!("riscvsim-serve-hint-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("wide.s");
    std::fs::write(&file, "ld x5, 0(x6)\n").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_riscvsim"))
        .args(["serve", file.to_str().unwrap(), "--no-open"])
        .env("RISCVSIM_NO_UPDATE_CHECK", "1")
        .env("NO_COLOR", "1")
        .env("LANG", "en_US.UTF-8")
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(out.status.code(), Some(1));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("RV64"), "{err}");
}

#[test]
fn assemble_follows_the_page_width_or_the_marker() {
    let port = free_port();
    let mut child = spawn(&["serve", "--port", &port.to_string(), "--no-open"]);
    let _ = read_until_address(&mut child);
    let wide = r#"{"source":"addi x5, x0, 1\naddw x6, x5, x5\n","xlen":64}"#;
    let ok = json_body(&post(port, "/api/assemble", wide));
    assert_eq!(ok["ok"], true, "{ok}");
    assert!(ok["listing"][0]["addr"].is_string(), "RV64 listing: {ok}");
    let marked = r##"{"source":"# xlen=64\naddw x6, x5, x5\n"}"##;
    assert_eq!(json_body(&post(port, "/api/assemble", marked))["ok"], true);
    let narrow = r#"{"source":"addw x6, x5, x5\n","xlen":32}"#;
    let err = json_body(&post(port, "/api/assemble", narrow));
    assert_eq!(err["ok"], false, "addw is not RV32: {err}");
    let plain = json_body(&post(port, "/api/assemble", r#"{"source":"addi x5, x0, 1\n"}"#));
    assert!(plain["listing"][0]["addr"].is_u64(), "{plain}");
    let _ = stop(&mut child);
}

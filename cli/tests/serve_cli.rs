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

fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
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

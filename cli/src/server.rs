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

/// The simulator UI, generated from the same sources as the hosted
/// studyriscv.com/simulator/ page by cli/build-web.mjs.
const INDEX_HTML: &str = include_str!("../web/index.html");

struct State {
    source: String,
    pipeline: Pipeline,
}

pub fn serve(
    source: String,
    pipeline: Pipeline,
    port: Option<u16>,
    paint: Paint,
) -> Result<(), String> {
    let (listener, port) = bind(port)?;
    println!();
    println!("  → {}", paint.bold(&format!("http://localhost:{port}")));
    println!();
    println!(
        "{}",
        paint.gray("session is in memory only — closing this process ends it (ctrl+c to stop)")
    );

    let state = Arc::new(Mutex::new(State { source, pipeline }));
    let paint = Arc::new(paint);

    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let state = Arc::clone(&state);
        let paint = Arc::clone(&paint);
        std::thread::spawn(move || {
            let _ = handle_connection(stream, &state, &paint);
        });
    }
    Ok(())
}

fn bind(requested: Option<u16>) -> Result<(TcpListener, u16), String> {
    let candidates: Vec<u16> = match requested {
        Some(p) => vec![p],
        None => (4200..4211).collect(),
    };
    for port in &candidates {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", *port)) {
            return Ok((listener, *port));
        }
    }
    Err(format!(
        "could not bind a local port (tried {:?})",
        candidates
    ))
}

fn handle_connection(
    mut stream: TcpStream,
    state: &Mutex<State>,
    paint: &Paint,
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

    let (status, content_type, payload) = route(&method, &path, &query, &body, state, paint);

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
    paint: &Paint,
) -> (&'static str, &'static str, String) {
    const OK: &str = "200 OK";
    const JSON: &str = "application/json";

    match (method, path) {
        ("GET", "/") | ("GET", "/index.html") => (OK, "text/html; charset=utf-8", INDEX_HTML.to_string()),
        ("GET", "/api/session") => {
            let guard = state.lock().unwrap();
            println!("{}", paint.gray("client connected"));
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
            println!("{}", paint.gray("program reset"));
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
                    println!("{}", paint.gray("program reset (re-assembled from browser)"));
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

use std::process::Command;

fn temp(name: &str, contents: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("riscvsim-cli-{}-{name}", std::process::id()));
    std::fs::write(&path, contents).expect("write fixture");
    path
}

fn riscvsim(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_riscvsim"))
        .args(args)
        .env("NO_COLOR", "1")
        .env("RISCVSIM_NO_UPDATE_CHECK", "1")
        .output()
        .expect("run riscvsim")
}

#[test]
fn translate_c_to_rv64_and_run_it() {
    let c = temp("prog.c", "int main() { unsigned char c = 250; c += 10; return c; }\n");
    let out = temp("prog.s", "");
    let o = riscvsim(&["translate", "--from", "c", "--to", "rv64", c.to_str().unwrap(), "-o", out.to_str().unwrap()]);
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let run = riscvsim(&["run", out.to_str().unwrap(), "--xlen=64", "--json"]);
    assert!(run.status.success(), "{}", String::from_utf8_lossy(&run.stdout));
    let json: serde_json::Value = serde_json::from_slice(&run.stdout).expect("json");
    assert_eq!(json["ok"], true);
    assert_eq!(json["registers"][10], "0x0000000000000004");
    let _ = std::fs::remove_file(c);
    let _ = std::fs::remove_file(out);
}

#[test]
fn translate_errors_name_the_line_and_exit_nonzero() {
    let c = temp("bad.c", "int main() {\n  return y;\n}\n");
    let o = riscvsim(&["translate", "--from", "c", "--to", "rv32", c.to_str().unwrap()]);
    assert_eq!(o.status.code(), Some(1), "assembly and translation errors exit 1 (problem with the input)");
    let err = String::from_utf8_lossy(&o.stderr);
    assert!(err.contains(":2:") && err.contains("'y' is not declared"), "{err}");
    let o = riscvsim(&["translate", "--from", "c", "--to", "cobol", c.to_str().unwrap()]);
    assert_eq!(o.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&o.stderr).contains("unknown language 'cobol'"));
    let o = riscvsim(&["translate", "--from", "rv32", "--to", "rust", c.to_str().unwrap()]);
    assert_eq!(o.status.code(), Some(1), "assembly and translation errors exit 1 (problem with the input)");
    assert!(String::from_utf8_lossy(&o.stderr).contains("no translator from rv32 to rust"));
    let o = riscvsim(&["translate", "--to", "rv32"]);
    assert_eq!(o.status.code(), Some(2));
    let _ = std::fs::remove_file(c);
}

#[test]
fn run_json_matches_the_shared_engine_report_and_honours_the_limit() {
    let src = "li a0, 0x100000000\nloop: j loop\n";
    let s = temp("loop.s", src);
    let o = riscvsim(&["run", s.to_str().unwrap(), "--xlen=64", "--limit", "500", "--json"]);
    assert_eq!(o.status.code(), Some(1));
    let json: serde_json::Value = serde_json::from_slice(&o.stdout).expect("json");
    let expected = serde_json::to_value(sim_engine::report::run64(src, 500)).unwrap();
    assert_eq!(json, expected, "CLI and browser engine must agree");
    assert!(json["message"].as_str().unwrap().starts_with("step limit reached"));
    assert_eq!(json["cycles"], 500);
    let o = riscvsim(&["run", s.to_str().unwrap(), "--limit", "zero"]);
    assert_eq!(o.status.code(), Some(2));
    let bad = temp("bad.s", "addd a0, a0, a0\n");
    let o = riscvsim(&["run", bad.to_str().unwrap(), "--json"]);
    assert_eq!(o.status.code(), Some(1), "assembly and translation errors exit 1 (problem with the input)");
    let json: serde_json::Value = serde_json::from_slice(&o.stdout).expect("json");
    assert_eq!((json["ok"].as_bool(), json["line"].as_u64()), (Some(false), Some(1)));
    let _ = std::fs::remove_file(s);
    let _ = std::fs::remove_file(bad);
}

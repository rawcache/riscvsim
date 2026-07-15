use std::process::Command;

#[test]
fn run_xlen64_executes_values_above_u32() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "riscvsim-rv64-cli-{}-{nonce}.s",
        std::process::id(),
    ));
    std::fs::write(
        &path,
        "li x5, 0x100000000\naddi x6, x5, 7\nli x10, 0x10000000\nsd x6, 0(x10)\nld x7, 0(x10)\n",
    )
    .expect("write RV64 fixture");

    let output = Command::new(env!("CARGO_BIN_EXE_riscvsim"))
        .arg("run")
        .arg(&path)
        .arg("--xlen=64")
        .env("NO_COLOR", "1")
        .output()
        .expect("run riscvsim");
    let _ = std::fs::remove_file(&path);

    assert!(
        output.status.success(),
        "stderr: {}\nstdout: {}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Assembling RV64IM program"));
    assert!(stdout.contains("4294967303"));
    assert!(stdout.contains("RV64 program complete"));
}

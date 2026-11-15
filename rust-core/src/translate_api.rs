//! WASM bindings for the C/C++/Rust/RISC-V translators and cross-XLEN converters.
//! Additive, using the same pattern as pipeline_api.rs: lib.rs only registers
//! the module, and the underlying behavior remains in sim-engine.

use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
struct TranslationResult {
    ok: bool,
    /// Translated text when ok.
    output: Option<String>,
    /// 1-based source line the error points at (0 = no anchor).
    line: usize,
    /// Honest failure message when !ok.
    message: Option<String>,
}

fn to_js(result: &TranslationResult) -> JsValue {
    serde_wasm_bindgen::to_value(result).unwrap_or(JsValue::NULL)
}

fn conversion_to_js(result: Result<String, sim_engine::XlenConvertError>) -> JsValue {
    match result {
        Ok(output) => to_js(&TranslationResult {
            ok: true,
            output: Some(output),
            line: 0,
            message: None,
        }),
        Err(error) => to_js(&TranslationResult {
            ok: false,
            output: None,
            line: error.line,
            message: Some(error.message),
        }),
    }
}

/// RISC-V assembly -> educational C pseudocode.
#[wasm_bindgen]
pub fn translate_asm_to_c(source: &str) -> JsValue {
    match sim_engine::asm_to_c(source) {
        Ok(output) => to_js(&TranslationResult {
            ok: true,
            output: Some(output),
            line: 0,
            message: None,
        }),
        Err(e) => to_js(&TranslationResult {
            ok: false,
            output: None,
            line: e.line,
            message: Some(e.message),
        }),
    }
}

/// RV64IM assembly -> educational 64-bit C pseudocode.
#[wasm_bindgen]
pub fn translate_asm64_to_c(source: &str) -> JsValue {
    match sim_engine::asm64_to_c(source) {
        Ok(output) => to_js(&TranslationResult {
            ok: true,
            output: Some(output),
            line: 0,
            message: None,
        }),
        Err(error) => to_js(&TranslationResult {
            ok: false,
            output: None,
            line: error.line,
            message: Some(error.message),
        }),
    }
}

/// C subset -> RV32IM assembly (runnable in this simulator).
#[wasm_bindgen]
pub fn translate_c_to_asm(source: &str) -> JsValue {
    match sim_engine::c_to_asm(source) {
        Ok(output) => to_js(&TranslationResult {
            ok: true,
            output: Some(output),
            line: 0,
            message: None,
        }),
        Err(e) => to_js(&TranslationResult {
            ok: false,
            output: None,
            line: e.line,
            message: Some(e.message),
        }),
    }
}

/// C subset -> RV64IM assembly with signed 32-bit `int` semantics.
#[wasm_bindgen]
pub fn translate_c_to_asm64(source: &str) -> JsValue {
    match sim_engine::c_to_asm64(source) {
        Ok(output) => to_js(&TranslationResult {
            ok: true,
            output: Some(output),
            line: 0,
            message: None,
        }),
        Err(error) => to_js(&TranslationResult {
            ok: false,
            output: None,
            line: error.line,
            message: Some(error.message),
        }),
    }
}

/// Documented C++ int/bool subset -> RV32IM assembly (runnable in this simulator).
#[wasm_bindgen]
pub fn translate_cpp_to_asm(source: &str) -> JsValue {
    match sim_engine::cpp_to_asm(source) {
        Ok(output) => to_js(&TranslationResult {
            ok: true,
            output: Some(output),
            line: 0,
            message: None,
        }),
        Err(error) => to_js(&TranslationResult {
            ok: false,
            output: None,
            line: error.line,
            message: Some(error.message),
        }),
    }
}

/// Documented C++ int/bool subset -> RV64IM assembly with signed 32-bit `int` semantics.
#[wasm_bindgen]
pub fn translate_cpp_to_asm64(source: &str) -> JsValue {
    match sim_engine::cpp_to_asm64(source) {
        Ok(output) => to_js(&TranslationResult {
            ok: true,
            output: Some(output),
            line: 0,
            message: None,
        }),
        Err(error) => to_js(&TranslationResult {
            ok: false,
            output: None,
            line: error.line,
            message: Some(error.message),
        }),
    }
}

/// Documented C integer subset -> compilable C++ subset source.
#[wasm_bindgen]
pub fn translate_c_to_cpp(source: &str) -> JsValue {
    match sim_engine::c_to_cpp(source) {
        Ok(output) => to_js(&TranslationResult {
            ok: true,
            output: Some(output),
            line: 0,
            message: None,
        }),
        Err(error) => to_js(&TranslationResult {
            ok: false,
            output: None,
            line: error.line,
            message: Some(error.message),
        }),
    }
}

/// Documented C++ int/bool subset -> compilable C subset source.
#[wasm_bindgen]
pub fn translate_cpp_to_c(source: &str) -> JsValue {
    match sim_engine::cpp_to_c(source) {
        Ok(output) => to_js(&TranslationResult {
            ok: true,
            output: Some(output),
            line: 0,
            message: None,
        }),
        Err(error) => to_js(&TranslationResult {
            ok: false,
            output: None,
            line: error.line,
            message: Some(error.message),
        }),
    }
}

/// Documented safe C intersection -> compilable Rust subset source.
#[wasm_bindgen]
pub fn translate_c_to_rust(source: &str) -> JsValue {
    match sim_engine::c_to_rust(source) {
        Ok(output) => to_js(&TranslationResult {
            ok: true,
            output: Some(output),
            line: 0,
            message: None,
        }),
        Err(error) => to_js(&TranslationResult {
            ok: false,
            output: None,
            line: error.line,
            message: Some(error.message),
        }),
    }
}

/// Documented C++ subset -> compilable Rust subset source.
#[wasm_bindgen]
pub fn translate_cpp_to_rust(source: &str) -> JsValue {
    match sim_engine::cpp_to_rust(source) {
        Ok(output) => to_js(&TranslationResult {
            ok: true,
            output: Some(output),
            line: 0,
            message: None,
        }),
        Err(error) => to_js(&TranslationResult {
            ok: false,
            output: None,
            line: error.line,
            message: Some(error.message),
        }),
    }
}

/// Documented by-value Rust subset -> compilable C subset source.
#[wasm_bindgen]
pub fn translate_rust_to_c(source: &str) -> JsValue {
    match sim_engine::rust_to_c(source) {
        Ok(output) => to_js(&TranslationResult {
            ok: true,
            output: Some(output),
            line: 0,
            message: None,
        }),
        Err(error) => to_js(&TranslationResult {
            ok: false,
            output: None,
            line: error.line,
            message: Some(error.message),
        }),
    }
}

/// Documented by-value Rust subset -> compilable native C++ subset source.
#[wasm_bindgen]
pub fn translate_rust_to_cpp(source: &str) -> JsValue {
    match sim_engine::rust_to_cpp(source) {
        Ok(output) => to_js(&TranslationResult {
            ok: true,
            output: Some(output),
            line: 0,
            message: None,
        }),
        Err(error) => to_js(&TranslationResult {
            ok: false,
            output: None,
            line: error.line,
            message: Some(error.message),
        }),
    }
}

/// Documented by-value Rust subset -> RV32IM assembly (runnable in this simulator).
#[wasm_bindgen]
pub fn translate_rust_to_asm(source: &str) -> JsValue {
    match sim_engine::rust_to_asm(source) {
        Ok(output) => to_js(&TranslationResult {
            ok: true,
            output: Some(output),
            line: 0,
            message: None,
        }),
        Err(error) => to_js(&TranslationResult {
            ok: false,
            output: None,
            line: error.line,
            message: Some(error.message),
        }),
    }
}

/// Documented by-value Rust subset -> RV64IM assembly with signed 32-bit `i32` semantics.
#[wasm_bindgen]
pub fn translate_rust_to_asm64(source: &str) -> JsValue {
    match sim_engine::rust_to_asm64(source) {
        Ok(output) => to_js(&TranslationResult {
            ok: true,
            output: Some(output),
            line: 0,
            message: None,
        }),
        Err(error) => to_js(&TranslationResult {
            ok: false,
            output: None,
            line: error.line,
            message: Some(error.message),
        }),
    }
}

/// RV32IM assembly -> executable RV64IM preserving RV32 value semantics.
#[wasm_bindgen]
pub fn translate_rv32_to_rv64(source: &str) -> JsValue {
    conversion_to_js(sim_engine::rv32_to_rv64(source))
}

/// Strict 32-bit-safe RV64IM assembly -> executable RV32IM.
#[wasm_bindgen]
pub fn translate_rv64_to_rv32(source: &str) -> JsValue {
    conversion_to_js(sim_engine::rv64_to_rv32(source))
}

/// The documented C subset, for honest UI text.
#[wasm_bindgen]
pub fn c_subset_supported() -> String {
    sim_engine::C_SUBSET_SUPPORTED.to_string()
}

#[wasm_bindgen]
pub fn c_subset_unsupported() -> String {
    sim_engine::C_SUBSET_UNSUPPORTED.to_string()
}

#[wasm_bindgen]
pub fn cpp_subset_supported() -> String {
    sim_engine::CPP_SUBSET_SUPPORTED.to_string()
}

#[wasm_bindgen]
pub fn cpp_subset_unsupported() -> String {
    sim_engine::CPP_SUBSET_UNSUPPORTED.to_string()
}

#[wasm_bindgen]
pub fn rust_subset_supported() -> String {
    sim_engine::RUST_SUBSET_SUPPORTED.to_string()
}

#[wasm_bindgen]
pub fn rust_subset_unsupported() -> String {
    sim_engine::RUST_SUBSET_UNSUPPORTED.to_string()
}

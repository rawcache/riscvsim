//! The StudyRISC-V chip mark, rendered in the terminal.
//!
//! Proportions follow the actual brand mark (favicon.png): the `❯_` prompt
//! glyph is the dominant element — a solid-filled chevron built from block
//! characters (`█` plus `▀`/`▄` half blocks, which double the effective
//! vertical resolution along the diagonals) and a thick filled underscore —
//! while the chip body and its three pins per side are a light box-drawing
//! frame around it, not a competing element.

/// Unicode chip art. Every line is the same display width (20 columns).
pub const CHIP_UNICODE: &[&str] = &[
    "     ╷   ╷   ╷      ",
    "  ╭──┴───┴───┴──╮   ",
    " ─┤             ├─  ",
    "  │ ▀█▄         │   ",
    " ─┤   ▀█▄       ├─  ",
    "  │   ▄█▀       │   ",
    " ─┤ ▄█▀    ███  ├─  ",
    "  ╰──┬───┬───┬──╯   ",
    "     ╵   ╵   ╵      ",
];

/// ASCII fallback for terminals without Unicode. The glyph stays solid-fill
/// (`#` blocks), only at whole-character resolution.
pub const CHIP_ASCII: &[&str] = &[
    "     .   .   .      ",
    "  +--+---+---+--+   ",
    " -|             |-  ",
    "  | ##          |   ",
    " -|  ##         |-  ",
    "  |  ##         |   ",
    " -| ##     ###  |-  ",
    "  +--+---+---+--+   ",
    "     '   '   '      ",
];

pub fn chip(unicode: bool) -> &'static [&'static str] {
    if unicode {
        CHIP_UNICODE
    } else {
        CHIP_ASCII
    }
}

/// Chars belonging to the `❯_` prompt glyph (vs. the chip outline/pins) —
/// the renderer paints these in solid ink so the glyph pops the way it
/// does in the favicon.
pub fn is_glyph_char(c: char) -> bool {
    matches!(c, '█' | '▀' | '▄' | '#')
}

/// One-cell brand mark for the header bar: the prompt from inside the chip.
pub fn mini_mark(unicode: bool) -> &'static str {
    if unicode {
        "❯_"
    } else {
        ">_"
    }
}

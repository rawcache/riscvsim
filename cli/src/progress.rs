//! Ctrl-C handling and the single live status line for long runs.
//!
//! No dependencies: the interrupt handler is installed through the C
//! runtime the standard library already links (`signal` on Unix,
//! `SetConsoleCtrlHandler` on Windows) and only flips an atomic flag, so the
//! run loop can stop between chunks and print a clean summary.

use crate::term::{group_thousands, Paint, Stream};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

static INTERRUPTED: AtomicBool = AtomicBool::new(false);

pub fn interrupted() -> bool {
    INTERRUPTED.load(Ordering::Relaxed)
}

#[cfg(unix)]
mod sys {
    use super::{Ordering, INTERRUPTED};
    const SIGINT: i32 = 2;
    extern "C" {
        fn signal(signum: i32, handler: usize) -> usize;
    }
    extern "C" fn on_sigint(_: i32) {
        INTERRUPTED.store(true, Ordering::Relaxed);
    }
    pub fn install() {
        // SAFETY: `on_sigint` is async-signal-safe (a single atomic store).
        unsafe {
            signal(SIGINT, on_sigint as extern "C" fn(i32) as usize);
        }
    }
}

#[cfg(windows)]
mod sys {
    use super::{Ordering, INTERRUPTED};
    extern "system" {
        fn SetConsoleCtrlHandler(handler: usize, add: i32) -> i32;
    }
    extern "system" fn on_ctrl(_: u32) -> i32 {
        INTERRUPTED.store(true, Ordering::Relaxed);
        1
    }
    pub fn install() {
        // SAFETY: registers a handler that only stores to an atomic.
        unsafe {
            SetConsoleCtrlHandler(on_ctrl as extern "system" fn(u32) -> i32 as usize, 1);
        }
    }
}

#[cfg(not(any(unix, windows)))]
mod sys {
    pub fn install() {}
}

/// Route Ctrl-C to the interrupt flag instead of killing the process.
pub fn catch_interrupt() {
    sys::install();
}

/// The live status line: spinner · cycles · speed, on stderr, redrawn in
/// place at most 20 times a second, only when stderr is a terminal, and
/// only once a run has lasted long enough to need it.
pub struct Status {
    enabled: bool,
    paint: Paint,
    started: Instant,
    last_draw: Option<Instant>,
    frame: usize,
    shown: bool,
    watch: Option<String>,
}

const SHOW_AFTER: Duration = Duration::from_millis(250);
const MIN_INTERVAL: Duration = Duration::from_millis(50); // 20 Hz

impl Status {
    pub fn new() -> Self {
        Self {
            enabled: Stream::Stderr.is_tty() && !std::env::var("TERM").is_ok_and(|t| t == "dumb"),
            paint: Paint::stderr(),
            started: Instant::now(),
            last_draw: None,
            frame: 0,
            shown: false,
            watch: None,
        }
    }

    /// Show `text` (for example `x5 = 42`) on the live line: `--watch`.
    pub fn watch(&mut self, text: String) {
        self.watch = Some(text);
    }

    pub fn update(&mut self, cycles: u64) {
        if !self.enabled {
            return;
        }
        let now = Instant::now();
        let elapsed = now - self.started;
        if elapsed < SHOW_AFTER {
            return;
        }
        if self.last_draw.is_some_and(|t| now - t < MIN_INTERVAL) {
            return;
        }
        self.last_draw = Some(now);
        let frames: &[&str] = if self.paint.unicode {
            &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
        } else {
            &["|", "/", "-", "\\"]
        };
        let spin = frames[self.frame % frames.len()];
        self.frame += 1;
        let rate = cycles as f64 / elapsed.as_secs_f64().max(1e-9);
        let dot = self.paint.dot();
        let watch = self.watch.as_deref().map(|w| format!("{} {dot} ", self.paint.bold(w))).unwrap_or_default();
        let line = format!(
            "{} running {dot} {} cycles {dot} {}{} {dot} Ctrl-C to stop",
            self.paint.status(spin),
            group_thousands(cycles),
            watch,
            format_rate(rate),
        );
        let mut err = std::io::stderr().lock();
        let _ = write!(err, "\r\x1b[2K{line}");
        let _ = err.flush();
        self.shown = true;
    }

    /// Erase the status line, leaving the cursor at column 0.
    pub fn clear(&mut self) {
        if self.shown {
            let mut err = std::io::stderr().lock();
            let _ = write!(err, "\r\x1b[2K");
            let _ = err.flush();
            self.shown = false;
        }
    }

}

impl Drop for Status {
    fn drop(&mut self) {
        self.clear();
    }
}

/// "12.3 M cycles/s"
pub fn format_rate(per_sec: f64) -> String {
    if per_sec >= 1e6 {
        format!("{:.1} M cycles/s", per_sec / 1e6)
    } else if per_sec >= 1e3 {
        format!("{:.0} k cycles/s", per_sec / 1e3)
    } else {
        format!("{per_sec:.0} cycles/s")
    }
}

#[cfg(test)]
mod tests {
    use super::format_rate;

    #[test]
    fn rates() {
        assert_eq!(format_rate(12_345_678.0), "12.3 M cycles/s");
        assert_eq!(format_rate(45_600.0), "46 k cycles/s");
        assert_eq!(format_rate(12.0), "12 cycles/s");
    }
}

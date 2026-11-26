//! `riscvsim tui` — the full-screen interactive simulator.
//!
//! Everything the browser simulator does, inside the terminal: the five
//! pipeline stages, forwarded values traveling between them, registers and
//! memory, the streaming terminal log — all mouse-clickable, all animated,
//! all driven by the exact same sim-engine pipeline.

mod app;
mod draw;
mod logo;
pub mod samples;
mod tour;

pub use app::ServeRequest;

use app::App;
use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::event::{DisableMouseCapture, EnableMouseCapture, Event, KeyEventKind};
use ratatui::crossterm::cursor::Show;
use ratatui::crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, BeginSynchronizedUpdate, EndSynchronizedUpdate,
    EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::crossterm::{event, execute};
use ratatui::Terminal;
use std::io::{self, IsTerminal};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub struct Opts {
    pub file: Option<PathBuf>,
    /// --tour: show the walkthrough even if the first-run marker exists.
    pub force_tour: bool,
    /// Register width, from `--xlen` (32 or 64).
    pub xlen: u32,
}

/// Put the terminal back the way we found it. Safe to call more than once
/// (normal exit, error, and the panic hook all call it).
fn restore_terminal() -> io::Result<()> {
    let raw = disable_raw_mode();
    execute!(io::stdout(), EndSynchronizedUpdate, DisableMouseCapture, LeaveAlternateScreen, Show)?;
    raw
}

/// Returns a [`ServeRequest`] when the session ended via `/serve` — the caller
/// starts the server after the terminal is restored.
pub fn run(opts: Opts) -> Result<Option<ServeRequest>, String> {
    if !io::stdout().is_terminal() {
        return Err(
            "the interactive simulator needs a terminal; output is redirected. \
             Use riscvsim run <file.s> for plain output"
                .into(),
        );
    }
    if std::env::var("TERM").map(|t| t == "dumb").unwrap_or(false) {
        return Err(
            "TERM=dumb: the interactive simulator needs a full terminal. \
             Use riscvsim run <file.s> for plain output"
                .into(),
        );
    }

    // Load the program: an explicit file, or the first built-in sample.
    let (file_path, file_name, source) = match &opts.file {
        Some(path) => {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.display().to_string());
            let source = std::fs::read_to_string(path)
                .map_err(|e| format!("could not read {}: {e}", path.display()))?;
            (Some(path.clone()), name, source)
        }
        None => {
            // A 64-bit session starts with the 64-bit sample.
            let s = if opts.xlen == 64 { &samples::RV64_SAMPLE } else { &samples::SAMPLES[0] };
            (None, s.file.to_string(), s.source.to_string())
        }
    };

    let show_tour = opts.force_tour || !tour::seen();
    let update_status = Arc::new(Mutex::new(None));
    crate::update::spawn_status_check(env!("CARGO_PKG_VERSION"), update_status.clone());
    let install_method = crate::doctor::active_install_method();
    let mut app = App::new(
        file_path,
        source,
        file_name,
        show_tour,
        update_status,
        install_method,
    );
    app.xlen = opts.xlen;
    app.boot();

    enable_raw_mode().map_err(|e| e.to_string())?;
    execute!(io::stdout(), EnterAlternateScreen, EnableMouseCapture).map_err(|e| e.to_string())?;
    // If anything panics mid-frame, put the terminal back together before
    // the panic message prints — a raw-mode shell is worse than a crash.
    let orig_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = restore_terminal();
        orig_hook(info);
    }));

    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend).map_err(|e| e.to_string())?;
    let result = event_loop(&mut terminal, &mut app);

    let _ = std::panic::take_hook(); // drop our hook
    restore_terminal().map_err(|e| e.to_string())?;
    result.map_err(|e| e.to_string())?;

    // A plain quit counts as seen only after at least one tour frame was
    // actually rendered. Startup failures and quits at an earlier gate do not.
    if app.tour_shown {
        tour::mark_seen();
    }
    Ok(app.serve_request.take())
}

fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
) -> io::Result<()> {
    loop {
        // Synchronized output: the terminal shows the whole frame at once
        // (no tearing); ratatui itself only writes the cells that changed.
        execute!(terminal.backend_mut(), BeginSynchronizedUpdate)?;
        let drawn = terminal.draw(|f| draw::draw(f, app)).map(|_| ());
        execute!(terminal.backend_mut(), EndSynchronizedUpdate)?;
        drawn?;

        // Block until input or the next animation frame is due; drain every
        // queued event before redrawing so clicks and keys never wait on
        // the render loop.
        if event::poll(app.tick_timeout())? {
            loop {
                match event::read()? {
                    Event::Key(key) if key.kind != KeyEventKind::Release => app.on_key(key),
                    Event::Mouse(me) => app.on_mouse(me),
                    // Redraw at the new size right away (ratatui resizes its
                    // buffers and repaints everything on the next draw).
                    Event::Resize(_, _) => terminal.autoresize()?,
                    _ => {}
                }
                if !event::poll(std::time::Duration::from_millis(0))? {
                    break;
                }
            }
        }
        app.tick();
        if app.quit {
            return Ok(());
        }
    }
}

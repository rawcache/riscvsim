//! `riscvsim tui` — the full-screen interactive simulator.
//!
//! Everything the browser simulator does, inside the terminal: the five
//! pipeline stages, forwarded values traveling between them, registers and
//! memory, the streaming terminal log — all mouse-clickable, all animated,
//! all driven by the exact same sim-engine pipeline.

mod app;
mod draw;
mod logo;
mod samples;
mod tour;

pub use app::ServeRequest;

use app::App;
use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::event::{DisableMouseCapture, EnableMouseCapture, Event, KeyEventKind};
use ratatui::crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
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
}

fn restore_terminal() -> io::Result<()> {
    disable_raw_mode()?;
    execute!(io::stdout(), LeaveAlternateScreen, DisableMouseCapture)?;
    Ok(())
}

/// Returns a [`ServeRequest`] when the session ended via `/serve` — the caller
/// starts the server after the terminal is restored.
pub fn run(opts: Opts) -> Result<Option<ServeRequest>, String> {
    if !io::stdout().is_terminal() {
        return Err("interactive mode needs a terminal (stdout is not a tty)".into());
    }
    if std::env::var("TERM").map(|t| t == "dumb").unwrap_or(false) {
        return Err(
            "TERM=dumb: interactive mode needs a full terminal — use `riscvsim run`".into(),
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
            let s = &samples::SAMPLES[0];
            (None, s.file.to_string(), s.source.to_string())
        }
    };

    let show_tour = opts.force_tour || !tour::seen();
    // Trust check: only when loading a real file from a directory the user
    // hasn't confirmed before. Built-in samples never prompt.
    let trust_key = file_path
        .as_ref()
        .and_then(|p| tour::trust_key(p))
        .filter(|key| !tour::is_trusted(key));
    let update_status = Arc::new(Mutex::new(None));
    crate::update::spawn_status_check(env!("CARGO_PKG_VERSION"), update_status.clone());
    let install_method = crate::doctor::active_install_method();
    let mut app = App::new(
        file_path,
        source,
        file_name,
        show_tour,
        trust_key,
        update_status,
        install_method,
    );
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

    // The walkthrough completing (or being skipped) already wrote the
    // marker; a plain quit during the tour counts as seen too.
    if show_tour {
        tour::mark_seen();
    }
    Ok(app.serve_request.take())
}

fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
) -> io::Result<()> {
    loop {
        terminal.draw(|f| draw::draw(f, app))?;

        // Block until input or the next animation frame is due; drain every
        // queued event before redrawing so clicks and keys never wait on
        // the render loop.
        if event::poll(app.tick_timeout())? {
            loop {
                match event::read()? {
                    Event::Key(key) if key.kind != KeyEventKind::Release => app.on_key(key),
                    Event::Mouse(me) => app.on_mouse(me),
                    Event::Resize(_, _) => {}
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

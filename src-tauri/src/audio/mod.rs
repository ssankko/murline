//! The sound engine's command surface. Format-neutral by rule: opaque string ids, reasons as plain
//! text, and no Audio Unit or CoreAudio type crossing into the webview, so a backend for another
//! platform can sit behind exactly these commands.

use serde::Serialize;

#[cfg(target_os = "macos")]
mod instruments;
#[cfg(target_os = "macos")]
pub mod mac;
#[cfg(target_os = "macos")]
mod window;
// On macOS the stub is only there for the tests that check what a platform without an engine
// answers; off macOS it is the engine.
#[cfg(any(not(target_os = "macos"), test))]
pub mod stub;

#[cfg(target_os = "macos")]
use mac as engine;
#[cfg(not(target_os = "macos"))]
use stub as engine;

/// What the Audio dialog reads: whether sound can come out of the app, and the one line saying why
/// not when it cannot.
#[derive(Debug, Serialize)]
pub struct Status {
    pub available: bool,
    pub reason: String,
}

impl Status {
    fn unavailable(reason: &str) -> Self {
        Status { available: false, reason: reason.into() }
    }
}

/// One line of the instrument picker. The id is opaque: a file and an Audio Unit look the same
/// from the webview, which only ever hands one back.
#[derive(Debug, Serialize)]
pub struct Instrument {
    pub id: String,
    pub name: String,
    /// `file` for one the sampler loads, `plugin` for a hosted Audio Unit, which is the one that
    /// has a window of its own.
    pub kind: String,
    pub loaded: bool,
    /// Why this instrument is not sounding, when it is the chosen one and its load failed.
    pub reason: String,
}

/// Builds the graph and starts it on the output device. The boot screen prints ok or the reason,
/// and a failure leaves every later step running.
#[tauri::command]
pub fn audio_start() -> Result<(), String> {
    engine::start()
}

#[tauri::command]
pub fn audio_status() -> Status {
    engine::status()
}

/// One metronome click, at a volume of 0 to 100. A no-op where there is no engine, so the
/// metronome is simply silent there.
#[tauri::command]
pub fn audio_click(strength: String, volume: u32) {
    engine::click(strength == "strong", volume);
}

/// Every instrument the engine can play: Logic's pianos, the files in the folder the webview
/// names, and the installed Audio Unit instruments.
#[tauri::command]
pub fn audio_instruments(folder: String) -> Vec<Instrument> {
    engine::instruments(&folder)
}

/// Loads one of them, with the state a plugin was last left in. Off the main thread: a big sampler
/// instrument takes a moment to read, and the app stays answering while it does.
#[tauri::command(async)]
pub fn audio_load_instrument(id: String, state: Option<String>) -> Result<(), String> {
    engine::load_instrument(&id, state.as_deref())
}

/// Opens the instrument's own window, and answers with its state when the user closes it again.
#[tauri::command]
pub async fn audio_show_instrument(app: tauri::AppHandle) -> Result<Option<String>, String> {
    engine::show_instrument(app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_platform_without_an_engine_says_so_and_every_command_still_answers() {
        assert_eq!(stub::start(), Err("No sound engine on this platform".into()));

        let status = stub::status();
        assert!(!status.available);
        assert_eq!(status.reason, "No sound engine on this platform");

        // The click is the one command that returns nothing: silence is the whole of its answer.
        stub::click(true, 70);
        stub::click(false, 0);

        assert!(stub::instruments("/instruments").is_empty());
        assert_eq!(
            stub::load_instrument("file:/instruments/piano.sf2", None),
            Err("No sound engine on this platform".into())
        );
    }
}

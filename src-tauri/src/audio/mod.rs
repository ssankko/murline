//! The sound engine's command surface. Format-neutral by rule: opaque string ids, reasons as plain
//! text, and no Audio Unit or CoreAudio type crossing into the webview, so a backend for another
//! platform can sit behind exactly these commands.

use serde::Serialize;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
pub mod mac;
pub mod preview;
// On macOS the stub is only there for the tests that check what a platform without an engine
// answers; off macOS it is the engine.
#[cfg(any(not(target_os = "macos"), test))]
pub mod stub;

#[cfg(target_os = "macos")]
use mac as engine;
#[cfg(not(target_os = "macos"))]
use stub as engine;

use preview::PreviewNote;

/// What the Audio dialog reads: whether sound can come out of the app, and the one line saying why
/// not when it cannot.
#[derive(Debug, Serialize)]
pub struct Status {
    pub available: bool,
    pub reason: String,
}

/// Where Preview playback stands, emitted as `preview-progress` about thirty times a second and
/// once more when the piece ends, with `playing` false and the time back at zero.
#[derive(Clone, Serialize)]
pub struct Progress {
    pub seconds: f64,
    pub playing: bool,
}

/// The handle the engine emits progress on, set once when the app starts.
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn remember(app: AppHandle) {
    let _ = APP.set(app);
}

/// Called from the engine's pump. Before the app has a handle, and in the tests, it does nothing.
pub fn progress(seconds: f64, playing: bool) {
    if let Some(app) = APP.get() {
        let _ = app.emit("preview-progress", Progress { seconds, playing });
    }
}

impl Status {
    fn unavailable(reason: &str) -> Self {
        Status { available: false, reason: reason.into() }
    }
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

/// The Preview's note list, in seconds at the score's own tempo. Replaces whatever was loaded.
#[tauri::command]
pub fn preview_load(notes: Vec<PreviewNote>) {
    engine::preview_load(notes);
}

#[tauri::command]
pub fn preview_play() {
    engine::preview_play();
}

#[tauri::command]
pub fn preview_pause() {
    engine::preview_pause();
}

/// Jumps to a time in the piece's own seconds, tempo percent aside.
#[tauri::command]
pub fn preview_seek(seconds: f64) {
    engine::preview_seek(seconds);
}

/// The tempo as a percent of the score's own: 50 makes the piece take twice as long.
#[tauri::command]
pub fn preview_rate(percent: u32) {
    engine::preview_rate(percent);
}

/// Stops, forgets the note list and returns to the start. What leaving the Preview sends.
#[tauri::command]
pub fn preview_stop() {
    engine::preview_stop();
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

        stub::preview_load(vec![]);
        stub::preview_play();
        stub::preview_pause();
        stub::preview_seek(4.0);
        stub::preview_rate(50);
        stub::preview_stop();
    }
}

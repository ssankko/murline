//! The sound engine's command surface. Format-neutral by rule: opaque string ids, reasons as plain
//! text, and no Audio Unit or CoreAudio type crossing into the webview, so a backend for another
//! platform can sit behind exactly these commands.

use serde::Serialize;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
pub mod device;
#[cfg(target_os = "macos")]
pub mod mac;
// On macOS the stub is only there for the tests that check what a platform without an engine
// answers; off macOS it is the engine.
#[cfg(any(not(target_os = "macos"), test))]
pub mod stub;

#[cfg(target_os = "macos")]
use mac as engine;
#[cfg(not(target_os = "macos"))]
use stub as engine;

/// The event the webview listens for to know its device list is stale. Sent when CoreAudio reports
/// a device plugged in or unplugged, so the picker follows the hardware without a restart.
pub const DEVICES_CHANGED: &str = "audio-devices-changed";

/// The running app, so the engine can send an event from a CoreAudio thread. Set once at start-up.
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn remember(app: AppHandle) {
    let _ = APP.set(app);
}

pub(crate) fn tell_devices_changed() {
    if let Some(app) = APP.get() {
        let _ = app.emit(DEVICES_CHANGED, ());
    }
}

/// What the Audio dialog reads: whether sound can come out of the app, the one line saying why not
/// when it cannot, and the output the engine plays through.
#[derive(Debug, Default, Serialize)]
pub struct Status {
    pub available: bool,
    pub reason: String,
    /// Opaque id of the device the engine plays through now; null while it plays through none.
    pub device: Option<String>,
    pub device_name: String,
    /// Why the device playing is not the one chosen; empty while the choice is honoured.
    pub fallback: String,
    pub buffer_frames: u32,
    pub sample_rate: f64,
    /// What the device reports the buffer costs: its own latency, the safety offset, the stream
    /// and the buffer itself, at the rate the device runs.
    pub latency_ms: f64,
}

impl Status {
    fn unavailable(reason: &str) -> Self {
        Status { reason: reason.into(), ..Status::default() }
    }
}

/// One output device as the picker lists it. The system default is not a row here; the dialog
/// offers it as the choice of no device at all.
#[derive(Debug, Serialize)]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
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

/// Every device the app can play through, newest list each call. The webview reads it again on
/// every `audio-devices-changed`.
#[tauri::command]
pub fn audio_output_devices() -> Vec<OutputDevice> {
    engine::output_devices()
}

/// Moves the output to `id`, or to the system default when it is null. The choice is kept even
/// when the device is not plugged in, so the engine takes it up again when it comes back.
#[tauri::command]
pub fn audio_set_output_device(id: Option<String>) -> Result<(), String> {
    engine::set_output_device(id)
}

/// 32, 64, 128 or 256 frames.
#[tauri::command]
pub fn audio_set_buffer_frames(frames: u32) -> Result<(), String> {
    engine::set_buffer_frames(frames)
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

        assert!(stub::output_devices().is_empty());
        assert!(stub::set_output_device(Some("anything".into())).is_err());
        assert!(stub::set_buffer_frames(64).is_err());
    }

    #[test]
    fn a_status_with_no_engine_carries_no_output_either() {
        let status = stub::status();
        assert_eq!(status.device, None);
        assert_eq!(status.buffer_frames, 0);
        assert_eq!(status.latency_ms, 0.0);
        assert_eq!(status.fallback, "");
    }
}

//! The sound engine everywhere but macOS: there is none. Every command still exists and answers,
//! so the webview needs no platform branch of its own; the app runs as it always did, silently.

use crate::audio::preview::PreviewNote;
use crate::audio::{Effect, Instrument, OutputDevice, Slot, Status};

const PLATFORM: &str = "No sound engine on this platform";

pub fn start() -> Result<(), String> {
    Err(PLATFORM.into())
}

pub fn status() -> Status {
    Status::unavailable(PLATFORM)
}

pub fn click(_strong: bool, _volume: u32) {}

pub fn set_keyboard_volume(_percent: u32) {}

pub fn effects() -> Vec<Effect> {
    Vec::new()
}

pub fn chain() -> Vec<Slot> {
    Vec::new()
}

/// The webview keeps the chain in its own setting, so it still shows one here; it simply plays
/// through nothing.
pub fn set_chain(_chain: Vec<Slot>) -> Result<Vec<Slot>, String> {
    Err(PLATFORM.into())
}

// Off macOS this is the command; on macOS it is compiled for the tests alone, and no test here has
// an app handle to call it with.
#[allow(dead_code)]
pub fn show_effect(_app: tauri::AppHandle, _index: usize) -> Result<(), String> {
    Err(PLATFORM.into())
}

pub fn output_devices() -> Vec<OutputDevice> {
    Vec::new()
}

pub fn set_output_device(_id: Option<String>) -> Result<(), String> {
    Err(PLATFORM.into())
}

pub fn set_buffer_frames(_frames: u32) -> Result<(), String> {
    Err(PLATFORM.into())
}

pub fn instruments(_folder: &str) -> Vec<Instrument> {
    Vec::new()
}

pub fn load_instrument(_id: &str, _state: Option<&str>) -> Result<(), String> {
    Err(PLATFORM.into())
}

// The stub compiles into the macOS tests too, where no test can hold an app to call this with.
#[allow(dead_code)]
pub async fn show_instrument(_app: tauri::AppHandle) -> Result<Option<String>, String> {
    Err(PLATFORM.into())
}

pub fn preview_load(_notes: Vec<PreviewNote>) {}

pub fn preview_play() {}

pub fn preview_pause() {}

pub fn preview_seek(_seconds: f64) {}

pub fn preview_rate(_percent: u32) {}

pub fn preview_stop() {}

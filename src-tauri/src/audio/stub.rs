//! The sound engine everywhere but macOS: there is none. Every command still exists and answers,
//! so the webview needs no platform branch of its own; the app runs as it always did, silently.

use crate::audio::{Instrument, Status};

const PLATFORM: &str = "No sound engine on this platform";

pub fn start() -> Result<(), String> {
    Err(PLATFORM.into())
}

pub fn status() -> Status {
    Status::unavailable(PLATFORM)
}

pub fn click(_strong: bool, _volume: u32) {}

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

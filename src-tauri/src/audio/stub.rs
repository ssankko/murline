//! The sound engine everywhere but macOS: there is none. Every command still exists and answers,
//! so the webview needs no platform branch of its own; the app runs as it always did, silently.

use crate::audio::{Effect, Slot, Status};

const PLATFORM: &str = "No sound engine on this platform";

pub fn start() -> Result<(), String> {
    Err(PLATFORM.into())
}

pub fn status() -> Status {
    Status::unavailable(PLATFORM)
}

pub fn click(_strong: bool, _volume: u32) {}

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

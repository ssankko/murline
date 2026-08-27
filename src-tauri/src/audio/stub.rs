//! The sound engine everywhere but macOS: there is none. Every command still exists and answers,
//! so the webview needs no platform branch of its own; the app runs as it always did, silently.

use crate::audio::Status;

const PLATFORM: &str = "No sound engine on this platform";

pub fn start() -> Result<(), String> {
    Err(PLATFORM.into())
}

pub fn status() -> Status {
    Status::unavailable(PLATFORM)
}

pub fn click(_strong: bool, _volume: u32) {}

//! The sound engine everywhere but macOS: there is none. Every command still exists and answers,
//! so the webview needs no platform branch of its own; the app runs as it always did, silently.

use crate::audio::Status;
use crate::audio::preview::PreviewNote;

const PLATFORM: &str = "No sound engine on this platform";

pub fn start() -> Result<(), String> {
    Err(PLATFORM.into())
}

pub fn status() -> Status {
    Status::unavailable(PLATFORM)
}

pub fn click(_strong: bool, _volume: u32) {}

pub fn preview_load(_notes: Vec<PreviewNote>) {}

pub fn preview_play() {}

pub fn preview_pause() {}

pub fn preview_seek(_seconds: f64) {}

pub fn preview_rate(_percent: u32) {}

pub fn preview_stop() {}

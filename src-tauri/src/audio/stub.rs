//! The sound engine everywhere but macOS: there is none. Every command still exists and answers,
//! so the webview needs no platform branch of its own; the app runs as it always did, silently.
//!
//! The graph is a type whose methods do nothing, reached through the same accessor the macOS
//! engine offers, so the command bodies compile against both and a stub that drifts fails the
//! build. Nothing here ever holds one, so no method is ever called.

use crate::audio::preview::PreviewNote;
use crate::audio::{Effect, Envelope, Instrument, Kept, OutputDevice, Slot, Status};

const PLATFORM: &str = "No sound engine on this platform";

/// The graph the app would play through. There is none here, so it is a shape and no state.
pub struct Graph;

// Off macOS these are what the commands call; on macOS the stub is compiled for the tests alone,
// where nothing holds a graph to call them on.
#[allow(dead_code, clippy::unused_self)]
impl Graph {
    pub fn status(&self) -> Status {
        Status::unavailable(PLATFORM)
    }

    pub fn click(&self, _strong: bool, _volume: u32) {}

    /// A key still answers with a velocity, because the caller reports the one that sounded.
    pub fn note(&self, _midi: u8, velocity: u8, _on: bool, _raw: bool) -> u8 {
        velocity
    }

    pub fn sustain(&self, _down: bool) {}

    /// Nothing is sounding, so a lost MIDI port has nothing to let go of.
    pub fn release_all(&self) {}

    pub fn set_keyboard_volume(&self, _percent: u32) {}

    pub fn set_velocity_curve(&mut self, _min: u32, _max: u32, _curve: f64) {}

    /// No instrument is loaded, so there is no envelope to describe.
    pub fn envelope(&self) -> Option<Envelope> {
        None
    }

    pub fn set_envelope(&mut self, _want: Envelope) {}

    pub fn set_role_level(&self, _role: crate::audio::sampler::Role, _percent: u32) {}

    pub fn set_device(&mut self, _chosen: Option<String>) -> Result<(), String> {
        Ok(())
    }

    pub fn set_buffer(&mut self, _frames: u32) -> Result<(), String> {
        Ok(())
    }

    pub fn set_voices(&mut self, _count: usize) -> Result<(), String> {
        Ok(())
    }

    pub fn preview_load(&self, _notes: Vec<PreviewNote>) {}

    pub fn preview_play(&self) {}

    pub fn preview_pause(&self) {}

    pub fn preview_seek(&self, _seconds: f64) {}

    pub fn preview_rate(&self, _percent: u32) {}

    pub fn preview_stop(&self) {}
}

/// There is never a graph, so every command falls to the answer it keeps for that.
pub fn graph() -> Option<Graph> {
    None
}

pub fn start() -> Result<(), String> {
    Err(PLATFORM.into())
}

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

pub fn set_sample_rate(_rate: u32) -> Result<(), String> {
    Err(PLATFORM.into())
}

pub fn instruments(_folder: &str) -> Vec<Instrument> {
    Vec::new()
}

pub fn load_instrument(_id: &str, _kept: &Kept) -> Result<Status, String> {
    Err(PLATFORM.into())
}

pub fn unload_instrument() -> Result<Status, String> {
    Err(PLATFORM.into())
}

// The stub compiles into the macOS tests too, where no test can hold an app to call this with.
#[allow(dead_code)]
pub async fn show_instrument(_app: tauri::AppHandle) -> Result<Option<String>, String> {
    Err(PLATFORM.into())
}

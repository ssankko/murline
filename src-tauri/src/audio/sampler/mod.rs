//! The sampler: the voice engine that turns an instrument's zones and decoded samples into sound,
//! one voice per struck key, rendered on the audio thread. Pure Rust; the macOS graph feeds it
//! commands and pulls its output through an AVAudioSourceNode.

use std::sync::Arc;

pub use super::Envelope;

pub mod engine;
pub mod exs;

/// One decoded sample: stereo, interleaved, 16-bit, at its own rate. `data` is either owned or a
/// memory map of the PCM cache; the engine only ever reads it.
pub struct Sample {
    pub rate: f64,
    pub data: Box<dyn AsRef<[i16]> + Send + Sync>,
}

impl Sample {
    pub fn frames(&self) -> usize {
        (*self.data).as_ref().len() / 2
    }
}

/// One playable region: the keys and velocities it answers, the key it was recorded at, and where
/// in its sample it starts and ends. `start` and `end` are frame indexes; `loop_` is a frame
/// range played round after the first pass, or nothing for a one-shot.
#[derive(Clone, Debug, PartialEq)]
pub struct Zone {
    pub key_lo: u8,
    pub key_hi: u8,
    pub vel_lo: u8,
    pub vel_hi: u8,
    pub root: u8,
    pub tune_cents: i32,
    pub gain_db: f32,
    pub sample: usize,
    pub start: usize,
    pub end: usize,
    pub loop_: Option<(usize, usize)>,
}

/// Everything a loaded instrument is: its zones and the samples they index.
pub struct Instrument {
    pub zones: Vec<Zone>,
    pub samples: Vec<Sample>,
}

/// What the rest of the app tells the engine. Sent over a channel and applied on the audio thread.
pub enum Command {
    /// Plays this instrument from the next render on; the one before is handed back by `apply`.
    Load(Arc<Instrument>),
    /// Forgets the instrument; silence until the next `Load`.
    Unload,
    NoteOn { note: u8, velocity: u8 },
    NoteOff { note: u8 },
    Sustain(bool),
    /// Ends every voice at once, pedal included.
    AllOff,
    Envelope(Envelope),
    /// The rate the engine renders at, when the device's changes.
    Rate(f64),
}

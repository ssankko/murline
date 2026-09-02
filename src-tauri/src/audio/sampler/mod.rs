//! The sampler: the voice engine that turns an instrument's zones and decoded samples into sound,
//! one voice per struck key, rendered on the audio thread. Pure Rust; the macOS graph feeds it
//! commands and pulls its output through an AVAudioSourceNode.

use std::sync::Arc;

pub use super::Envelope;
pub use stream::{Fill, Stream};
pub(crate) use stream::Ring;

#[cfg(target_os = "macos")]
pub mod disk;
pub mod engine;
pub mod exs;
pub mod sf2;
mod stream;

/// The stretch of a zone that is decoded into RAM at load, so a voice sounds the moment it starts
/// and the reader has this long to catch up with it.
pub const HEAD: f64 = 0.250;

/// One sample: stereo, interleaved, 16-bit, at its own rate. `data` holds every frame for a sample
/// small enough to keep, and nothing for one the zones read off the disk while they play.
pub struct Sample {
    pub rate: f64,
    pub frames: usize,
    pub data: Option<Vec<i16>>,
}

impl Sample {
    /// A sample held whole in memory, which is what a SoundFont's zones play from.
    pub fn memory(rate: f64, data: Vec<i16>) -> Self {
        Self { rate, frames: data.len() / 2, data: Some(data) }
    }
}

/// What a zone is for: the tone a key-down sounds, or one of the noises a piano makes around it.
/// Every role but `Sustain` sounds at a level the user sets, 0 being silent.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// The tone itself, on key-down.
    #[default]
    Sustain,
    /// The damper falling back on the string, on key-up.
    Release,
    /// The key itself coming back up, on key-up.
    KeyOff,
    /// The other strings ringing along, on key-down while the pedal is down.
    Sympathetic,
    /// The pedal going down and coming up.
    PedalNoise,
}

/// How many roles there are, which is the width of the engine's level array.
pub const ROLES: usize = 5;

/// One playable region: the keys and velocities it answers, the key it was recorded at, and where
/// in its sample it starts and ends. `start` and `end` are frame indexes; `loop_` is a frame
/// range played round after the first pass, or nothing for a one-shot.
#[derive(Clone, Debug, PartialEq)]
pub struct Zone {
    pub role: Role,
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

/// Everything a loaded instrument is: its zones, the samples they index, and, when the samples are
/// too big to hold, each zone's head in RAM and the rings the rest arrives through.
pub struct Instrument {
    pub zones: Vec<Zone>,
    pub samples: Vec<Sample>,
    /// Each zone's first frames, indexed like `zones`; empty for an instrument held in memory.
    pub heads: Vec<Vec<i16>>,
    /// The rings the streamed zones read from. The reader thread holds a weak reference to this,
    /// so dropping the instrument is what stops it.
    pub stream: Option<Arc<Stream>>,
    /// The zones each of the 128 keys answers with, indexed by key. A strike reads only its own
    /// key's list, which is a handful of zones out of the thousand a piano has.
    keyed: Vec<Vec<usize>>,
}

impl Instrument {
    /// Everything a load has made, with the per-key index built here so the audio thread never
    /// has to look for the zones a key answers with.
    pub fn new(
        zones: Vec<Zone>,
        samples: Vec<Sample>,
        heads: Vec<Vec<i16>>,
        stream: Option<Arc<Stream>>,
    ) -> Self {
        let mut keyed = vec![Vec::new(); 128];
        for (index, zone) in zones.iter().enumerate() {
            for key in zone.key_lo..=zone.key_hi.min(127) {
                keyed[key as usize].push(index);
            }
        }
        Self { zones, samples, heads, stream, keyed }
    }

    /// An instrument whose samples are all in memory and so needs no reader.
    pub fn memory(zones: Vec<Zone>, samples: Vec<Sample>) -> Self {
        Self::new(zones, samples, Vec::new(), None)
    }

    /// The zones this key answers with, in the order they are listed.
    pub fn keyed(&self, key: u8) -> &[usize] {
        self.keyed.get(key as usize).map_or(&[], Vec::as_slice)
    }
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
    /// The share of its recorded loudness one role sounds at, 0 to 1. `Sustain` ignores it.
    RoleLevel { role: Role, level: f32 },
    /// How many voices may sound at once from the next render on. Empties the pool, so everything
    /// sounding stops.
    MaxVoices(usize),
}

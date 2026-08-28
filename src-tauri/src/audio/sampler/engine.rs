//! The voice engine. Filled in by the sampler ticket.

use std::sync::Arc;

use super::{Command, Instrument};

/// The engine that owns the voices. Lives on the audio thread: `apply` and `render` never
/// allocate, lock or block.
pub struct Sampler {
    _rate: f64,
    _max_voices: usize,
}

impl Sampler {
    /// Ready to render at `rate` frames a second with at most `max_voices` voices at once. Every
    /// buffer the engine will ever need is allocated here.
    pub fn new(rate: f64, max_voices: usize) -> Self {
        Self { _rate: rate, _max_voices: max_voices }
    }

    /// Applies one command. Answers the instrument let go by a `Load` or `Unload`, so the caller
    /// can drop it off the audio thread.
    pub fn apply(&mut self, _command: Command) -> Option<Arc<Instrument>> {
        todo!("sampler ticket")
    }

    /// Writes the next `left.len()` frames into both channels, replacing what was there.
    pub fn render(&mut self, _left: &mut [f32], _right: &mut [f32]) {
        todo!("sampler ticket")
    }
}

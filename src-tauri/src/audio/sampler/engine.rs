//! The voice engine: an instrument's zones sounded one voice per struck key, mixed on the audio
//! thread.

use std::f32::consts::PI;
use std::sync::Arc;

use super::{Command, Envelope, Instrument};

/// Every voice opens under a raised-cosine fade this long, whatever the envelope's attack says, so
/// a sample whose first frame sits far from zero cannot put a step into the output.
const START_FADE: f64 = 0.003;

/// A voice cut short, by a steal or by a load, fades over this instead of stopping dead.
const CUT_FADE: f64 = 0.005;

/// The level a voice counts as finished at, -80 dBFS.
const SILENCE: f32 = 1e-4;

/// Headroom on the mix, -16 dB, so a chord of loud notes stays clear of the clamp and the
/// keyboard volume still has something to trim.
/// ponytail: one figure for every instrument; a gain of its own per instrument when one lands far
/// from the rest.
const OUTPUT_GAIN: f32 = 0.158;

#[derive(Clone, Copy, Default, PartialEq)]
enum Stage {
    #[default]
    Attack,
    Decay,
    Sustain,
    Release,
    /// Fading out to be reused or dropped; the envelope no longer moves.
    Cut,
}

/// One sounding key. Everything it needs per frame is worked out when it starts, so a render is
/// arithmetic on numbers already here.
#[derive(Clone, Copy, Default)]
struct Voice {
    active: bool,
    note: u8,
    /// Index into the instrument's samples.
    sample: usize,
    /// Reads the instrument a load handed back rather than the one playing now.
    retired: bool,
    pos: f64,
    step: f64,
    end: f64,
    loop_: Option<(f64, f64)>,
    /// Zone gain and velocity together, the constant part of the voice's loudness.
    amp: f32,
    stage: Stage,
    level: f32,
    attack_step: f32,
    decay_step: f32,
    sustain: f32,
    release_coef: f32,
    /// 0 to 1 across the start fade; at 1 the fade is over.
    fade: f32,
    fade_step: f32,
    cut: f32,
    cut_step: f32,
    /// A note-off arrived under the pedal and waits for it to come up.
    held: bool,
    /// Start order, so the oldest releasing voice is the first to go.
    age: u64,
}

impl Voice {
    /// What the voice is worth to the ear now, which is what stealing compares.
    fn gain(&self) -> f32 {
        self.level * self.cut
    }

    fn fade_gain(&self) -> f32 {
        if self.fade >= 1.0 { 1.0 } else { 0.5 - 0.5 * (PI * self.fade).cos() }
    }

    fn release(&mut self, rate: f64) {
        self.held = false;
        // A zero release would be a hard stop, so it borrows the cut fade.
        if self.release_coef <= 0.0 {
            self.cut(rate);
        } else {
            self.stage = Stage::Release;
        }
    }

    fn cut(&mut self, rate: f64) {
        if self.stage != Stage::Cut {
            self.stage = Stage::Cut;
            self.cut_step = 1.0 / (CUT_FADE * rate) as f32;
        }
    }

    fn advance(&mut self) {
        self.pos += self.step;
        if let Some((from, to)) = self.loop_ {
            if self.pos >= to {
                self.pos -= to - from;
            }
        } else if self.pos >= self.end {
            self.active = false;
            return;
        }
        if self.fade < 1.0 {
            self.fade += self.fade_step;
        }
        match self.stage {
            Stage::Attack => {
                self.level += self.attack_step;
                if self.level >= 1.0 {
                    self.level = 1.0;
                    self.stage = Stage::Decay;
                }
            }
            Stage::Decay => {
                self.level -= self.decay_step;
                if self.level <= self.sustain {
                    self.level = self.sustain;
                    self.stage = Stage::Sustain;
                }
            }
            Stage::Sustain => {}
            Stage::Release => self.level *= self.release_coef,
            Stage::Cut => {
                self.cut -= self.cut_step;
                if self.cut <= 0.0 {
                    self.active = false;
                }
            }
        }
        if self.stage != Stage::Attack && self.level < SILENCE {
            self.active = false;
        }
    }

    fn mix(&mut self, instrument: &Instrument, left: &mut [f32], right: &mut [f32]) {
        let Some(sample) = instrument.samples.get(self.sample) else {
            self.active = false;
            return;
        };
        let data = (*sample.data).as_ref();
        let Some(last) = (data.len() / 2).checked_sub(1) else {
            self.active = false;
            return;
        };
        for i in 0..left.len() {
            let gain = self.amp * self.level * self.fade_gain() * self.cut / 32768.0;
            let a = (self.pos as usize).min(last) * 2;
            let b = (self.pos as usize + 1).min(last) * 2;
            let frac = (self.pos - self.pos.floor()) as f32;
            let (al, ar) = (data[a] as f32, data[a + 1] as f32);
            left[i] += (al + (data[b] as f32 - al) * frac) * gain;
            right[i] += (ar + (data[b + 1] as f32 - ar) * frac) * gain;
            self.advance();
            if !self.active {
                return;
            }
        }
    }
}

/// The engine that owns the voices. Lives on the audio thread: `apply` and `render` never
/// allocate, lock or block.
pub struct Sampler {
    rate: f64,
    max_voices: usize,
    voices: Vec<Voice>,
    instrument: Option<Arc<Instrument>>,
    /// The instrument a load handed back, held while its voices fade so their samples stay alive.
    retiring: Option<Arc<Instrument>>,
    envelope: Envelope,
    pedal: bool,
    age: u64,
}

impl Sampler {
    /// Ready to render at `rate` frames a second with at most `max_voices` voices at once. Every
    /// buffer the engine will ever need is allocated here.
    pub fn new(rate: f64, max_voices: usize) -> Self {
        let max_voices = max_voices.max(1);
        Self {
            rate,
            max_voices,
            // Twice the sounding limit; the spare half carries the voices fading out of a steal.
            voices: vec![Voice::default(); max_voices * 2],
            instrument: None,
            retiring: None,
            // A plain hold and release, for samples that carry their own decay.
            envelope: Envelope { attack: 0.0, decay: 0.0, sustain: 1.0, release: 0.3 },
            pedal: false,
            age: 0,
        }
    }

    /// Applies one command. Answers the instrument let go by a `Load` or `Unload`, so the caller
    /// can drop it off the audio thread.
    pub fn apply(&mut self, command: Command) -> Option<Arc<Instrument>> {
        let rate = self.rate;
        match command {
            Command::Load(instrument) => return self.swap(Some(instrument)),
            Command::Unload => return self.swap(None),
            Command::NoteOn { note, velocity } => self.note_on(note, velocity),
            Command::NoteOff { note } => {
                let pedal = self.pedal;
                for v in self.sounding().filter(|v| v.note == note) {
                    if pedal { v.held = true } else { v.release(rate) }
                }
            }
            Command::Sustain(down) => {
                self.pedal = down;
                if !down {
                    for v in self.voices.iter_mut().filter(|v| v.active && v.held) {
                        v.release(rate);
                    }
                }
            }
            Command::AllOff => {
                self.pedal = false;
                for v in self.voices.iter_mut().filter(|v| v.active) {
                    v.cut(rate);
                }
            }
            Command::Envelope(envelope) => self.envelope = envelope,
        }
        None
    }

    /// Writes the next `left.len()` frames into both channels, replacing what was there.
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        let frames = left.len().min(right.len());
        let (left, right) = (&mut left[..frames], &mut right[..frames]);
        left.fill(0.0);
        right.fill(0.0);
        let Self { voices, instrument, retiring, .. } = self;
        for v in voices.iter_mut().filter(|v| v.active) {
            match if v.retired { retiring.as_deref() } else { instrument.as_deref() } {
                Some(playing) => v.mix(playing, left, right),
                None => v.active = false,
            }
        }
        for s in left.iter_mut().chain(right.iter_mut()) {
            *s = (*s * OUTPUT_GAIN).clamp(-1.0, 1.0);
        }
        if retiring.is_some() && !voices.iter().any(|v| v.active && v.retired) {
            // ponytail: the last reference can land here and free the samples on the audio thread;
            // hand it back through the command channel if a load ever ticks.
            *retiring = None;
        }
    }

    /// Voices answering to a key, which a note-off and a re-strike both act on.
    fn sounding(&mut self) -> impl Iterator<Item = &mut Voice> {
        self.voices
            .iter_mut()
            .filter(|v| v.active && !v.retired && v.stage != Stage::Release && v.stage != Stage::Cut)
    }

    fn swap(&mut self, next: Option<Arc<Instrument>>) -> Option<Arc<Instrument>> {
        let rate = self.rate;
        for v in self.voices.iter_mut().filter(|v| v.active) {
            // A second load inside one fade leaves the older voices nothing to read.
            if v.retired {
                v.active = false;
            } else {
                v.retired = true;
                v.cut(rate);
            }
        }
        let gone = self.instrument.take();
        self.retiring =
            gone.clone().filter(|_| self.voices.iter().any(|v| v.active && v.retired));
        self.instrument = next;
        gone
    }

    fn note_on(&mut self, note: u8, velocity: u8) {
        let Some(instrument) = self.instrument.as_ref() else { return };
        let Some(zone) = instrument.zones.iter().find(|z| {
            (z.key_lo..=z.key_hi).contains(&note) && (z.vel_lo..=z.vel_hi).contains(&velocity)
        }) else {
            return;
        };
        let Some(sample) = instrument.samples.get(zone.sample) else { return };
        let (zone, frames, sample_rate) = (zone.clone(), sample.frames(), sample.rate);
        let (rate, envelope) = (self.rate, self.envelope);

        let semitones = note as f64 - zone.root as f64 + zone.tune_cents as f64 / 100.0;
        let step = (semitones / 12.0).exp2() * sample_rate / rate;
        // ponytail: velocity reads straight as amplitude; a per-instrument curve if the touch of a
        // real piano wants one.
        let amp = 10f32.powf(zone.gain_db / 20.0) * velocity as f32 / 127.0;
        let attack = envelope.attack > 0.0;

        // A re-strike lets the ringing voice fall away rather than silencing it.
        for v in self.sounding().filter(|v| v.note == note) {
            v.release(rate);
        }
        self.age += 1;
        let slot = self.slot();
        self.voices[slot] = Voice {
            active: true,
            note,
            sample: zone.sample,
            retired: false,
            pos: zone.start.min(frames) as f64,
            step,
            end: zone.end.min(frames) as f64,
            loop_: zone
                .loop_
                .filter(|&(from, to)| to > from && to <= frames)
                .map(|(from, to)| (from as f64, to as f64)),
            amp,
            stage: if attack { Stage::Attack } else { Stage::Decay },
            level: if attack { 0.0 } else { 1.0 },
            attack_step: if attack { 1.0 / (envelope.attack * rate) as f32 } else { 1.0 },
            // A decay of nothing lands on the sustain level in one frame.
            decay_step: if envelope.decay > 0.0 {
                (1.0 - envelope.sustain as f32) / (envelope.decay * rate) as f32
            } else {
                1.0
            },
            sustain: envelope.sustain as f32,
            // An exponential that touches silence exactly when the release is up.
            release_coef: if envelope.release > 0.0 {
                SILENCE.powf(1.0 / (envelope.release * rate) as f32)
            } else {
                0.0
            },
            fade: 0.0,
            fade_step: 1.0 / (START_FADE * rate) as f32,
            cut: 1.0,
            cut_step: 0.0,
            held: false,
            age: self.age,
        };
    }

    /// Frees a slot for a new voice, fading out whatever has to give way for it.
    fn slot(&mut self) -> usize {
        let live = self.voices.iter().filter(|v| v.active && v.stage != Stage::Cut).count();
        if live >= self.max_voices
            && let Some(i) = self.victim()
        {
            let rate = self.rate;
            self.voices[i].cut(rate);
        }
        if let Some(i) = self.voices.iter().position(|v| !v.active) {
            return i;
        }
        // Every slot busy: the quietest is the one already nearest silence.
        self.quietest(|_| true)
    }

    /// The voice a steal takes: the oldest one already releasing, else the quietest.
    fn victim(&self) -> Option<usize> {
        let live = |v: &Voice| v.active && v.stage != Stage::Cut;
        let oldest = self
            .voices
            .iter()
            .enumerate()
            .filter(|(_, v)| live(v) && v.stage == Stage::Release)
            .min_by_key(|(_, v)| v.age)
            .map(|(i, _)| i);
        oldest.or_else(|| self.voices.iter().any(live).then(|| self.quietest(live)))
    }

    fn quietest(&self, keep: impl Fn(&Voice) -> bool) -> usize {
        self.voices
            .iter()
            .enumerate()
            .filter(|(_, v)| keep(v))
            .min_by(|a, b| a.1.gain().total_cmp(&b.1.gain()))
            .map_or(0, |(i, _)| i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::sampler::{Sample, Zone};

    const RATE: f64 = 44100.0;

    /// A stereo sine that opens at half scale, the hard edge a Logic piano zone starts on.
    fn instrument(hz: f64) -> Arc<Instrument> {
        let frames = (RATE * 3.0) as usize;
        let mut data = Vec::with_capacity(frames * 2);
        for i in 0..frames {
            let phase = std::f64::consts::TAU * hz * i as f64 / RATE + std::f64::consts::FRAC_PI_6;
            let v = (phase.sin() * 32000.0) as i16;
            data.push(v);
            data.push(v);
        }
        let sample = Sample { rate: RATE, data: Box::new(data) };
        let zone = Zone {
            key_lo: 0,
            key_hi: 127,
            vel_lo: 0,
            vel_hi: 127,
            root: 60,
            tune_cents: 0,
            gain_db: 0.0,
            sample: 0,
            start: 0,
            end: frames,
            loop_: None,
        };
        Arc::new(Instrument { zones: vec![zone], samples: vec![sample] })
    }

    fn render(sampler: &mut Sampler, seconds: f64) -> Vec<f32> {
        let frames = (RATE * seconds) as usize;
        let (mut left, mut right) = (vec![0.0; frames], vec![0.0; frames]);
        sampler.render(&mut left, &mut right);
        left
    }

    fn peak(out: &[f32]) -> f32 {
        out.iter().fold(0.0f32, |m, s| m.max(s.abs()))
    }

    fn jump(out: &[f32]) -> f32 {
        out.windows(2).fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()))
    }

    fn rms(out: &[f32]) -> f32 {
        (out.iter().map(|s| s * s).sum::<f32>() / out.len() as f32).sqrt()
    }

    #[test]
    fn the_start_fade_hides_the_samples_first_edge() {
        let mut s = Sampler::new(RATE, 8);
        s.apply(Command::Envelope(Envelope { attack: 0.0, decay: 0.0, sustain: 1.0, release: 0.5 }));
        s.apply(Command::Load(instrument(20.0)));
        s.apply(Command::NoteOn { note: 60, velocity: 127 });
        let out = render(&mut s, 0.2);
        let fade = (START_FADE * RATE) as usize;
        assert!(jump(&out[..fade]) < 0.02 * peak(&out), "{} of {}", jump(&out[..fade]), peak(&out));
    }

    #[test]
    fn a_re_strike_leaves_the_ringing_voice_to_release() {
        let mut s = Sampler::new(RATE, 8);
        s.apply(Command::Envelope(Envelope { attack: 0.0, decay: 0.0, sustain: 1.0, release: 1.0 }));
        s.apply(Command::Load(instrument(220.0)));
        s.apply(Command::NoteOn { note: 60, velocity: 64 });
        let before = render(&mut s, 0.4);
        s.apply(Command::NoteOn { note: 60, velocity: 64 });
        let after = render(&mut s, 0.02);
        let held = rms(&before[before.len() - after.len()..]);
        assert!(rms(&after) > 0.5 * held, "{} against {held}", rms(&after));
        assert_eq!(s.voices.iter().filter(|v| v.active).count(), 2);
        assert!(s.voices.iter().any(|v| v.active && v.stage == Stage::Release));
    }

    #[test]
    fn the_pedal_holds_a_note_off_until_it_comes_up() {
        let mut s = Sampler::new(RATE, 8);
        s.apply(Command::Envelope(Envelope { attack: 0.0, decay: 0.0, sustain: 1.0, release: 0.1 }));
        s.apply(Command::Load(instrument(220.0)));
        s.apply(Command::NoteOn { note: 60, velocity: 100 });
        let sounding = peak(&render(&mut s, 0.1));
        s.apply(Command::Sustain(true));
        s.apply(Command::NoteOff { note: 60 });
        assert!(peak(&render(&mut s, 0.2)) > 0.9 * sounding);
        s.apply(Command::Sustain(false));
        let tail = render(&mut s, 0.15);
        assert!(peak(&tail[(RATE * 0.1) as usize..]) < 1e-3);
    }

    #[test]
    fn stealing_a_voice_costs_no_step_in_the_output() {
        let mut s = Sampler::new(RATE, 4);
        s.apply(Command::Envelope(Envelope { attack: 0.0, decay: 0.0, sustain: 1.0, release: 2.0 }));
        s.apply(Command::Load(instrument(55.0)));
        let mut out = Vec::new();
        for note in 60..68 {
            s.apply(Command::NoteOn { note, velocity: 64 });
            out.extend(render(&mut s, 0.05));
        }
        assert!(peak(&out) <= 1.0);
        assert!(jump(&out) < 0.1 * peak(&out), "{} of {}", jump(&out), peak(&out));
    }

    #[test]
    fn an_octave_up_plays_the_sample_twice_as_fast() {
        let crossings = |note| {
            let mut s = Sampler::new(RATE, 8);
            s.apply(Command::Load(instrument(20.0)));
            s.apply(Command::NoteOn { note, velocity: 100 });
            let out = render(&mut s, 0.5);
            out.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count() as i32
        };
        let (root, octave) = (crossings(60), crossings(72));
        assert!((octave - 2 * root).abs() <= 2, "{octave} against {root}");
    }

    #[test]
    fn a_load_hands_back_the_instrument_it_replaces() {
        let mut s = Sampler::new(RATE, 8);
        let first = instrument(220.0);
        assert!(s.apply(Command::Load(first.clone())).is_none());
        let back = s.apply(Command::Load(instrument(220.0))).unwrap();
        assert!(Arc::ptr_eq(&back, &first));
    }
}

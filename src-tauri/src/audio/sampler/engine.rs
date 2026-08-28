//! The voice engine: an instrument's zones sounded one voice per struck key, mixed on the audio
//! thread.

use std::f32::consts::PI;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use super::{Command, Envelope, Fill, Instrument, Role, Stream};

/// Every voice opens under a raised-cosine fade this long, whatever the envelope's attack says, so
/// a sample whose first frame sits far from zero cannot put a step into the output.
const START_FADE: f64 = 0.003;

/// A voice cut short, by a steal or by a load, fades over this instead of stopping dead.
const CUT_FADE: f64 = 0.005;

/// The level a voice counts as finished at, -80 dBFS.
const SILENCE: f32 = 1e-4;

/// The velocity a pedal noise starts at. The velocity bands of a Pedal Noise group hold
/// round-robin takes of the one noise rather than louder and softer ones, so any band answers.
// ponytail: one band, so every press sounds alike; rotate the bands if the sameness is heard.
const PEDAL_VELOCITY: u8 = 64;

/// Voices given up to make room for a newer one, over the life of the process. The hardware tests
/// read it to see whether a pedalled chord outgrows the voice budget.
// ponytail: one counter for the process, because the app plays through one engine; put it on the
// `Sampler` when a second one ever renders.
static STEALS: AtomicU64 = AtomicU64::new(0);

#[allow(dead_code)]
pub fn steals() -> u64 {
    STEALS.load(Ordering::Relaxed)
}

/// A voice a damper can stop: the tone, and the strings ringing along with it. The noises are
/// one-shots that play themselves out however the keys and the pedal move afterwards.
fn damped(role: Role) -> bool {
    matches!(role, Role::Sustain | Role::Sympathetic)
}

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
    /// What the voice is sounding, which says what stops it.
    role: Role,
    /// Index into the instrument's samples.
    sample: usize,
    /// Index into the instrument's zones, which is where the voice's head frames are.
    zone: usize,
    /// Reads the instrument a load handed back rather than the one playing now.
    retired: bool,
    pos: f64,
    step: f64,
    start: f64,
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
    /// The frames of a streamed voice straddling `pos`, and the index of `now` counted from the
    /// zone's start. A streamed sample arrives in order, so the voice keeps its own two frames
    /// rather than looking any of them up.
    now: [i16; 2],
    next: [i16; 2],
    cursor: usize,
    /// Which fill in the voice's slot is the voice's own, so it cannot read another voice's.
    generation: u64,
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

    fn mix(&mut self, slot: usize, instrument: &Instrument, left: &mut [f32], right: &mut [f32]) {
        match instrument.samples.get(self.sample).map(|sample| sample.data.as_deref()) {
            Some(Some(data)) => self.mix_memory(data, left, right),
            Some(None) => match (instrument.heads.get(self.zone), instrument.stream.as_deref()) {
                (Some(head), Some(stream)) => self.mix_stream(head, slot, stream, left, right),
                _ => self.active = false,
            },
            None => self.active = false,
        }
    }

    /// A sample held whole: every frame is a lookup, so a loop costs nothing but a rewind.
    fn mix_memory(&mut self, data: &[i16], left: &mut [f32], right: &mut [f32]) {
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

    /// A streamed sample: the zone's head out of RAM, then its slot's ring, with the frame before
    /// the boundary kept so the interpolation across it is the same as any other.
    fn mix_stream(
        &mut self,
        head: &[i16],
        slot: usize,
        stream: &Stream,
        left: &mut [f32],
        right: &mut [f32],
    ) {
        let head_frames = head.len() / 2;
        for i in 0..left.len() {
            let want = (self.pos - self.start) as usize;
            let mut dry = false;
            while self.cursor < want {
                let mut frame = [0i16; 2];
                if self.cursor + 1 < head_frames {
                    frame.copy_from_slice(&head[(self.cursor + 1) * 2..][..2]);
                } else if !stream.read(slot, self.generation, &mut frame) {
                    dry = true;
                    break;
                }
                self.now = self.next;
                self.next = frame;
                self.cursor += 1;
            }
            if dry {
                // The frames that did not arrive in time are gone: the voice is silent until the
                // ring has something again, and picks the sample up where the reader has got to.
                self.cursor = want;
                self.now = [0; 2];
                self.next = [0; 2];
            }
            let gain = self.amp * self.level * self.fade_gain() * self.cut / 32768.0;
            let frac = (self.pos - self.pos.floor()) as f32;
            let (nl, nr) = (self.now[0] as f32, self.now[1] as f32);
            left[i] += (nl + (self.next[0] as f32 - nl) * frac) * gain;
            right[i] += (nr + (self.next[1] as f32 - nr) * frac) * gain;
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
    /// The roles that may start a voice, as `Role::bit` set. `Sustain` is not in it: the tone
    /// sounds whatever the toggles say.
    roles: u8,
    /// What each key was last struck at, so the noises its key-up makes match the strike.
    struck: [u8; 128],
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
            roles: u8::MAX,
            struck: [0; 128],
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
            Command::NoteOff { note } => self.note_off(note),
            Command::Sustain(down) => self.pedal(down),
            Command::Roles(roles) => self.roles = roles,
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
        for (slot, v) in voices.iter_mut().enumerate().filter(|(_, v)| v.active) {
            match if v.retired { retiring.as_deref() } else { instrument.as_deref() } {
                Some(playing) => {
                    v.mix(slot, playing, left, right);
                    if let (false, Some(stream)) = (v.active, playing.stream.as_deref()) {
                        stream.end(slot);
                    }
                }
                None => v.active = false,
            }
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

    /// A key struck: the tone, and the strings the raised dampers let ring along with it.
    fn note_on(&mut self, note: u8, velocity: u8) {
        self.struck[note as usize] = velocity;
        let rate = self.rate;
        // A re-strike lets the ringing voice fall away rather than silencing it.
        for v in self.sounding().filter(|v| v.note == note && damped(v.role)) {
            v.release(rate);
        }
        self.start(note, velocity, Role::Sustain);
        if self.pedal {
            self.start(note, velocity, Role::Sympathetic);
        }
    }

    /// A key let go: the key itself coming back up, and, when nothing holds the note on, the
    /// damper landing on the string.
    fn note_off(&mut self, note: u8) {
        let (rate, pedal) = (self.rate, self.pedal);
        for v in self.sounding().filter(|v| v.note == note && damped(v.role)) {
            if pedal { v.held = true } else { v.release(rate) }
        }
        self.start(note, self.struck[note as usize], Role::KeyOff);
        if !pedal {
            self.start(note, self.struck[note as usize], Role::Release);
        }
    }

    /// The pedal moving: its own noise either way, and on the way up the dampers landing on every
    /// string it was holding.
    fn pedal(&mut self, down: bool) {
        self.pedal = down;
        if !down {
            let rate = self.rate;
            let mut damping = [false; 128];
            for v in self.voices.iter_mut().filter(|v| v.active && v.held) {
                damping[v.note as usize] |= v.role == Role::Sustain;
                v.release(rate);
            }
            for note in 0..128u8 {
                if damping[note as usize] {
                    self.start(note, self.struck[note as usize], Role::Release);
                }
            }
        }
        if let Some(key) = self.pedal_key(down) {
            self.start(key, PEDAL_VELOCITY, Role::PedalNoise);
        }
    }

    /// Which key carries the noise of the pedal going this way. The direction is told by key
    /// alone: Logic's pianos give the two noises two keys of their own, the up on the lower one
    /// and the down on the higher.
    fn pedal_key(&self, down: bool) -> Option<u8> {
        let zones = self.instrument.as_ref()?.zones.iter();
        let keys = zones.filter(|z| z.role == Role::PedalNoise).map(|z| z.key_lo);
        if down { keys.max() } else { keys.min() }
    }

    /// Sounds every zone that answers this key, this velocity and this role. An EXS layers them:
    /// Studio Grand holds its three mic sets as three zones over the same key, and a piano whose
    /// groups split the keyboard has one. A role the user has switched off starts nothing.
    fn start(&mut self, note: u8, velocity: u8, role: Role) {
        if velocity == 0 || (role != Role::Sustain && self.roles & role.bit() == 0) {
            return;
        }
        // The instrument is held for the whole of this, so nothing here borrows the engine.
        let Some(instrument) = self.instrument.clone() else { return };
        for index in 0..instrument.zones.len() {
            let zone = &instrument.zones[index];
            if zone.role == role
                && (zone.key_lo..=zone.key_hi).contains(&note)
                && (zone.vel_lo..=zone.vel_hi).contains(&velocity)
            {
                self.sound(&instrument, index, note, velocity, role);
            }
        }
    }

    /// One voice off one zone, which is where everything a render needs is worked out.
    fn sound(
        &mut self,
        instrument: &Arc<Instrument>,
        index: usize,
        note: u8,
        velocity: u8,
        role: Role,
    ) {
        let zone = instrument.zones[index].clone();
        let Some(sample) = instrument.samples.get(zone.sample) else { return };
        let (frames, sample_rate, streamed) =
            (sample.frames, sample.rate, sample.data.is_none());
        let (rate, envelope) = (self.rate, self.envelope);

        let semitones = note as f64 - zone.root as f64 + zone.tune_cents as f64 / 100.0;
        let step = (semitones / 12.0).exp2() * sample_rate / rate;
        // ponytail: velocity reads straight as amplitude; a per-instrument curve if the touch of a
        // real piano wants one.
        let amp = 10f32.powf(zone.gain_db / 20.0) * velocity as f32 / 127.0;
        let attack = envelope.attack > 0.0;

        self.age += 1;
        let slot = self.slot();

        let start = zone.start.min(frames);
        let end = zone.end.min(frames);
        // The head is what the voice sounds first; the reader is asked for everything after it.
        let head = instrument.heads.get(index).map_or(0, |head| head.len() / 2);
        let generation = match instrument.stream.as_deref().filter(|_| streamed) {
            Some(stream) if start + head < end => stream.start(Fill {
                slot,
                sample: zone.sample,
                from: start + head,
                to: end,
                generation: 0,
            }),
            _ => 0,
        };
        let frame = |at: usize| match instrument.heads.get(index) {
            Some(head) if at * 2 + 1 < head.len() => [head[at * 2], head[at * 2 + 1]],
            _ => [0; 2],
        };

        self.voices[slot] = Voice {
            active: true,
            note,
            role,
            sample: zone.sample,
            zone: index,
            retired: false,
            pos: start as f64,
            step,
            start: start as f64,
            end: end as f64,
            // ponytail: a streamed zone plays to its end once. Logic's pianos loop nothing, so a
            // looping one wants the reader to wrap round the loop points before it is worth it.
            loop_: zone
                .loop_
                .filter(|&(from, to)| !streamed && to > from && to <= frames)
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
            now: frame(0),
            next: frame(1),
            cursor: 0,
            generation,
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
            STEALS.fetch_add(1, Ordering::Relaxed);
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
    use crate::audio::sampler::{Role, Sample, Stream, Zone};

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
        let sample = Sample::memory(RATE, data);
        let zone = Zone {
            role: Role::Sustain,
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
        Arc::new(Instrument::memory(vec![zone], vec![sample]))
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

    /// The same sine as `instrument`, as a zone whose head is in memory and whose rest has to be
    /// read: 0.1 s of head out of a second of sample, so a render of more than that crosses the
    /// boundary. Answers the instrument and the frame the reader has to make.
    fn streamed() -> (Arc<Instrument>, impl Fn(usize) -> [i16; 2]) {
        let frames = RATE as usize;
        let head_frames = (RATE * 0.1) as usize;
        let frame = |i: usize| {
            let phase = std::f64::consts::TAU * 220.0 * i as f64 / RATE;
            let v = (phase.sin() * 32000.0) as i16;
            [v, v]
        };
        let zone = Zone {
            role: Role::Sustain,
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
        let head = (0..head_frames).flat_map(frame).collect();
        let instrument = Instrument {
            zones: vec![zone],
            samples: vec![Sample { rate: RATE, frames, data: None }],
            heads: vec![head],
            stream: Some(Arc::new(Stream::new(16, 1 << 16))),
        };
        (Arc::new(instrument), frame)
    }

    /// A thread standing in for the disk: it takes every order and answers it whole. Ends with the
    /// instrument, like the real reader does.
    fn feeder(instrument: &Arc<Instrument>, frame: impl Fn(usize) -> [i16; 2] + Send + 'static) {
        let watch = Arc::downgrade(instrument.stream.as_ref().unwrap());
        std::thread::spawn(move || {
            while let Some(stream) = watch.upgrade() {
                match stream.order() {
                    Some(fill) if stream.open(&fill) => {
                        let frames: Vec<i16> = (fill.from..fill.to).flat_map(&frame).collect();
                        stream.feed(&fill, &frames);
                    }
                    _ => std::thread::sleep(std::time::Duration::from_millis(1)),
                }
            }
        });
    }

    /// Waits for the reader to have the frames the render is about to ask for, which on the real
    /// device the head buys time for and here would otherwise be a race.
    fn wait(instrument: &Instrument, slot: usize, frames: usize) {
        let stream = instrument.stream.as_deref().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while stream.ready(slot) < frames && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
    }

    #[test]
    fn a_streamed_zone_runs_out_of_its_head_into_the_ring_without_a_step() {
        let (instrument, frame) = streamed();
        feeder(&instrument, frame);
        let mut s = Sampler::new(RATE, 8);
        s.apply(Command::Load(instrument.clone()));
        // A key off its root, so the boundary is crossed between two frames rather than on one.
        s.apply(Command::NoteOn { note: 61, velocity: 127 });
        wait(&instrument, 0, (RATE * 0.7) as usize);

        let out = render(&mut s, 0.5);
        let boundary = (RATE * 0.09) as usize;
        assert!(peak(&out[boundary..]) > 0.5 * peak(&out[..boundary]), "the sample plays on");
        // The sample's own slope is the biggest step it may have, and the head has that slope in
        // it already: a boundary the ear could hear would be a step larger than anything inside.
        let inside = jump(&out[..boundary]);
        assert!(jump(&out) <= inside * 1.05, "{} against {inside} inside the head", jump(&out));
        assert_eq!(instrument.stream.as_ref().unwrap().underruns(), 0);
    }

    #[test]
    fn a_ring_that_never_fills_costs_silence_and_an_underrun() {
        let (instrument, _) = streamed();
        let mut s = Sampler::new(RATE, 8);
        s.apply(Command::Load(instrument.clone()));
        s.apply(Command::NoteOn { note: 60, velocity: 127 });

        let out = render(&mut s, 0.5);
        let boundary = (RATE * 0.1) as usize;
        assert!(peak(&out[..boundary]) > 0.01, "the head sounds");
        assert_eq!(peak(&out[boundary..]), 0.0, "and nothing after it");
        assert!(instrument.stream.as_ref().unwrap().underruns() > 0);
    }

    /// One zone per role, over a short sine. The noises answer every key so a test can count the
    /// voices they start; the pedal noises sit on two keys of their own, as Logic's pianos put
    /// them, the up on the lower key.
    fn every_role() -> Arc<Instrument> {
        let frames = (RATE * 0.5) as usize;
        let mut data = Vec::with_capacity(frames * 2);
        for i in 0..frames {
            let v = ((std::f64::consts::TAU * 220.0 * i as f64 / RATE).sin() * 32000.0) as i16;
            data.push(v);
            data.push(v);
        }
        let zone = |role, key_lo, key_hi| Zone {
            role,
            key_lo,
            key_hi,
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
        Arc::new(Instrument::memory(
            vec![
                zone(Role::Sustain, 0, 127),
                zone(Role::Release, 0, 127),
                zone(Role::KeyOff, 0, 127),
                zone(Role::Sympathetic, 0, 127),
                zone(Role::PedalNoise, 12, 12),
                zone(Role::PedalNoise, 24, 24),
            ],
            vec![Sample::memory(RATE, data)],
        ))
    }

    fn playing(s: &Sampler, role: Role) -> Vec<u8> {
        s.voices.iter().filter(|v| v.active && v.role == role).map(|v| v.note).collect()
    }

    #[test]
    fn a_key_up_sounds_the_key_coming_back_and_the_damper_landing() {
        let mut s = Sampler::new(RATE, 8);
        s.apply(Command::Load(every_role()));
        s.apply(Command::NoteOn { note: 60, velocity: 100 });
        assert!(playing(&s, Role::Sympathetic).is_empty(), "the pedal is up");
        s.apply(Command::NoteOff { note: 60 });
        assert_eq!(playing(&s, Role::KeyOff), vec![60]);
        assert_eq!(playing(&s, Role::Release), vec![60]);
    }

    #[test]
    fn the_pedal_holds_the_damper_back_until_it_comes_up() {
        let mut s = Sampler::new(RATE, 8);
        s.apply(Command::Load(every_role()));
        s.apply(Command::NoteOn { note: 60, velocity: 100 });
        s.apply(Command::Sustain(true));
        s.apply(Command::NoteOff { note: 60 });
        assert_eq!(playing(&s, Role::KeyOff), vec![60], "the key comes up either way");
        assert!(playing(&s, Role::Release).is_empty(), "the pedal still holds the string");
        s.apply(Command::Sustain(false));
        assert_eq!(playing(&s, Role::Release), vec![60]);
    }

    #[test]
    fn the_pedal_makes_a_noise_each_way() {
        let mut s = Sampler::new(RATE, 8);
        s.apply(Command::Load(every_role()));
        s.apply(Command::Sustain(true));
        assert_eq!(playing(&s, Role::PedalNoise), vec![24]);
        s.apply(Command::Sustain(false));
        assert_eq!(playing(&s, Role::PedalNoise), vec![24, 12]);
    }

    #[test]
    fn a_key_struck_under_the_pedal_rings_the_strings_around_it() {
        let mut s = Sampler::new(RATE, 8);
        s.apply(Command::Load(every_role()));
        s.apply(Command::Sustain(true));
        s.apply(Command::NoteOn { note: 60, velocity: 100 });
        assert_eq!(playing(&s, Role::Sustain), vec![60]);
        assert_eq!(playing(&s, Role::Sympathetic), vec![60]);
    }

    #[test]
    fn a_role_switched_off_starts_nothing() {
        let mut s = Sampler::new(RATE, 8);
        s.apply(Command::Load(every_role()));
        s.apply(Command::Roles(0));
        s.apply(Command::Sustain(true));
        s.apply(Command::NoteOn { note: 60, velocity: 100 });
        s.apply(Command::NoteOff { note: 60 });
        s.apply(Command::Sustain(false));
        assert_eq!(playing(&s, Role::Sustain), vec![60], "the tone is no toggle");
        for role in [Role::Release, Role::KeyOff, Role::Sympathetic, Role::PedalNoise] {
            assert!(playing(&s, role).is_empty(), "{role:?}");
        }
    }

    /// Renders in buffer-sized passes at the pace a device would pull them, which is what the
    /// disk reader is written to keep up with.
    #[cfg(target_os = "macos")]
    fn realtime(sampler: &mut Sampler, seconds: f64) -> Vec<f32> {
        const BUFFER: usize = 512;
        let mut out = Vec::new();
        let (mut left, mut right) = ([0.0; BUFFER], [0.0; BUFFER]);
        while out.len() < (RATE * seconds) as usize {
            sampler.render(&mut left, &mut right);
            out.extend_from_slice(&left);
            std::thread::sleep(std::time::Duration::from_secs_f64(BUFFER as f64 / RATE));
        }
        out
    }

    /// The Concert Grand's own samples, off the disk: the only place to hear whether the noises
    /// arrive at the moment the key and the pedal ask for them.
    #[test]
    #[ignore = "needs the Logic sample library"]
    #[cfg(target_os = "macos")]
    fn the_concert_grand_answers_a_key_up_with_a_release_sample() {
        let path = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join(
            "Music/Logic Pro Library.bundle/Plug-In Settings/Sampler/z_Internal/Studio Piano/\
             Concert Grand Piano.exs",
        );
        let exs = crate::audio::sampler::exs::read(&path).unwrap();
        let instrument = Arc::new(crate::audio::sampler::disk::load(&exs, 32).unwrap());
        let after_key_up = |roles: u8| {
            let mut s = Sampler::new(RATE, 16);
            s.apply(Command::Load(instrument.clone()));
            s.apply(Command::Roles(roles));
            s.apply(Command::NoteOn { note: 60, velocity: 100 });
            realtime(&mut s, 0.5);
            s.apply(Command::NoteOff { note: 60 });
            rms(&realtime(&mut s, 0.1))
        };
        let (on, off) = (after_key_up(u8::MAX), after_key_up(0));
        println!("100 ms after key-up: roles on {on}, roles off {off}");
        assert!(on > 2.0 * off, "the release sample is not sounding: {on} against {off}");
    }

    #[test]
    fn every_zone_that_answers_a_key_sounds_at_once() {
        let frames = (RATE * 0.2) as usize;
        let zone = Zone {
            role: Role::Sustain,
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
        let sample = Sample::memory(RATE, vec![16000; frames * 2]);
        let layered = Arc::new(Instrument::memory(vec![zone.clone(), zone], vec![sample]));

        let mut s = Sampler::new(RATE, 8);
        s.apply(Command::Load(layered));
        s.apply(Command::NoteOn { note: 60, velocity: 100 });
        assert_eq!(playing(&s, Role::Sustain).len(), 2, "the layers of one key both sound");
        // And they mix: one alone reaches half of this.
        assert!(peak(&render(&mut s, 0.1)) > 0.7, "the two layers add up");
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

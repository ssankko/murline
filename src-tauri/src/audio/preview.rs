//! Preview playback's clock: a note list in seconds, and the note on and note off events that fall
//! inside one render buffer. Nothing here knows about Audio Units, so it compiles and is tested on
//! every platform; the macOS engine is what turns an `Event` into a MIDI message.

use serde::Deserialize;

/// One note of the Preview, as the webview built it from the Score.
#[derive(Clone, Debug, Deserialize)]
pub struct PreviewNote {
    pub midi: u8,
    pub velocity: u8,
    /// Seconds from the start of the piece at the score's own tempo.
    pub on: f64,
    pub off: f64,
}

/// What the engine sends to the instrument: a note on with its velocity, or a note off.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Event {
    pub midi: u8,
    pub velocity: u8,
    pub on: bool,
}

/// Room kept for the notes sounding at once and for the events of one buffer. `pump` runs on the
/// audio thread, so both lists are reserved to this at load and never grow there.
pub const HELD: usize = 256;

/// The note list and where in it the playback is. `pump` is the whole of it: a render callback asks
/// for the events of the frames it is about to render, and gets them in the order they sound.
#[derive(Default)]
pub struct Scheduler {
    /// In `on` order, which is the order the webview builds them in.
    notes: Vec<PreviewNote>,
    playing: bool,
    /// Where the playback stands, in the score's own seconds.
    seconds: f64,
    /// Score seconds per second of wall time: 0.5 at a tempo of 50 percent.
    rate: f64,
    /// The first note not yet started.
    next: usize,
    /// Off time, note, and whether the note is zero-length (off <= on), of everything the
    /// scheduler has struck and not yet let go.
    sounding: Vec<(f64, u8, bool)>,
    /// One buffer's events with the time and tie rank they are sorted by. A field rather than a
    /// local so that a pump on the audio thread allocates nothing.
    due: Vec<(f64, u8, Event)>,
}

impl Scheduler {
    /// Takes the note list and hands back the one it replaces, which the caller drops where
    /// dropping is allowed.
    pub fn load(&mut self, mut notes: Vec<PreviewNote>) -> Vec<PreviewNote> {
        // `seek` bisects the list, so the order the webview sent is made sure of here.
        notes.sort_unstable_by(|a, b| a.on.total_cmp(&b.on));
        self.sounding.reserve(HELD);
        self.due.reserve(HELD);
        self.stop();
        std::mem::replace(&mut self.notes, notes)
    }

    pub fn play(&mut self) {
        self.playing = !self.notes.is_empty();
    }

    /// Stops where it stands. The caller releases what was sounding.
    pub fn pause(&mut self) {
        self.playing = false;
        self.sounding.clear();
    }

    /// Back to the start with the note list kept, which is also what the end of the piece does.
    pub fn stop(&mut self) {
        self.playing = false;
        self.seconds = 0.0;
        self.next = 0;
        self.sounding.clear();
    }

    /// Jumps to a time in the score's seconds. A note already under way is not struck again: the
    /// playback carries on from the next note that starts.
    pub fn seek(&mut self, seconds: f64) {
        self.seconds = seconds.max(0.0);
        self.next = self.notes.partition_point(|note| note.on < self.seconds);
        self.sounding.clear();
    }

    /// The tempo as a percent of the score's own. The schedule stretches from here on; what has
    /// already sounded keeps its time.
    pub fn set_rate(&mut self, percent: u32) {
        self.rate = percent.max(1) as f64 / 100.0;
        self.sounding.clear();
    }

    pub fn playing(&self) -> bool {
        self.playing
    }

    pub fn seconds(&self) -> f64 {
        self.seconds
    }

    /// Nothing left to sound: the piece is over and the caller stops.
    pub fn ended(&self) -> bool {
        self.playing && self.next >= self.notes.len() && self.sounding.is_empty()
    }

    /// Writes the events of the next `frames` frames into `out`, in the order they sound, and
    /// moves the clock past them. An event whose scaled time falls inside the buffer is sent at
    /// this callback, so the error is never more than one buffer. Nothing is allocated as long as
    /// `out` holds `HELD`, which is what lets the audio thread call it.
    pub fn pump(&mut self, frames: u32, sample_rate: f64, out: &mut Vec<Event>) {
        out.clear();
        if !self.playing {
            return;
        }
        let rate = if self.rate == 0.0 { 1.0 } else { self.rate };
        let end = self.seconds + (frames as f64 / sample_rate) * rate;

        // A tie at the same time breaks by rank: an off goes out before an unrelated on, so a
        // same-pitch retrigger never lands on top of the voice it is replacing. A zero-length
        // note's own off is the exception: it must follow its own on, or that voice never starts.
        const OFF: u8 = 0;
        const ON: u8 = 1;
        const OFF_OF_A_ZERO_LENGTH_NOTE: u8 = 2;

        let due = &mut self.due;
        due.clear();
        while let Some(note) = self.notes.get(self.next) {
            if note.on >= end {
                break;
            }
            due.push((note.on, ON, Event { midi: note.midi, velocity: note.velocity, on: true }));
            self.sounding.push((note.off, note.midi, note.off <= note.on));
            self.next += 1;
        }
        // After the note ons, so a note shorter than one buffer is let go inside the same buffer.
        self.sounding.retain(|&(off, midi, zero_length)| {
            let over = off < end;
            if over {
                let rank = if zero_length { OFF_OF_A_ZERO_LENGTH_NOTE } else { OFF };
                due.push((off, rank, Event { midi, velocity: 0, on: false }));
            }
            !over
        });
        due.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));

        self.seconds = end;
        out.extend(due.iter().map(|&(_, _, event)| event));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One buffer of 64 frames at 44.1 kHz, the size the engine runs by default.
    const FRAMES: u32 = 64;
    const RATE: f64 = 44100.0;
    /// How long one buffer lasts, in seconds.
    const BUFFER: f64 = FRAMES as f64 / RATE;

    fn note(midi: u8, on: f64, off: f64) -> PreviewNote {
        PreviewNote { midi, velocity: 80, on, off }
    }

    fn scheduler(notes: Vec<PreviewNote>) -> Scheduler {
        let mut scheduler = Scheduler::default();
        scheduler.load(notes);
        scheduler.set_rate(100);
        scheduler.play();
        scheduler
    }

    /// One buffer's events, as a list the assertions compare against.
    fn pump(scheduler: &mut Scheduler) -> Vec<Event> {
        let mut events = Vec::new();
        scheduler.pump(FRAMES, RATE, &mut events);
        events
    }

    /// The buffer index each note on landed in over `count` buffers.
    fn strikes(scheduler: &mut Scheduler, count: u32) -> Vec<(u32, u8)> {
        let mut at = Vec::new();
        for buffer in 0..count {
            for event in pump(scheduler) {
                if event.on {
                    at.push((buffer, event.midi));
                }
            }
        }
        at
    }

    #[test]
    fn every_event_is_sent_in_the_buffer_its_time_falls_in() {
        let mut scheduler =
            scheduler(vec![note(60, 0.0, BUFFER * 2.5), note(64, BUFFER * 3.5, BUFFER * 4.0)]);

        assert_eq!(pump(&mut scheduler), vec![Event { midi: 60, velocity: 80, on: true }]);
        assert!(pump(&mut scheduler).is_empty(), "nothing falls in the second buffer");
        assert_eq!(pump(&mut scheduler), vec![Event { midi: 60, velocity: 0, on: false }]);
        assert_eq!(pump(&mut scheduler), vec![Event { midi: 64, velocity: 80, on: true }]);
        assert_eq!(pump(&mut scheduler), vec![Event { midi: 64, velocity: 0, on: false }]);
        assert!(scheduler.ended());
    }

    #[test]
    fn a_seek_drops_what_was_sounding_and_carries_on_from_the_new_time() {
        let mut scheduler = scheduler(vec![note(60, 0.0, 10.0), note(72, 1.0, 1.5)]);
        assert!(!pump(&mut scheduler).is_empty(), "the first note struck");

        scheduler.seek(1.0 - BUFFER / 2.0);
        // The note that was under way is not struck again and never asks to be let go.
        assert_eq!(pump(&mut scheduler), vec![Event { midi: 72, velocity: 80, on: true }]);
    }

    #[test]
    fn half_the_tempo_stretches_the_schedule_twofold() {
        let notes = vec![note(60, BUFFER * 4.5, BUFFER * 5.0)];
        let full = strikes(&mut scheduler(notes.clone()), 20);
        assert_eq!(full, vec![(4, 60)]);

        let mut slow = scheduler(notes);
        slow.set_rate(50);
        assert_eq!(strikes(&mut slow, 20), vec![(9, 60)]);
    }

    #[test]
    fn a_same_pitch_retrigger_at_the_previous_notes_off_sends_the_off_first() {
        let mut scheduler = scheduler(vec![
            note(60, 0.0, BUFFER * 0.5),
            note(60, BUFFER * 0.5, BUFFER * 5.0),
        ]);

        assert_eq!(
            pump(&mut scheduler),
            vec![
                Event { midi: 60, velocity: 80, on: true },
                Event { midi: 60, velocity: 0, on: false },
                Event { midi: 60, velocity: 80, on: true },
            ],
            "the tied off must reach the sampler before the retrigger's on"
        );
    }

    #[test]
    fn a_zero_length_note_still_sends_its_on_before_its_off() {
        let mut scheduler = scheduler(vec![note(60, BUFFER * 0.5, BUFFER * 0.5)]);

        assert_eq!(
            pump(&mut scheduler),
            vec![
                Event { midi: 60, velocity: 80, on: true },
                Event { midi: 60, velocity: 0, on: false },
            ],
            "the note's own off must not jump ahead of its own on"
        );
    }

    #[test]
    fn a_paused_or_stopped_scheduler_sends_nothing() {
        let mut scheduler = scheduler(vec![note(60, BUFFER * 1.5, 10.0)]);
        assert!(pump(&mut scheduler).is_empty(), "the note is still one buffer away");

        scheduler.pause();
        assert!(pump(&mut scheduler).is_empty());

        scheduler.play();
        assert_eq!(strikes(&mut scheduler, 4), vec![(0, 60)], "resumed where it stood");

        scheduler.stop();
        assert_eq!(scheduler.seconds(), 0.0);
        assert!(pump(&mut scheduler).is_empty());
    }
}

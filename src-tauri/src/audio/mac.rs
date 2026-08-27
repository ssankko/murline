//! The sound engine on macOS: one AVAudioEngine graph with an AVAudioUnitSampler for the
//! instrument and a player node for the metronome click, both into the main mixer and out to the
//! device. Every entry point the command surface and the tests use is a method on `Graph`; the app
//! keeps one of them in `GRAPH` for as long as it runs.
//!
//! Nothing here is on the audio thread: the render callback is Apple's, and the calls below are the
//! host-side ones AVFAudio documents as safe off it.

// Notes, pedal and the instrument are what the MIDI and instrument tickets wire to the app; until
// then the tests at the bottom of this file are their only caller.
#![allow(dead_code)]

use crate::audio::preview::{PreviewNote, Scheduler};
use crate::audio::{Status, progress};
use objc2::AllocAnyThread;
use objc2::rc::Retained;
use objc2_avf_audio::{
    AVAudioEngine, AVAudioEngineManualRenderingMode, AVAudioEngineManualRenderingStatus,
    AVAudioFormat, AVAudioMixing, AVAudioPCMBuffer, AVAudioPlayerNode, AVAudioUnitSampler,
};
use objc2_foundation::{NSError, NSString, NSURL};
use std::path::Path;
use std::sync::{Mutex, Once};
use std::thread::sleep;
use std::time::{Duration, Instant};

/// The sample rate the click blips are built at. The device runs at whatever it runs at; the mixer
/// converts, and a metronome tick is far too short for the difference to be audible.
const RATE: f64 = 44100.0;
/// Length of one click, short enough to read as a tick and not as a pitch.
const CLICK_MS: f64 = 30.0;
/// The weak click's pitch, and the strong one a fifth above it so the bar line stands out.
const WEAK_HZ: f64 = 1600.0;
const STRONG_HZ: f64 = 2400.0;
/// Peak of a weak click at full volume, and the little extra a strong one gets.
const WEAK_PEAK: f32 = 0.3;
const STRONG_PEAK: f32 = 0.4;

/// The MIDI channel everything the app plays goes out on.
const CHANNEL: u8 = 0;
/// Controller numbers: the sustain pedal, and the two panics that end a note however it was started.
const SUSTAIN: u8 = 64;
const ALL_SOUND_OFF: u8 = 120;
const ALL_NOTES_OFF: u8 = 123;
/// The bank a melodic SoundFont instrument lives in, per Apple's `kAUSampler_DefaultMelodicBankMSB`.
const MELODIC_BANK_MSB: u8 = 0x79;

/// How often the Preview's pump wakes while a piece plays, and while nothing does.
// ponytail: the pump runs on a wall-clock thread, not the device's own render callback, because
// reaching that callback from Rust means an AVAudioSourceNode block holding the graph's lock on the
// audio thread. Two milliseconds is inside one 64-frame buffer; move the pump into a render block
// if the jitter is ever audible.
const PUMP: Duration = Duration::from_millis(2);
/// Idle wakes are what a press of play waits for, so they stay short enough not to be felt.
const IDLE: Duration = Duration::from_millis(20);
/// About thirty progress events a second, which is what the moving bar highlight needs.
const PROGRESS: Duration = Duration::from_millis(33);

/// The one graph the app plays through, empty until `start` builds it.
static GRAPH: Mutex<Option<Graph>> = Mutex::new(None);
/// AUSampler keeps its loaded samples in one map per process, and two loads at once abort inside
/// it, so every load in this process takes its turn.
static LOADING: Mutex<()> = Mutex::new(());

pub struct Graph {
    engine: Retained<AVAudioEngine>,
    sampler: Retained<AVAudioUnitSampler>,
    clicker: Retained<AVAudioPlayerNode>,
    format: Retained<AVAudioFormat>,
    strong: Retained<AVAudioPCMBuffer>,
    weak: Retained<AVAudioPCMBuffer>,
    /// Frames one offline render pass may take at most, zero while the graph plays to a device.
    offline_frames: u32,
    /// Name of the instrument loaded into the sampler, which is what makes the engine playable.
    instrument: Option<String>,
    /// Preview playback's note list and clock, pumped once per rendered buffer.
    preview: Scheduler,
}

// AVFAudio's classes carry no main-thread requirement, and every call into one goes through the
// mutex around the graph, so no two threads are ever inside the same object at once.
unsafe impl Send for Graph {}

impl Graph {
    /// The nodes, attached and connected, with the engine not yet started. A caller picks realtime
    /// or offline rendering next, because the choice cannot be made after the start.
    pub fn build() -> Result<Self, String> {
        unsafe {
            let format =
                AVAudioFormat::initStandardFormatWithSampleRate_channels(AVAudioFormat::alloc(), RATE, 2)
                    .ok_or("Stereo audio at 44.1 kHz is not available")?;
            let engine = AVAudioEngine::new();
            let sampler = AVAudioUnitSampler::new();
            let clicker = AVAudioPlayerNode::new();
            engine.attachNode(&sampler);
            engine.attachNode(&clicker);
            let mixer = engine.mainMixerNode();
            engine.connect_to_format(&sampler, &mixer, Some(&format));
            engine.connect_to_format(&clicker, &mixer, Some(&format));
            Ok(Graph {
                strong: blip(&format, STRONG_HZ, STRONG_PEAK)?,
                weak: blip(&format, WEAK_HZ, WEAK_PEAK)?,
                format,
                engine,
                sampler,
                clicker,
                offline_frames: 0,
                instrument: None,
                preview: Scheduler::default(),
            })
        }
    }

    /// Starts the graph on the output device.
    pub fn start(&self) -> Result<(), String> {
        unsafe {
            self.engine.prepare();
            self.engine.startAndReturnError().map_err(reason)?;
            // The click player runs from here on; every click is one buffer scheduled onto it.
            self.clicker.play();
        }
        Ok(())
    }

    /// Starts the graph with no device at all, rendering only when `render` asks it to. What the
    /// tests use, and the only way to hear the graph without hardware.
    pub fn start_offline(&mut self, max_frames: u32) -> Result<(), String> {
        unsafe {
            self.engine
                .enableManualRenderingMode_format_maximumFrameCount_error(
                    AVAudioEngineManualRenderingMode::Offline,
                    &self.format,
                    max_frames,
                )
                .map_err(reason)?;
        }
        self.offline_frames = max_frames;
        self.start()
    }

    /// Renders `frames` of the offline graph and hands back the loudest sample in them. Silence is
    /// zero, so a test reads sound or its absence off one number.
    pub fn render_peak(&mut self, frames: u32) -> Result<f32, String> {
        unsafe {
            let format = self.engine.manualRenderingFormat();
            let buffer = AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
                AVAudioPCMBuffer::alloc(),
                &format,
                self.offline_frames,
            )
            .ok_or("The render buffer could not be made")?;
            let render = self.engine.manualRenderingBlock();
            let mut peak = 0f32;
            let mut left = frames;
            while left > 0 {
                // One pump per pass, exactly as the device path pumps once per buffer.
                self.pump(left.min(self.offline_frames));
                // The frame length is set again every pass: the block writes back how much it
                // rendered, and the next pass must be offered the whole buffer once more.
                buffer.setFrameLength(self.offline_frames);
                let mut os_status = 0;
                let status = (*render).call((
                    left.min(self.offline_frames),
                    buffer.mutableAudioBufferList(),
                    &mut os_status,
                ));
                let rendered = buffer.frameLength();
                if status != AVAudioEngineManualRenderingStatus::Success || rendered == 0 {
                    return Err(format!("The engine rendered nothing (status {os_status})"));
                }
                let channels = buffer.floatChannelData();
                for channel in 0..format.channelCount() as usize {
                    let samples = (*channels.add(channel)).as_ptr();
                    for frame in 0..rendered as usize {
                        peak = peak.max(samples.add(frame).read().abs());
                    }
                }
                left -= rendered.min(left);
            }
            Ok(peak)
        }
    }

    /// Loads a SoundFont or DLS bank's first melodic program into the sampler, which is what makes
    /// the engine playable. Reads from disk, so never from the audio thread.
    pub fn load_sound_bank(&mut self, path: &Path, name: String) -> Result<(), String> {
        // Nothing of the old instrument may ring on through the new one.
        self.release_all();
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let _turn = LOADING.lock().unwrap();
        unsafe {
            self.sampler
                .loadSoundBankInstrumentAtURL_program_bankMSB_bankLSB_error(&url, 0, MELODIC_BANK_MSB, 0)
                .map_err(reason)?;
        }
        self.instrument = Some(name);
        Ok(())
    }

    pub fn instrument(&self) -> Option<&str> {
        self.instrument.as_deref()
    }

    pub fn note_on(&self, note: u8, velocity: u8) {
        unsafe { self.sampler.startNote_withVelocity_onChannel(note, velocity, CHANNEL) };
    }

    pub fn note_off(&self, note: u8) {
        unsafe { self.sampler.stopNote_onChannel(note, CHANNEL) };
    }

    /// The sustain pedal. A note let go while it is down keeps sounding until it comes up.
    pub fn sustain(&self, down: bool) {
        self.controller(SUSTAIN, if down { 127 } else { 0 });
    }

    /// Ends everything sounding, pedal included: what a stopped play and a lost MIDI port send.
    pub fn release_all(&self) {
        self.controller(SUSTAIN, 0);
        self.controller(ALL_NOTES_OFF, 0);
        self.controller(ALL_SOUND_OFF, 0);
    }

    fn controller(&self, controller: u8, value: u8) {
        unsafe { self.sampler.sendController_withValue_onChannel(controller, value, CHANNEL) };
    }

    /// The Preview's note list, in seconds at the score's own tempo.
    pub fn preview_load(&mut self, notes: Vec<PreviewNote>) {
        self.preview.load(notes);
        self.release_all();
    }

    pub fn preview_play(&mut self) {
        self.preview.play();
    }

    pub fn preview_pause(&mut self) {
        self.preview.pause();
        self.release_all();
    }

    pub fn preview_seek(&mut self, seconds: f64) {
        self.preview.seek(seconds);
        self.release_all();
    }

    pub fn preview_rate(&mut self, percent: u32) {
        self.preview.set_rate(percent);
        self.release_all();
    }

    /// Stops and forgets the note list: what leaving the Preview sends.
    pub fn preview_stop(&mut self) {
        self.preview.load(Vec::new());
        self.release_all();
    }

    /// Sends the Preview events of the next `frames` frames to the instrument, and ends the play
    /// when the last note has been let go.
    fn pump(&mut self, frames: u32) {
        for event in self.preview.pump(frames, RATE) {
            if event.on {
                self.note_on(event.midi, event.velocity);
            } else {
                self.note_off(event.midi);
            }
        }
        if self.preview.ended() {
            self.preview.stop();
            self.release_all();
        }
    }

    /// One metronome click, at a volume of 0 to 100.
    pub fn click(&self, strong: bool, volume: u32) {
        let buffer = if strong { &self.strong } else { &self.weak };
        unsafe {
            self.clicker.setVolume(volume.min(100) as f32 / 100.0);
            self.clicker.scheduleBuffer_completionHandler(buffer, std::ptr::null_mut());
        }
    }
}

/// One click as a buffer of samples: a sine falling to silence, because a square end would pop.
fn blip(format: &AVAudioFormat, hz: f64, peak: f32) -> Result<Retained<AVAudioPCMBuffer>, String> {
    let frames = (RATE * CLICK_MS / 1000.0) as u32;
    unsafe {
        let buffer =
            AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(AVAudioPCMBuffer::alloc(), format, frames)
                .ok_or("The click buffer could not be made")?;
        buffer.setFrameLength(frames);
        let channels = buffer.floatChannelData();
        for frame in 0..frames as usize {
            let at = frame as f64 / RATE;
            let fall = (-at / (CLICK_MS / 1000.0 / 5.0)).exp() as f32;
            let sample = peak * fall * (2.0 * std::f64::consts::PI * hz * at).sin() as f32;
            for channel in 0..format.channelCount() as usize {
                (*channels.add(channel)).as_ptr().add(frame).write(sample);
            }
        }
        Ok(buffer)
    }
}

/// An NSError as the plain-text line the boot screen and the Audio dialog print.
fn reason(error: Retained<NSError>) -> String {
    error.localizedDescription().to_string()
}

/// Every command that touches the running graph goes through here, so nothing reaches the nodes
/// while another thread is inside them. Without a graph there is nothing to do and no error.
fn with<T>(act: impl FnOnce(&mut Graph) -> T) -> Option<T> {
    GRAPH.lock().unwrap().as_mut().map(act)
}

pub fn start() -> Result<(), String> {
    let graph = Graph::build()?;
    graph.start()?;
    *GRAPH.lock().unwrap() = Some(graph);
    static PUMPING: Once = Once::new();
    PUMPING.call_once(|| {
        std::thread::spawn(pump_forever);
    });
    Ok(())
}

/// The Preview's clock on the device path: wake, work out how many frames went by, send the events
/// that fall in them, and tell the webview where the playback stands.
fn pump_forever() {
    let mut last = Instant::now();
    let mut told = Instant::now() - PROGRESS;
    loop {
        let frames = (last.elapsed().as_secs_f64() * RATE) as u32;
        let Some((was_playing, playing, seconds)) = with(|graph| {
            let was_playing = graph.preview.playing();
            if was_playing {
                graph.pump(frames);
            }
            (was_playing, graph.preview.playing(), graph.preview.seconds())
        }) else {
            sleep(IDLE);
            continue;
        };
        if !was_playing {
            last = Instant::now();
            sleep(IDLE);
            continue;
        }
        last += Duration::from_secs_f64(frames as f64 / RATE);
        // The end of the piece is told at once, so the play button comes back without a wait.
        if !playing || told.elapsed() >= PROGRESS {
            told = Instant::now();
            progress(seconds, playing);
        }
        sleep(PUMP);
    }
}

pub fn preview_load(notes: Vec<PreviewNote>) {
    with(|graph| graph.preview_load(notes));
}

pub fn preview_play() {
    with(|graph| graph.preview_play());
}

pub fn preview_pause() {
    with(|graph| graph.preview_pause());
}

pub fn preview_seek(seconds: f64) {
    with(|graph| graph.preview_seek(seconds));
}

pub fn preview_rate(percent: u32) {
    with(|graph| graph.preview_rate(percent));
}

pub fn preview_stop() {
    with(|graph| graph.preview_stop());
}

pub fn status() -> Status {
    match GRAPH.lock().unwrap().as_ref() {
        None => Status::unavailable("The sound engine did not start"),
        // Later tickets choose an instrument; until one is loaded the graph is silent by design.
        Some(graph) if graph.instrument().is_none() => Status::unavailable("No instrument chosen"),
        Some(_) => Status { available: true, reason: String::new() },
    }
}

pub fn click(strong: bool, volume: u32) {
    with(|graph| graph.click(strong, volume));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A few kilobytes of SoundFont: one looped sine mapped across the keyboard, so any note the
    /// tests play sounds. `fixtures/make-sine-sf2.py` writes it.
    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/sine.sf2");
    /// Frames one offline render pass takes at most, and how many one look at the graph renders:
    /// a tenth of a second, long enough for a note to speak and for a release to finish.
    const PASS: u32 = 4096;
    const LOOK: u32 = 4410;
    /// How long one offline pass lasts, which is the buffer a Preview event falls into.
    const PASS_SECONDS: f64 = PASS as f64 / RATE;

    /// A graph with the fixture in its sampler, rendering to nothing but the test's own buffer.
    fn offline() -> Graph {
        let mut graph = Graph::build().unwrap();
        graph.load_sound_bank(Path::new(FIXTURE), "Sine".into()).unwrap();
        graph.start_offline(PASS).unwrap();
        graph
    }

    fn preview_note(midi: u8, on: f64, off: f64) -> PreviewNote {
        PreviewNote { midi, velocity: 100, on, off, tick: 0 }
    }

    /// Renders one pass at a time and hands back the first one that made a sound.
    fn first_sounding_pass(graph: &mut Graph, passes: u32) -> Option<u32> {
        (0..passes).find(|_| graph.render_peak(PASS).unwrap() > 0.01)
    }

    #[test]
    fn the_fixture_loads_and_an_untouched_graph_is_silent() {
        let mut graph = offline();
        assert_eq!(graph.instrument(), Some("Sine"));
        assert_eq!(graph.render_peak(LOOK).unwrap(), 0.0);
    }

    #[test]
    fn a_note_sounds_until_it_is_let_go() {
        let mut graph = offline();
        graph.note_on(60, 100);
        assert!(graph.render_peak(LOOK).unwrap() > 0.01);

        graph.note_off(60);
        // The release runs out inside this pass; what comes after it is silence.
        graph.render_peak(LOOK).unwrap();
        assert_eq!(graph.render_peak(LOOK).unwrap(), 0.0);
    }

    #[test]
    fn releasing_everything_ends_a_note_that_was_never_let_go() {
        let mut graph = offline();
        graph.note_on(72, 100);
        assert!(graph.render_peak(LOOK).unwrap() > 0.01);

        graph.release_all();
        graph.render_peak(LOOK).unwrap();
        assert_eq!(graph.render_peak(LOOK).unwrap(), 0.0);
    }

    #[test]
    fn the_sustain_pedal_holds_a_released_note_until_it_comes_up() {
        let mut graph = offline();
        graph.sustain(true);
        graph.note_on(64, 100);
        graph.note_off(64);
        graph.render_peak(LOOK).unwrap();
        assert!(graph.render_peak(LOOK).unwrap() > 0.01, "the pedal is down");

        graph.sustain(false);
        graph.render_peak(LOOK).unwrap();
        assert_eq!(graph.render_peak(LOOK).unwrap(), 0.0, "the pedal came up");
    }

    #[test]
    fn a_click_puts_sound_on_the_mixer_and_a_volume_of_zero_does_not() {
        let mut graph = offline();
        graph.click(true, 100);
        let strong = graph.render_peak(LOOK).unwrap();
        assert!(strong > 0.01);

        graph.click(false, 100);
        let weak = graph.render_peak(LOOK).unwrap();
        assert!(weak > 0.01 && weak < strong, "strong {strong}, weak {weak}");

        graph.click(true, 0);
        assert_eq!(graph.render_peak(LOOK).unwrap(), 0.0);
    }

    #[test]
    fn a_preview_note_sounds_in_the_pass_its_time_falls_in() {
        let mut graph = offline();
        graph.preview_load(vec![preview_note(60, PASS_SECONDS * 2.5, PASS_SECONDS * 3.5)]);
        graph.preview_play();

        assert_eq!(first_sounding_pass(&mut graph, 8), Some(2));
    }

    #[test]
    fn half_the_tempo_stretches_the_schedule_twofold() {
        let note = preview_note(60, PASS_SECONDS * 1.25, PASS_SECONDS * 2.0);

        let mut graph = offline();
        graph.preview_load(vec![note.clone()]);
        graph.preview_play();
        assert_eq!(first_sounding_pass(&mut graph, 8), Some(1));

        let mut slow = offline();
        slow.preview_load(vec![note]);
        slow.preview_rate(50);
        slow.preview_play();
        assert_eq!(first_sounding_pass(&mut slow, 8), Some(2), "twice as long to come");
    }

    #[test]
    fn a_seek_lets_go_of_what_was_sounding_and_carries_on_from_the_new_time() {
        let mut graph = offline();
        // The schedule never lets the first note go; only the seek can end it.
        graph.preview_load(vec![preview_note(60, 0.0, 100.0), preview_note(72, 3.0, 3.5)]);
        graph.preview_play();
        assert_eq!(first_sounding_pass(&mut graph, 2), Some(0));

        graph.preview_seek(2.0);
        // The release runs out inside this pass; what comes after it is silence.
        graph.render_peak(PASS).unwrap();
        assert_eq!(graph.render_peak(PASS).unwrap(), 0.0, "the note under way was let go");

        assert!(first_sounding_pass(&mut graph, 20).is_some(), "the next note still comes");
    }

    #[test]
    fn the_end_of_the_piece_stops_the_playback_and_returns_to_the_start() {
        let mut graph = offline();
        graph.preview_load(vec![preview_note(60, 0.0, PASS_SECONDS * 0.5)]);
        graph.preview_play();
        graph.render_peak(PASS).unwrap();

        assert!(!graph.preview.playing());
        assert_eq!(graph.preview.seconds(), 0.0);
    }
}

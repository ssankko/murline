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

use crate::audio::Status;
// The instrument the graph plays, and the window a hosted plugin brings with it.
pub use crate::audio::instruments::{list as instruments, load as load_instrument};
pub use crate::audio::window::show_instrument;
use objc2::AllocAnyThread;
use objc2::rc::Retained;
use objc2_avf_audio::{
    AVAudioEngine, AVAudioEngineManualRenderingMode, AVAudioEngineManualRenderingStatus,
    AVAudioFormat, AVAudioMixing, AVAudioPCMBuffer, AVAudioPlayerNode, AVAudioUnitMIDIInstrument,
    AVAudioUnitSampler,
};
use objc2_foundation::{NSError, NSString, NSURL};
use std::path::Path;
use std::sync::Mutex;

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

/// The one graph the app plays through, empty until `start` builds it.
pub(super) static GRAPH: Mutex<Option<Graph>> = Mutex::new(None);
/// AUSampler keeps its loaded samples in one map per process, and two loads at once abort inside
/// it, so every load in this process takes its turn. Starting a graph counts as one: a hosted unit
/// reads its own samples in as the engine initialises the node.
static LOADING: Mutex<()> = Mutex::new(());

/// The instrument the user picked: its opaque id, the name the status line says, and why it is
/// silent when the load failed.
#[derive(Clone)]
pub struct Chosen {
    pub id: String,
    pub name: String,
    pub failure: Option<String>,
}

pub struct Graph {
    engine: Retained<AVAudioEngine>,
    sampler: Retained<AVAudioUnitSampler>,
    /// The hosted Audio Unit instrument, when the choice is a plugin instead of a file. It plays
    /// in the sampler's place; the sampler stays in the graph, silent.
    plugin: Option<Retained<AVAudioUnitMIDIInstrument>>,
    clicker: Retained<AVAudioPlayerNode>,
    format: Retained<AVAudioFormat>,
    strong: Retained<AVAudioPCMBuffer>,
    weak: Retained<AVAudioPCMBuffer>,
    /// Frames one offline render pass may take at most, zero while the graph plays to a device.
    offline_frames: u32,
    /// The instrument the user picked, which is what makes the engine playable.
    chosen: Option<Chosen>,
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
                plugin: None,
                clicker,
                offline_frames: 0,
                chosen: None,
            })
        }
    }

    /// Starts the graph on the output device.
    pub fn start(&self) -> Result<(), String> {
        let _turn = LOADING.lock().unwrap();
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
    pub fn render_peak(&self, frames: u32) -> Result<f32, String> {
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

    /// Loads an instrument file into the sampler: a SoundFont's first melodic program, or an EXS
    /// or AUPreset whole. Reads from disk, so never from the audio thread.
    pub fn load_file(&mut self, path: &Path) -> Result<(), String> {
        let sound_bank = path.extension().is_some_and(|kind| kind.eq_ignore_ascii_case("sf2"));
        if sound_bank && not_a_sound_font(path) {
            return Err("That file is not a SoundFont".into());
        }
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let _turn = LOADING.lock().unwrap();
        unsafe {
            if sound_bank {
                self.sampler
                    .loadSoundBankInstrumentAtURL_program_bankMSB_bankLSB_error(
                        &url,
                        0,
                        MELODIC_BANK_MSB,
                        0,
                    )
                    .map_err(reason)?;
            } else {
                self.sampler.loadInstrumentAtURL_error(&url).map_err(reason)?;
            }
        }
        self.drop_plugin();
        Ok(())
    }

    /// Puts a hosted Audio Unit instrument in the sampler's place, taking out whichever one played
    /// before it.
    pub fn set_plugin(&mut self, unit: Retained<AVAudioUnitMIDIInstrument>) {
        self.drop_plugin();
        let _turn = LOADING.lock().unwrap();
        unsafe {
            self.engine.attachNode(&unit);
            let mixer = self.engine.mainMixerNode();
            self.engine.connect_to_format(&unit, &mixer, Some(&self.format));
        }
        self.plugin = Some(unit);
    }

    fn drop_plugin(&mut self) {
        if let Some(old) = self.plugin.take() {
            unsafe { self.engine.detachNode(&old) };
        }
    }

    /// The hosted plugin, which is the one instrument that has a window of its own.
    pub fn plugin(&self) -> Option<&AVAudioUnitMIDIInstrument> {
        self.plugin.as_deref()
    }

    pub fn chosen(&self) -> Option<&Chosen> {
        self.chosen.as_ref()
    }

    pub fn choose(&mut self, chosen: Chosen) {
        self.chosen = Some(chosen);
    }

    pub fn instrument(&self) -> Option<&str> {
        self.chosen.as_ref().filter(|chosen| chosen.failure.is_none()).map(|chosen| chosen.name.as_str())
    }

    /// Whichever node the notes go to: the plugin when one is hosted, the sampler otherwise.
    fn target(&self) -> &AVAudioUnitMIDIInstrument {
        self.plugin.as_deref().unwrap_or(&self.sampler)
    }

    pub fn note_on(&self, note: u8, velocity: u8) {
        unsafe { self.target().startNote_withVelocity_onChannel(note, velocity, CHANNEL) };
    }

    pub fn note_off(&self, note: u8) {
        unsafe { self.target().stopNote_onChannel(note, CHANNEL) };
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
        unsafe { self.target().sendController_withValue_onChannel(controller, value, CHANNEL) };
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

/// True when the file opens and holds something that is plainly no SoundFont. AUSampler traps
/// inside itself on one of those and takes the app with it, so the header is read here first. A
/// file that will not open at all is left to the sampler, whose own error says so better.
fn not_a_sound_font(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 12];
    std::fs::File::open(path).and_then(|mut file| file.read_exact(&mut head)).is_ok()
        && (&head[..4] != b"RIFF" || &head[8..] != b"sfbk")
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
pub(super) fn reason(error: Retained<NSError>) -> String {
    error.localizedDescription().to_string()
}

pub fn start() -> Result<(), String> {
    let graph = Graph::build()?;
    graph.start()?;
    *GRAPH.lock().unwrap() = Some(graph);
    Ok(())
}

pub fn status() -> Status {
    let held = GRAPH.lock().unwrap();
    let Some(graph) = held.as_ref() else {
        return Status::unavailable("The sound engine did not start");
    };
    match graph.chosen() {
        None => Status::unavailable("No instrument chosen"),
        Some(Chosen { name, failure: Some(failure), .. }) => {
            Status::unavailable(&format!("{name} did not load: {failure}"))
        }
        Some(_) => Status { available: true, reason: String::new() },
    }
}

pub fn click(strong: bool, volume: u32) {
    if let Some(graph) = GRAPH.lock().unwrap().as_ref() {
        graph.click(strong, volume);
    }
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

    /// A graph with the fixture in its sampler, rendering to nothing but the test's own buffer.
    fn offline() -> Graph {
        let mut graph = Graph::build().unwrap();
        graph.load_file(Path::new(FIXTURE)).unwrap();
        graph.start_offline(PASS).unwrap();
        graph
    }

    #[test]
    fn the_fixture_loads_and_an_untouched_graph_is_silent() {
        let graph = offline();
        assert_eq!(graph.render_peak(LOOK).unwrap(), 0.0);
    }

    #[test]
    fn a_note_sounds_until_it_is_let_go() {
        let graph = offline();
        graph.note_on(60, 100);
        assert!(graph.render_peak(LOOK).unwrap() > 0.01);

        graph.note_off(60);
        // The release runs out inside this pass; what comes after it is silence.
        graph.render_peak(LOOK).unwrap();
        assert_eq!(graph.render_peak(LOOK).unwrap(), 0.0);
    }

    #[test]
    fn releasing_everything_ends_a_note_that_was_never_let_go() {
        let graph = offline();
        graph.note_on(72, 100);
        assert!(graph.render_peak(LOOK).unwrap() > 0.01);

        graph.release_all();
        graph.render_peak(LOOK).unwrap();
        assert_eq!(graph.render_peak(LOOK).unwrap(), 0.0);
    }

    #[test]
    fn the_sustain_pedal_holds_a_released_note_until_it_comes_up() {
        let graph = offline();
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
        let graph = offline();
        graph.click(true, 100);
        let strong = graph.render_peak(LOOK).unwrap();
        assert!(strong > 0.01);

        graph.click(false, 100);
        let weak = graph.render_peak(LOOK).unwrap();
        assert!(weak > 0.01 && weak < strong, "strong {strong}, weak {weak}");

        graph.click(true, 0);
        assert_eq!(graph.render_peak(LOOK).unwrap(), 0.0);
    }
}

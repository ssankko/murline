//! The sound engine on macOS: one AVAudioEngine graph with an AVAudioUnitSampler for the
//! instrument and a player node for the metronome click, both into the main mixer and out to the
//! device. Every entry point the command surface and the tests use is a method on `Graph`; the app
//! keeps one of them in `GRAPH` for as long as it runs.
//!
//! Nothing here is on the audio thread: the render callback is Apple's, and the calls below are the
//! host-side ones AVFAudio documents as safe off it.

mod effects;
pub use effects::{chain, effects, set_chain, show_effect};

use crate::audio::device::{self, DeviceId};
use crate::audio::{OutputDevice, Status};
use objc2::AllocAnyThread;
use objc2::rc::Retained;
use objc2_audio_toolbox::{
    AudioUnit, AudioUnitGetProperty, AudioUnitSetProperty, kAudioOutputUnitProperty_CurrentDevice,
    kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global,
};
use objc2_avf_audio::{
    AVAudioEngine, AVAudioEngineManualRenderingMode, AVAudioEngineManualRenderingStatus,
    AVAudioFormat, AVAudioMixing, AVAudioPCMBuffer, AVAudioPlayerNode, AVAudioUnitSampler,
};
use objc2_foundation::{NSError, NSString, NSURL};
use std::path::Path;
use std::ptr::{NonNull, from_ref};
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

/// The buffer sizes the dialog offers, and the one the app starts at.
pub const FRAME_CHOICES: [u32; 4] = [32, 64, 128, 256];
pub const DEFAULT_FRAMES: u32 = 64;
/// The status line when the device the user picked is not plugged in.
const GONE: &str = "Your chosen output device is not connected; playing through the system default";

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
    /// The effects between the sampler and the mixer, in the order they play.
    chain: Vec<effects::Held>,
    /// Frames one offline render pass may take at most, zero while the graph plays to a device.
    offline_frames: u32,
    /// Name of the instrument loaded into the sampler, which is what makes the engine playable.
    instrument: Option<String>,
    /// The device the user picked, kept as its UID even while it is unplugged so that plugging it
    /// back in takes it up again. None is the system default.
    chosen: Option<String>,
    /// The device actually playing, and whether the choice above had to be given up to find it.
    device: DeviceId,
    fell_back: bool,
    /// The buffer the user picked. What the device runs may differ, and the status reports that.
    wanted_frames: u32,
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
                chain: Vec::new(),
                offline_frames: 0,
                instrument: None,
                chosen: None,
                device: 0,
                fell_back: false,
                wanted_frames: DEFAULT_FRAMES,
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
    #[allow(dead_code)]
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
    #[allow(dead_code)]
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

    /// Loads a SoundFont or DLS bank's first melodic program into the sampler, which is what makes
    /// the engine playable. Reads from disk, so never from the audio thread.
    // The instrument ticket is what puts a file in front of this; for now the tests are its caller.
    #[allow(dead_code)]
    pub fn load_sound_bank(&mut self, path: &Path, name: String) -> Result<(), String> {
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

    /// The output unit AVAudioEngine plays through, which is where the device is chosen.
    fn output_unit(&self) -> AudioUnit {
        unsafe { self.engine.outputNode().audioUnit() }
    }

    /// Reads back the device the engine started on, so the status has an answer before the first
    /// setting is applied.
    fn adopt(&mut self) {
        self.device = current_device(self.output_unit()).unwrap_or(0);
    }

    /// Moves the whole graph to `device`. Nothing is left sounding: the notes go first, and the
    /// engine has to stop before the output unit will take a different device.
    fn play_through(&mut self, device: DeviceId, fell_back: bool) -> Result<(), String> {
        self.release_all();
        unsafe { self.engine.stop() };
        set_current_device(self.output_unit(), device)?;
        self.device = device;
        self.fell_back = fell_back;
        // A device that will not take the buffer keeps its own; the move itself still stands, and
        // the status reports the size actually running.
        let _ = self.apply_buffer();
        self.start()
    }

    /// Takes the device list as it now is: stays put when the choice still resolves to the device
    /// playing, moves to the system default when the chosen device has gone, and moves back to the
    /// chosen device when it returns.
    pub fn follow_devices(&mut self) -> Result<(), String> {
        let (device, fell_back) = device::resolve(self.chosen.as_deref())?;
        if device == self.device && fell_back == self.fell_back {
            return Ok(());
        }
        self.play_through(device, fell_back)
    }

    pub fn set_device(&mut self, chosen: Option<String>) -> Result<(), String> {
        self.chosen = chosen;
        let (device, fell_back) = device::resolve(self.chosen.as_deref())?;
        self.play_through(device, fell_back)
    }

    pub fn set_buffer(&mut self, frames: u32) -> Result<(), String> {
        if !FRAME_CHOICES.contains(&frames) {
            return Err(format!("{frames} frames is not one of 32, 64, 128 and 256"));
        }
        self.wanted_frames = frames;
        self.release_all();
        // The device restarts its own IO around the change, so the graph stops first and what would
        // have been a half-rendered buffer is silence instead.
        unsafe { self.engine.stop() };
        let applied = self.apply_buffer();
        self.start()?;
        applied
    }

    fn apply_buffer(&self) -> Result<(), String> {
        let asked = device::set_buffer_frames(self.device, self.wanted_frames);
        let running = device::buffer_frames(self.device);
        for unit in [self.output_unit(), unsafe { self.sampler.audioUnit() }] {
            raise_max_frames(unit, running);
        }
        asked
    }

    /// What the Audio dialog shows about the output, folded into the status the engine answers.
    fn describe_output(&self, status: &mut Status) {
        let frames = device::buffer_frames(self.device);
        status.device = device::uid(self.device);
        status.device_name = device::name(self.device);
        status.fallback = if self.fell_back { GONE.into() } else { String::new() };
        status.buffer_frames = frames;
        status.sample_rate = device::sample_rate(self.device);
        status.latency_ms = device::latency_ms(self.device, frames);
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

fn current_device(unit: AudioUnit) -> Option<DeviceId> {
    let mut device: DeviceId = 0;
    let mut size = size_of::<DeviceId>() as u32;
    let status = unsafe {
        AudioUnitGetProperty(
            unit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            NonNull::from(&mut device).cast(),
            NonNull::from(&mut size),
        )
    };
    (status == 0).then_some(device)
}

fn set_current_device(unit: AudioUnit, device: DeviceId) -> Result<(), String> {
    let status = unsafe {
        AudioUnitSetProperty(
            unit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            from_ref(&device).cast(),
            size_of::<DeviceId>() as u32,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{} could not be played through (status {status})", device::name(device)))
    }
}

/// Lets a unit render a whole device buffer in one slice. Units start well above every buffer the
/// dialog offers, so this fires only for a device running a bigger one than the app asked for.
/// Lowering the figure to match a small buffer is deliberately not done: it buys nothing, and a
/// unit that is already initialised refuses it.
fn raise_max_frames(unit: AudioUnit, frames: u32) {
    let mut current = 0u32;
    let mut size = size_of::<u32>() as u32;
    let read = unsafe {
        AudioUnitGetProperty(
            unit,
            kAudioUnitProperty_MaximumFramesPerSlice,
            kAudioUnitScope_Global,
            0,
            NonNull::from(&mut current).cast(),
            NonNull::from(&mut size),
        )
    };
    if read != 0 || current >= frames {
        return;
    }
    unsafe {
        AudioUnitSetProperty(
            unit,
            kAudioUnitProperty_MaximumFramesPerSlice,
            kAudioUnitScope_Global,
            0,
            from_ref(&frames).cast(),
            size_of::<u32>() as u32,
        )
    };
}

pub fn start() -> Result<(), String> {
    let mut graph = Graph::build()?;
    graph.start()?;
    graph.adopt();
    *GRAPH.lock().unwrap() = Some(graph);
    device::watch(devices_changed);
    Ok(())
}

/// CoreAudio's answer to a plug or an unplug: the engine takes the new list into account, then the
/// dialog is told to read its picker again. CoreAudio calls this on one of its own threads and
/// wants it back at once, and stopping the engine there would run inside the HAL's own locks, so
/// the work moves off it.
fn devices_changed() {
    std::thread::spawn(|| {
        if let Some(graph) = GRAPH.lock().unwrap().as_mut() {
            let _ = graph.follow_devices();
        }
        crate::audio::tell_devices_changed();
    });
}

pub fn status() -> Status {
    let held = GRAPH.lock().unwrap();
    let Some(graph) = held.as_ref() else {
        return Status::unavailable("The sound engine did not start");
    };
    // Later tickets choose an instrument; until one is loaded the graph is silent by design.
    let mut status = match graph.instrument() {
        None => Status::unavailable("No instrument chosen"),
        Some(_) => Status { available: true, ..Status::default() },
    };
    graph.describe_output(&mut status);
    status
}

pub fn click(strong: bool, volume: u32) {
    with(|graph| graph.click(strong, volume));
}

/// One key of the MIDI keyboard, down or up. Velocity reaches the instrument raw.
pub fn note(midi: u8, velocity: u8, on: bool) {
    with(|graph| {
        if on {
            graph.note_on(midi, velocity);
        } else {
            graph.note_off(midi);
        }
    });
}

/// The sustain pedal, as controller 64 sent it. Half travel and up is down, as every host reads it.
pub fn pedal(value: u8) {
    with(|graph| graph.sustain(crate::midi::Message::pedal_down(value)));
}

/// Ends everything sounding: what a lost MIDI port sends, so no note rings after an unplug.
pub fn release_all() {
    with(Graph::release_all);
}

/// Runs something on the graph, or on nothing at all when the engine never started.
fn with(act: impl FnOnce(&Graph)) {
    if let Some(graph) = GRAPH.lock().unwrap().as_ref() {
        act(graph);
    }
}

pub fn output_devices() -> Vec<OutputDevice> {
    device::outputs()
}

pub fn set_output_device(id: Option<String>) -> Result<(), String> {
    with_graph(|graph| graph.set_device(id))
}

pub fn set_buffer_frames(frames: u32) -> Result<(), String> {
    with_graph(|graph| graph.set_buffer(frames))
}

fn with_graph(run: impl FnOnce(&mut Graph) -> Result<(), String>) -> Result<(), String> {
    let mut held = GRAPH.lock().unwrap();
    run(held.as_mut().ok_or("The sound engine did not start")?)
}

/// Puts an offline graph where the app's own would be, and reads what it renders. The MIDI tests
/// play through the engine the way the app does, without an audio device.
#[cfg(test)]
pub fn install(graph: Graph) {
    *GRAPH.lock().unwrap() = Some(graph);
}

#[cfg(test)]
pub fn peak(frames: u32) -> f32 {
    GRAPH.lock().unwrap().as_ref().map_or(0.0, |graph| graph.render_peak(frames).unwrap())
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
        graph.load_sound_bank(Path::new(FIXTURE), "Sine".into()).unwrap();
        graph.start_offline(PASS).unwrap();
        graph
    }

    #[test]
    fn the_fixture_loads_and_an_untouched_graph_is_silent() {
        let graph = offline();
        assert_eq!(graph.instrument(), Some("Sine"));
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

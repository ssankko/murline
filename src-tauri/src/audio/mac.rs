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
use crate::audio::preview::{PreviewNote, Scheduler};
use crate::audio::{OutputDevice, Status, progress};
// The instrument the graph plays, and the window a hosted plugin brings with it.
pub use crate::audio::instruments::{list as instruments, load as load_instrument};
pub use crate::audio::window::show_instrument;
use objc2::AllocAnyThread;
use objc2::rc::Retained;
use objc2_audio_toolbox::{
    AudioUnit, AudioUnitGetProperty, AudioUnitSetProperty, kAudioOutputUnitProperty_CurrentDevice,
    kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global,
};
use objc2_avf_audio::{
    AVAudioEngine, AVAudioEngineManualRenderingMode, AVAudioFormat, AVAudioMixing,
    AVAudioPCMBuffer, AVAudioPlayerNode, AVAudioUnitMIDIInstrument, AVAudioUnitSampler,
};
#[cfg(test)]
use objc2_avf_audio::AVAudioEngineManualRenderingStatus;
use objc2_foundation::{NSError, NSString, NSURL};
use std::path::{Path, PathBuf};
use std::ptr::{NonNull, from_ref};
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

/// The buffer sizes the dialog offers, and the one the app starts at.
pub const FRAME_CHOICES: [u32; 4] = [32, 64, 128, 256];
pub const DEFAULT_FRAMES: u32 = 64;
/// The status line when the device the user picked is not plugged in.
const GONE: &str = "Your chosen output device is not connected; playing through the system default";

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
    /// The effects between the sampler and the mixer, in the order they play.
    chain: Vec<effects::Held>,
    /// The file the sampler plays. AUSampler holds a loaded instrument only from the load to the
    /// next time its node is initialised, and the engine initialises the node on every start and
    /// on every change of the wiring, so the file goes back in each time.
    file: Option<PathBuf>,
    /// Frames one offline render pass may take at most, zero while the graph plays to a device.
    offline_frames: u32,
    /// The instrument the user picked, which is what makes the engine playable.
    chosen: Option<Chosen>,
    /// The device the user picked, kept as its UID even while it is unplugged so that plugging it
    /// back in takes it up again. None is the system default.
    chosen_device: Option<String>,
    /// The device actually playing, and whether the choice above had to be given up to find it.
    device: DeviceId,
    fell_back: bool,
    /// The buffer the user picked. What the device runs may differ, and the status reports that.
    wanted_frames: u32,
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
                plugin: None,
                clicker,
                chain: Vec::new(),
                file: None,
                offline_frames: 0,
                chosen: None,
                chosen_device: None,
                device: 0,
                fell_back: false,
                wanted_frames: DEFAULT_FRAMES,
                preview: Scheduler::default(),
            })
        }
    }

    /// Starts the graph on the output device.
    pub fn start(&self) -> Result<(), String> {
        let _turn = LOADING.lock().unwrap();
        // Starting initialises the sampler, which is what makes a load stick and what loses the
        // load before it, so the file is read in first while the node is still uninitialised.
        let _ = self.reload();
        unsafe {
            self.engine.prepare();
            self.engine.startAndReturnError().map_err(reason)?;
            // The click player runs from here on; every click is one buffer scheduled onto it. A
            // player the engine stopped underneath still answers that it is playing, so playing it
            // again would be a no-op and every later click silent: it is stopped first.
            self.clicker.stop();
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
    #[cfg(test)]
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

    /// Loads an instrument file into the sampler: a SoundFont's first melodic program, or an EXS
    /// or AUPreset whole. Reads from disk, so never from the audio thread.
    pub fn load_file(&mut self, path: &Path) -> Result<(), String> {
        if sound_bank(path) && not_a_sound_font(path) {
            return Err("That file is not a SoundFont".into());
        }
        // Nothing of the old instrument may ring on through the new one.
        self.release_all();
        let _turn = LOADING.lock().unwrap();
        self.file = Some(path.to_path_buf());
        self.drop_plugin();
        // The sampler is the instrument again, so it takes the head of the chain back, and the
        // rewire is what reads the file in on the way.
        effects::rewire(self)
    }

    /// Reads the sampler's file into it again. Called with the node out of the path or the engine
    /// stopped, which is the one state AUSampler takes a load in: a load made while the node is
    /// initialised is answered with success and dropped, and the sampler goes on playing the sine
    /// it plays when it holds nothing at all.
    fn reload(&self) -> Result<(), String> {
        if self.plugin.is_some() {
            return Ok(());
        }
        let Some(path) = &self.file else { return Ok(()) };
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        unsafe {
            if sound_bank(path) {
                self.sampler.loadSoundBankInstrumentAtURL_program_bankMSB_bankLSB_error(
                    &url,
                    0,
                    MELODIC_BANK_MSB,
                    0,
                )
            } else {
                self.sampler.loadInstrumentAtURL_error(&url)
            }
        }
        .map_err(reason)
    }

    /// Puts a hosted Audio Unit instrument in the sampler's place, taking out whichever one played
    /// before it.
    pub fn set_plugin(&mut self, unit: Retained<AVAudioUnitMIDIInstrument>) {
        self.drop_plugin();
        let _turn = LOADING.lock().unwrap();
        unsafe { self.engine.attachNode(&unit) };
        self.plugin = Some(unit);
        // Through the effects, not straight to the mixer: the chain belongs to the instrument
        // whichever kind it is.
        let _ = effects::rewire(self);
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
        let (device, fell_back) = device::resolve(self.chosen_device.as_deref())?;
        if device == self.device && fell_back == self.fell_back {
            return Ok(());
        }
        self.play_through(device, fell_back)
    }

    pub fn set_device(&mut self, chosen: Option<String>) -> Result<(), String> {
        self.chosen_device = chosen;
        let (device, fell_back) = device::resolve(self.chosen_device.as_deref())?;
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

/// A SoundFont goes into the sampler by a call of its own, and every other kind whole.
fn sound_bank(path: &Path) -> bool {
    path.extension().is_some_and(|kind| kind.eq_ignore_ascii_case("sf2"))
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

/// Every command that touches the running graph goes through here, so nothing reaches the nodes
/// while another thread is inside them. Without a graph there is nothing to do and no error.
fn with<T>(act: impl FnOnce(&mut Graph) -> T) -> Option<T> {
    GRAPH.lock().unwrap().as_mut().map(act)
}

pub fn start() -> Result<(), String> {
    let mut graph = Graph::build()?;
    graph.start()?;
    graph.adopt();
    *GRAPH.lock().unwrap() = Some(graph);
    device::watch(devices_changed);
    static PUMPING: Once = Once::new();
    PUMPING.call_once(|| {
        std::thread::spawn(pump_forever);
    });
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
    let held = GRAPH.lock().unwrap();
    let Some(graph) = held.as_ref() else {
        return Status::unavailable("The sound engine did not start");
    };
    let mut status = match graph.chosen() {
        None => Status::unavailable("No instrument chosen"),
        Some(Chosen { name, failure: Some(failure), .. }) => {
            Status::unavailable(&format!("{name} did not load: {failure}"))
        }
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
    with(|graph| graph.release_all());
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
    GRAPH.lock().unwrap().as_mut().map_or(0.0, |graph| graph.render_peak(frames).unwrap())
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
        graph.load_file(Path::new(FIXTURE)).unwrap();
        graph.start_offline(PASS).unwrap();
        graph
    }

    /// The sine AUSampler plays when it holds no instrument at all. Every test here that hears the
    /// fixture is worth only the difference between the two sounds, so it has a name.
    fn the_samplers_own_sine() -> f32 {
        let mut graph = Graph::build().unwrap();
        graph.start_offline(PASS).unwrap();
        note_peak(&mut graph)
    }

    /// Plays a note and lets it go again, answering how loud it was. Two instruments differ in
    /// that number, which is all a test needs to tell one from the other.
    fn note_peak(graph: &mut Graph) -> f32 {
        graph.note_on(60, 100);
        let peak = graph.render_peak(LOOK).unwrap();
        graph.release_all();
        graph.render_peak(LOOK).unwrap();
        peak
    }

    fn preview_note(midi: u8, on: f64, off: f64) -> PreviewNote {
        PreviewNote { midi, velocity: 100, on, off }
    }

    /// Renders one pass at a time and hands back the first one that made a sound.
    fn first_sounding_pass(graph: &mut Graph, passes: u32) -> Option<u32> {
        (0..passes).find(|_| graph.render_peak(PASS).unwrap() > 0.01)
    }

    /// The one test that plays out of the real output device, in the order the app boots, so that
    /// a human can hear what no assertion here can tell: that the piano is a piano and that the
    /// metronome clicks. Run it with `cargo test -- --ignored the_boot_order` and listen.
    #[test]
    #[ignore]
    fn the_boot_order_on_this_mac_plays_a_piano_and_then_a_bar_of_clicks() {
        let graph = Graph::build().unwrap();
        graph.start().unwrap();
        install(graph);

        set_output_device(None).unwrap();
        set_buffer_frames(DEFAULT_FRAMES).unwrap();
        let piano = instruments("")
            .into_iter()
            .find(|one| one.name == "Concert Grand Piano")
            .expect("Logic's Concert Grand Piano is on this Mac");
        load_instrument(&piano.id, None).unwrap();
        set_chain(Vec::new()).unwrap();
        assert!(status().available, "{}", status().reason);

        for midi in [60, 64, 67] {
            note(midi, 90, true);
        }
        sleep(Duration::from_millis(2500));
        for midi in [60, 64, 67] {
            note(midi, 0, false);
        }
        sleep(Duration::from_millis(500));
        for beat in 0..4 {
            click(beat == 0, 70);
            sleep(Duration::from_millis(500));
        }
    }

    #[test]
    fn the_fixture_loads_and_an_untouched_graph_is_silent() {
        let mut graph = offline();
        assert_eq!(graph.render_peak(LOOK).unwrap(), 0.0);
    }

    /// The app loads its instrument into an engine that has been running since boot, and AUSampler
    /// takes a load in that state without a word and goes on playing its own sine.
    #[test]
    fn a_file_loaded_into_a_running_graph_is_what_sounds() {
        let mut graph = Graph::build().unwrap();
        graph.start_offline(PASS).unwrap();
        graph.load_file(Path::new(FIXTURE)).unwrap();

        let peak = note_peak(&mut graph);
        assert!(peak > 0.01, "the fixture sounds");
        assert_ne!(peak, the_samplers_own_sine(), "and it is the fixture, not the empty sampler");
    }

    /// Both settings put the sampler's node together again, and AUSampler drops its instrument
    /// every time one is: the Audio dialog would otherwise turn the piano back into the sine.
    #[test]
    fn the_instrument_lives_through_a_restart_and_a_change_of_the_chain() {
        let sine = the_samplers_own_sine();
        let mut graph = offline();
        assert_ne!(note_peak(&mut graph), sine, "the fixture is what plays");

        // What a change of output device or buffer does underneath the graph.
        unsafe { graph.engine.stop() };
        graph.start().unwrap();
        assert_ne!(note_peak(&mut graph), sine, "and after the engine has been round again");

        effects::apply(&mut graph, vec![crate::audio::Slot {
            id: "aufx:rvb2:appl".into(),
            name: String::new(),
            bypass: true,
            state: String::new(),
            missing: false,
        }]);
        assert_ne!(note_peak(&mut graph), sine, "and after the chain changed under it");
    }

    /// Every output device and buffer setting stops and starts the engine, and the app applies one
    /// of each at boot, so the click has to live through it.
    #[test]
    fn the_click_sounds_after_the_engine_has_stopped_and_started() {
        let mut graph = offline();
        unsafe { graph.engine.stop() };
        graph.start().unwrap();

        graph.click(true, 100);
        assert!(graph.render_peak(LOOK).unwrap() > 0.01);
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

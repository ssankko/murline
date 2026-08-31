//! The sound engine on macOS: one AVAudioEngine graph with two ways to make the instrument's
//! sound and a player node for the metronome click, all into the main mixer and out to the device.
//! An instrument file, EXS or SoundFont, plays through the app's own voice engine behind a source
//! node; a hosted Audio Unit plays through itself. Every entry point the command surface and the
//! tests use is a method on `Graph`; the app keeps one of them in `GRAPH` for as long as it runs.
//!
//! One thing here runs on the audio thread: the source node's render block, which owns the voice
//! engine and the Preview's clock and takes the orders for both through channels. Everything else
//! is host-side work AVFAudio documents as safe off that thread.

mod effects;
pub use effects::{chain, effects, set_chain, show_effect};

use crate::audio::device::{self, DeviceId};
use crate::audio::preview::{Event, HELD, PreviewNote, Scheduler};
use crate::audio::sampler::{self, Command, Ring, engine::Sampler};
use crate::audio::{Envelope, OutputDevice, Status, load, progress};
// The instrument the graph plays, and the window a hosted plugin brings with it.
pub use crate::audio::instruments::{list as instruments, load as load_instrument};
pub use crate::audio::window::show_instrument;
use block2::RcBlock;
use objc2::AllocAnyThread;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_audio_toolbox::{
    AudioUnit, AudioUnitGetProperty, AudioUnitSetProperty, kAudioOutputUnitProperty_CurrentDevice,
    kAudioUnitManufacturer_Apple, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global,
    kAudioUnitSubType_PeakLimiter, kAudioUnitType_Effect,
};
use objc2_avf_audio::{
    AVAudioEngine, AVAudioEngineConfigurationChangeNotification, AVAudioEngineManualRenderingMode,
    AVAudioFormat, AVAudioFrameCount, AVAudioMixerNode, AVAudioMixing, AVAudioNode,
    AVAudioPCMBuffer, AVAudioPlayerNode, AVAudioSourceNode, AVAudioUnitEffect,
    AVAudioUnitMIDIInstrument,
};
#[cfg(test)]
use objc2_avf_audio::AVAudioEngineManualRenderingStatus;
use objc2_core_audio_types::{AudioBuffer, AudioBufferList, AudioTimeStamp};
use objc2_foundation::{NSError, NSNotification, NSNotificationCenter, NSOperationQueue};
use std::cell::RefCell;
use std::path::Path;
use std::ptr::{NonNull, from_ref};
use std::sync::atomic::Ordering::Relaxed;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64};
use std::sync::mpsc::{Receiver, Sender, TrySendError, channel, sync_channel};
use std::sync::{Arc, Mutex, Once, Weak};
use std::thread::sleep;
use std::time::{Duration, Instant};

/// The sample rate the graph starts at, until the setting moves it to one of `RATE_CHOICES`.
const RATE: f64 = 44100.0;
/// The sample rates the dialog offers, which the voice engine renders at and the device is asked
/// to run at. Every voice costs the engine in proportion: 96 kHz is twice the render load of 48.
const RATE_CHOICES: [u32; 4] = [44100, 48000, 88200, 96000];
/// Length of one click, short enough to read as a tick and not as a pitch.
const CLICK_MS: f64 = 30.0;
/// The weak click's pitch, and the strong one a fifth above it so the bar line stands out.
const WEAK_HZ: f64 = 1600.0;
const STRONG_HZ: f64 = 2400.0;
/// Peak of a weak click at full volume, and the little extra a strong one gets.
const WEAK_PEAK: f32 = 0.3;
const STRONG_PEAK: f32 = 0.4;

/// What a file instrument answers a key with until the webview sends the one kept for it: a plain
/// hold, the recorded sample carrying its own decay, and a release short enough to read as a
/// damper falling.
const FILE_ENVELOPE: Envelope = Envelope { attack: 0.0, decay: 0.0, sustain: 1.0, release: 0.3 };

/// How many voices the engine may hold sounding at once, as the dialog offers them, and the one
/// the app starts at. A key is not a voice: an EXS layers its zones, so one key of the Studio
/// Grand sounds three mic sets and, under the pedal, three sympathetic zones beside them, and its
/// key-up sounds six more. Ten keys held and let go reach about 126. Twice the limit in ring slots
/// is allocated with the instrument, at 256 KB each, so an EXS costs 64 MB of streaming buffers at
/// 128 voices and 256 MB at 512.
const VOICE_CHOICES: [usize; 3] = [128, 256, sampler::engine::MOST_VOICES];
const DEFAULT_VOICES: usize = 128;

/// The MIDI channel everything the app plays goes out on.
const CHANNEL: u8 = 0;
/// Controller numbers: the sustain pedal, and the two panics that end a note however it was started.
const SUSTAIN: u8 = 64;
const ALL_SOUND_OFF: u8 = 120;
const ALL_NOTES_OFF: u8 = 123;

/// The buffer the app starts at, of the sizes the dialog offers.
const DEFAULT_FRAMES: u32 = 64;
/// The velocity remap the engine starts with: the whole range in, the whole range out, straight.
/// Out of the box the app hands back exactly what the keyboard sent.
const DEFAULT_MIN: u8 = 1;
const DEFAULT_MAX: u8 = 127;
const DEFAULT_CURVE: f64 = 1.0;

/// The longest the graph waits for the output device's first render before it starts the click
/// player on it.
const FIRST_RENDER: Duration = Duration::from_secs(2);
/// Idle wakes are what a press of play waits for, so they stay short enough not to be felt.
const IDLE: Duration = Duration::from_millis(20);
/// About thirty progress events a second, which is what the moving bar highlight needs.
const PROGRESS: Duration = Duration::from_millis(33);
/// Four render-load events a second: fast enough for the status bar to read as live, slow enough
/// that the number stands still long enough to be read.
const LOAD: Duration = Duration::from_millis(250);
/// Preview events the render block may leave waiting for a hosted plugin, and how many the
/// reporter takes out of the ring at a time. A wake behind schedule empties it over several turns.
const PREVIEW_RING: usize = 1024;
const PREVIEW_BATCH: usize = 64;

/// What the Preview's scheduler, which lives in the render block, is told to do.
enum Preview {
    Load(Vec<PreviewNote>),
    Play,
    Pause,
    Seek(f64),
    Rate(u32),
    Stop,
}

/// The Preview across the audio thread: what the render block publishes about the playback, which
/// instrument its events belong to, and the ring a hosted plugin's notes leave the block by.
struct Shared {
    /// Where the playback stands, as `f64::to_bits`.
    seconds: AtomicU64,
    playing: AtomicBool,
    /// True while the voice engine holds the instrument, so the block plays the events into it;
    /// false while a plugin does, and they go out through `notes` for the reporter to start.
    file: AtomicBool,
    notes: Ring<Event>,
}

/// What the render block reports about its own work, written at the end of every call and read by
/// the reporter thread: the voices sounding, and the block's own wall time as a percent of the
/// time the buffer it filled will take to play.
#[derive(Default)]
struct Meters {
    voices: AtomicU32,
    load: AtomicU32,
}

/// The one graph the app plays through, empty until `start` builds it.
pub(super) static GRAPH: Mutex<Option<Graph>> = Mutex::new(None);
/// Building an Audio Unit and initialising it both open files and start code up inside CoreAudio,
/// which two at once in one process do not survive, so every one of them takes its turn here.
/// Starting a graph counts as one: a hosted unit reads its own samples in as the engine
/// initialises the node.
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
    /// The node the app's own voice engine plays through: its render block holds the voices and
    /// pulls the commands below out of the channel on the audio thread.
    source: Retained<AVAudioSourceNode>,
    commands: Sender<Command>,
    /// Where the voice engine hands back the instruments it has stopped playing. Draining it drops
    /// the last reference, and with it the sample memory map, off the audio thread.
    // ponytail: a dead instrument sits here until the next load drains it, which costs its heads
    // and its rings; drain on a timer if that is ever too long to wait.
    graveyard: Receiver<Arc<sampler::Instrument>>,
    /// The rings of a streamed instrument, held weakly only to count the underruns.
    streaming: Option<Weak<sampler::Stream>>,
    /// True while the voice engine holds an instrument file, false while a plugin plays instead.
    file: bool,
    /// The roles beside the tone the loaded instrument has zones for, which is what the webview
    /// offers a toggle for. Empty while a plugin or a file without them plays.
    roles: Vec<sampler::Role>,
    /// The hosted Audio Unit instrument, when the choice is a plugin instead of a file. It plays
    /// in the voice engine's place, whose node stays in the graph, silent.
    plugin: Option<Retained<AVAudioUnitMIDIInstrument>>,
    clicker: Retained<AVAudioPlayerNode>,
    /// The keyboard volume, a gain the whole instrument path runs through on its way to the mixer.
    /// It sits after the effects on purpose: a trim before them would change what a compressor or
    /// a reverb is given and so change how the instrument answers the hands, which is the one
    /// thing turning the volume down must not do. The click does not pass through it.
    fader: Retained<AVAudioMixerNode>,
    /// Apple's peak limiter, last before the mixer, at its own defaults. The keyboard volume goes
    /// up to twice unity, so a loud instrument turned up would otherwise reach the device above
    /// full scale and clip there.
    limiter: Retained<AVAudioUnitEffect>,
    format: Retained<AVAudioFormat>,
    /// The rate the voice engine renders at, which is the format's.
    rate: f64,
    /// The rate the loaded file's samples were recorded at; 0 for a plugin or nothing.
    instrument_rate: f64,
    strong: Retained<AVAudioPCMBuffer>,
    weak: Retained<AVAudioPCMBuffer>,
    /// The effects between the instrument and the mixer, in the order they play.
    chain: Vec<effects::Held>,
    /// The envelope the voice engine was last given, which is what the panel shows. A load puts
    /// the file default back, and the webview sends the one kept for the instrument over it.
    envelope: Option<Envelope>,
    /// Frames one offline render pass may take at most, zero while the graph plays to a device.
    offline_frames: u32,
    /// The instrument the user picked, which is what makes the engine playable.
    chosen: Option<Chosen>,
    /// The device the user picked, kept as its UID even while it is unplugged so that plugging it
    /// back in takes it up again. None is the system default.
    chosen_device: Option<String>,
    /// Where the device facts come from: CoreAudio's HAL when the app runs, a table in a test.
    devices: Arc<dyn device::Devices>,
    /// The device actually playing and everything about it, read again at every device and buffer
    /// change, so the status costs no property read.
    output: device::Output,
    /// The buffer the user picked. What the device runs may differ, and the status reports that.
    wanted_frames: u32,
    /// The voices the user picked, which is both the engine's limit and half the ring slots a file
    /// instrument is read in with.
    voices: usize,
    /// The velocity remap: the output the lightest strike lands on, the output the hardest lands
    /// on, and the exponent of the path between them.
    velocity_min: u8,
    velocity_max: u8,
    velocity_curve: f64,
    /// Preview operations on their way to the scheduler inside the render block.
    previews: Sender<Preview>,
    /// Note lists the render block has finished with, so they are freed here and not on the audio
    /// thread. Drained at every operation, the way `graveyard` is at every load.
    played: Receiver<Vec<PreviewNote>>,
    preview: Arc<Shared>,
    meters: Arc<Meters>,
}

// AVFAudio's classes carry no main-thread requirement, and every call into one goes through the
// mutex around the graph, so no two threads are ever inside the same object at once.
unsafe impl Send for Graph {}

impl Graph {
    /// The nodes, attached and connected, with the engine not yet started. A caller picks realtime
    /// or offline rendering next, because the choice cannot be made after the start.
    pub fn build() -> Result<Self, String> {
        Graph::over(Arc::new(device::Hal))
    }

    /// The same graph over a device source of the caller's choosing, which is how a test plays
    /// through a table rather than through the machine's own hardware.
    pub fn over(devices: Arc<dyn device::Devices>) -> Result<Self, String> {
        unsafe {
            let format = stereo(RATE)?;
            let engine = AVAudioEngine::new();
            let clicker = AVAudioPlayerNode::new();
            let fader = AVAudioMixerNode::new();
            let limiter = AVAudioUnitEffect::initWithAudioComponentDescription(
                AVAudioUnitEffect::alloc(),
                effects::description(
                    kAudioUnitType_Effect,
                    kAudioUnitSubType_PeakLimiter,
                    kAudioUnitManufacturer_Apple,
                ),
            );
            let preview = Arc::new(Shared {
                seconds: AtomicU64::new(0),
                playing: AtomicBool::new(false),
                file: AtomicBool::new(false),
                notes: Ring::new(PREVIEW_RING),
            });
            let meters = Arc::new(Meters::default());
            let Wired { source, commands, graveyard, previews, played } =
                source_node(&format, RATE, preview.clone(), meters.clone());
            engine.attachNode(&source);
            engine.attachNode(&clicker);
            engine.attachNode(&fader);
            engine.attachNode(&limiter);
            let mixer = engine.mainMixerNode();
            // The instrument end of this is rewired whenever the chain changes; the fader's own
            // way out through the limiter never is, so setting the volume touches no connection.
            engine.connect_to_format(&source, &fader, Some(&format));
            engine.connect_to_format(&fader, &limiter, Some(&format));
            engine.connect_to_format(&limiter, &mixer, Some(&format));
            engine.connect_to_format(&clicker, &mixer, Some(&format));
            Ok(Graph {
                strong: blip(&format, RATE, STRONG_HZ, STRONG_PEAK)?,
                weak: blip(&format, RATE, WEAK_HZ, WEAK_PEAK)?,
                format,
                rate: RATE,
                instrument_rate: 0.0,
                engine,
                source,
                commands,
                graveyard,
                streaming: None,
                file: false,
                roles: Vec::new(),
                plugin: None,
                clicker,
                fader,
                limiter,
                chain: Vec::new(),
                envelope: None,
                offline_frames: 0,
                chosen: None,
                chosen_device: None,
                devices,
                output: device::Output::default(),
                wanted_frames: DEFAULT_FRAMES,
                voices: DEFAULT_VOICES,
                velocity_min: DEFAULT_MIN,
                velocity_max: DEFAULT_MAX,
                velocity_curve: DEFAULT_CURVE,
                previews,
                played,
                preview,
                meters,
            })
        }
    }

    /// Starts the graph on the output device.
    pub fn start(&self) -> Result<(), String> {
        let _turn = LOADING.lock().unwrap();
        unsafe {
            self.engine.prepare();
            self.engine.startAndReturnError().map_err(reason)?;
            // A player told to play before the output has rendered once raises inside AVFAudio,
            // and the device takes anything up to a second to its first cycle, so the render is
            // waited for. An output that never renders is left to the player to complain about.
            let output = self.engine.outputNode();
            let deadline = Instant::now() + FIRST_RENDER;
            while output.lastRenderTime().is_none() && Instant::now() < deadline {
                sleep(Duration::from_millis(5));
            }
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
        Ok(self.render_frames(frames)?.iter().fold(0f32, |top, one| top.max(one.abs())))
    }

    /// The left channel of what the offline graph renders, frame by frame, for the tests that read
    /// the shape of a note rather than its loudness.
    #[cfg(test)]
    fn render_frames(&mut self, frames: u32) -> Result<Vec<f32>, String> {
        let mut taken = Vec::with_capacity(frames as usize);
        unsafe {
            let format = self.engine.manualRenderingFormat();
            let buffer = AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
                AVAudioPCMBuffer::alloc(),
                &format,
                self.offline_frames,
            )
            .ok_or("The render buffer could not be made")?;
            let render = self.engine.manualRenderingBlock();
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
                let samples = (*buffer.floatChannelData()).as_ptr();
                for frame in 0..rendered as usize {
                    taken.push(samples.add(frame).read());
                }
                left -= rendered.min(left);
            }
            Ok(taken)
        }
    }

    /// Reads an instrument file and hands it to the voice engine: a SoundFont whole, an EXS as the
    /// head of each zone with a reader behind it. Everything that can fail happens before anything
    /// is switched over, so a file that will not read leaves the instrument playing where it was.
    /// Reads from disk, so never from the audio thread.
    pub fn load_file(&mut self, path: &Path) -> Result<(), String> {
        let instrument = Arc::new(if sound_bank(path) {
            sampler::sf2::read(path)?
        } else {
            // One ring per voice slot, which is what the engine sounds at once plus the spares its
            // steals fade out through.
            sampler::disk::load(&sampler::exs::read(path)?, self.voices * 2)?
        });
        // Weakly, so unloading the instrument still stops its reader thread.
        self.streaming = instrument.stream.as_ref().map(Arc::downgrade);
        // Nothing of the old instrument may ring on through the new one.
        self.release_all();
        self.load_instrument(instrument)
    }

    /// Frames the voice engine wanted from the disk and did not have in time, over the life of the
    /// instrument playing. Zero is the only good number; the hardware tests read it.
    #[allow(dead_code)]
    pub fn underruns(&self) -> u64 {
        self.streaming.as_ref().and_then(Weak::upgrade).map_or(0, |stream| stream.underruns())
    }

    /// Puts an instrument straight into the voice engine and gives its node the head of the chain,
    /// taking out whichever instrument held it. The envelope is the one every file starts on until
    /// the webview sends the one kept for this instrument.
    pub(super) fn load_instrument(
        &mut self,
        instrument: Arc<sampler::Instrument>,
    ) -> Result<(), String> {
        self.drop_plugin();
        self.bury();
        self.file = true;
        self.preview.file.store(true, Relaxed);
        self.envelope = Some(FILE_ENVELOPE);
        self.instrument_rate = instrument.samples.first().map_or(0.0, |sample| sample.rate);
        self.roles = [
            sampler::Role::Release,
            sampler::Role::KeyOff,
            sampler::Role::Sympathetic,
            sampler::Role::PedalNoise,
        ]
        .into_iter()
        .filter(|&role| instrument.zones.iter().any(|zone| zone.role == role))
        .collect();
        self.send(Command::Load(instrument));
        self.send(Command::Envelope(FILE_ENVELOPE));
        effects::rewire(self);
        Ok(())
    }

    /// Takes the instrument out of the voice engine, which is what leaves it silent while a plugin
    /// plays.
    fn unload_exs(&mut self) {
        if !self.file {
            return;
        }
        self.file = false;
        self.preview.file.store(false, Relaxed);
        self.roles.clear();
        self.instrument_rate = 0.0;
        self.send(Command::Unload);
        self.bury();
    }

    /// Drops whatever instrument the voice engine has handed back, off the audio thread.
    fn bury(&self) {
        while self.graveyard.try_recv().is_ok() {}
    }

    /// One order to the voice engine, taken up at its next render. Nothing waits for it: the
    /// channel is unbounded and the engine reads it dry every buffer.
    fn send(&self, command: Command) {
        let _ = self.commands.send(command);
    }

    /// What the instrument answers a key with now: the last envelope the voice engine was given.
    /// Nothing while a plugin is playing, which shapes its notes behind its own window.
    pub fn envelope(&self) -> Option<Envelope> {
        self.envelope.filter(|_| self.plugin.is_none())
    }

    /// Sets it, and remembers it so the panel shows what is playing. The voice engine takes it at
    /// the next buffer, and every note struck from there on follows it.
    pub fn set_envelope(&mut self, want: Envelope) {
        self.envelope = Some(want);
        self.send(Command::Envelope(want));
    }

    /// Puts a hosted Audio Unit instrument in the voice engine's place, taking out whichever one
    /// played before it.
    pub fn set_plugin(&mut self, unit: Retained<AVAudioUnitMIDIInstrument>) {
        self.envelope = None;
        self.drop_plugin();
        self.unload_exs();
        let _turn = LOADING.lock().unwrap();
        unsafe { self.engine.attachNode(&unit) };
        self.plugin = Some(unit);
        // Through the effects, not straight to the mixer: the chain belongs to the instrument
        // whichever kind it is.
        effects::rewire(self);
    }

    fn drop_plugin(&mut self) {
        if let Some(old) = self.plugin.take() {
            unsafe { self.engine.detachNode(&old) };
            release_on_main(old);
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

    /// Where the MIDI goes: the hosted plugin, the one instrument that takes notes rather than
    /// commands. The voice engine has nothing here, so every caller checks `file` first.
    fn target(&self) -> Option<&AVAudioUnitMIDIInstrument> {
        self.plugin.as_deref()
    }

    /// The node the instrument's sound comes out of, which is what the effect chain starts from.
    fn head(&self) -> &AVAudioNode {
        match &self.plugin {
            Some(plugin) => plugin,
            None => &self.source,
        }
    }

    /// The output unit AVAudioEngine plays through, which is where the device is chosen.
    fn output_unit(&self) -> AudioUnit {
        unsafe { self.engine.outputNode().audioUnit() }
    }

    /// Reads back the device the engine started on, so the status has an answer before the first
    /// setting is applied.
    fn adopt(&mut self) {
        self.output = self.devices.describe(current_device(self.output_unit()).unwrap_or(0));
    }

    /// Reads the device again, which is what a buffer or rate write moves, keeping the line saying
    /// why it is the device playing.
    fn reread(&mut self) {
        let fallback = std::mem::take(&mut self.output.fallback);
        self.output = self.devices.describe(self.output.id);
        self.output.fallback = fallback;
    }

    /// Moves the whole graph to `output`. Nothing is left sounding: the notes go first, and the
    /// engine has to stop before the output unit will take a different device.
    fn play_through(&mut self, output: device::Output) -> Result<(), String> {
        // Already playing through it: the move is only about which device, so nothing is torn down.
        if output.id == self.output.id && self.running() {
            self.output = output;
            return Ok(());
        }
        self.release_all();
        unsafe { self.engine.stop() };
        // A graph in manual rendering mode plays into the caller's buffer and has no output device
        // to point; the value it keeps is still the device the status reports.
        if self.offline_frames == 0 {
            set_current_device(self.output_unit(), output.id).map_err(|status| {
                format!("{} could not be played through (status {status})", output.name)
            })?;
        }
        self.output = output;
        // A device that will not take the buffer keeps its own; the move itself still stands, and
        // the status reports the size actually running.
        let _ = self.apply_buffer();
        self.start()
    }

    /// Takes the device list as it now is: stays put when the choice still resolves to the device
    /// playing, moves to the system default when the chosen device has gone, and moves back to the
    /// chosen device when it returns. A graph that has stopped is started again even when the
    /// device it plays through has not changed, because AVAudioEngine stops itself whenever the
    /// output hardware changes under it and never starts itself back up.
    pub fn follow_devices(&mut self) -> Result<(), String> {
        let output = self.devices.open(self.chosen_device.as_deref())?;
        if output.id == self.output.id && output.fallback == self.output.fallback && self.running()
        {
            self.output = output;
            return Ok(());
        }
        self.play_through(output)
    }

    fn running(&self) -> bool {
        unsafe { self.engine.isRunning() }
    }

    pub fn set_device(&mut self, chosen: Option<String>) -> Result<(), String> {
        self.chosen_device = chosen;
        let output = self.devices.open(self.chosen_device.as_deref())?;
        self.play_through(output)
    }

    /// Asks for `frames`, one of the sizes the dialog offers. A device that does not take the size
    /// gets the nearest one it does, so a saved size from another device never breaks the one
    /// playing.
    pub fn set_buffer(&mut self, frames: u32) -> Result<(), String> {
        if !device::FRAME_CHOICES.contains(&frames) {
            return Err(format!("{frames} frames is not one of 32, 64, 128, 256 and 512"));
        }
        self.wanted_frames = frames;
        // The device is on that size already, so there is nothing to restart the IO for.
        if self.nearest_buffer() == Some(self.output.frames) {
            return Ok(());
        }
        self.release_all();
        // The device restarts its own IO around the change, so the graph stops first and what would
        // have been a half-rendered buffer is silence instead.
        unsafe { self.engine.stop() };
        let applied = self.apply_buffer();
        self.start()?;
        applied
    }

    /// The voices the engine may hold sounding at once. The pool empties, so everything sounding
    /// stops; the ring slots of a file instrument are allocated with it, so the caller loads the
    /// instrument again for the new count to reach the streaming too.
    pub fn set_voices(&mut self, count: usize) -> Result<(), String> {
        if !VOICE_CHOICES.contains(&count) {
            return Err(format!("{count} voices is not one of 128, 256 and 512"));
        }
        self.voices = count;
        self.send(Command::MaxVoices(count));
        Ok(())
    }

    /// Moves the voice engine to `rate`, one of `RATE_CHOICES`. Its node renders at the rate it
    /// was built with, so a new one takes its place: everything sounding stops, the instrument
    /// leaves with the old node and the caller loads it again, and the Preview forgets its notes.
    /// The device is asked to run at the rate too, so nothing is resampled on the way out; one
    /// that will not keeps its own, and the mixer converts.
    pub fn set_sample_rate(&mut self, rate: u32) -> Result<(), String> {
        if !RATE_CHOICES.contains(&rate) {
            return Err(format!("{rate} Hz is not one of 44100, 48000, 88200 and 96000"));
        }
        if f64::from(rate) == self.rate {
            return Ok(());
        }
        self.release_all();
        unsafe { self.engine.stop() };
        self.rewire_at(f64::from(rate))?;
        // A device that lists the rate is moved to it, so nothing is resampled on the way out;
        // one that does not keeps its own, and the mixer converts.
        let asked = if self.output.runs_at(f64::from(rate)) {
            self.devices.set_rate(self.output.id, f64::from(rate))
        } else {
            Ok(())
        };
        self.reread();
        self.start()?;
        asked
    }

    /// Builds the voice engine's node at `rate` in the old one's place, with the graph stopped,
    /// and connects the way to the mixer again in the new format.
    fn rewire_at(&mut self, rate: f64) -> Result<(), String> {
        let format = stereo(rate)?;
        self.unload_exs();
        let _turn = LOADING.lock().unwrap();
        let Wired { source, commands, graveyard, previews, played } =
            source_node(&format, rate, self.preview.clone(), self.meters.clone());
        unsafe {
            self.engine.detachNode(&self.source);
            self.engine.attachNode(&source);
            let mixer = self.engine.mainMixerNode();
            self.engine.connect_to_format(&self.fader, &self.limiter, Some(&format));
            self.engine.connect_to_format(&self.limiter, &mixer, Some(&format));
            self.engine.connect_to_format(&self.clicker, &mixer, Some(&format));
        }
        self.strong = blip(&format, rate, STRONG_HZ, STRONG_PEAK)?;
        self.weak = blip(&format, rate, WEAK_HZ, WEAK_PEAK)?;
        self.source = source;
        self.commands = commands;
        self.graveyard = graveyard;
        self.previews = previews;
        self.played = played;
        self.format = format;
        self.rate = rate;
        self.send(Command::MaxVoices(self.voices));
        effects::rewire(self);
        Ok(())
    }

    /// The size the device is asked for: the wanted one, else the smallest it takes above it,
    /// else the largest it takes.
    fn nearest_buffer(&self) -> Option<u32> {
        let choices = &self.output.buffers;
        choices.iter().find(|&&frames| frames >= self.wanted_frames).or(choices.last()).copied()
    }

    /// Writes the buffer the device is to run and reads the device again, since what it ends up
    /// running is its own answer.
    fn apply_buffer(&mut self) -> Result<(), String> {
        let asked = match self.nearest_buffer() {
            Some(frames) => self.devices.set_frames(self.output.id, frames),
            None => Err(format!("{} takes none of the buffer sizes", self.output.name)),
        };
        self.reread();
        for unit in [self.output_unit(), unsafe { self.limiter.audioUnit() }] {
            raise_max_frames(unit, self.output.frames);
        }
        asked
    }

    /// What the Audio dialog shows about the output, copied from the device value the graph keeps.
    fn describe_output(&self, status: &mut Status) {
        status.device.clone_from(&self.output.uid);
        status.device_name.clone_from(&self.output.name);
        status.fallback.clone_from(&self.output.fallback);
        status.buffer_frames = self.output.frames;
        status.buffer_choices.clone_from(&self.output.buffers);
        status.sample_rate = self.output.rate;
        status.latency_ms = self.output.latency_ms;
    }

    /// Plays the note and answers the output velocity it was played at, which is the velocity the
    /// rest of the app works in. The remap happens here and only here, so a caller that needs the
    /// output takes it from the return rather than mapping a second time.
    pub fn note_on(&self, note: u8, velocity: u8) -> u8 {
        let velocity = curved(velocity, self.velocity_min, self.velocity_max, self.velocity_curve);
        self.strike(note, velocity);
        velocity
    }

    /// Plays the note at the velocity given, with no remap: for a caller holding an output velocity
    /// already, which the curve would squeeze into the band a second time.
    pub fn strike(&self, note: u8, velocity: u8) {
        if self.file {
            self.send(Command::NoteOn { note, velocity });
        } else if let Some(unit) = self.target() {
            unsafe { unit.startNote_withVelocity_onChannel(note, velocity, CHANNEL) };
        }
    }

    /// The velocity remap: `min` and `max` are the output velocities the lightest and the hardest
    /// strike land on, `curve` the exponent of the path between them. Nothing is reconnected and no
    /// voice is flushed, so the user can move any of them while playing and hear the next strike
    /// answer.
    pub fn set_velocity_curve(&mut self, min: u32, max: u32, curve: f64) {
        self.velocity_min = min.clamp(1, 127) as u8;
        self.velocity_max = max.clamp(1, 127) as u8;
        self.velocity_curve = if curve > 0.0 { curve } else { DEFAULT_CURVE };
    }

    pub fn note_off(&self, note: u8) {
        if self.file {
            self.send(Command::NoteOff { note });
        } else if let Some(unit) = self.target() {
            unsafe { unit.stopNote_onChannel(note, CHANNEL) };
        }
    }

    /// The sustain pedal. A note let go while it is down keeps sounding until it comes up.
    pub fn sustain(&self, down: bool) {
        if self.file {
            self.send(Command::Sustain(down));
        } else {
            self.controller(SUSTAIN, if down { 127 } else { 0 });
        }
    }

    /// How loud one of the noises around the tone sounds, as a percent of the sample. The tone has
    /// no level, and a hosted plugin makes its noises behind its own window, so this reaches only
    /// the sampler.
    pub fn set_role_level(&self, role: sampler::Role, percent: u32) {
        self.send(Command::RoleLevel { role, level: percent.min(100) as f32 / 100.0 });
    }

    /// Ends everything sounding, pedal included: what a stopped play and a lost MIDI port send.
    pub fn release_all(&self) {
        if self.file {
            self.send(Command::AllOff);
            return;
        }
        self.controller(SUSTAIN, 0);
        self.controller(ALL_NOTES_OFF, 0);
        self.controller(ALL_SOUND_OFF, 0);
    }

    fn controller(&self, controller: u8, value: u8) {
        if let Some(unit) = self.target() {
            unsafe { unit.sendController_withValue_onChannel(controller, value, CHANNEL) };
        }
    }

    /// The Preview's note list, in seconds at the score's own tempo and at the output velocities
    /// the curve maps its notes to. The curve is read here and only here, so one changed while a
    /// piece plays is heard from the next load on.
    pub fn preview_load(&self, mut notes: Vec<PreviewNote>) {
        for note in &mut notes {
            note.velocity =
                curved(note.velocity, self.velocity_min, self.velocity_max, self.velocity_curve);
        }
        self.tell(Preview::Load(notes));
        self.release_all();
    }

    pub fn preview_play(&self) {
        self.tell(Preview::Play);
    }

    pub fn preview_pause(&self) {
        self.tell(Preview::Pause);
        self.release_all();
    }

    pub fn preview_seek(&self, seconds: f64) {
        self.tell(Preview::Seek(seconds));
        self.release_all();
    }

    pub fn preview_rate(&self, percent: u32) {
        self.tell(Preview::Rate(percent));
        self.release_all();
    }

    /// Stops and forgets the note list: what leaving the Preview sends.
    pub fn preview_stop(&self) {
        self.tell(Preview::Stop);
        self.release_all();
    }

    /// One operation for the render block's scheduler, and with it the freeing of whatever note
    /// list the block has handed back.
    fn tell(&self, operation: Preview) {
        while self.played.try_recv().is_ok() {}
        let _ = self.previews.send(operation);
    }

    /// Where the playback stands and whether it runs, as the render block last published it.
    fn preview_progress(&self) -> (f64, bool) {
        (f64::from_bits(self.preview.seconds.load(Relaxed)), self.preview.playing.load(Relaxed))
    }

    /// Plays one Preview event on the hosted plugin. Its velocity has already been through the
    /// curve, so nothing is remapped here.
    fn play_preview(&self, event: Event) {
        if let Some(unit) = self.target() {
            unsafe {
                if event.on {
                    unit.startNote_withVelocity_onChannel(event.midi, event.velocity, CHANNEL);
                } else {
                    unit.stopNote_onChannel(event.midi, CHANNEL);
                }
            }
        }
    }

    /// The keyboard volume, 0 to 200: a gain on the finished sound, set in place, where 100 is
    /// unity and anything above it amplifies. Nothing is reconnected, because any connection change
    /// flushes every voice the graph has sounding and would cut a ringing note off at the moment
    /// the fader moved.
    pub fn set_keyboard_volume(&self, percent: u32) {
        unsafe { self.fader.setOutputVolume(percent.min(200) as f32 / 100.0) };
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

/// Input velocity to output velocity: velocity 1 lands on `min`, velocity 127 lands on `max`, and
/// the exponent bends the path between them. Nothing is clamped, because every input already lands
/// inside the two ends. Velocity 0 stays 0, a note on at zero velocity being a note off to every
/// instrument.
///
/// This is the velocity the whole app works in, the instrument and the grade alike, not the sound
/// alone. An exponent above 1 makes soft playing softer and the keyboard harder to fill out, below
/// 1 the other way, and exactly 1 is a straight line between the two ends.
fn curved(velocity: u8, min: u8, max: u8, exponent: f64) -> u8 {
    if velocity == 0 {
        return 0;
    }
    let (min, max) = (f64::from(min), f64::from(max));
    let along = f64::from(velocity - 1) / 126.0;
    (min + (max - min) * along.powf(exponent)).round() as u8
}

/// Hands the last reference to a hosted plugin to the main thread, which is the one thread a
/// plugin is taken apart on. A switch of instrument or of the chain runs on the thread the command
/// came in on, and a plugin freed there is freed while AppKit may be draining the teardown of the
/// window that same plugin drew: two threads then run one plugin's own dealloc, and a plugin whose
/// editor and instance share objects frees them twice over and takes the app down. Apple documents
/// no thread for either side, so the app takes the one AppKit already tears windows down on.
/// Nothing waits for this; the plugin is gone by the next turn of the main run loop.
pub(super) fn release_on_main<T: objc2::Message + 'static>(unit: Retained<T>) {
    let leaving = std::cell::RefCell::new(Some(unit));
    let let_go = RcBlock::new(move || drop(leaving.borrow_mut().take()));
    unsafe { NSOperationQueue::mainQueue().addOperationWithBlock(&let_go) };
}

/// A SoundFont carries its samples inside it; every other kind the engine plays names files.
fn sound_bank(path: &Path) -> bool {
    path.extension().is_some_and(|kind| kind.eq_ignore_ascii_case("sf2"))
}

/// The voice engine's node. The block it is built around holds the engine and the Preview's
/// scheduler, reads the orders the graph sends both of them and writes the voices into the two
/// channels the graph asked for. It runs on the audio thread, so it takes no lock, allocates
/// nothing and says nothing: an instrument it stops playing goes down `dead` for another thread to
/// drop, and a note list it lets go of down `played`.
///
/// Deriving the Preview's clock from the frames rendered here is what keeps it on the audio clock,
/// so a note lands in the buffer its time falls in whatever the host thread is doing.
///
/// `preview` and `meters` are the reporter's too, so they carry over from one node to the next.
fn source_node(
    format: &AVAudioFormat,
    rate: f64,
    preview: Arc<Shared>,
    meters: Arc<Meters>,
) -> Wired {
    let (commands, orders) = channel();
    // Four slots, filled here so the render block's hand-back allocates nothing.
    let (dead, graveyard) = sync_channel(4);
    let (previews, operations) = channel();
    // Two slots hold a note list handed back and the one behind it, which is more than a user
    // swapping pieces can fill before the next operation drains them.
    let (finished, played) = sync_channel::<Vec<PreviewNote>>(2);
    let voices = RefCell::new(Sampler::new(rate, DEFAULT_VOICES, dead));
    let scheduler = RefCell::new(Scheduler::default());
    let events = RefCell::new(Vec::with_capacity(HELD));
    let render = RcBlock::new(
        move |silence: NonNull<Bool>,
              _when: NonNull<AudioTimeStamp>,
              frames: AVAudioFrameCount,
              output: NonNull<AudioBufferList>| {
            let entered = Instant::now();
            let mut voices = voices.borrow_mut();
            while let Ok(command) = orders.try_recv() {
                voices.apply(command);
            }

            let mut scheduler = scheduler.borrow_mut();
            while let Ok(operation) = operations.try_recv() {
                let old = match operation {
                    Preview::Load(notes) => scheduler.load(notes),
                    Preview::Stop => scheduler.load(Vec::new()),
                    Preview::Play => {
                        scheduler.play();
                        Vec::new()
                    }
                    Preview::Pause => {
                        scheduler.pause();
                        Vec::new()
                    }
                    Preview::Seek(seconds) => {
                        scheduler.seek(seconds);
                        Vec::new()
                    }
                    Preview::Rate(percent) => {
                        scheduler.set_rate(percent);
                        Vec::new()
                    }
                };
                // An empty list owns no memory and is dropped here; a real one goes out to be
                // freed elsewhere, or is leaked until the next drain when every slot is taken.
                if !old.is_empty()
                    && let Err(TrySendError::Full(kept) | TrySendError::Disconnected(kept)) =
                        finished.try_send(old)
                {
                    std::mem::forget(kept);
                }
            }

            let mut events = events.borrow_mut();
            scheduler.pump(frames, rate, &mut events);
            let file = preview.file.load(Relaxed);
            for event in events.iter() {
                if file {
                    let command = if event.on {
                        Command::NoteOn { note: event.midi, velocity: event.velocity }
                    } else {
                        Command::NoteOff { note: event.midi }
                    };
                    voices.apply(command);
                } else {
                    preview.notes.push(std::slice::from_ref(event));
                }
            }
            if scheduler.ended() {
                scheduler.stop();
                if file {
                    voices.apply(Command::AllOff);
                }
            }
            preview.seconds.store(scheduler.seconds().to_bits(), Relaxed);
            preview.playing.store(scheduler.playing(), Relaxed);

            unsafe {
                let list = output.as_ptr();
                let buffers = std::slice::from_raw_parts_mut(
                    (&raw mut (*list).mBuffers).cast::<AudioBuffer>(),
                    (*list).mNumberBuffers as usize,
                );
                // The node was built with the graph's own format, so what comes back is always the
                // two channels of non-interleaved stereo the engine renders.
                let [left, right] = buffers else { return -1 };
                let frames = frames as usize;
                voices.render(
                    std::slice::from_raw_parts_mut(left.mData.cast(), frames),
                    std::slice::from_raw_parts_mut(right.mData.cast(), frames),
                );
            }
            // Told it was given silence, an effect down the chain may skip the cycle; a reverb
            // asked to render silence a thousand times a second otherwise costs the same idle as
            // sounding.
            let active = voices.active();
            if active == 0 {
                unsafe { silence.write(Bool::YES) };
            }
            // The render load: what this call cost against the time its own buffer will play for.
            // Two relaxed stores and a clock read, so the block still allocates nothing and waits
            // on nothing.
            let playing_for = f64::from(frames) / rate;
            let share = entered.elapsed().as_secs_f64() / playing_for * 100.0;
            meters.load.store(share as u32, Relaxed);
            meters.voices.store(active as u32, Relaxed);
            0
        },
    );
    let source = unsafe {
        AVAudioSourceNode::initWithFormat_renderBlock(
            AVAudioSourceNode::alloc(),
            format,
            RcBlock::as_ptr(&render),
        )
    };
    Wired { source, commands, graveyard, previews, played }
}

/// The voice engine's node and the graph's ends of the channels into its render block.
struct Wired {
    source: Retained<AVAudioSourceNode>,
    commands: Sender<Command>,
    graveyard: Receiver<Arc<sampler::Instrument>>,
    previews: Sender<Preview>,
    played: Receiver<Vec<PreviewNote>>,
}

/// Non-interleaved float stereo at `rate`, the format every connection in the graph is made in.
fn stereo(rate: f64) -> Result<Retained<AVAudioFormat>, String> {
    unsafe {
        AVAudioFormat::initStandardFormatWithSampleRate_channels(AVAudioFormat::alloc(), rate, 2)
    }
    .ok_or_else(|| format!("Stereo audio at {rate} Hz is not available"))
}

/// One click as a buffer of samples: a sine falling to silence, because a square end would pop.
fn blip(
    format: &AVAudioFormat,
    rate: f64,
    hz: f64,
    peak: f32,
) -> Result<Retained<AVAudioPCMBuffer>, String> {
    let frames = (rate * CLICK_MS / 1000.0) as u32;
    unsafe {
        let buffer =
            AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(AVAudioPCMBuffer::alloc(), format, frames)
                .ok_or("The click buffer could not be made")?;
        buffer.setFrameLength(frames);
        let channels = buffer.floatChannelData();
        for frame in 0..frames as usize {
            let at = frame as f64 / rate;
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

fn set_current_device(unit: AudioUnit, device: DeviceId) -> Result<(), i32> {
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
    if status == 0 { Ok(()) } else { Err(status) }
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
    watch_configuration(&graph.engine);
    *GRAPH.lock().unwrap() = Some(graph);
    device::watch(devices_changed);
    static REPORTING: Once = Once::new();
    REPORTING.call_once(|| {
        std::thread::spawn(report_forever);
    });
    Ok(())
}

/// The answer to a plug, an unplug, a change of system default, and AVAudioEngine's own report
/// that the output hardware moved under it: the engine takes the new list into account, then the
/// dialog is told to read its picker again. Both callers hand this work to a thread of its own:
/// CoreAudio calls the listener on one of its threads and wants it back at once, and AVFAudio
/// documents that tearing the engine down inside its notification can deadlock.
fn devices_changed() {
    std::thread::spawn(|| {
        if let Some(graph) = GRAPH.lock().unwrap().as_mut()
            && let Err(why) = graph.follow_devices()
        {
            // The next notification tries again; until one succeeds this line is why it is silent.
            eprintln!("The sound engine could not follow the output change: {why}");
        }
        crate::audio::tell_devices_changed();
    });
}

/// AVAudioEngine stops itself when the hardware it plays through changes, an unplugged interface
/// among them, and posts this notification once it has. Without watching for it the engine can be
/// left stopped for good: CoreAudio's device-list notification arrives on its own schedule, and a
/// restart made from that one is undone by the stop that follows it. Registered once for the one
/// engine the app has, so the observer token is deliberately never dropped.
fn watch_configuration(engine: &AVAudioEngine) {
    let follow = RcBlock::new(|_: NonNull<NSNotification>| devices_changed());
    let token = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(AVAudioEngineConfigurationChangeNotification),
            Some(engine),
            None,
            &follow,
        )
    };
    std::mem::forget(token);
}

/// Reports the Preview: it tells the webview where the render block's clock stands, and starts on
/// a hosted plugin the notes the block left in the ring, an Audio Unit being no thing to call from
/// the audio thread. It also carries the render load out to the status bar, four times a second.
// ponytail: a plugin's notes are started at this thread's wake rather than at the frame they fall
// on; MusicDeviceMIDIEvent with a frame offset, sent from inside the block, is the exact upgrade.
fn report_forever() {
    let mut told = Instant::now() - PROGRESS;
    let mut metered = Instant::now() - LOAD;
    let mut reported = None;
    let mut was_playing = false;
    let mut notes = [Event::default(); PREVIEW_BATCH];
    loop {
        let Some((seconds, playing, voices, limit, share)) = with(|graph| {
            loop {
                let took = graph.preview.notes.pop(&mut notes);
                if took == 0 {
                    break;
                }
                for &event in &notes[..took] {
                    graph.play_preview(event);
                }
            }
            let (seconds, playing) = graph.preview_progress();
            (
                seconds,
                playing,
                graph.meters.voices.load(Relaxed),
                graph.voices as u32,
                graph.meters.load.load(Relaxed),
            )
        }) else {
            sleep(IDLE);
            continue;
        };
        // Only a change is told: an idle engine then wakes the webview for nothing.
        if metered.elapsed() >= LOAD && reported != Some((voices, limit, share)) {
            metered = Instant::now();
            reported = Some((voices, limit, share));
            load(voices, limit, share);
        }
        // The end of the piece is told at once, so the play button comes back without a wait.
        if (playing || was_playing) && (!playing || told.elapsed() >= PROGRESS) {
            told = Instant::now();
            progress(seconds, playing);
        }
        was_playing = playing;
        sleep(IDLE);
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
    status.instrument = graph.instrument().unwrap_or_default().into();
    status.instrument_rate = graph.instrument_rate;
    status.roles.clone_from(&graph.roles);
    graph.describe_output(&mut status);
    status
}

pub fn click(strong: bool, volume: u32) {
    with(|graph| graph.click(strong, volume));
}

pub fn set_keyboard_volume(percent: u32) {
    with(|graph| graph.set_keyboard_volume(percent));
}

pub fn set_velocity_curve(min: u32, max: u32, curve: f64) {
    with(|graph| graph.set_velocity_curve(min, max, curve));
}

pub fn envelope() -> Option<Envelope> {
    with(|graph| graph.envelope()).flatten()
}

pub fn set_envelope(want: Envelope) {
    with(|graph| graph.set_envelope(want));
}

pub fn set_role_level(role: sampler::Role, percent: u32) {
    with(|graph| graph.set_role_level(role, percent));
}

/// One key of the MIDI keyboard, down or up. Answers the output velocity the note was played at, so
/// the caller telling the webview about the strike reports the same number the instrument heard.
/// A key coming up carries the velocity it arrived with: only a note on is remapped, and `raw`
/// takes even that off, for a velocity that is already an output.
pub fn note(midi: u8, velocity: u8, on: bool, raw: bool) -> u8 {
    with(|graph| {
        match (on, raw) {
            (false, _) => graph.note_off(midi),
            (true, true) => graph.strike(midi, velocity),
            (true, false) => return graph.note_on(midi, velocity),
        }
        velocity
    })
    .unwrap_or(velocity)
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

pub fn set_voices(count: usize) -> Result<(), String> {
    with_graph(|graph| graph.set_voices(count))
}

pub fn set_sample_rate(rate: u32) -> Result<(), String> {
    with_graph(|graph| graph.set_sample_rate(rate))
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
    /// Long enough for the file envelope's release to run right out, so what a test renders after
    /// this is what a note that has finished dying away sounds like.
    const RELEASE: u32 = RATE as u32 / 2;

    /// A graph with the fixture in its voice engine, rendering to nothing but the test's own
    /// buffer.
    fn offline() -> Graph {
        let mut graph = Graph::build().unwrap();
        graph.load_file(Path::new(FIXTURE)).unwrap();
        graph.start_offline(PASS).unwrap();
        graph
    }

    /// Plays a note and lets it go again, answering how loud it was. Two instruments differ in
    /// that number, which is all a test needs to tell one from the other.
    fn note_peak(graph: &mut Graph) -> f32 {
        struck(graph, 100)
    }

    /// The same, at a velocity of the test's choosing: what one strike comes out at once the
    /// velocity remap has had it.
    fn struck(graph: &mut Graph, velocity: u8) -> f32 {
        graph.note_on(60, velocity);
        let peak = graph.render_peak(LOOK).unwrap();
        graph.release_all();
        graph.render_peak(LOOK).unwrap();
        peak
    }

    /// The note as it comes out at one fader position. A mixer ramps a volume change over the
    /// render call that follows it, so the window read is the second one.
    fn at_volume(graph: &mut Graph, percent: u32) -> f32 {
        graph.set_keyboard_volume(percent);
        // Softly, so that even twice the volume stays under the limiter and the number read here
        // is the fader's own doing and nothing else's.
        graph.note_on(60, 40);
        graph.render_peak(LOOK).unwrap();
        let peak = graph.render_peak(LOOK).unwrap();
        graph.release_all();
        graph.render_peak(LOOK).unwrap();
        peak
    }

    use crate::audio::instruments::hosted_instrument;

    /// True while something other than the test's own reference holds the plugin, which is how a
    /// switch that handed the plugin to the main thread reads from here. A switch that let go of it
    /// on this thread instead leaves the test holding the last one.
    fn still_held_elsewhere(unit: &AVAudioUnitMIDIInstrument) -> bool {
        let references: usize = unsafe { objc2::msg_send![unit, retainCount] };
        references > 1
    }

    fn preview_note(midi: u8, on: f64, off: f64) -> PreviewNote {
        PreviewNote { midi, velocity: 100, on, off }
    }

    /// Renders one pass at a time and hands back the first one that made a sound.
    fn first_sounding_pass(graph: &mut Graph, passes: u32) -> Option<u32> {
        (0..passes).find(|_| graph.render_peak(PASS).unwrap() > 0.01)
    }

    /// One click and the peak it comes out at, zero if it never sounded. The player takes a
    /// scheduled buffer onto its render side on its own time, so the graph is rendered on until
    /// the click is there, one pass more for a click that began at the end of a pass, and a look
    /// further so it has died away before the next one.
    fn click_peak(graph: &mut Graph, strong: bool, volume: u32) -> f32 {
        graph.click(strong, volume);
        let mut passes = (0..50).map(|_| graph.render_peak(PASS).unwrap());
        let Some(first) = passes.find(|&peak| peak > 0.01) else { return 0.0 };
        let peak = first.max(passes.next().unwrap_or(0.0));
        graph.render_peak(LOOK).unwrap();
        peak
    }

    /// A second of a 55 Hz sine that starts at its own peak, looped, mapped across the keyboard at
    /// the pitch it was recorded at. A voice that read it straight from the first frame would put
    /// nine tenths of full scale into the output in one frame, which is what a click is.
    fn a_sine_that_starts_at_its_peak() -> Arc<sampler::Instrument> {
        let frames = RATE as usize;
        let data: Vec<i16> = (0..frames)
            .flat_map(|frame| {
                let turn = 2.0 * std::f64::consts::PI * 55.0 * frame as f64 / RATE;
                let one = (turn.cos() * 0.9 * f64::from(i16::MAX)) as i16;
                [one, one]
            })
            .collect();
        Arc::new(sampler::Instrument::memory(
            vec![sampler::Zone {
                role: sampler::Role::Sustain,
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
                loop_: Some((0, frames)),
            }],
            vec![sampler::Sample::memory(RATE, data)],
        ))
    }

    /// The head of the chain moves between the voice engine and a plugin and back. Both stay
    /// attached, so what this hears is that only the one chosen is connected: two heads at once
    /// would sum, and a head left behind would go on sounding.
    #[test]
    fn the_head_of_the_chain_moves_between_the_voice_engine_and_a_plugin() {
        let mut graph = Graph::build().unwrap();
        graph.start_offline(PASS).unwrap();

        graph.load_instrument(a_sine_that_starts_at_its_peak()).unwrap();
        let engine = note_peak(&mut graph);
        assert!(engine > 0.01, "the voice engine sounds: {engine}");

        graph.set_plugin(hosted_instrument());
        assert!(note_peak(&mut graph) > 0.01, "the plugin takes the head");

        graph.load_instrument(a_sine_that_starts_at_its_peak()).unwrap();
        let again = note_peak(&mut graph);
        assert!((again - engine).abs() < 0.01, "the voice engine takes it back: {again}");
    }

    /// The voice engine plays through the graph, and a note off a sample that begins nowhere near
    /// zero still comes in without a step: the engine fades every voice open, and a step is what
    /// the ear hears as a click at the start of a note.
    #[test]
    fn a_note_out_of_the_voice_engine_comes_in_without_a_step() {
        let mut graph = Graph::build().unwrap();
        graph.start_offline(PASS).unwrap();
        graph.load_instrument(a_sine_that_starts_at_its_peak()).unwrap();

        graph.note_on(60, 127);
        let samples = graph.render_frames(LOOK).unwrap();
        let peak = samples.iter().fold(0f32, |top, one| top.max(one.abs()));
        assert!(peak > 0.1, "the instrument sounds at all: {peak}");

        let head = &samples[..(RATE * 0.003) as usize];
        let step = head.windows(2).fold(0f32, |top, pair| top.max((pair[1] - pair[0]).abs()));
        assert!(
            step < peak * 0.02,
            "the note opens by steps of {step} against a peak of {peak}"
        );

        graph.release_all();
    }

    /// The limiter after the fader holds the finished sound inside full scale, so a hot instrument
    /// at 200 per cent cannot arrive at the device clipped. Bypassing it says how far past full
    /// scale the same chord would otherwise go.
    #[test]
    fn the_limiter_keeps_a_loud_two_hundred_inside_full_scale() {
        let mut graph = offline();
        graph.set_keyboard_volume(200);

        let limited = loud_chord(&mut graph);
        assert!(limited <= 1.0, "the loudest sample stays inside full scale: {limited}");

        unsafe { graph.limiter.setBypass(true) };
        let raw = loud_chord(&mut graph);
        assert!(raw > 1.0, "and the limiter is what holds it: {raw} without one");
    }

    /// Two octaves struck at once and held, at their loudest: what the graph puts out over the
    /// windows that follow.
    fn loud_chord(graph: &mut Graph) -> f32 {
        for note in 48..72 {
            graph.note_on(note, 127);
        }
        let peak = (0..8).map(|_| graph.render_peak(LOOK).unwrap()).fold(0f32, f32::max);
        graph.release_all();
        graph.render_peak(LOOK).unwrap();
        peak
    }

    /// The keyboard fader sets the finished sound: the same note played twice differs by exactly
    /// what the fader was moved by, 100 is the sound untouched, 200 is twice as loud, and a fader
    /// at zero makes no sound at all.
    #[test]
    fn the_fader_sets_the_note_between_silence_and_twice_as_loud() {
        let mut graph = offline();
        let full = at_volume(&mut graph, 100);
        assert!(full > 0.01, "the fixture sounds at all: {full}");

        let quarter = at_volume(&mut graph, 25);
        assert!(quarter < full / 2.0, "a fader pulled down is quieter: {quarter} against {full}");
        assert!(
            (quarter - full / 4.0).abs() < full / 50.0,
            "and quieter by what the fader says: {quarter} against a quarter of {full}"
        );

        // Twice, to the sample: one note is far under the limiter's threshold, so the limiter that
        // sits after the fader leaves it alone.
        let double = at_volume(&mut graph, 200);
        assert!(
            (double - full * 2.0).abs() < full / 100.0,
            "a fader above 100 amplifies: {double} against twice {full}"
        );

        assert_eq!(at_volume(&mut graph, 0), 0.0, "a fader at zero is silence");
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
            note(midi, 90, true, false);
        }
        sleep(Duration::from_millis(2500));
        for midi in [60, 64, 67] {
            note(midi, 0, false, false);
        }
        sleep(Duration::from_millis(500));
        for beat in 0..4 {
            click(beat == 0, 70);
            sleep(Duration::from_millis(500));
        }
    }

    /// What a note looks like on the way out of the real device, which is the only path with the
    /// device's own buffer under it: taps the mixer, plays, and prints the attack of each note, any
    /// gap in the render timeline and the biggest jump from one sample to the next. A note that
    /// starts with a click reads as a rise to full inside a millisecond or as a jump the size of the
    /// signal; a piano attack rises over tens of milliseconds. Run it and read the numbers:
    /// `cargo test -- --ignored what_a_note_looks_like`.
    #[test]
    #[ignore = "opens a real audio device"]
    fn what_a_note_looks_like_on_the_way_out_of_the_real_device() {
        use objc2_avf_audio::AVAudioTime;
        use std::sync::Arc;

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
        assert!(status().available, "{}", status().reason);

        // Samples, and the render time each buffer of them claims to start at: a jump in that time
        // is the engine having skipped a stretch of the render, which is what a dropout is.
        type Tapped = (Vec<f32>, Vec<(i64, u32)>);
        let taken: Arc<Mutex<Tapped>> = Arc::new(Mutex::new(Default::default()));
        let into = taken.clone();
        let tap = RcBlock::new(
            move |buffer: NonNull<AVAudioPCMBuffer>, when: NonNull<AVAudioTime>| unsafe {
                let buffer = buffer.as_ref();
                let channel = (*buffer.floatChannelData()).as_ptr();
                let mut held = into.lock().unwrap();
                let frames = buffer.frameLength();
                held.1.push((when.as_ref().sampleTime(), frames));
                for frame in 0..frames as usize {
                    held.0.push(channel.add(frame).read());
                }
            },
        );
        let rate = unsafe {
            let held = GRAPH.lock().unwrap();
            let mixer = held.as_ref().unwrap().engine.mainMixerNode();
            mixer.installTapOnBus_bufferSize_format_block(0, 1024, None, RcBlock::as_ptr(&tap));
            mixer.outputFormatForBus(0).sampleRate()
        };
        println!("tap at {rate} Hz, buffer {} frames", status().buffer_frames);

        for velocity in [20u8, 60, 100, 127] {
            sleep(Duration::from_millis(400));
            *taken.lock().unwrap() = Default::default();
            note(60, velocity, true, false);
            sleep(Duration::from_millis(900));
            note(60, 0, false, false);
            sleep(Duration::from_millis(300));

            let (samples, times) = taken.lock().unwrap().clone();
            let gaps = times
                .windows(2)
                .filter(|pair| pair[0].0 + i64::from(pair[0].1) != pair[1].0)
                .count();
            let peak = samples.iter().fold(0f32, |top, one| top.max(one.abs()));
            let onset = samples.iter().position(|one| one.abs() > 0.0005).unwrap_or(0);
            let to_full = samples.iter().position(|one| one.abs() >= peak * 0.9);
            let jump = samples.windows(2).fold(0f32, |top, pair| top.max((pair[1] - pair[0]).abs()));
            println!(
                "v{velocity}: peak {peak:.4}, 90% of it {:.1} ms after the first sound, \
                 biggest jump between samples {jump:.4}, {gaps} gaps in the render",
                to_full.map_or(-1.0, |at| (at - onset) as f64 / rate * 1000.0)
            );
            let step = (rate / 2000.0) as usize;
            let head: Vec<String> = (0..24)
                .map(|slot| {
                    let at = onset + slot * step;
                    let window = &samples[at.min(samples.len())..(at + step).min(samples.len())];
                    format!("{:.3}", window.iter().fold(0f32, |top, one| top.max(one.abs())))
                })
                .collect();
            println!("  peak per half ms from the first sound: {}", head.join(" "));
        }
        release_all();
    }

    /// The two hardest cases for the voice engine, read off the real device with the attack at
    /// zero: the frames right after the onset, where a step is the click the start fade exists to
    /// hide, and a re-strike of a key still ringing, where the level must not fall away.
    /// Run it and read the numbers: `cargo test -- --ignored what_the_voice_engine_looks_like`.
    #[test]
    #[ignore = "opens a real audio device"]
    fn what_the_voice_engine_looks_like_on_the_way_out_of_the_real_device() {
        use objc2_avf_audio::AVAudioTime;

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
        assert!(status().available, "{}", status().reason);
        set_envelope(Envelope { attack: 0.0, ..envelope().expect("the engine's envelope") });

        let taken: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let into = taken.clone();
        let tap = RcBlock::new(
            move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| unsafe {
                let buffer = buffer.as_ref();
                let channel = (*buffer.floatChannelData()).as_ptr();
                let mut held = into.lock().unwrap();
                for frame in 0..buffer.frameLength() as usize {
                    held.push(channel.add(frame).read());
                }
            },
        );
        let rate = unsafe {
            let held = GRAPH.lock().unwrap();
            let mixer = held.as_ref().unwrap().engine.mainMixerNode();
            mixer.installTapOnBus_bufferSize_format_block(0, 1024, None, RcBlock::as_ptr(&tap));
            mixer.outputFormatForBus(0).sampleRate()
        };

        note(60, 127, true, false);
        sleep(Duration::from_millis(400));
        // The same key again while the first strike is still ringing.
        note(60, 127, true, false);
        sleep(Duration::from_millis(400));
        note(60, 0, false, false);
        sleep(Duration::from_millis(300));

        let samples = taken.lock().unwrap().clone();
        let onset = samples.iter().position(|one| one.abs() > 0.0005).unwrap_or(0);
        let head: Vec<String> = samples[onset..(onset + 48).min(samples.len())]
            .iter()
            .map(|one| format!("{one:.4}"))
            .collect();
        println!("tap at {rate} Hz, buffer {} frames", status().buffer_frames);
        println!("the first 48 frames after the onset: {}", head.join(" "));

        let window = (rate * 0.020) as usize;
        let again = onset + (rate * 0.400) as usize;
        let rms = |from: usize| {
            let slice = &samples[from.min(samples.len())..(from + window).min(samples.len())];
            (slice.iter().map(|one| one * one).sum::<f32>() / slice.len().max(1) as f32).sqrt()
        };
        println!(
            "RMS over the 20 ms before the re-strike {:.4}, over the 20 ms after it {:.4}",
            rms(again.saturating_sub(window)),
            rms(again)
        );
        release_all();
    }

    /// The Preview's clock read off the real device: eight quarter notes of middle C at 120 BPM,
    /// tapped at the mixer and measured onset to onset. The clock lives in the render block, so
    /// the spacing must hold to well inside one buffer however the host threads are scheduled.
    /// Run it and read the numbers: `cargo test -- --ignored the_preview_keeps_its_beat`.
    #[test]
    #[ignore = "opens a real audio device"]
    fn the_preview_keeps_its_beat_on_the_real_device() {
        use objc2_avf_audio::AVAudioTime;

        /// One beat at 120 BPM, and how long each note is held of it.
        const BEAT: f64 = 0.5;
        const HELD_FOR: f64 = 0.4;
        const NOTES: usize = 8;

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
        assert!(status().available, "{}", status().reason);

        // Room for the whole tap up front: a tap block that grows its buffer holds up the render
        // thread, and a held-up render thread is a hole in what this measures.
        let taken: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::with_capacity(96_000 * 8)));
        let into = taken.clone();
        let tap = RcBlock::new(
            move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| unsafe {
                let buffer = buffer.as_ref();
                let channel = (*buffer.floatChannelData()).as_ptr();
                let mut held = into.lock().unwrap();
                for frame in 0..buffer.frameLength() as usize {
                    held.push(channel.add(frame).read());
                }
            },
        );
        let rate = unsafe {
            let held = GRAPH.lock().unwrap();
            let mixer = held.as_ref().unwrap().engine.mainMixerNode();
            mixer.installTapOnBus_bufferSize_format_block(0, 1024, None, RcBlock::as_ptr(&tap));
            mixer.outputFormatForBus(0).sampleRate()
        };

        preview_load(
            (0..NOTES)
                .map(|beat| PreviewNote {
                    midi: 60,
                    velocity: 100,
                    on: beat as f64 * BEAT,
                    off: beat as f64 * BEAT + HELD_FOR,
                })
                .collect(),
        );
        preview_play();
        sleep(Duration::from_secs(5));
        preview_stop();

        let samples = taken.lock().unwrap().clone();
        // The first note speaks where the sound first rises out of the silence before it. A plain
        // level does not find the ones after it, which strike into the ringing of the one before:
        // they are the same sample at the same velocity, so each is placed instead at the lag that
        // fits the first note's attack best over the frames around the beat it is due on.
        let loudest = samples.iter().fold(0f32, |top, one| top.max(one.abs()));
        let beat = (rate * BEAT) as usize;
        let window = (rate * 0.025) as usize;
        let first = samples
            .iter()
            .position(|one| one.abs() > loudest * 0.05)
            .expect("the first note sounded");
        let attack = &samples[first..first + (rate * 0.020) as usize];
        // How far the two are apart, squared and summed: nought where they are the same frames,
        // and the ringing of the note before only lifts the whole curve.
        let apart = |at: usize| -> f64 {
            attack
                .iter()
                .zip(&samples[at..])
                .map(|(a, b)| f64::from(*a - *b) * f64::from(*a - *b))
                .sum()
        };
        let onsets: Vec<usize> = (0..NOTES)
            .map(|note| {
                let expected = first + note * beat;
                (expected.saturating_sub(window)..expected + window)
                    .min_by(|&a, &b| apart(a).total_cmp(&apart(b)))
                    .expect("every note sounded")
            })
            .collect();
        assert_eq!(onsets[0], first, "the first note fits itself where it stands");

        let ms = |frames: f64| frames * 1000.0 / rate;
        let spacings: Vec<f64> =
            onsets.windows(2).map(|pair| ms((pair[1] - pair[0]) as f64)).collect();
        // How far each note landed from the beat it was written on. A note is struck at the head
        // of the buffer its time falls in, so it comes early by anything up to one buffer and
        // never late, and the error of the note before it is not carried into the next: this is
        // what says the clock is the audio clock and has not drifted over the eight beats.
        let off: Vec<f64> = (0..NOTES)
            .map(|note| ms(onsets[note] as f64 - (onsets[0] + note * beat) as f64))
            .collect();
        let buffer = ms(f64::from(status().buffer_frames));
        let worst = off.iter().fold(0f64, |top, one| top.max(one.abs()));
        let list = |these: &[f64]| {
            these.iter().map(|one| format!("{one:.3}")).collect::<Vec<_>>().join(" ")
        };
        println!("tap at {rate} Hz, buffer {} frames, {buffer:.3} ms", status().buffer_frames);
        println!("onset to onset in ms: {}", list(&spacings));
        println!("off the written beat in ms: {}", list(&off));
        println!("worst {worst:.3} ms against a buffer of {buffer:.3} ms");
        assert!(worst <= buffer, "a note landed {worst:.3} ms off its beat");
        release_all();
    }

    fn underruns() -> u64 {
        GRAPH.lock().unwrap().as_ref().map_or(0, |graph| graph.underruns())
    }

    /// What streaming costs on the real device: how long the Concert Grand takes to load now that
    /// only the zone heads are read, and whether ten notes held under the pedal for three seconds
    /// outrun the reader. A voice the disk cannot keep up with counts underruns and goes silent;
    /// an engine the render cannot keep up with leaves gaps in the timeline. Both want to be zero.
    /// Run it and read the numbers: `cargo test -- --ignored a_streamed_chord`.
    #[test]
    #[ignore = "opens a real audio device"]
    fn a_streamed_chord_holds_for_three_seconds_without_running_dry() {
        use objc2_avf_audio::AVAudioTime;

        let graph = Graph::build().unwrap();
        graph.start().unwrap();
        install(graph);
        set_output_device(None).unwrap();
        set_buffer_frames(DEFAULT_FRAMES).unwrap();

        type Tapped = (Vec<f32>, Vec<(i64, u32)>);
        let taken: Arc<Mutex<Tapped>> = Arc::new(Mutex::new(Default::default()));
        let into = taken.clone();
        let tap = RcBlock::new(
            move |buffer: NonNull<AVAudioPCMBuffer>, when: NonNull<AVAudioTime>| unsafe {
                let buffer = buffer.as_ref();
                let channel = (*buffer.floatChannelData()).as_ptr();
                let mut held = into.lock().unwrap();
                let frames = buffer.frameLength();
                held.1.push((when.as_ref().sampleTime(), frames));
                for frame in 0..frames as usize {
                    held.0.push(channel.add(frame).read());
                }
            },
        );
        unsafe {
            let held = GRAPH.lock().unwrap();
            let mixer = held.as_ref().unwrap().engine.mainMixerNode();
            mixer.installTapOnBus_bufferSize_format_block(0, 1024, None, RcBlock::as_ptr(&tap));
        }

        // Ten keys at the hardest strike, held down with the pedal: every one of them streams for
        // as long as the chord lasts, which is the most the reader is ever asked for. The Studio
        // Grand layers three mic sets over each of them, so it asks for three times the voices.
        let chord = [48u8, 52, 55, 60, 64, 67, 72, 76, 79, 84];
        for name in ["Concert Grand Piano", "Studio Grand Piano"] {
            let piano = instruments("")
                .into_iter()
                .find(|one| one.name == name)
                .unwrap_or_else(|| panic!("Logic's {name} is on this Mac"));
            let started = Instant::now();
            load_instrument(&piano.id, None).unwrap();
            let load = started.elapsed();
            assert!(status().available, "{}", status().reason);
            println!("\n{name} loaded in {load:?}, roles {:?}", status().roles);

            *taken.lock().unwrap() = Default::default();
            let (dry, stolen) = (underruns(), sampler::engine::steals());
            pedal(127);
            for midi in chord {
                note(midi, 127, true, false);
            }
            sleep(Duration::from_secs(3));
            for midi in chord {
                note(midi, 0, false, false);
            }
            pedal(0);
            sleep(Duration::from_millis(500));

            let (samples, times) = taken.lock().unwrap().clone();
            let gaps = times
                .windows(2)
                .filter(|pair| pair[0].0 + i64::from(pair[0].1) != pair[1].0)
                .count();
            let peak = samples.iter().fold(0f32, |top, one| top.max(one.abs()));
            println!(
                "{} notes for 3 s: peak {peak:.4}, {} underruns, {gaps} gaps, {} voices stolen",
                chord.len(),
                underruns() - dry,
                sampler::engine::steals() - stolen,
            );
            release_all();

            assert!(load < Duration::from_secs(3), "loaded in {load:?}");
            assert!(peak > 0.01, "the chord sounded");
            assert_eq!(underruns() - dry, 0, "no voice ran dry");
            assert_eq!(gaps, 0, "and the render never skipped");
            assert_eq!(sampler::engine::steals() - stolen, 0, "and no voice was given up");
        }
    }

    #[test]
    fn the_velocity_remap_runs_from_the_minimum_to_the_maximum() {
        assert_eq!(curved(0, 1, 127, 1.6), 0, "a note off stays a note off");

        // Both ends are exact wherever they are put: velocity 1 is the minimum and velocity 127 is
        // the maximum, whatever the exponent does between them.
        for (min, max) in [(1, 127), (30, 90), (64, 64), (1, 40), (100, 127)] {
            for curve in [0.5, 1.0, 1.6, 2.5] {
                assert_eq!(curved(1, min, max, curve), min, "the lightest strike is the minimum");
                assert_eq!(curved(127, min, max, curve), max, "the hardest is the maximum");
            }
        }

        // Nothing is clamped: every input lands inside the two ends because the map put it there.
        for each in 1..=127 {
            assert!((30..=90).contains(&curved(each, 30, 90, 1.6)), "the whole range is remapped");
        }

        // The middle of the slider is the straight line, and either side bends off it.
        assert_eq!(curved(64, 1, 127, 1.0), 64, "an exponent of one is the keyboard's reading");
        assert!(curved(64, 1, 127, 2.0) < 64, "a soft curve puts the middle under the line");
        assert!(curved(64, 1, 127, 0.5) > 64, "a hard curve puts it over");

        // Raising the minimum lifts the light end and leaves the hard end where it was.
        assert!(curved(1, 64, 127, 1.6) > curved(1, 1, 127, 1.6));
        assert_eq!(curved(127, 64, 127, 1.6), curved(127, 1, 127, 1.6));

        for curve in [0.5, 1.0, 1.6, 2.5] {
            let out = |each| curved(each, 1, 127, curve);
            assert!((1..=127).all(|each| out(each) > 0), "no strike is silenced");
            assert!((1..=127).all(|each| out(each) >= out(each - 1)), "harder is never quieter");
        }
    }

    /// The remap is applied once, inside `note_on`, and `note` answers with its result. A caller
    /// that wants the output velocity takes it from there rather than mapping again, which is what
    /// keeps the strike the webview grades from being bent twice.
    #[test]
    fn a_played_note_answers_the_velocity_it_was_played_at() {
        let mut graph = offline();
        graph.set_velocity_curve(40, 100, 1.0);

        let out = graph.note_on(60, 64);
        assert_eq!(out, curved(64, 40, 100, 1.0), "the note answers its own output velocity");
        assert_ne!(out, 64, "and it is not the input, under a remap that moves it");
        assert_ne!(curved(out, 40, 100, 1.0), out, "a second mapping would land somewhere else");

        // A key coming up is not a note on, so nothing is remapped on the way out.
        graph.note_off(60);
        graph.release_all();
    }

    /// The remap is between the keyboard and the instrument, so it is the note that changes, not
    /// the finished sound: what this hears is the voice engine answering a different velocity.
    #[test]
    fn the_minimum_velocity_lifts_a_light_strike_and_leaves_a_hard_one() {
        let mut graph = offline();

        graph.set_velocity_curve(1, 127, 1.6);
        let (light, hard) = (struck(&mut graph, 1), struck(&mut graph, 127));

        graph.set_velocity_curve(76, 127, 1.6);
        assert!(struck(&mut graph, 1) > light, "the lightest strike came up");
        assert_eq!(struck(&mut graph, 127), hard, "a hard strike is where it was");
    }

    #[test]
    fn a_soft_curve_makes_a_middling_strike_quieter_than_a_hard_one() {
        let mut graph = offline();

        graph.set_velocity_curve(1, 127, 2.5);
        let soft = struck(&mut graph, 64);

        graph.set_velocity_curve(1, 127, 0.5);
        assert!(struck(&mut graph, 64) > soft, "the same strike is louder under a hard curve");
    }

    #[test]
    fn the_fixture_loads_and_an_untouched_graph_is_silent() {
        let mut graph = offline();
        assert_eq!(graph.render_peak(LOOK).unwrap(), 0.0);
    }

    /// The app loads its instrument into an engine that has been running since boot, so a file
    /// read in after the start is what the keyboard sounds.
    #[test]
    fn a_file_loaded_into_a_running_graph_is_what_sounds() {
        let mut graph = Graph::build().unwrap();
        graph.start_offline(PASS).unwrap();
        assert_eq!(note_peak(&mut graph), 0.0, "a graph with nothing loaded is silent");

        graph.load_file(Path::new(FIXTURE)).unwrap();
        assert!(note_peak(&mut graph) > 0.01, "and the fixture sounds once it is in");
    }

    /// Both settings take the graph apart and put it together again, and the instrument lives in
    /// the voice engine rather than in the wiring, so neither can lose it.
    #[test]
    fn the_instrument_lives_through_a_restart_and_a_change_of_the_chain() {
        let mut graph = offline();
        assert!(note_peak(&mut graph) > 0.01, "the fixture is what plays");

        // What a change of output device or buffer does underneath the graph.
        unsafe { graph.engine.stop() };
        graph.start().unwrap();
        assert!(note_peak(&mut graph) > 0.01, "and after the engine has been round again");

        effects::apply(&mut graph, vec![crate::audio::Slot {
            id: "aufx:rvb2:appl".into(),
            name: String::new(),
            bypass: true,
            state: String::new(),
            missing: false,
        }]);
        assert!(note_peak(&mut graph) > 0.01, "and after the chain changed under it");
    }

    /// Every output device and buffer setting stops and starts the engine, and the app applies one
    /// of each at boot, so the click has to live through it.
    #[test]
    fn the_click_sounds_after_the_engine_has_stopped_and_started() {
        let mut graph = offline();
        unsafe { graph.engine.stop() };
        graph.start().unwrap();

        assert!(click_peak(&mut graph, true, 100) > 0.01);
    }

    #[test]
    fn a_note_sounds_until_it_is_let_go() {
        let mut graph = offline();
        graph.note_on(60, 100);
        assert!(graph.render_peak(LOOK).unwrap() > 0.01);

        graph.note_off(60);
        // The release runs out inside this pass; what comes after it is silence.
        graph.render_peak(RELEASE).unwrap();
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
        graph.render_peak(RELEASE).unwrap();
        assert_eq!(graph.render_peak(LOOK).unwrap(), 0.0, "the pedal came up");
    }

    #[test]
    fn a_click_puts_sound_on_the_mixer_and_a_volume_of_zero_does_not() {
        let mut graph = offline();
        let strong = click_peak(&mut graph, true, 100);
        assert!(strong > 0.01);

        let weak = click_peak(&mut graph, false, 100);
        assert!(weak > 0.01 && weak < strong, "strong {strong}, weak {weak}");

        assert_eq!(click_peak(&mut graph, true, 0), 0.0);
    }

    /// The Audio dialog switches instrument on the worker thread its command came in on, and a
    /// plugin's Audio Unit freed there races the main thread's teardown of the window that plugin
    /// drew: two threads inside one plugin's dealloc free the same objects twice. So a switch never
    /// lets go of the plugin itself; it leaves the last reference to the main thread.
    #[test]
    fn the_plugin_a_switch_takes_out_is_let_go_of_on_the_main_thread() {
        let unit = hosted_instrument();
        let mut graph = Graph::build().unwrap();
        graph.set_plugin(unit.clone());

        graph.load_file(Path::new(FIXTURE)).unwrap();
        assert!(still_held_elsewhere(&unit), "the file switch left the plugin to the main thread");

        // And the same the other way round, one plugin displacing another.
        graph.set_plugin(unit.clone());
        graph.set_plugin(hosted_instrument());
        assert!(still_held_elsewhere(&unit), "and so does a plugin taking another plugin's place");
    }

    /// What the user does in the Audio dialog: pick, listen, pick again. Every switch rewires the
    /// graph, so the instrument that ends up in the path has to be the one just chosen, however
    /// many switches came before it.
    #[test]
    fn switching_instrument_over_and_over_leaves_the_last_one_chosen_playing() {
        let mut graph = Graph::build().unwrap();
        graph.start_offline(PASS).unwrap();

        for _ in 0..3 {
            graph.load_file(Path::new(FIXTURE)).unwrap();
            let file = note_peak(&mut graph);
            assert!(file > 0.01, "the file plays");

            graph.set_plugin(hosted_instrument());
            assert!(note_peak(&mut graph) > 0.01, "the plugin plays in its place");

            graph.load_file(Path::new(FIXTURE)).unwrap();
            assert_eq!(note_peak(&mut graph), file, "and the file takes it back");
        }
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

        assert_eq!(graph.preview_progress(), (0.0, false));
    }

    /// A plugin holds the head of the chain and the source node is out of the path, but the
    /// Preview's clock lives in that node's block: the fader keeps it on a silenced input of its
    /// own so it is still rendered, and its notes come out through the ring for the reporter.
    #[test]
    fn the_preview_clock_runs_on_while_a_plugin_holds_the_head() {
        let mut graph = offline();
        graph.set_plugin(hosted_instrument());
        graph.preview_load(vec![preview_note(60, 0.0, 100.0)]);
        graph.preview_play();

        assert_eq!(graph.render_peak(PASS).unwrap(), 0.0, "the muted node is heard by nothing");
        let (seconds, playing) = graph.preview_progress();
        assert!(playing && seconds >= PASS_SECONDS, "the clock moved on: {seconds}");

        let mut notes = [Event::default(); 4];
        assert_eq!(graph.preview.notes.pop(&mut notes), 1);
        assert_eq!(notes[0], Event { midi: 60, velocity: 100, on: true });
    }

    /// The render block owns the note list while it plays, and the audio thread is no place to
    /// free one: a load in the middle of a piece has to hand the list it replaces back out.
    #[test]
    fn a_load_while_playing_hands_the_old_note_list_back_out_of_the_render_block() {
        let mut graph = offline();
        graph.preview_load(vec![preview_note(60, 0.0, 100.0), preview_note(64, 0.0, 100.0)]);
        graph.preview_play();
        graph.render_peak(PASS).unwrap();

        graph.preview_load(vec![preview_note(72, 0.0, 100.0)]);
        graph.render_peak(PASS).unwrap();
        assert_eq!(graph.played.try_recv().map(|old| old.len()), Ok(2));
    }

    /// How long a note goes on sounding after the key comes up, to the nearest hundredth of a
    /// second. A thousandth of full scale counts as silence.
    fn release_ms(graph: &mut Graph) -> f64 {
        const STEP: u32 = 441;
        graph.note_on(60, 100);
        graph.render_peak(LOOK).unwrap();
        graph.note_off(60);
        let mut steps = 0;
        while steps < 300 && graph.render_peak(STEP).unwrap() > 0.001 {
            steps += 1;
        }
        graph.release_all();
        graph.render_peak(LOOK).unwrap();
        f64::from(steps) * 10.0
    }

    #[test]
    fn a_longer_release_keeps_a_note_sounding_after_the_key_has_come_up() {
        let mut graph = offline();

        // A file instrument starts on the envelope every one of them starts on.
        let brought = graph.envelope().expect("the instrument's envelope");
        assert_eq!(brought.release, FILE_ENVELOPE.release);
        let short = release_ms(&mut graph);

        graph.set_envelope(Envelope { release: 0.75, ..brought });
        assert_eq!(graph.envelope().expect("the envelope set").release, 0.75);
        let long = release_ms(&mut graph);
        assert!(long > short + 100.0, "{long} ms against {short} ms");

        // Changing an effect rewires the graph. The envelope has to outlast that, or it would
        // last only until the next change of anything.
        effects::rewire(&graph);
        let after = release_ms(&mut graph);
        assert!(after > short + 100.0, "the rewire left {after} ms");
    }
}

#[cfg(test)]
mod idle {
    use super::*;

    /// Prints what each thread of this process cost over eight seconds while the graph plays
    /// silence on the real output device at 64 frames: `cargo test -- --ignored --nocapture idle::`.
    fn probe(label: &str, grand: bool, reverb: bool) {
        let mut graph = Graph::build().unwrap();
        graph.start().unwrap();
        graph.adopt();
        graph.set_buffer(32).unwrap();
        if reverb {
            let slot = serde_json::from_str(r#"{"id":"aumf:FR2p:FabF","name":"Pro-R 2"}"#).unwrap();
            let chain = effects::apply(&mut graph, vec![slot]);
            assert!(chain.iter().all(|slot| !slot.missing), "Pro-R 2 is installed");
        }
        if grand {
            let path = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join(
                "Music/Logic Pro Library.bundle/Plug-In Settings/Sampler/z_Internal/Studio Piano/\
                 Concert Grand Piano.exs",
            );
            graph.load_file(&path).unwrap();
        }
        let threads = || {
            let out = std::process::Command::new("ps")
                .args(["-M", "-o", "pid", "-p", &std::process::id().to_string()])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).to_string()
        };
        std::thread::sleep(Duration::from_secs(2));
        let before = threads();
        std::thread::sleep(Duration::from_secs(8));
        let after = threads();
        println!("--- {label}, {} frames\n{before}\n{after}", graph.output.frames);
    }

    #[test]
    #[ignore = "plays through the real output device"]
    fn an_empty_graph() {
        probe("empty graph", false, false);
    }

    #[test]
    #[ignore = "needs the Logic sample library"]
    fn a_graph_with_the_concert_grand() {
        probe("concert grand loaded", true, false);
    }

    #[test]
    #[ignore = "needs FabFilter Pro-R 2"]
    fn a_graph_with_a_reverb() {
        probe("Pro-R 2 in the chain", false, true);
    }
}

#[cfg(test)]
mod rate {
    use super::*;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/sine.sf2");

    /// Zero crossings a second in the fixture's middle C, rendered offline at `rate`: the pitch
    /// as a number, which stays put when the engine honours the rate it was moved to.
    fn crossings_per_second_at(rate: f64) -> f64 {
        let mut graph = Graph::build().unwrap();
        graph.rewire_at(rate).unwrap();
        graph.load_file(Path::new(FIXTURE)).unwrap();
        graph.start_offline(4096).unwrap();
        graph.note_on(60, 100);
        let out = graph.render_frames(8192).unwrap();
        let crossings = out.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
        crossings as f64 / (out.len() as f64 / rate)
    }

    #[test]
    fn the_status_names_the_rate_a_file_was_recorded_at() {
        let mut graph = Graph::build().unwrap();
        assert_eq!(graph.instrument_rate, 0.0, "nothing loaded");
        graph.load_file(Path::new(FIXTURE)).unwrap();
        assert!(graph.instrument_rate > 0.0, "{}", graph.instrument_rate);
        graph.unload_exs();
        assert_eq!(graph.instrument_rate, 0.0);
    }

    #[test]
    fn a_rate_off_the_list_is_refused() {
        let mut graph = Graph::build().unwrap();
        assert!(graph.set_sample_rate(22050).is_err());
    }

    #[test]
    fn the_voice_engine_keeps_the_pitch_at_the_rate_it_was_moved_to() {
        let (base, moved) = (crossings_per_second_at(RATE), crossings_per_second_at(96000.0));
        assert!(base > 100.0, "{base} crossings a second: the fixture sounds");
        assert!((moved - base).abs() <= base * 0.05, "{moved} against {base}");
    }
}

/// What the engine offers for the device it plays through, and what it refuses. The graph renders
/// offline over a table of devices, so every rule here is checked with no hardware: an offline
/// graph has no output device to point at, and the table answers for the one it keeps.
#[cfg(test)]
mod output {
    use super::*;
    use crate::audio::device::{Output, Table};

    /// A graph over the table's devices, rendering to the test's own buffer and on no device until
    /// one is set.
    fn over(table: Arc<Table>) -> Graph {
        let mut graph = Graph::over(table).unwrap();
        graph.start_offline(4096).unwrap();
        graph
    }

    /// The device a table answers as the system default.
    fn speakers() -> Output {
        Output::plugged(1, "speakers")
    }

    /// A device to choose over the default, which takes one buffer size fewer, so the answers for
    /// one device are told from the other's.
    fn interface() -> Output {
        Output { buffers: vec![64, 128, 256, 512], ..Output::plugged(2, "interface") }
    }

    /// A graph that has not been put on a device answers for no device, which takes nothing: the
    /// same refusal a device that does not list the size gives.
    #[test]
    fn a_buffer_the_device_does_not_list_is_refused() {
        let mut graph = Graph::build().unwrap();
        assert!(graph.output.buffers.is_empty());
        assert!(graph.set_buffer(DEFAULT_FRAMES).is_err());
    }

    /// The app asks for its buffer size at every boot, and the device is usually on it already.
    #[test]
    fn the_size_the_device_already_runs_costs_no_restart() {
        let table = Arc::new(Table::of(&[Output { frames: 128, ..speakers() }]));
        let mut graph = over(table);
        graph.set_device(None).unwrap();
        graph.set_buffer(128).unwrap();
        assert!(graph.running(), "the engine plays on rather than stopping and starting");
        assert_eq!(graph.output.frames, 128);
    }

    /// The size the device does not take is the nearest one above it, and the largest it takes
    /// when every one of them is smaller.
    #[test]
    fn a_buffer_the_device_will_not_take_becomes_the_nearest_one_it_will() {
        let table = Arc::new(Table::of(&[Output { buffers: vec![128, 256], ..speakers() }]));
        let mut graph = over(table);
        graph.set_device(None).unwrap();

        graph.set_buffer(32).unwrap();
        assert_eq!(graph.output.frames, 128, "the smallest size the device takes above 32");
        graph.set_buffer(512).unwrap();
        assert_eq!(graph.output.frames, 256, "the largest it takes, every choice being smaller");
    }

    /// A device change carries the buffer the user picked onto the device that takes over.
    #[test]
    fn the_device_taken_up_runs_the_buffer_the_user_picked() {
        let table = Arc::new(Table::of(&[speakers(), interface()]));
        let mut graph = over(table);
        graph.set_device(None).unwrap();
        graph.set_buffer(64).unwrap();
        graph.set_device(Some("interface".into())).unwrap();

        assert_eq!(graph.output.id, interface().id, "playing through the choice");
        assert_eq!(graph.output.frames, 64);
        assert!(graph.running());
    }

    /// The engine follows the device list: it gives the chosen device up when it is unplugged and
    /// takes it back when it returns, and says so in the status while it is gone.
    #[test]
    fn an_unplugged_choice_falls_back_to_the_default_and_is_taken_up_again() {
        let table = Arc::new(Table::of(&[speakers(), interface()]));
        let mut graph = over(table.clone());
        graph.set_device(Some("interface".into())).unwrap();
        assert_eq!(status_of(&graph).fallback, "");

        table.plug(&[speakers()]);
        graph.follow_devices().unwrap();
        assert_eq!(graph.output.id, speakers().id, "the system default plays instead");
        assert!(!status_of(&graph).fallback.is_empty(), "and the status says why");
        assert!(graph.running());

        table.plug(&[speakers(), interface()]);
        graph.follow_devices().unwrap();
        assert_eq!(graph.output.id, interface().id, "the choice is honoured again");
        assert_eq!(status_of(&graph).fallback, "");
    }

    /// AVAudioEngine stops itself whenever the output hardware changes under it and never starts
    /// itself back up, so the next device change has to, even when no device has changed.
    #[test]
    fn a_graph_the_hardware_stopped_is_playing_again_after_the_next_device_change() {
        let table = Arc::new(Table::of(&[speakers()]));
        let mut graph = over(table);
        graph.set_device(None).unwrap();

        unsafe { graph.engine.stop() };
        assert!(!graph.running());

        graph.follow_devices().unwrap();
        assert!(graph.running(), "the engine is playing again rather than silent for good");
        assert_eq!(graph.output.id, speakers().id, "through the same device, nothing else changed");
    }

    /// What the status bar reads is a copy of the device value the graph keeps.
    #[test]
    fn the_status_names_the_device_playing_and_what_it_takes() {
        let table = Arc::new(Table::of(&[speakers(), interface()]));
        let mut graph = over(table);
        graph.set_device(Some("interface".into())).unwrap();

        let status = status_of(&graph);
        assert_eq!(status.device.as_deref(), Some("interface"));
        assert_eq!(status.device_name, "interface");
        assert_eq!(status.buffer_choices, interface().buffers);
        assert_eq!(status.buffer_frames, graph.output.frames);
        assert_eq!(status.sample_rate, 44100.0);
    }

    /// A device that lists the rate is moved to it; one that does not keeps its own and the mixer
    /// converts, which is no error to the caller.
    #[test]
    fn the_device_follows_the_rate_it_lists_and_keeps_its_own_otherwise() {
        let fixed = Output { rates: vec![(44100.0, 44100.0)], ..speakers() };
        let table = Arc::new(Table::of(&[fixed]));
        let mut graph = over(table.clone());
        graph.set_device(None).unwrap();

        graph.set_sample_rate(48000).unwrap();
        assert_eq!(graph.output.rate, 44100.0, "the device it will not run at keeps its own");

        table.plug(&[Output { rates: vec![(44100.0, 96000.0)], ..speakers() }]);
        graph.follow_devices().unwrap();
        graph.set_sample_rate(96000).unwrap();
        assert_eq!(graph.output.rate, 96000.0);
    }

    /// The status the engine answers, off one graph rather than the app's own.
    fn status_of(graph: &Graph) -> Status {
        let mut status = Status::default();
        graph.describe_output(&mut status);
        status
    }
}

#[cfg(test)]
mod silence {
    use super::*;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/sine.sf2");

    /// The source tells the chain its buffer is silent once no voice sounds; an effect with a tail
    /// keeps rendering it all the same, so a reverb rings on after the last voice has died.
    #[test]
    fn a_reverb_rings_on_after_the_last_voice_dies() {
        let mut graph = Graph::build().unwrap();
        graph.load_file(Path::new(FIXTURE)).unwrap();
        let slot = serde_json::from_str(r#"{"id":"aufx:mrev:appl","name":"Reverb"}"#).unwrap();
        let chain = effects::apply(&mut graph, vec![slot]);
        assert!(chain.iter().all(|slot| !slot.missing), "Apple's reverb is installed");
        graph.start_offline(4096).unwrap();
        graph.note_on(60, 100);
        graph.render_peak(8192).unwrap();
        graph.release_all();
        // Renders until the voice has died, which is when the source starts flagging silence.
        let mut passes = 0;
        while graph.meters.voices.load(Relaxed) > 0 {
            graph.render_peak(4096).unwrap();
            passes += 1;
            assert!(passes < 100, "the voice never died");
        }
        let tail = graph.render_peak(8192).unwrap();
        let later = graph.render_peak(8192).unwrap();
        assert!(tail > 1e-3, "the tail after the voice died peaks at {tail}");
        assert!(later > 0.0 && later < tail, "and dies away: {later} after {tail}");
    }
}

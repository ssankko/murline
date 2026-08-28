//! The sound engine on macOS: one AVAudioEngine graph with three ways to make the instrument's
//! sound and a player node for the metronome click, all into the main mixer and out to the device.
//! An EXS file plays through the app's own voice engine behind a source node, a SoundFont through
//! AVAudioUnitSampler, and a hosted Audio Unit through itself. Every entry point the command
//! surface and the tests use is a method on `Graph`; the app keeps one of them in `GRAPH` for as
//! long as it runs.
//!
//! One thing here runs on the audio thread: the source node's render block, which owns the voice
//! engine and takes its orders through a channel. Everything else is host-side work AVFAudio
//! documents as safe off that thread.

mod effects;
mod envelope;
pub use effects::{chain, effects, set_chain, show_effect};

use crate::audio::device::{self, DeviceId};
use crate::audio::preview::{PreviewNote, Scheduler};
use crate::audio::sampler::{self, Command, engine::Sampler};
use crate::audio::{Envelope, OutputDevice, Status, progress};
// The instrument the graph plays, and the window a hosted plugin brings with it.
pub use crate::audio::instruments::{list as instruments, load as load_instrument};
pub use crate::audio::window::show_instrument;
use block2::RcBlock;
use objc2::AllocAnyThread;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_audio_toolbox::{
    AudioUnit, AudioUnitGetProperty, AudioUnitSetProperty, kAudioOutputUnitProperty_CurrentDevice,
    kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global,
};
use objc2_avf_audio::{
    AVAudioEngine, AVAudioEngineConfigurationChangeNotification, AVAudioEngineManualRenderingMode,
    AVAudioFormat, AVAudioFrameCount, AVAudioMixerNode, AVAudioMixing, AVAudioNode,
    AVAudioPCMBuffer, AVAudioPlayerNode, AVAudioSourceNode, AVAudioUnitMIDIInstrument,
    AVAudioUnitSampler,
};
#[cfg(test)]
use objc2_avf_audio::AVAudioEngineManualRenderingStatus;
use objc2_core_audio_types::{AudioBuffer, AudioBufferList, AudioTimeStamp};
use objc2_foundation::{
    NSError, NSNotification, NSNotificationCenter, NSOperationQueue, NSString, NSURL,
};
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::ptr::{NonNull, from_ref};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, Once};
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

/// What an EXS instrument answers a key with until the webview sends the one kept for it: a plain
/// hold, the recorded sample carrying its own decay, and a release short enough to read as a
/// damper falling.
const EXS_ENVELOPE: Envelope = Envelope { attack: 0.0, decay: 0.0, sustain: 1.0, release: 0.3 };

/// How many notes the voice engine may hold sounding at once. A pedalled two-handed passage runs
/// to a few dozen, and every voice past that costs only the samples it mixes.
const VOICES: usize = 64;

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
/// The velocity remap the engine starts with: the whole range in, the whole range out, straight.
/// Out of the box the app hands back exactly what the keyboard sent.
const DEFAULT_MIN: u8 = 1;
const DEFAULT_MAX: u8 = 127;
const DEFAULT_CURVE: f64 = 1.0;
/// The status line when the device the user picked is not plugged in.
const GONE: &str = "Your chosen output device is not connected; playing through the system default";

/// How often the Preview's pump wakes while a piece plays, and while nothing does.
// ponytail: the pump runs on a wall-clock thread rather than in the source node's render block,
// which would have to take the graph's lock on the audio thread to send the notes. Two
// milliseconds is inside one 64-frame buffer; move the pump into the block, over a lock-free
// hand-off, if the jitter is ever audible.
const PUMP: Duration = Duration::from_millis(2);
/// The longest the graph waits for the output device's first render before it starts the click
/// player on it.
const FIRST_RENDER: Duration = Duration::from_secs(2);
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
    /// The node the app's own voice engine plays through: its render block holds the voices and
    /// pulls the commands below out of the channel on the audio thread.
    source: Retained<AVAudioSourceNode>,
    commands: Sender<Command>,
    /// Where the voice engine hands back an instrument it has stopped playing. Draining it drops
    /// the last reference, and with it the sample memory map, off the audio thread.
    // ponytail: one dead instrument sits here until the next load drains it, which costs a
    // mapping's worth of address space; drain on a timer if that is ever too long to wait.
    graveyard: Receiver<Arc<sampler::Instrument>>,
    /// True while the voice engine holds the instrument, false while AUSampler does. A hosted
    /// plugin displaces both.
    exs: bool,
    /// The hosted Audio Unit instrument, when the choice is a plugin instead of a file. It plays
    /// in the sampler's place; the sampler stays in the graph, silent.
    plugin: Option<Retained<AVAudioUnitMIDIInstrument>>,
    clicker: Retained<AVAudioPlayerNode>,
    /// The keyboard volume, a gain the whole instrument path runs through on its way to the mixer.
    /// It sits after the effects on purpose: a trim before them would change what a compressor or
    /// a reverb is given and so change how the instrument answers the hands, which is the one
    /// thing turning the volume down must not do. The click does not pass through it.
    fader: Retained<AVAudioMixerNode>,
    format: Retained<AVAudioFormat>,
    strong: Retained<AVAudioPCMBuffer>,
    weak: Retained<AVAudioPCMBuffer>,
    /// The effects between the sampler and the mixer, in the order they play.
    chain: Vec<effects::Held>,
    /// The file the sampler plays. AUSampler holds a loaded instrument only from the load to the
    /// next time its node is initialised, and the engine initialises the node on every start and
    /// on every change of the wiring, so the file goes back in each time.
    file: Option<PathBuf>,
    /// The envelope asked for, if any, which is put back on the sampler after every reload: a load
    /// reads the instrument file's own envelope in over whatever was set.
    envelope: Option<Envelope>,
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
    /// The velocity remap: the output the lightest strike lands on, the output the hardest lands
    /// on, and the exponent of the path between them.
    velocity_min: u8,
    velocity_max: u8,
    velocity_curve: f64,
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
            let fader = AVAudioMixerNode::new();
            let (commands, orders) = channel();
            let (dead, graveyard) = channel();
            let source = source_node(&format, orders, dead);
            engine.attachNode(&sampler);
            engine.attachNode(&source);
            engine.attachNode(&clicker);
            engine.attachNode(&fader);
            let mixer = engine.mainMixerNode();
            // The instrument end of this is rewired whenever the chain changes; the fader's own
            // connection to the mixer never is, so setting the volume touches no connection.
            engine.connect_to_format(&sampler, &fader, Some(&format));
            engine.connect_to_format(&fader, &mixer, Some(&format));
            engine.connect_to_format(&clicker, &mixer, Some(&format));
            Ok(Graph {
                strong: blip(&format, STRONG_HZ, STRONG_PEAK)?,
                weak: blip(&format, WEAK_HZ, WEAK_PEAK)?,
                format,
                engine,
                sampler,
                source,
                commands,
                graveyard,
                exs: false,
                plugin: None,
                clicker,
                fader,
                chain: Vec::new(),
                file: None,
                envelope: None,
                offline_frames: 0,
                chosen: None,
                chosen_device: None,
                device: 0,
                fell_back: false,
                wanted_frames: DEFAULT_FRAMES,
                velocity_min: DEFAULT_MIN,
                velocity_max: DEFAULT_MAX,
                velocity_curve: DEFAULT_CURVE,
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
                let samples = (*buffer.floatChannelData()).as_ptr();
                for frame in 0..rendered as usize {
                    taken.push(samples.add(frame).read());
                }
                left -= rendered.min(left);
            }
            Ok(taken)
        }
    }

    /// Loads an instrument file: an EXS into the app's own voice engine, a SoundFont's first
    /// melodic program or an AUPreset into AUSampler. Reads from disk, so never from the audio
    /// thread.
    pub fn load_file(&mut self, path: &Path) -> Result<(), String> {
        if exs_file(path) {
            return self.load_exs(path);
        }
        if sound_bank(path) && not_a_sound_font(path) {
            return Err("That file is not a SoundFont".into());
        }
        // Nothing of the old instrument may ring on through the new one.
        self.release_all();
        let _turn = LOADING.lock().unwrap();
        self.file = Some(path.to_path_buf());
        // The envelope belongs to the instrument that was playing, not to this one, which brings
        // its own; the webview sets whatever was kept for this one once the load is through.
        self.envelope = None;
        self.drop_plugin();
        self.unload_exs();
        // The sampler is the instrument again, so it takes the head of the chain back, and the
        // rewire is what reads the file in on the way.
        effects::rewire(self)
    }

    /// Reads an EXS file and its samples and hands them to the voice engine. Everything that can
    /// fail happens before anything is switched over, so a file that will not read leaves the
    /// instrument that was playing exactly where it was.
    fn load_exs(&mut self, path: &Path) -> Result<(), String> {
        let instrument = sampler::decode::load(&sampler::exs::read(path)?)?;
        // Nothing of the old instrument may ring on through the new one.
        self.release_all();
        // AUSampler plays nothing from here on, so it has no file to read back at the next rewire.
        self.file = None;
        self.load_instrument(Arc::new(instrument))
    }

    /// Puts an instrument straight into the voice engine and gives its node the head of the chain,
    /// taking out whichever instrument held it. The envelope is the one every EXS starts on until
    /// the webview sends the one kept for this instrument.
    pub(super) fn load_instrument(
        &mut self,
        instrument: Arc<sampler::Instrument>,
    ) -> Result<(), String> {
        self.drop_plugin();
        self.bury();
        self.exs = true;
        self.envelope = Some(EXS_ENVELOPE);
        self.send(Command::Load(instrument));
        self.send(Command::Envelope(EXS_ENVELOPE));
        effects::rewire(self)
    }

    /// Takes the instrument out of the voice engine, which is what leaves it silent while AUSampler
    /// or a plugin plays.
    fn unload_exs(&mut self) {
        if !self.exs {
            return;
        }
        self.exs = false;
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
        .map_err(reason)?;
        if let Some(want) = self.envelope {
            envelope::write(&self.sampler, want);
        }
        Ok(())
    }

    /// What the instrument answers a key with now, or nothing when a plugin is playing, which
    /// shapes its notes behind its own window. The voice engine's is the last one it was given.
    pub fn envelope(&self) -> Option<Envelope> {
        if self.plugin.is_some() {
            return None;
        }
        if self.exs {
            return self.envelope;
        }
        envelope::read(&self.sampler)
    }

    /// Sets it, and remembers it so that the next reload does not read the file's own back over it.
    /// The voice engine takes one at the next buffer; AUSampler takes about a second over it.
    pub fn set_envelope(&mut self, want: Envelope) {
        self.envelope = Some(want);
        if self.exs {
            self.send(Command::Envelope(want));
        } else if self.plugin.is_none() {
            envelope::write(&self.sampler, want);
        }
    }

    /// Puts a hosted Audio Unit instrument in the sampler's place, taking out whichever one played
    /// before it.
    pub fn set_plugin(&mut self, unit: Retained<AVAudioUnitMIDIInstrument>) {
        self.envelope = None;
        self.drop_plugin();
        self.unload_exs();
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

    /// Whichever unit the MIDI goes to: the plugin when one is hosted, AUSampler otherwise. The
    /// voice engine takes commands instead, so every caller of this checks `exs` first.
    fn target(&self) -> &AVAudioUnitMIDIInstrument {
        self.plugin.as_deref().unwrap_or(&self.sampler)
    }

    /// The node the instrument's sound comes out of, which is what the effect chain starts from.
    fn head(&self) -> &AVAudioNode {
        if let Some(plugin) = &self.plugin {
            plugin
        } else if self.exs {
            &self.source
        } else {
            &self.sampler
        }
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
    /// chosen device when it returns. A graph that has stopped is started again even when the
    /// device it plays through has not changed, because AVAudioEngine stops itself whenever the
    /// output hardware changes under it and never starts itself back up.
    pub fn follow_devices(&mut self) -> Result<(), String> {
        let (device, fell_back) = device::resolve(self.chosen_device.as_deref())?;
        if device == self.device && fell_back == self.fell_back && self.running() {
            return Ok(());
        }
        self.play_through(device, fell_back)
    }

    fn running(&self) -> bool {
        unsafe { self.engine.isRunning() }
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

    /// Plays the note and answers the output velocity it was played at, which is the velocity the
    /// rest of the app works in. The remap happens here and only here, so a caller that needs the
    /// output takes it from the return rather than mapping a second time.
    pub fn note_on(&self, note: u8, velocity: u8) -> u8 {
        let velocity = curved(velocity, self.velocity_min, self.velocity_max, self.velocity_curve);
        if self.exs {
            self.send(Command::NoteOn { note, velocity });
        } else {
            unsafe { self.target().startNote_withVelocity_onChannel(note, velocity, CHANNEL) };
        }
        velocity
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
        if self.exs {
            self.send(Command::NoteOff { note });
        } else {
            unsafe { self.target().stopNote_onChannel(note, CHANNEL) };
        }
    }

    /// The sustain pedal. A note let go while it is down keeps sounding until it comes up.
    pub fn sustain(&self, down: bool) {
        if self.exs {
            self.send(Command::Sustain(down));
        } else {
            self.controller(SUSTAIN, if down { 127 } else { 0 });
        }
    }

    /// Ends everything sounding, pedal included: what a stopped play and a lost MIDI port send.
    pub fn release_all(&self) {
        if self.exs {
            self.send(Command::AllOff);
            return;
        }
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

    /// The keyboard volume, 0 to 100: a gain on the finished sound, set in place. Nothing is
    /// reconnected, because any connection change flushes every voice the graph has sounding and
    /// would cut a ringing note off at the moment the fader moved.
    pub fn set_keyboard_volume(&self, percent: u32) {
        unsafe { self.fader.setOutputVolume(percent.min(100) as f32 / 100.0) };
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

/// A SoundFont goes into the sampler by a call of its own, and every other kind whole.
fn sound_bank(path: &Path) -> bool {
    path.extension().is_some_and(|kind| kind.eq_ignore_ascii_case("sf2"))
}

/// An EXS is the app's own to play, samples and all.
fn exs_file(path: &Path) -> bool {
    path.extension().is_some_and(|kind| kind.eq_ignore_ascii_case("exs"))
}

/// The voice engine's node. The block it is built around holds the engine, reads the commands the
/// graph sends it and writes the voices into the two channels the graph asked for. It runs on the
/// audio thread, so it takes no lock, allocates nothing and says nothing: an instrument it stops
/// playing goes down `dead` for another thread to drop.
fn source_node(
    format: &AVAudioFormat,
    orders: Receiver<Command>,
    dead: Sender<Arc<sampler::Instrument>>,
) -> Retained<AVAudioSourceNode> {
    let voices = RefCell::new(Sampler::new(RATE, VOICES));
    let render = RcBlock::new(
        move |_silence: NonNull<Bool>,
              _when: NonNull<AudioTimeStamp>,
              frames: AVAudioFrameCount,
              output: NonNull<AudioBufferList>| {
            let mut voices = voices.borrow_mut();
            while let Ok(command) = orders.try_recv() {
                if let Some(let_go) = voices.apply(command) {
                    let _ = dead.send(let_go);
                }
            }
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
            0
        },
    );
    unsafe {
        AVAudioSourceNode::initWithFormat_renderBlock(
            AVAudioSourceNode::alloc(),
            format,
            RcBlock::as_ptr(&render),
        )
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
    watch_configuration(&graph.engine);
    *GRAPH.lock().unwrap() = Some(graph);
    device::watch(devices_changed);
    static PUMPING: Once = Once::new();
    PUMPING.call_once(|| {
        std::thread::spawn(pump_forever);
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
    status.instrument = graph.instrument().unwrap_or_default().into();
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

/// One key of the MIDI keyboard, down or up. Answers the output velocity the note was played at, so
/// the caller telling the webview about the strike reports the same number the instrument heard.
/// A key coming up carries the velocity it arrived with: only a note on is remapped.
pub fn note(midi: u8, velocity: u8, on: bool) -> u8 {
    with(|graph| {
        if on {
            graph.note_on(midi, velocity)
        } else {
            graph.note_off(midi);
            velocity
        }
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
        graph.note_on(60, 100);
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
        Arc::new(sampler::Instrument {
            zones: vec![sampler::Zone {
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
            samples: vec![sampler::Sample { rate: RATE, data: Box::new(data) }],
        })
    }

    /// The head of the chain moves between the three instruments and back. All of them stay
    /// attached, so what this hears is that only the one chosen is connected: two heads at once
    /// would sum, and a head left behind would go on sounding.
    #[test]
    fn the_head_of_the_chain_moves_between_the_voice_engine_the_sampler_and_a_plugin() {
        let mut graph = Graph::build().unwrap();
        graph.start_offline(PASS).unwrap();

        graph.load_instrument(a_sine_that_starts_at_its_peak()).unwrap();
        let engine = note_peak(&mut graph);
        assert!(engine > 0.01, "the voice engine sounds: {engine}");

        graph.load_file(Path::new(FIXTURE)).unwrap();
        let sampler = note_peak(&mut graph);
        assert!(sampler > 0.01, "the sampler sounds in its place: {sampler}");
        assert!((sampler - engine).abs() > 0.01, "and it is the fixture, not the sine");

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

    /// The keyboard fader trims the finished sound: the same note played twice differs by exactly
    /// what the fader was moved by, and a fader at zero makes no sound at all.
    #[test]
    fn the_fader_trims_the_note_and_zero_is_silence() {
        let mut graph = offline();
        let full = at_volume(&mut graph, 100);
        assert!(full > 0.01, "the fixture sounds at all: {full}");

        let quarter = at_volume(&mut graph, 25);
        assert!(quarter < full / 2.0, "a fader pulled down is quieter: {quarter} against {full}");
        assert!(
            (quarter - full / 4.0).abs() < full / 50.0,
            "and quieter by what the fader says: {quarter} against a quarter of {full}"
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

    /// The one test that plays to a device rather than to a buffer, because a graph in manual
    /// rendering mode has no output unit and so no device to lose. It sounds nothing: no instrument
    /// is loaded and no note is sent. An open device is outside what the spec lets an ordinary run
    /// touch, so: `cargo test -- --ignored a_graph_the_hardware_stopped`.
    #[test]
    #[ignore = "opens a real audio device"]
    fn a_graph_the_hardware_stopped_is_playing_again_after_the_next_device_change() {
        // A Mac with no output device at all has nothing to start on.
        let Ok(default) = device::default_output() else { return };
        let Some(chosen) = device::uid(default) else { return };
        let mut graph = Graph::build().unwrap();
        graph.start().unwrap();
        // Pinned to one device, so a headphone connecting on the machine running the test cannot
        // move the graph and the stop below is the only thing left that explains a silent engine.
        graph.set_device(Some(chosen)).unwrap();

        // What AVAudioEngine does to itself when the output hardware changes under it.
        unsafe { graph.engine.stop() };
        assert!(!graph.running());

        graph.follow_devices().unwrap();
        assert!(graph.running(), "the engine is playing again rather than silent for good");
        assert_eq!(graph.device, default, "through the same device, nothing else having changed");
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
            note(60, velocity, true);
            sleep(Duration::from_millis(900));
            note(60, 0, false);
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

    /// The same measurement for the voice engine, on the two things AUSampler was measured wrong
    /// on: the frames right after the onset, where its first sample stepped to about -40 dBFS at
    /// once, and a re-strike of a key still ringing, where its level fell from 0.027 to 0.000.
    /// Both are read off the real device with the attack at zero, which is the hardest case.
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

        note(60, 127, true);
        sleep(Duration::from_millis(400));
        // The same key again while the first strike is still ringing.
        note(60, 127, true);
        sleep(Duration::from_millis(400));
        note(60, 0, false);
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
    /// the finished sound: what this hears is the sampler answering a different velocity.
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
    /// graph and reads the sampler's file back in, so the instrument that ends up in the path has
    /// to be the one just chosen, however many switches came before it.
    #[test]
    fn switching_instrument_over_and_over_leaves_the_last_one_chosen_playing() {
        let sine = the_samplers_own_sine();
        let mut graph = Graph::build().unwrap();
        graph.start_offline(PASS).unwrap();

        for _ in 0..3 {
            graph.load_file(Path::new(FIXTURE)).unwrap();
            assert_ne!(note_peak(&mut graph), sine, "the file plays");

            graph.set_plugin(hosted_instrument());
            assert!(note_peak(&mut graph) > 0.01, "the plugin plays in its place");

            graph.load_file(Path::new(FIXTURE)).unwrap();
            assert_ne!(note_peak(&mut graph), sine, "and the file takes it back");
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

        assert!(!graph.preview.playing());
        assert_eq!(graph.preview.seconds(), 0.0);
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

        // The fixture's SoundFont asks for a millisecond of release, and that is what is read back.
        let brought = graph.envelope().expect("the sampler's own envelope");
        assert!(brought.release < 0.01, "the file asked for {}", brought.release);
        let short = release_ms(&mut graph);

        graph.set_envelope(Envelope { release: 0.75, ..brought });
        assert_eq!(graph.envelope().expect("the envelope set").release, 0.75);
        let long = release_ms(&mut graph);
        assert!(long > short + 100.0, "{long} ms against {short} ms");

        // Changing an effect rewires the graph, which reads the instrument file in again. The
        // envelope has to outlast that, or it would last only until the next change of anything.
        effects::rewire(&graph).unwrap();
        let after = release_ms(&mut graph);
        assert!(after > short + 100.0, "the rewire left {after} ms");

        // Disposing a sampler that has taken a whole state aborts inside CoreAudio.
        std::mem::forget(graph);
    }
}

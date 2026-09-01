//! The Instrument in force, behind one interface. The graph holds one of these at the head of the
//! effect chain and sends every note, pedal and controller through it, so the note path branches
//! here and nowhere else: the app's own voice engine takes orders down a channel into its render
//! block, a hosted Audio Unit takes MIDI and plays itself, and the tests take one that writes down
//! what it was sent.

use super::{ALL_NOTES_OFF, ALL_SOUND_OFF, CHANNEL, SUSTAIN};
use crate::audio::Envelope;
use crate::audio::preview::Event;
use crate::audio::sampler::{self, Command};
use objc2::rc::Retained;
use objc2_avf_audio::{AVAudioNode, AVAudioSourceNode, AVAudioUnitMIDIInstrument};
use std::sync::mpsc::Sender;

/// Whichever Instrument the graph plays through now.
pub(super) enum Head {
    Voices(Voices),
    Plugin(Plugin),
    #[cfg(test)]
    Recorder(std::sync::Arc<Recorder>),
}

impl Head {
    /// The node the Instrument's sound leaves through, which the effect chain starts from.
    pub fn node(&self) -> &AVAudioNode {
        match self {
            Head::Voices(voices) => &voices.node,
            Head::Plugin(plugin) => &plugin.unit,
            #[cfg(test)]
            Head::Recorder(recorder) => &recorder.node,
        }
    }

    /// Whether the voice engine's own node is the head. Anything else leaves that node out of the
    /// path, where the graph keeps it on a silenced input so the Preview's clock is still
    /// rendered.
    pub fn is_voice_engine(&self) -> bool {
        matches!(self, Head::Voices(_))
    }

    /// Whether the render block plays the Preview's events into this Instrument itself. Otherwise
    /// they leave the block through the ring, and the reporter hands them over with `preview`.
    pub fn takes_preview_in_the_block(&self) -> bool {
        self.is_voice_engine()
    }

    pub fn note_on(&self, note: u8, velocity: u8) {
        match self {
            Head::Voices(voices) => voices.send(Command::NoteOn { note, velocity }),
            Head::Plugin(plugin) => unsafe {
                plugin.unit.startNote_withVelocity_onChannel(note, velocity, CHANNEL);
            },
            #[cfg(test)]
            Head::Recorder(recorder) => recorder.write(Sent::NoteOn(note, velocity)),
        }
    }

    pub fn note_off(&self, note: u8) {
        match self {
            Head::Voices(voices) => voices.send(Command::NoteOff { note }),
            Head::Plugin(plugin) => unsafe { plugin.unit.stopNote_onChannel(note, CHANNEL) },
            #[cfg(test)]
            Head::Recorder(recorder) => recorder.write(Sent::NoteOff(note)),
        }
    }

    /// The sustain pedal. A note let go while it is down keeps sounding until it comes up.
    pub fn sustain(&self, down: bool) {
        if let Head::Voices(voices) = self {
            voices.send(Command::Sustain(down));
        } else {
            self.controller(SUSTAIN, if down { 127 } else { 0 });
        }
    }

    /// Ends everything sounding, pedal included: what a stopped play and a lost MIDI port send.
    pub fn release_all(&self) {
        if let Head::Voices(voices) = self {
            voices.send(Command::AllOff);
        } else {
            self.controller(SUSTAIN, 0);
            self.controller(ALL_NOTES_OFF, 0);
            self.controller(ALL_SOUND_OFF, 0);
        }
    }

    pub fn controller(&self, controller: u8, value: u8) {
        match self {
            // The voice engine knows the pedal alone; every other controller says nothing to it.
            Head::Voices(voices) => {
                if controller == SUSTAIN {
                    voices.send(Command::Sustain(value >= 64));
                }
            }
            Head::Plugin(plugin) => unsafe {
                plugin.unit.sendController_withValue_onChannel(controller, value, CHANNEL);
            },
            #[cfg(test)]
            Head::Recorder(recorder) => recorder.write(Sent::Controller(controller, value)),
        }
    }

    /// One Preview event the reporter took out of the ring. Its velocity has already been through
    /// the curve, so nothing is remapped here.
    pub fn preview(&self, event: Event) {
        match self {
            #[cfg(test)]
            Head::Recorder(recorder) => recorder.write(Sent::Preview(event)),
            _ if event.on => self.note_on(event.midi, event.velocity),
            _ => self.note_off(event.midi),
        }
    }

    /// The Envelope this Instrument answers a key with, which is what the panel shows. Nothing for
    /// an Instrument that shapes its notes behind its own window, and nothing until a file is in.
    pub fn envelope(&self) -> Option<Envelope> {
        if let Head::Voices(voices) = self { voices.envelope } else { None }
    }

    /// Sets it, and remembers it so the panel shows what is playing. The voice engine takes it at
    /// the next buffer, and every note struck from there on follows it.
    pub fn set_envelope(&mut self, want: Envelope) {
        match self {
            Head::Voices(voices) => {
                voices.envelope = Some(want);
                voices.send(Command::Envelope(want));
            }
            #[cfg(test)]
            Head::Recorder(recorder) => recorder.write(Sent::Envelope(want)),
            Head::Plugin(_) => {}
        }
    }

    /// The Roles beside the tone this Instrument has samples for, which is what the panel offers a
    /// level for. Empty for a plugin and for a file with none of them.
    pub fn roles(&self) -> &[sampler::Role] {
        if let Head::Voices(voices) = self { &voices.roles } else { &[] }
    }

    /// How loud one of the noises around the tone sounds, as a percent of the sample.
    pub fn set_role_level(&self, role: sampler::Role, percent: u32) {
        match self {
            Head::Voices(voices) => {
                voices.send(Command::RoleLevel { role, level: percent.min(100) as f32 / 100.0 });
            }
            #[cfg(test)]
            Head::Recorder(recorder) => recorder.write(Sent::RoleLevel(role, percent)),
            Head::Plugin(_) => {}
        }
    }

    /// The hosted plugin, the one Instrument with a window of its own.
    pub fn plugin(&self) -> Option<&AVAudioUnitMIDIInstrument> {
        if let Head::Plugin(plugin) = self { Some(&plugin.unit) } else { None }
    }

    /// The unit an Instrument leaving the head takes with it, which the graph detaches and hands
    /// to the main thread.
    pub fn into_plugin(self) -> Option<Retained<AVAudioUnitMIDIInstrument>> {
        if let Head::Plugin(plugin) = self { Some(plugin.unit) } else { None }
    }
}

/// The app's own voice engine: orders travel down the channel into the render block that holds the
/// voices, and the sound leaves through the node that block sits behind.
pub(super) struct Voices {
    node: Retained<AVAudioSourceNode>,
    commands: Sender<Command>,
    /// Nothing until a file is in, which is what leaves the panel with no Envelope to show.
    envelope: Option<Envelope>,
    roles: Vec<sampler::Role>,
}

impl Voices {
    pub fn new(
        node: Retained<AVAudioSourceNode>,
        commands: Sender<Command>,
        envelope: Option<Envelope>,
        roles: Vec<sampler::Role>,
    ) -> Self {
        Voices { node, commands, envelope, roles }
    }

    /// One order, taken up at the next render. Nothing waits for it: the channel is unbounded and
    /// the engine reads it dry every buffer.
    fn send(&self, command: Command) {
        let _ = self.commands.send(command);
    }
}

/// A hosted Audio Unit instrument, which takes MIDI and makes its own sound.
pub(super) struct Plugin {
    unit: Retained<AVAudioUnitMIDIInstrument>,
}

impl Plugin {
    pub fn new(unit: Retained<AVAudioUnitMIDIInstrument>) -> Self {
        Plugin { unit }
    }
}

/// One call the graph made on the Instrument at the head, as the recorder wrote it down.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Sent {
    NoteOn(u8, u8),
    NoteOff(u8),
    Controller(u8, u8),
    Envelope(Envelope),
    RoleLevel(sampler::Role, u32),
    Preview(Event),
}

/// An Instrument that makes no sound and writes down every call instead, so a test reads what the
/// graph sent rather than how loud the graph became. Its node renders silence, so the chain is
/// wired to it exactly as it is to a plugin.
#[cfg(test)]
pub(super) struct Recorder {
    node: Retained<AVAudioSourceNode>,
    sent: std::sync::Mutex<Vec<Sent>>,
}

// Held by the graph and by the test that installed it. Its node is reached only through the
// graph's own mutex, as every AVFAudio object in the engine is, and its list has a lock of its own.
#[cfg(test)]
unsafe impl Send for Recorder {}
#[cfg(test)]
unsafe impl Sync for Recorder {}

#[cfg(test)]
impl Recorder {
    pub fn new(format: &objc2_avf_audio::AVAudioFormat) -> Self {
        use block2::RcBlock;
        use objc2::AllocAnyThread;
        use objc2::runtime::Bool;
        use objc2_avf_audio::AVAudioFrameCount;
        use objc2_core_audio_types::{AudioBuffer, AudioBufferList, AudioTimeStamp};
        use std::ptr::NonNull;

        let render = RcBlock::new(
            |silence: NonNull<Bool>,
             _when: NonNull<AudioTimeStamp>,
             _frames: AVAudioFrameCount,
             output: NonNull<AudioBufferList>| {
                // The buffers come in with whatever was last in them, so they are cleared as well
                // as flagged: an engine that renders the pass all the same must hear silence.
                unsafe {
                    let list = output.as_ptr();
                    let buffers = std::slice::from_raw_parts_mut(
                        (&raw mut (*list).mBuffers).cast::<AudioBuffer>(),
                        (*list).mNumberBuffers as usize,
                    );
                    for buffer in buffers {
                        std::slice::from_raw_parts_mut(
                            buffer.mData.cast::<u8>(),
                            buffer.mDataByteSize as usize,
                        )
                        .fill(0);
                    }
                    silence.write(Bool::YES);
                }
                0
            },
        );
        let node = unsafe {
            AVAudioSourceNode::initWithFormat_renderBlock(
                AVAudioSourceNode::alloc(),
                format,
                RcBlock::as_ptr(&render),
            )
        };
        Recorder { node, sent: std::sync::Mutex::new(Vec::new()) }
    }

    /// Its own node, which the graph attaches and wires the chain to.
    pub fn node(&self) -> &AVAudioNode {
        &self.node
    }

    fn write(&self, one: Sent) {
        self.sent.lock().unwrap().push(one);
    }

    /// Everything sent since the last read, and the list emptied for the next one.
    pub fn taken(&self) -> Vec<Sent> {
        std::mem::take(&mut self.sent.lock().unwrap())
    }
}

//! The reader that opens the machine's MIDI ports. One connection per port being listened on, each
//! with a `Parser` of its own, so two keyboards sending running status never read each other's
//! bytes.
//!
//! midir reports no plug and no unplug, so a thread of its own re-lists the ports about once a
//! second and only acts when the list is not the one already open.

use crate::audio::engine;
use crate::midi::{Message, Parser, Pedal, Port, Status, Strike, relisten};
use midir::{MidiInput, MidiInputConnection};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri_specta::Event;

/// The name the MIDI system shows the app under to everything else on the machine.
const CLIENT: &str = "murline";

/// How long between two readings of the port list.
const POLL: Duration = Duration::from_secs(1);

static READER: Mutex<Reader> = Mutex::new(Reader {
    app: None,
    midi: None,
    error: None,
    pinned: None,
    hidden: Vec::new(),
    open: Vec::new(),
    listed: Vec::new(),
});

struct Reader {
    app: Option<AppHandle>,
    /// Lists the ports. Held for as long as the app runs, and never used to open one: opening
    /// consumes the `MidiInput` it is opened from, so every connection gets one of its own.
    midi: Option<MidiInput>,
    /// Why there is no MIDI at all, which is the one line the settings dialog shows. A single port
    /// that will not open is not this: it is passed over and the others still play.
    error: Option<String>,
    /// The one port to listen on, whether the player picked it for the session or for good.
    pinned: Option<String>,
    /// The ports the player has put away. Passed over while nothing is pinned.
    hidden: Vec<String>,
    /// The ports being listened on, by port id. Dropping one closes it.
    open: Vec<(String, MidiInputConnection<()>)>,
    listed: Vec<Port>,
}

impl Reader {
    /// Every port the machine now has. The id comes from midir: on macOS the CoreMIDI unique id,
    /// which the same keyboard keeps across a re-plug, and on Windows the device interface path.
    fn ports(&self) -> Vec<Port> {
        let Some(midi) = &self.midi else {
            return Vec::new();
        };
        midi.ports()
            .iter()
            .map(|port| {
                let id = port.id();
                let name = midi.port_name(port).unwrap_or_else(|_| id.clone());
                Port { id, name }
            })
            .collect()
    }

    /// Lists the ports, opens the ones the listening rule asks for, closes the rest, and tells the
    /// webview. Everything a plug, an unplug and a change of rule all go through.
    fn sync(&mut self) {
        let listed = self.ports();
        let open: Vec<String> = self.open.iter().map(|(id, _)| id.clone()).collect();
        let (wanted, dropped) = relisten(&open, &listed, self.pinned.as_deref(), &self.hidden);

        self.open.retain(|(id, _)| wanted.contains(id));
        // A port that went is a port that will never send the note offs for what it was holding.
        if dropped && let Some(graph) = engine::graph() {
            graph.release_all();
        }
        for id in &wanted {
            // A port another app holds open for itself is simply left out; the rest still play.
            if !open.contains(id)
                && let Some(connection) = self.listen(id)
            {
                self.open.push((id.clone(), connection));
            }
        }

        self.listed = listed;
        let status = self.status();
        if let Some(app) = &self.app {
            let _ = status.emit(app);
        }
    }

    /// One port, opened on a client of its own that reads it until the connection is dropped.
    fn listen(&self, id: &str) -> Option<MidiInputConnection<()>> {
        let midi = MidiInput::new(CLIENT).ok()?;
        let port = midi.find_port_by_id(id.to_string())?;
        let app = self.app.clone();
        let mut parser = Parser::default();
        midi.connect(
            &port,
            CLIENT,
            move |_stamp, bytes, ()| {
                let time = now_ms();
                parser.feed(bytes, |message| play(app.as_ref(), message, time));
            },
            (),
        )
        .ok()
    }

    fn status(&self) -> Status {
        let devices = self
            .open
            .iter()
            .filter_map(|(id, _)| self.listed.iter().find(|port| &port.id == id))
            .map(|port| port.name.clone())
            .collect();
        Status {
            devices,
            ports: self.listed.clone(),
            pinned: self.pinned.clone(),
            error: self.error.clone(),
        }
    }
}

/// The moment a message was read, as Unix milliseconds: the timeline the webview stamps its own
/// events with. midir's own stamp counts microseconds from a point the platform picks, which is
/// not that timeline and cannot be turned into it.
fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64() * 1e3
}

/// One message: the instrument hears it first, and the webview is told after, because the sound is
/// what the player is waiting for and the screen is not.
///
/// The velocity the webview is told about is the one the note was played at, not the one the
/// keyboard sent: the remap governs the whole app, so grading, Wait mode and the last-strike
/// readout all read the output velocity. `note` answers with it, which is what keeps the map from
/// being applied a second time here.
fn play(app: Option<&AppHandle>, message: Message, time: f64) {
    match message {
        Message::Note { midi, velocity, on } => {
            // Without a graph the key sounded nowhere, so the velocity it arrived at is the one.
            let velocity =
                engine::graph().map_or(velocity, |graph| graph.note(midi, velocity, on, false));
            if let Some(app) = app {
                let _ = Strike { midi, velocity, time, on }.emit(app);
            }
        }
        Message::Pedal { value } => {
            if let Some(graph) = engine::graph() {
                graph.sustain(Message::pedal_down(value));
            }
            if let Some(app) = app {
                let _ = Pedal { value }.emit(app);
            }
        }
    }
}

/// The rule is in force before the first sync, so the ports that open at boot are the ones the
/// player left the app listening on.
pub fn start(app: AppHandle, pinned: Option<String>, hidden: Vec<String>) {
    let mut reader = READER.lock().unwrap();
    reader.app = Some(app);
    reader.pinned = pinned;
    reader.hidden = hidden;
    match MidiInput::new(CLIENT) {
        Ok(midi) => reader.midi = Some(midi),
        Err(error) => reader.error = Some(format!("MIDI is unavailable ({error})")),
    }
    let watching = reader.midi.is_some();
    reader.sync();
    drop(reader);
    if watching {
        thread::spawn(watch);
    }
}

/// Follows the hardware for as long as the app runs. Reading the list is cheap; opening ports and
/// telling the webview is not, and neither happens while the list stays as it was.
fn watch() {
    loop {
        thread::sleep(POLL);
        let mut reader = READER.lock().unwrap();
        let listed = reader.ports();
        if listed != reader.listed {
            reader.sync();
        }
    }
}

pub fn status() -> Status {
    READER.lock().unwrap().status()
}

pub fn listen(pinned: Option<String>, hidden: Vec<String>) {
    let mut reader = READER.lock().unwrap();
    reader.pinned = pinned;
    reader.hidden = hidden;
    reader.sync();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_is_stamped_in_unix_milliseconds() {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1e3;
        assert!((now_ms() - now).abs() < 1000.0, "{} against {now}", now_ms());
    }

    /// The whole path a key press takes, on a port the test makes itself. It needs the macOS sound
    /// engine to hear the note, and a virtual port, which Windows gives no way to make.
    #[cfg(target_os = "macos")]
    mod sounding {
        use super::*;
        use crate::audio;
        use midir::MidiOutput;
        use midir::os::unix::VirtualOutput;
        use std::thread::sleep;

        /// The same two kilobytes of SoundFont the engine's own tests play: one sine across the
        /// keyboard, so a note that reaches the instrument is a peak the test can read.
        const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/sine.sf2");
        const PASS: u32 = 4096;
        const LOOK: u32 = 4410;
        const KEYBOARD: &str = "piano test keyboard";

        /// Waits for something the MIDI system does on a thread of its own. Generous, because the
        /// first message of a run waits for the MIDI server to come up and that is not always
        /// quick.
        fn until(mut done: impl FnMut() -> bool) -> bool {
            (0..500).any(|_| {
                sleep(Duration::from_millis(10));
                done()
            })
        }

        fn id_of(reader: &Reader, name: &str) -> Option<String> {
            reader.ports().into_iter().find(|port| port.name == name).map(|port| port.id)
        }

        #[test]
        fn a_key_on_the_pinned_port_sounds_and_the_port_going_away_ends_it() {
            let mut graph = audio::mac::Graph::build().unwrap();
            graph.load_file(std::path::Path::new(FIXTURE)).unwrap();
            graph.start_offline(PASS).unwrap();
            audio::mac::install(graph);

            let mut keyboard =
                MidiOutput::new("piano test").unwrap().create_virtual(KEYBOARD).unwrap();

            let mut reader = READER.lock().unwrap();
            reader.midi = Some(MidiInput::new("piano test reader").unwrap());
            assert!(until(|| id_of(&reader, KEYBOARD).is_some()));
            reader.pinned = id_of(&reader, KEYBOARD);
            reader.sync();
            assert_eq!(reader.status().devices, [KEYBOARD], "{:?}", reader.error);

            keyboard.send(&[0x90, 60, 100]).unwrap();
            assert!(until(|| audio::mac::peak(LOOK) > 0.01), "the key never reached the instrument");

            // Unplugged. The note off will never come, so everything sounding has to be let go.
            drop(keyboard);
            assert!(until(|| id_of(&reader, KEYBOARD).is_none()));
            reader.sync();
            assert!(reader.status().devices.is_empty());
            audio::mac::peak(LOOK);
            assert_eq!(audio::mac::peak(LOOK), 0.0, "a note rang on after the unplug");
        }
    }
}

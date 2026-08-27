//! The CoreMIDI reader. One client for the app, one input port per source it listens on, and one
//! `Parser` inside each port's callback, so two keyboards sending running status never read each
//! other's bytes.
//!
//! CoreMIDI input ports are shared by every client on the machine, so Logic or a tuner open beside
//! the app keeps receiving the same keyboard.

use crate::audio;
use crate::midi::{Message, Parser, Pedal, Port, Status, Strike, relisten};
use coremidi::{Client, InputPort, Notification, Source, Sources};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// Event names the webview listens on. The strike payload is the shape the play engine reads.
const STRIKE: &str = "midi-strike";
const PEDAL: &str = "midi-pedal";
const PORTS: &str = "midi-ports";

static READER: Mutex<Reader> = Mutex::new(Reader {
    app: None,
    client: None,
    error: None,
    pinned: None,
    open: Vec::new(),
    listed: Vec::new(),
});

struct Reader {
    app: Option<AppHandle>,
    /// Held for as long as the app runs: dropping it takes the notifications with it.
    client: Option<Client>,
    /// Why there is no MIDI at all, which is the one line the settings dialog shows.
    error: Option<String>,
    pinned: Option<String>,
    /// The ports being listened on, by source id. Dropping one closes it.
    open: Vec<(String, InputPort)>,
    listed: Vec<Port>,
}

impl Reader {
    /// Lists the machine's sources, opens the ones the pin asks for, closes the rest, and tells the
    /// webview. Everything a plug, an unplug and a change of pin all go through.
    fn sync(&mut self) {
        let listed: Vec<Port> = Sources
            .into_iter()
            .filter_map(|source| {
                let id = source.unique_id()?.to_string();
                let name = source.display_name().unwrap_or_else(|| id.clone());
                Some(Port { id, name })
            })
            .collect();
        let open: Vec<String> = self.open.iter().map(|(id, _)| id.clone()).collect();
        let (wanted, dropped) = relisten(&open, &listed, self.pinned.as_deref());

        self.open.retain(|(id, _)| wanted.contains(id));
        // A port that went is a port that will never send the note offs for what it was holding.
        if dropped {
            audio::mac::release_all();
        }
        let mut trouble = None;
        for id in &wanted {
            if open.contains(id) {
                continue;
            }
            match self.listen(id) {
                Ok(port) => self.open.push((id.clone(), port)),
                Err(status) => trouble = Some(format!("MIDI port {id} would not open ({status})")),
            }
        }
        // A port that would not open is this run's trouble, not the session's: the next re-list
        // clears it. The client failing to exist at all is kept, because nothing clears that.
        if self.client.is_some() {
            self.error = trouble;
        }

        self.listed = listed;
        let status = self.status();
        if let Some(app) = &self.app {
            let _ = app.emit(PORTS, status);
        }
    }

    /// One source, opened on a port of its own that reads it until the port is dropped.
    fn listen(&self, id: &str) -> Result<InputPort, i32> {
        let source = id
            .parse()
            .ok()
            .and_then(Source::from_unique_id)
            .ok_or(0)?;
        let app = self.app.clone();
        let mut parser = Parser::default();
        let port = self.client.as_ref().ok_or(0)?.input_port(id, move |packets| {
            for packet in packets.iter() {
                let time = unix_ms(packet.timestamp());
                parser.feed(packet.data(), |message| play(app.as_ref(), message, time));
            }
        })?;
        port.connect_source(&source)?;
        Ok(port)
    }

    fn status(&self) -> Status {
        let devices = self
            .open
            .iter()
            .filter_map(|(id, _)| self.listed.iter().find(|port| &port.id == id))
            .map(|port| port.name.clone())
            .collect();
        Status { devices, ports: self.listed.clone(), error: self.error.clone() }
    }
}

/// One message: the instrument hears it first, and the webview is told after, because the sound is
/// what the player is waiting for and the screen is not.
fn play(app: Option<&AppHandle>, message: Message, time: f64) {
    match message {
        Message::Note { midi, velocity, on } => {
            audio::mac::note(midi, velocity, on);
            if let Some(app) = app {
                let _ = app.emit(STRIKE, Strike { midi, velocity, time, on });
            }
        }
        Message::Pedal { value } => {
            audio::mac::pedal(value);
            if let Some(app) = app {
                let _ = app.emit(PEDAL, Pedal { value });
            }
        }
    }
}

pub fn start(app: AppHandle) {
    let mut reader = READER.lock().unwrap();
    reader.app = Some(app);
    // The notifications arrive on the run loop that was current here, which is the main one Tauri
    // runs for as long as the window is open.
    match Client::new_with_notifications("piano", |notification: &Notification| {
        use Notification::{ObjectAdded, ObjectRemoved, SetupChanged};
        if matches!(notification, SetupChanged | ObjectAdded(_) | ObjectRemoved(_)) {
            READER.lock().unwrap().sync();
        }
    }) {
        Ok(client) => reader.client = Some(client),
        Err(status) => reader.error = Some(format!("MIDI is unavailable ({status})")),
    }
    reader.sync();
}

pub fn status() -> Status {
    READER.lock().unwrap().status()
}

pub fn pin(id: Option<String>) {
    let mut reader = READER.lock().unwrap();
    reader.pinned = id;
    reader.sync();
}

#[repr(C)]
struct Timebase {
    numer: u32,
    denom: u32,
}

unsafe extern "C" {
    fn mach_absolute_time() -> u64;
    fn mach_timebase_info(info: *mut Timebase) -> i32;
}

/// Milliseconds one mach tick is worth, and the Unix millisecond tick zero fell on. Sampled once,
/// which is what keeps these times on the same timeline as the webview's
/// `performance.timeOrigin + performance.now()`: that pair is sampled once too, and neither clock
/// counts the time the Mac spends asleep.
fn clock() -> (f64, f64) {
    static CLOCK: OnceLock<(f64, f64)> = OnceLock::new();
    *CLOCK.get_or_init(|| {
        let mut base = Timebase { numer: 1, denom: 1 };
        unsafe { mach_timebase_info(&mut base) };
        let per_tick = f64::from(base.numer) / f64::from(base.denom) / 1e6;
        let ticks = unsafe { mach_absolute_time() } as f64;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
        (per_tick, now.as_secs_f64() * 1e3 - ticks * per_tick)
    })
}

/// A CoreMIDI timestamp as Unix milliseconds. Zero means now, which is what a keyboard playing
/// live sends.
fn unix_ms(timestamp: u64) -> f64 {
    let (per_tick, origin) = clock();
    let ticks = if timestamp == 0 { unsafe { mach_absolute_time() } } else { timestamp };
    ticks as f64 * per_tick + origin
}

#[cfg(test)]
mod tests {
    use super::*;
    use coremidi::PacketBuffer;
    use std::thread::sleep;
    use std::time::Duration;

    /// The same two kilobytes of SoundFont the engine's own tests play: one sine across the
    /// keyboard, so a note that reaches the instrument is a peak the test can read.
    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/sine.sf2");
    const PASS: u32 = 4096;
    const LOOK: u32 = 4410;

    /// Waits for something CoreMIDI does on a thread of its own. Generous, because the first
    /// message of a run waits for the MIDI server to come up and that is not always quick.
    fn until(mut done: impl FnMut() -> bool) -> bool {
        (0..500).any(|_| {
            sleep(Duration::from_millis(10));
            done()
        })
    }

    fn listed(id: &str) -> bool {
        Sources.into_iter().any(|source| source.unique_id().is_some_and(|u| u.to_string() == id))
    }

    /// The whole path a key press takes, on a source the test makes itself: CoreMIDI to the parser
    /// to the instrument. Nothing here needs a keyboard or an audio device.
    #[test]
    fn a_key_on_the_pinned_port_sounds_and_the_port_going_away_ends_it() {
        let mut graph = audio::mac::Graph::build().unwrap();
        graph.load_sound_bank(std::path::Path::new(FIXTURE), "Sine".into()).unwrap();
        graph.start_offline(PASS).unwrap();
        audio::mac::install(graph);

        let client = Client::new("piano test").unwrap();
        let keyboard = client.virtual_source("piano test keyboard").unwrap();
        let id = keyboard.unique_id().unwrap().to_string();

        let mut reader = READER.lock().unwrap();
        reader.client = Some(Client::new("piano test reader").unwrap());
        reader.pinned = Some(id.clone());
        assert!(until(|| listed(&id)));
        reader.sync();
        assert_eq!(reader.status().devices, ["piano test keyboard"], "{:?}", reader.error);

        keyboard.received(&PacketBuffer::new(0, &[0x90, 60, 100])).unwrap();
        assert!(until(|| audio::mac::peak(LOOK) > 0.01), "the key never reached the instrument");

        // Unplugged. The note off will never come, so everything sounding has to be let go.
        drop(keyboard);
        assert!(until(|| !listed(&id)));
        reader.sync();
        assert!(reader.status().devices.is_empty());
        audio::mac::peak(LOOK);
        assert_eq!(audio::mac::peak(LOOK), 0.0, "a note rang on after the unplug");
    }

    #[test]
    fn a_timestamp_reads_as_the_wall_clock_the_webview_stamps_its_own_events_with() {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1e3;
        // Zero is what a live keyboard sends, and it means the moment the packet arrived.
        assert!((unix_ms(0) - now).abs() < 1000.0, "{} against {now}", unix_ms(0));

        // Ticks are not milliseconds; five milliseconds of them have to read as about five.
        let first = unsafe { mach_absolute_time() };
        std::thread::sleep(std::time::Duration::from_millis(5));
        let apart = unix_ms(unsafe { mach_absolute_time() }) - unix_ms(first);
        assert!((5.0..25.0).contains(&apart), "{apart} ms apart");
    }
}

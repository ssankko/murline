//! The app's one reader of MIDI input. Rust opens the ports, feeds every note and the sustain
//! pedal to the sound engine, and only then tells the webview what was played, so the sound never
//! waits on a round trip through JavaScript.
//!
//! What crosses into the webview is a strike of MIDI number, velocity, on or off, and a
//! Unix-millisecond time: one shape on every platform, none of it naming a MIDI system.

use crate::settings;
use serde::Serialize;
use serde_json::Value;

mod input;

/// The sustain pedal's controller number. The only controller that reaches the instrument: soft
/// pedal, sostenuto, pitch bend and the rest are dropped where they are parsed.
const SUSTAIN: u8 = 64;
/// The pedal is down from half travel up, as every MIDI device and host reads controller 64.
const PEDAL_DOWN: u8 = 64;

/// One MIDI input port as the settings dialog lists it. The id is stable across a re-plug, so a
/// pinned keyboard is the same keyboard when it comes back.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Port {
    pub id: String,
    pub name: String,
}

/// What the webview's MIDI module shows: the ports being listened to, every port the machine has,
/// the one port pinned if there is one, and the one line saying why there is no MIDI at all.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Status {
    pub devices: Vec<String>,
    pub ports: Vec<Port>,
    pub pinned: Option<String>,
    pub error: Option<String>,
}

/// One strike as the play engine reads it, and as the webview has always received it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Strike {
    pub midi: u8,
    pub velocity: u8,
    /// Unix milliseconds, the timeline `performance.timeOrigin + performance.now()` runs on.
    pub time: f64,
    pub on: bool,
}

/// A sustain pedal move, 0 to 127 as the pedal sent it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Pedal {
    pub value: u8,
}

/// What one MIDI message turns into. Everything else the keyboard sends is dropped here.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Message {
    /// A key going down or coming up. Velocity is raw; the velocity offset is a grading
    /// calibration and stays on the webview side.
    Note { midi: u8, velocity: u8, on: bool },
    Pedal { value: u8 },
}

impl Message {
    pub fn pedal_down(value: u8) -> bool {
        value >= PEDAL_DOWN
    }
}

/// Reads the byte stream one port sends. Kept apart from the ports so the whole of the reading is
/// testable without a keyboard: a port hands its bytes to `feed` and gets messages back.
///
/// Running status is why this is a state machine and not a match on three bytes: a keyboard is free
/// to send the status byte once and then only note pairs, and packets may split anywhere.
#[derive(Default)]
pub struct Parser {
    /// The channel status byte in force, zero when none is.
    status: u8,
    /// The first data byte of the message being read.
    first: u8,
    /// How many data bytes of it have arrived.
    have: u8,
}

impl Parser {
    pub fn feed(&mut self, bytes: &[u8], mut emit: impl FnMut(Message)) {
        for &byte in bytes {
            match byte {
                // Clock, start and stop may sit between the bytes of a note and change nothing.
                0xf8..=0xff => {}
                // Anything else system ends running status; none of it reaches the instrument.
                0xf0..=0xf7 => {
                    self.status = 0;
                    self.have = 0;
                }
                0x80..=0xef => {
                    self.status = byte;
                    self.have = 0;
                }
                _ if self.status == 0 => {}
                _ if self.have + 1 < self.wants() => {
                    self.first = byte;
                    self.have += 1;
                }
                _ => {
                    self.have = 0;
                    match self.status & 0xf0 {
                        // A note on of velocity zero is a note off, which is what a keyboard
                        // sending running status uses to end a note.
                        0x90 => {
                            let on = byte > 0;
                            emit(Message::Note { midi: self.first, velocity: byte, on });
                        }
                        0x80 => emit(Message::Note { midi: self.first, velocity: byte, on: false }),
                        0xb0 if self.first == SUSTAIN => emit(Message::Pedal { value: byte }),
                        _ => {}
                    }
                }
            }
        }
    }

    /// Data bytes the message in force is made of.
    fn wants(&self) -> u8 {
        match self.status & 0xf0 {
            0xc0 | 0xd0 => 1,
            _ => 2,
        }
    }
}

/// The ports to listen on out of everything the machine now has, and whether one that is open is
/// not among them. A pin is the only port opened, hidden or not; with no pin, every listed port
/// the player has not hidden. A port that is dropped, unplugged, unpinned or hidden, leaves behind
/// every note it was holding, so the caller releases all of them when this says one is dropped.
fn relisten(
    open: &[String],
    listed: &[Port],
    pinned: Option<&str>,
    hidden: &[String],
) -> (Vec<String>, bool) {
    let wanted: Vec<String> = listed
        .iter()
        .filter(|port| match pinned {
            Some(id) => port.id == id,
            None => !hidden.contains(&port.id),
        })
        .map(|port| port.id.clone())
        .collect();
    let dropped = open.iter().any(|id| !wanted.contains(id));
    (wanted, dropped)
}

/// The listening rule the stored settings hold: the port pinned for good, and the ports put away.
/// A value of another shape than the window writes is no rule at all.
fn rule(device: Option<Value>, hidden: Option<Value>) -> (Option<String>, Vec<String>) {
    let id = |value: Value| match value {
        Value::String(id) => Some(id),
        _ => None,
    };
    let hidden = match hidden {
        Some(Value::Array(ids)) => ids.into_iter().filter_map(id).collect(),
        _ => Vec::new(),
    };
    (device.and_then(id), hidden)
}

/// Opens the ports and keeps them open for as long as the app runs. Called once at setup, before
/// the webview asks anything, so a key pressed on the boot screen already sounds, and on the rule
/// the player left behind, so a hidden port stays shut through the boot.
pub fn start(app: tauri::AppHandle) {
    let (pinned, hidden) =
        rule(settings::one(&app, "midi_device"), settings::one(&app, "midi_hidden"));
    input::start(app, pinned, hidden);
}

#[tauri::command]
pub fn midi_status() -> Status {
    input::status()
}

/// The rule the ports follow: listen on the pinned port alone, or on every port outside the hidden
/// list when nothing is pinned. The webview owns both, out of the session and the settings, and
/// sends them whole at every change.
#[tauri::command]
pub fn midi_listen(pinned: Option<String>, hidden: Vec<String>) {
    input::listen(pinned, hidden);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(bytes: &[u8]) -> Vec<Message> {
        let mut parser = Parser::default();
        let mut out = Vec::new();
        parser.feed(bytes, |message| out.push(message));
        out
    }

    fn note(midi: u8, velocity: u8, on: bool) -> Message {
        Message::Note { midi, velocity, on }
    }

    fn port(id: &str) -> Port {
        Port { id: id.into(), name: format!("{id} keyboard") }
    }

    #[test]
    fn a_key_down_and_up_are_one_strike_each() {
        assert_eq!(parse(&[0x90, 60, 100]), [note(60, 100, true)]);
        assert_eq!(parse(&[0x80, 60, 64]), [note(60, 64, false)]);
    }

    #[test]
    fn a_note_on_of_no_velocity_is_the_key_coming_up() {
        assert_eq!(parse(&[0x90, 60, 0]), [note(60, 0, false)]);
    }

    #[test]
    fn a_status_byte_sent_once_reads_every_pair_after_it() {
        assert_eq!(
            parse(&[0x90, 60, 100, 64, 90, 60, 0]),
            [note(60, 100, true), note(64, 90, true), note(60, 0, false)]
        );
    }

    #[test]
    fn a_message_split_across_packets_is_still_one_message() {
        let mut parser = Parser::default();
        let mut out = Vec::new();
        for packet in [&[0x90u8][..], &[60][..], &[100][..]] {
            parser.feed(packet, |message| out.push(message));
        }
        assert_eq!(out, [note(60, 100, true)]);
    }

    #[test]
    fn a_clock_byte_between_the_bytes_of_a_note_changes_nothing() {
        assert_eq!(parse(&[0x90, 0xf8, 60, 0xf8, 100]), [note(60, 100, true)]);
    }

    #[test]
    fn the_sustain_pedal_comes_through_and_no_other_controller_does() {
        assert_eq!(parse(&[0xb0, 64, 127]), [Message::Pedal { value: 127 }]);
        assert_eq!(parse(&[0xb0, 64, 0]), [Message::Pedal { value: 0 }]);
        // Soft pedal, sostenuto and everything else are the instrument's business, not the app's.
        assert_eq!(parse(&[0xb0, 67, 127]), []);
        assert_eq!(parse(&[0xb0, 66, 127]), []);
        assert_eq!(parse(&[0xb0, 1, 127]), []);
    }

    #[test]
    fn pitch_bend_and_program_change_are_dropped_without_losing_the_note_after_them() {
        assert_eq!(parse(&[0xe0, 0, 64, 0x90, 60, 100]), [note(60, 100, true)]);
        // A program change is one data byte long; reading it as two would eat the note on.
        assert_eq!(parse(&[0xc0, 5, 0x90, 60, 100]), [note(60, 100, true)]);
    }

    #[test]
    fn a_system_message_ends_running_status_so_its_bytes_are_not_read_as_notes() {
        assert_eq!(parse(&[0x90, 60, 100, 0xf0, 1, 2, 3, 0xf7]), [note(60, 100, true)]);
    }

    #[test]
    fn a_pedal_over_half_travel_is_down() {
        assert!(Message::pedal_down(127));
        assert!(Message::pedal_down(64));
        assert!(!Message::pedal_down(63));
        assert!(!Message::pedal_down(0));
    }

    /// The first sync of a run, over the rule the stored settings hold: nothing is open yet, and
    /// what opens is what the player left the app on.
    #[test]
    fn a_boot_opens_the_ports_the_stored_settings_leave_open() {
        let boot = |device, hidden| {
            let (pinned, hidden) = rule(device, hidden);
            relisten(&[], &[port("a"), port("b")], pinned.as_deref(), &hidden).0
        };

        assert_eq!(boot(Some(json!("b")), None), ["b"], "the pinned port alone");
        assert_eq!(boot(None, Some(json!(["b"]))), ["a"], "a hidden port stays shut");
        assert_eq!(boot(None, None), ["a", "b"], "nothing pinned and nothing hidden");
        assert_eq!(boot(Some(json!(null)), Some(json!(null))), ["a", "b"], "no rule stored");
    }

    #[test]
    fn a_port_that_goes_away_is_dropped_and_the_rest_are_listened_to_again() {
        let (open, dropped) = relisten(&["a".into()], &[port("a"), port("b")], None, &[]);
        assert_eq!(open, ["a", "b"]);
        assert!(!dropped, "nothing left");

        let (open, dropped) = relisten(&["a".into(), "b".into()], &[port("b")], None, &[]);
        assert_eq!(open, ["b"]);
        assert!(dropped, "a is gone, so everything it was holding must be released");
    }

    #[test]
    fn a_pinned_port_is_the_only_one_opened_and_it_is_reopened_when_it_returns() {
        let (open, dropped) = relisten(&[], &[port("a"), port("b")], Some("b"), &[]);
        assert_eq!(open, ["b"]);
        assert!(!dropped);

        // Unplugged: the pin stands, and there is nothing to open.
        let (open, dropped) = relisten(&["b".into()], &[port("a")], Some("b"), &[]);
        assert_eq!(open, [] as [String; 0]);
        assert!(dropped);

        // Plugged back in under the same id: open again, without a restart.
        let (open, dropped) = relisten(&[], &[port("a"), port("b")], Some("b"), &[]);
        assert_eq!(open, ["b"]);
        assert!(!dropped);
    }

    #[test]
    fn pinning_another_port_drops_the_one_that_was_open_so_nothing_it_held_rings_on() {
        let (open, dropped) = relisten(&["a".into()], &[port("a"), port("b")], Some("b"), &[]);
        assert_eq!(open, ["b"]);
        assert!(dropped);
    }

    #[test]
    fn a_hidden_port_is_left_alone_while_nothing_is_pinned() {
        let (open, dropped) = relisten(&[], &[port("a"), port("b")], None, &["b".into()]);
        assert_eq!(open, ["a"]);
        assert!(!dropped);

        // Hiding the one that was open closes it, so the notes it holds have to be let go.
        let (open, dropped) = relisten(&["a".into()], &[port("a")], None, &["a".into()]);
        assert_eq!(open, [] as [String; 0]);
        assert!(dropped);
    }

    #[test]
    fn a_pin_on_a_hidden_port_opens_it_and_dropping_the_pin_leaves_it_hidden() {
        // Choosing a device is the player saying "this one, now", which outranks having hidden it.
        let (open, dropped) = relisten(&[], &[port("a"), port("b")], Some("b"), &["b".into()]);
        assert_eq!(open, ["b"]);
        assert!(!dropped);

        let (open, dropped) = relisten(&["b".into()], &[port("a"), port("b")], None, &["b".into()]);
        assert_eq!(open, ["a"]);
        assert!(dropped);
    }
}

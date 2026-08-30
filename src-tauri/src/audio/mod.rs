//! The sound engine's command surface. Format-neutral by rule: opaque string ids, reasons as plain
//! text, and no Audio Unit or CoreAudio type crossing into the webview, so a backend for another
//! platform can sit behind exactly these commands.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
pub mod device;
#[cfg(target_os = "macos")]
mod instruments;
#[cfg(target_os = "macos")]
pub mod mac;
#[cfg(target_os = "macos")]
mod window;
pub mod preview;
pub mod sampler;
// On macOS the stub is only there for the tests that check what a platform without an engine
// answers; off macOS it is the engine.
#[cfg(any(not(target_os = "macos"), test))]
pub mod stub;

#[cfg(target_os = "macos")]
pub(crate) use mac as engine;
#[cfg(not(target_os = "macos"))]
pub(crate) use stub as engine;

use preview::PreviewNote;

/// The event the webview listens for to know its device list is stale. Sent when CoreAudio reports
/// a device plugged in or unplugged, so the picker follows the hardware without a restart.
pub const DEVICES_CHANGED: &str = "audio-devices-changed";

/// The running app, so the engine can send events from its own threads. Set once at start-up.
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn remember(app: AppHandle) {
    let _ = APP.set(app);
}

pub(crate) fn tell_devices_changed() {
    if let Some(app) = APP.get() {
        let _ = app.emit(DEVICES_CHANGED, ());
    }
}

/// Where Preview playback stands, emitted as `preview-progress` about thirty times a second and
/// once more when the piece ends, with `playing` false and the time back at zero.
#[derive(Clone, Serialize)]
pub struct Progress {
    pub seconds: f64,
    pub playing: bool,
}

/// Called from the engine's pump. Before the app has a handle, and in the tests, it does nothing.
pub fn progress(seconds: f64, playing: bool) {
    if let Some(app) = APP.get() {
        let _ = app.emit("preview-progress", Progress { seconds, playing });
    }
}

/// What the render block last cost, emitted as `audio-load`: the voices sounding, the most it may
/// hold at once, and the block's own time as a percent of the time the buffer it filled plays for.
#[derive(Clone, Serialize)]
pub struct Load {
    pub voices: u32,
    pub limit: u32,
    pub load: u32,
}

/// Called from the engine's reporter four times a second. Silent while the app has no handle, and
/// nothing is sent at all while there is no graph to measure.
pub fn load(voices: u32, limit: u32, load: u32) {
    if let Some(app) = APP.get() {
        let _ = app.emit("audio-load", Load { voices, limit, load });
    }
}

/// What the Audio dialog reads: whether sound can come out of the app, the one line saying why not
/// when it cannot, and the output the engine plays through.
#[derive(Debug, Default, Serialize)]
pub struct Status {
    pub available: bool,
    pub reason: String,
    /// Opaque id of the device the engine plays through now; null while it plays through none.
    pub device: Option<String>,
    pub device_name: String,
    /// What the engine is playing through now; empty when nothing is loaded, which is one of the
    /// reasons above. The mixer names it beside the device.
    pub instrument: String,
    /// Why the device playing is not the one chosen; empty while the choice is honoured.
    pub fallback: String,
    pub buffer_frames: u32,
    /// The buffer sizes the device playing takes, of the ones the dialog knows, ascending. Empty
    /// where there is no engine and no device.
    pub buffer_choices: Vec<u32>,
    pub sample_rate: f64,
    /// The rate the loaded instrument's samples were recorded at, which the engine plays them as
    /// they are at; 0 for a plugin, which renders at any rate, and while nothing is loaded.
    pub instrument_rate: f64,
    /// What the device reports the buffer costs: its own latency, the safety offset, the stream
    /// and the buffer itself, at the rate the device runs.
    pub latency_ms: f64,
    /// The noises around the tone the loaded instrument offers, each of them a toggle the webview
    /// keeps for it. Empty for a plugin and for a file that has none of them.
    pub roles: Vec<sampler::Role>,
}

impl Status {
    fn unavailable(reason: &str) -> Self {
        Status { reason: reason.into(), ..Status::default() }
    }
}

/// One effect the machine has installed, as the Add menu lists it.
#[derive(Debug, Serialize)]
pub struct Effect {
    /// Opaque to the webview, and the same string on every Mac that has the plugin.
    pub id: String,
    pub name: String,
    pub manufacturer: String,
}

/// One place in the effect chain. The webview keeps the whole list as one global setting and hands
/// it back whole; `missing` is the engine's answer, not the webview's to send.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Slot {
    pub id: String,
    /// What the plugin was called when it was last seen, which is how a missing slot is named.
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub bypass: bool,
    /// The plugin's own settings: its property list, base64 so it is a plain string in JSON.
    #[serde(default)]
    pub state: String,
    /// Whether the plugin is not installed on this machine, in which case the slot keeps its place
    /// and its state but makes no sound.
    #[serde(default)]
    pub missing: bool,
}

/// How a sampler instrument's loudness answers a key: seconds to reach full loudness, seconds to
/// fall from there, the fraction of full loudness a held note settles at, and seconds to fade once
/// the key comes up. Only the sampler has one; a hosted plugin shapes its notes in its own window.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Envelope {
    pub attack: f64,
    pub decay: f64,
    pub sustain: f64,
    pub release: f64,
}

/// One output device as the picker lists it. The system default is not a row here; the dialog
/// offers it as the choice of no device at all.
#[derive(Debug, Serialize)]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
}

/// One line of the instrument picker. The id is opaque: a file and an Audio Unit look the same
/// from the webview, which only ever hands one back.
#[derive(Debug, Serialize)]
pub struct Instrument {
    pub id: String,
    pub name: String,
    /// `file` for one the sampler loads, `plugin` for a hosted Audio Unit, which is the one that
    /// has a window of its own.
    pub kind: String,
    pub loaded: bool,
    /// Why this instrument is not sounding, when it is the chosen one and its load failed.
    pub reason: String,
}

/// The settings the engine owns, in the order a start puts them in: the output first, then what
/// the voice engine is built with, then the chain and the levels after it. The velocity remap is
/// three keys and goes in as one, so `velocity_min` stands for all three.
const OWNED: [&str; 7] = [
    "audio_output_device",
    "audio_buffer_frames",
    "audio_sample_rate",
    "audio_voices",
    "effect_chain",
    "keyboard_volume",
    "velocity_min",
];

/// Puts one global setting on the running engine, and answers with the engine's refusal when it
/// will not take it. The whole set is passed because the velocity remap is three keys read as one.
/// A key the engine does not own, and one never written, changes nothing.
pub fn apply(key: &str, all: &crate::settings::Stored) -> Result<(), String> {
    let number = |name: &str, or: f64| all.get(name).and_then(Value::as_f64).unwrap_or(or);
    // The remap goes in whole, at the map that changes nothing for a key nobody has written.
    if matches!(key, "velocity_min" | "velocity_max" | "velocity_curve") {
        engine::set_velocity_curve(
            number("velocity_min", 1.0) as u32,
            number("velocity_max", 127.0) as u32,
            number("velocity_curve", 1.0),
        );
        return Ok(());
    }
    let Some(value) = all.get(key) else { return Ok(()) };
    match key {
        // Null is the system default, which is where an engine that has been told nothing plays.
        "audio_output_device" => engine::set_output_device(value.as_str().map(str::to_string)),
        "audio_buffer_frames" => engine::set_buffer_frames(number(key, 0.0) as u32),
        "audio_sample_rate" => engine::set_sample_rate(number(key, 0.0) as u32),
        "audio_voices" => engine::set_voices(number(key, 0.0) as usize),
        "effect_chain" => engine::set_chain(
            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?,
        )
        .map(|_| ()),
        "keyboard_volume" => {
            engine::set_keyboard_volume(number(key, 100.0) as u32);
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Builds the graph, starts it on the output device and puts the stored settings back on it. Each
/// setting is applied whatever the one before it did, so an unplugged device does not cost the app
/// its effect chain; only a failed start stops the rest.
#[tauri::command]
pub async fn audio_start(app: tauri::AppHandle) -> Result<(), String> {
    engine::start()?;
    let all = crate::settings::all(&app).await?;
    let refusals: Vec<String> = OWNED.iter().filter_map(|key| apply(key, &all).err()).collect();
    match refusals.into_iter().next() {
        Some(reason) => Err(reason),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn audio_status() -> Status {
    engine::status()
}

/// One metronome click, at a volume of 0 to 100. A no-op where there is no engine, so the
/// metronome is simply silent there.
#[tauri::command]
pub fn audio_click(strength: String, volume: u32) {
    engine::click(strength == "strong", volume);
}

/// One note the app plays rather than the player: the inactive hand sounding itself. It takes the
/// same path a MIDI key takes, so the velocity curve is on it, unless `raw` says the caller already
/// holds an output velocity. A no-op where there is no engine.
#[tauri::command]
pub fn audio_note(midi: u8, velocity: u8, on: bool, raw: bool) {
    engine::note(midi, velocity, on, raw);
}

/// Every Audio Unit effect installed on the machine, Apple's own included.
#[tauri::command]
pub fn audio_effects() -> Vec<Effect> {
    engine::effects()
}

#[tauri::command]
pub fn audio_chain() -> Vec<Slot> {
    engine::chain()
}

/// Opens one slot's plugin window. Closing it emits `audio-chain-changed` with the whole chain,
/// which is how the plugin's settings reach the setting the webview keeps.
#[tauri::command]
pub fn audio_show_effect(app: tauri::AppHandle, index: usize) -> Result<(), String> {
    engine::show_effect(app, index)
}

/// Every device the app can play through, newest list each call. The webview reads it again on
/// every `audio-devices-changed`.
#[tauri::command]
pub fn audio_output_devices() -> Vec<OutputDevice> {
    engine::output_devices()
}

/// Every instrument the engine can play: Logic's pianos, the files in the folder the webview
/// names, and the installed Audio Unit instruments.
#[tauri::command]
pub fn audio_instruments(folder: String) -> Vec<Instrument> {
    engine::instruments(&folder)
}

/// Loads one of them, with the state a plugin was last left in. Off the main thread: a big sampler
/// instrument takes a moment to read, and the app stays answering while it does.
#[tauri::command(async)]
pub fn audio_load_instrument(id: String, state: Option<String>) -> Result<(), String> {
    engine::load_instrument(&id, state.as_deref())
}

/// Opens the instrument's own window, and answers with its state when the user closes it again.
#[tauri::command]
pub async fn audio_show_instrument(app: tauri::AppHandle) -> Result<Option<String>, String> {
    engine::show_instrument(app).await
}

/// The envelope the loaded instrument answers a key with now. Null when a plugin is playing, which
/// is how the webview knows to offer no envelope for it, and null where there is no engine.
#[tauri::command]
pub fn audio_envelope() -> Option<Envelope> {
    engine::envelope()
}

/// Replaces it. The voice engine has it at the next buffer, and every note struck from there on
/// follows it; whatever is already sounding plays on unchanged.
#[tauri::command]
pub fn audio_apply_envelope(envelope: Envelope) {
    engine::set_envelope(envelope);
}

/// How loud one of the noises a piano makes around the tone sounds, 0 to 100: the damper landing,
/// the key coming back up, the strings ringing along, the pedal. 0 sounds none of it, the tone
/// itself has no level, and a role the loaded instrument has no samples for is simply silent. A
/// load puts every role back to 100, and the webview keeps a level per instrument and sends it
/// after every load.
#[tauri::command]
pub fn audio_apply_role_level(role: sampler::Role, percent: u32) {
    engine::set_role_level(role, percent);
}

/// The Preview's note list, in seconds at the score's own tempo. Replaces whatever was loaded.
#[tauri::command]
pub fn preview_load(notes: Vec<PreviewNote>) {
    engine::preview_load(notes);
}

#[tauri::command]
pub fn preview_play() {
    engine::preview_play();
}

#[tauri::command]
pub fn preview_pause() {
    engine::preview_pause();
}

/// Jumps to a time in the piece's own seconds, tempo percent aside.
#[tauri::command]
pub fn preview_seek(seconds: f64) {
    engine::preview_seek(seconds);
}

/// The tempo as a percent of the score's own: 50 makes the piece take twice as long.
#[tauri::command]
pub fn preview_rate(percent: u32) {
    engine::preview_rate(percent);
}

/// Stops, forgets the note list and returns to the start. What leaving the Preview sends.
#[tauri::command]
pub fn preview_stop() {
    engine::preview_stop();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_platform_without_an_engine_says_so_and_every_command_still_answers() {
        assert_eq!(stub::start(), Err("No sound engine on this platform".into()));

        let status = stub::status();
        assert!(!status.available);
        assert_eq!(status.reason, "No sound engine on this platform");

        // The click and the keyboard volume return nothing: silence is the whole of their answer.
        stub::click(true, 70);
        stub::click(false, 0);
        stub::set_keyboard_volume(100);
        stub::set_keyboard_volume(0);
        stub::set_velocity_curve(1, 127, 1.0);
        stub::set_envelope(Envelope::default());
        assert!(stub::envelope().is_none());
        stub::set_role_level(sampler::Role::Release, 50);
        stub::pedal(64);
        stub::release_all();
        // A key still answers with a velocity, because the caller reports the one that sounded.
        assert_eq!(stub::note(60, 100, true, false), 100);

        assert!(stub::effects().is_empty());
        assert!(stub::chain().is_empty());
        assert_eq!(
            stub::set_chain(Vec::new()).err(),
            Some("No sound engine on this platform".into())
        );

        assert!(stub::output_devices().is_empty());
        assert!(stub::set_output_device(Some("anything".into())).is_err());
        assert!(stub::set_buffer_frames(64).is_err());
        assert!(stub::set_sample_rate(48000).is_err());
        assert!(stub::set_voices(256).is_err());

        assert!(stub::instruments("/instruments").is_empty());
        assert_eq!(
            stub::load_instrument("file:/instruments/piano.sf2", None),
            Err("No sound engine on this platform".into())
        );
    }

    #[test]
    fn a_status_with_no_engine_carries_no_output_either() {
        let status = stub::status();
        assert_eq!(status.device, None);
        assert_eq!(status.buffer_frames, 0);
        assert_eq!(status.latency_ms, 0.0);
        assert_eq!(status.fallback, "");
        assert!(status.roles.is_empty());
    }

    #[test]
    fn preview_commands_answer_without_an_engine() {
        stub::preview_load(vec![]);
        stub::preview_play();
        stub::preview_pause();
        stub::preview_seek(4.0);
        stub::preview_rate(50);
        stub::preview_stop();
    }
}

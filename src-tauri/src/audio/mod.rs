//! The sound engine's command surface. Format-neutral by rule: opaque string ids, reasons as plain
//! text, and no Audio Unit or CoreAudio type crossing into the webview, so a backend for another
//! platform can sit behind exactly these commands.

use crate::refusal::Refusal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;
use tauri::AppHandle;
use tauri_specta::Event;

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

/// Tells the webview its device list is stale. Sent when CoreAudio reports a device plugged in or
/// unplugged, so the picker follows the hardware without a restart.
#[derive(Clone, Serialize, specta::Type, Event)]
pub struct AudioDevicesChanged;

/// Carries the whole effect chain, as `audio_chain` would answer it, whenever the engine changes
/// it: what the webview writes back to the setting it keeps.
#[derive(Clone, Serialize, specta::Type, Event)]
pub struct AudioChainChanged(pub Vec<Slot>);

/// The running app, so the engine can send events from its own threads. Set once at start-up.
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn remember(app: AppHandle) {
    let _ = APP.set(app);
}

pub(crate) fn tell_devices_changed() {
    if let Some(app) = APP.get() {
        let _ = AudioDevicesChanged.emit(app);
    }
}

/// Where Preview playback stands, sent about thirty times a second and once more when the piece
/// ends, with `playing` false and the time back at zero.
#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "preview-progress")]
#[serde(rename = "PreviewProgress")]
pub struct Progress {
    // Never NaN, so it crosses as a plain number and not as specta's `number | null` for an f64.
    #[specta(type = specta_typescript::Number)]
    pub seconds: f64,
    pub playing: bool,
}

/// Called from the engine's pump. Before the app has a handle, and in the tests, it does nothing.
pub fn progress(seconds: f64, playing: bool) {
    if let Some(app) = APP.get() {
        let _ = Progress { seconds, playing }.emit(app);
    }
}

/// What the render block last cost: the voices sounding, the most it may hold at once, and the
/// block's own time as a percent of the time the buffer it filled plays for.
#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "audio-load")]
#[serde(rename = "Meter")]
// The webview reads the event's fields by name, `load` among them.
#[allow(clippy::struct_field_names)]
pub struct Load {
    pub voices: u32,
    pub limit: u32,
    pub load: u32,
}

/// Called from the engine's reporter four times a second. Silent while the app has no handle, and
/// nothing is sent at all while there is no graph to measure.
pub fn load(voices: u32, limit: u32, load: u32) {
    if let Some(app) = APP.get() {
        let _ = Load { voices, limit, load }.emit(app);
    }
}

/// What the Audio dialog reads: whether sound can come out of the app, the one line saying why not
/// when it cannot, and the output the engine plays through.
#[derive(Debug, Default, Serialize, specta::Type)]
#[serde(rename = "AudioStatus")]
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
    // Never NaN, so it crosses as a plain number and not as specta's `number | null` for an f64.
    #[specta(type = specta_typescript::Number)]
    pub sample_rate: f64,
    /// The rate the loaded instrument's samples were recorded at, which the engine plays them as
    /// they are at; 0 for a plugin, which renders at any rate, and while nothing is loaded.
    #[specta(type = specta_typescript::Number)]
    pub instrument_rate: f64,
    /// What the device reports the buffer costs: its own latency, the safety offset, the stream
    /// and the buffer itself, at the rate the device runs.
    #[specta(type = specta_typescript::Number)]
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
#[derive(Debug, Serialize, specta::Type)]
pub struct Effect {
    /// Opaque to the webview, and the same string on every Mac that has the plugin.
    pub id: String,
    pub name: String,
    pub manufacturer: String,
}

/// One place in the effect chain. The webview keeps the whole list as one global setting and hands
/// it back whole; `missing` is the engine's answer, not the webview's to send.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename = "EffectSlot")]
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
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct Envelope {
    // Never NaN, so it crosses as a plain number and not as specta's `number | null` for an f64.
    #[specta(type = specta_typescript::Number)]
    pub attack: f64,
    #[specta(type = specta_typescript::Number)]
    pub decay: f64,
    #[specta(type = specta_typescript::Number)]
    pub sustain: f64,
    #[specta(type = specta_typescript::Number)]
    pub release: f64,
}

/// One output device as the picker lists it. The system default is not a row here; the dialog
/// offers it as the choice of no device at all.
#[derive(Debug, Serialize, specta::Type)]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
}

/// What the window keeps for one instrument and a load puts back with it: the state a plugin was
/// last left in, the Envelope for a file, and the level of every Role that was moved. Read from the
/// Global settings here, so the engine's load knows nothing about settings.
#[derive(Debug, Clone, Default)]
pub struct Kept {
    pub state: Option<String>,
    pub envelope: Option<Envelope>,
    pub roles: Vec<(sampler::Role, u32)>,
}

/// One line of the instrument picker. The id is opaque: a file and an Audio Unit look the same
/// from the webview, which only ever hands one back.
#[derive(Debug, Serialize, specta::Type)]
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

/// What a command answers when it needs the graph and there is none: the engine never started, or
/// its start failed. Off macOS that is every call, since there is no graph to build.
pub(crate) const NO_ENGINE: &str = "The sound engine did not start";

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
        if let Some(mut graph) = engine::graph() {
            graph.set_velocity_curve(
                number("velocity_min", 1.0) as u32,
                number("velocity_max", 127.0) as u32,
                number("velocity_curve", 1.0),
            );
        }
        return Ok(());
    }
    let Some(value) = all.get(key) else { return Ok(()) };
    match key {
        // Null is the system default, which is where an engine that has been told nothing plays.
        "audio_output_device" => {
            engine::graph().ok_or(NO_ENGINE)?.set_device(value.as_str().map(str::to_string))
        }
        "audio_buffer_frames" => {
            engine::graph().ok_or(NO_ENGINE)?.set_buffer(number(key, 0.0) as u32)
        }
        "audio_sample_rate" => engine::set_sample_rate(number(key, 0.0) as u32),
        "audio_voices" => engine::graph().ok_or(NO_ENGINE)?.set_voices(number(key, 0.0) as usize),
        "effect_chain" => engine::set_chain(
            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?,
        )
        .map(|_| ()),
        "keyboard_volume" => {
            if let Some(graph) = engine::graph() {
                graph.set_keyboard_volume(number(key, 100.0) as u32);
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Builds the graph, starts it on the output device and puts the stored settings back on it. Each
/// setting is applied whatever the one before it did, so an unplugged device does not cost the app
/// its effect chain; only a failed start stops the rest.
#[tauri::command]
#[specta::specta]
pub async fn audio_start(app: tauri::AppHandle) -> Result<(), Refusal> {
    engine::start()?;
    let all = crate::settings::all(&app).await?;
    let refusals: Vec<String> = OWNED.iter().filter_map(|key| apply(key, &all).err()).collect();
    match refusals.into_iter().next() {
        Some(reason) => Err(reason.into()),
        None => Ok(()),
    }
}

#[tauri::command]
#[specta::specta]
pub fn audio_status() -> Status {
    engine::graph().map_or_else(|| Status::unavailable(NO_ENGINE), |graph| graph.status())
}

/// One metronome click, at a volume of 0 to 100. A no-op where there is no engine, so the
/// metronome is simply silent there.
#[tauri::command]
#[specta::specta]
pub fn audio_click(strength: &str, volume: u32) {
    if let Some(graph) = engine::graph() {
        graph.click(strength == "strong", volume);
    }
}

/// One note the app plays rather than the player: the inactive hand sounding itself. It takes the
/// same path a MIDI key takes, so the velocity curve is on it, unless `raw` says the caller already
/// holds an output velocity. A no-op where there is no engine.
#[tauri::command]
#[specta::specta]
pub fn audio_note(midi: u8, velocity: u8, on: bool, raw: bool) {
    if let Some(graph) = engine::graph() {
        graph.note(midi, velocity, on, raw);
    }
}

/// Every Audio Unit effect installed on the machine, Apple's own included.
#[tauri::command]
#[specta::specta]
pub fn audio_effects() -> Vec<Effect> {
    engine::effects()
}

#[tauri::command]
#[specta::specta]
pub fn audio_chain() -> Vec<Slot> {
    engine::chain()
}

/// Opens one slot's plugin window. Closing it emits `audio-chain-changed` with the whole chain,
/// which is how the plugin's settings reach the setting the webview keeps.
#[tauri::command]
#[specta::specta]
pub fn audio_show_effect(app: tauri::AppHandle, index: usize) -> Result<(), Refusal> {
    Ok(engine::show_effect(app, index)?)
}

/// Every device the app can play through, newest list each call. The webview reads it again on
/// every `audio-devices-changed`.
#[tauri::command]
#[specta::specta]
pub fn audio_output_devices() -> Vec<OutputDevice> {
    engine::output_devices()
}

/// Every instrument the engine can play: Logic's pianos, the files in the folder the webview
/// names, and the installed Audio Unit instruments.
#[tauri::command]
#[specta::specta]
pub fn audio_instruments(folder: &str) -> Vec<Instrument> {
    engine::instruments(folder)
}

/// Loads one of them, with the state a plugin was last left in, the Envelope kept for it and the
/// level of every Role that was moved, and answers the engine's status. The engine builds the
/// instrument with nothing locked, so a key pressed meanwhile plays on the one still in.
#[tauri::command]
#[specta::specta]
pub async fn audio_load_instrument(app: tauri::AppHandle, id: String) -> Result<Status, Refusal> {
    let all = crate::settings::all(&app).await?;
    Ok(engine::load_instrument(&id, &kept_for(&id, &all))?)
}

/// Takes the loaded instrument out, so the app makes no sound until one is chosen again, and
/// answers the engine's status, which now names no instrument.
#[tauri::command]
#[specta::specta]
pub fn audio_unload_instrument() -> Result<Status, Refusal> {
    Ok(engine::unload_instrument()?)
}

/// What the window keeps for one instrument, out of the Global settings.
fn kept_for(id: &str, all: &crate::settings::Stored) -> Kept {
    Kept {
        state: all.get("instrument_state").and_then(Value::as_str).map(str::to_string),
        envelope: all
            .get("instrument_envelopes")
            .and_then(|kept| kept.get(id))
            .and_then(|one| serde_json::from_value(one.clone()).ok()),
        roles: role_levels(all.get("instrument_roles").and_then(|kept| kept.get(id))),
    }
}

/// The Role levels kept for one instrument, in either shape the setting takes on disk: a map of
/// role to per cent, or the older list of the roles switched off, which reads as those roles at 0.
fn role_levels(kept: Option<&Value>) -> Vec<(sampler::Role, u32)> {
    let role = |name: &str| serde_json::from_value(Value::String(name.into())).ok();
    match kept {
        Some(Value::Array(off)) => {
            off.iter().filter_map(|one| Some((role(one.as_str()?)?, 0))).collect()
        }
        Some(Value::Object(levels)) => levels
            .iter()
            .filter_map(|(name, level)| Some((role(name)?, level.as_u64()? as u32)))
            .collect(),
        _ => Vec::new(),
    }
}

/// Opens the instrument's own window, and answers with its state when the user closes it again.
#[tauri::command]
#[specta::specta]
pub async fn audio_show_instrument(app: tauri::AppHandle) -> Result<Option<String>, Refusal> {
    Ok(engine::show_instrument(app).await?)
}

/// The envelope the loaded instrument answers a key with now. Null when a plugin is playing, which
/// is how the webview knows to offer no envelope for it, and null where there is no engine.
#[tauri::command]
#[specta::specta]
pub fn audio_envelope() -> Option<Envelope> {
    engine::graph().and_then(|graph| graph.envelope())
}

/// Replaces it. The voice engine has it at the next buffer, and every note struck from there on
/// follows it; whatever is already sounding plays on unchanged.
#[tauri::command]
#[specta::specta]
pub fn audio_apply_envelope(envelope: Envelope) {
    if let Some(mut graph) = engine::graph() {
        graph.set_envelope(envelope);
    }
}

/// How loud one of the noises a piano makes around the tone sounds, 0 to 100: the damper landing,
/// the key coming back up, the strings ringing along, the pedal. 0 sounds none of it, the tone
/// itself has no level, and a role the loaded instrument has no samples for is simply silent. What
/// a slider sends as it moves; a load puts the kept levels on by itself.
#[tauri::command]
#[specta::specta]
pub fn audio_apply_role_level(role: sampler::Role, percent: u32) {
    if let Some(graph) = engine::graph() {
        graph.set_role_level(role, percent);
    }
}

/// The Preview's note list, in seconds at the score's own tempo. Replaces whatever was loaded.
#[tauri::command]
#[specta::specta]
pub fn preview_load(notes: Vec<PreviewNote>) {
    if let Some(graph) = engine::graph() {
        graph.preview_load(notes);
    }
}

#[tauri::command]
#[specta::specta]
pub fn preview_play() {
    if let Some(graph) = engine::graph() {
        graph.preview_play();
    }
}

#[tauri::command]
#[specta::specta]
pub fn preview_pause() {
    if let Some(graph) = engine::graph() {
        graph.preview_pause();
    }
}

/// Jumps to a time in the piece's own seconds, tempo percent aside.
#[tauri::command]
#[specta::specta]
pub fn preview_seek(seconds: f64) {
    if let Some(graph) = engine::graph() {
        graph.preview_seek(seconds);
    }
}

/// The tempo as a percent of the score's own: 50 makes the piece take twice as long.
#[tauri::command]
#[specta::specta]
pub fn preview_rate(percent: u32) {
    if let Some(graph) = engine::graph() {
        graph.preview_rate(percent);
    }
}

/// Stops, forgets the note list and returns to the start. What leaving the Preview sends.
#[tauri::command]
#[specta::specta]
pub fn preview_stop() {
    if let Some(graph) = engine::graph() {
        graph.preview_stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Off macOS there is no graph at all, so every command falls to the answer it keeps for
    /// that, and what needs no graph still answers.
    #[test]
    fn a_platform_without_an_engine_has_no_graph_and_still_answers() {
        assert!(stub::graph().is_none());
        assert_eq!(stub::start(), Err("No sound engine on this platform".into()));

        assert!(stub::effects().is_empty());
        assert!(stub::chain().is_empty());
        assert_eq!(
            stub::set_chain(Vec::new()).err(),
            Some("No sound engine on this platform".into())
        );

        assert!(stub::output_devices().is_empty());
        assert!(stub::set_sample_rate(48000).is_err());

        assert!(stub::instruments("/instruments").is_empty());
        assert_eq!(
            stub::load_instrument("file:/instruments/piano.sf2", &Kept::default()).err(),
            Some("No sound engine on this platform".into())
        );
        assert_eq!(
            stub::unload_instrument().err(),
            Some("No sound engine on this platform".into())
        );
    }

    /// The one answer a command that describes the engine gives when no graph answers it.
    #[test]
    fn a_status_with_no_graph_says_so_and_carries_no_output_either() {
        let status = Status::unavailable(NO_ENGINE);
        assert!(!status.available);
        assert_eq!(status.reason, "The sound engine did not start");
        assert_eq!(status.device, None);
        assert_eq!(status.buffer_frames, 0);
        assert_eq!(status.latency_ms, 0.0);
        assert_eq!(status.fallback, "");
        assert!(status.roles.is_empty());
    }

    /// What the window keeps for one instrument, in both shapes the Role levels take on disk.
    #[test]
    fn the_role_levels_kept_for_an_instrument_read_in_either_shape() {
        let all: crate::settings::Stored = serde_json::from_str(
            r#"{
                "instrument_state": "YmxvYg==",
                "instrument_envelopes": {
                    "one": { "attack": 0.1, "decay": 0.2, "sustain": 0.3, "release": 0.4 }
                },
                "instrument_roles": {
                    "one": { "key_off": 40 },
                    "two": ["sympathetic", "pedal_noise"]
                }
            }"#,
        )
        .unwrap();

        let first = kept_for("one", &all);
        assert_eq!(first.state.as_deref(), Some("YmxvYg=="));
        assert_eq!(first.envelope.map(|one| one.release), Some(0.4));
        assert_eq!(first.roles, [(sampler::Role::KeyOff, 40)]);

        // The older shape: the roles that were switched off, which is those roles at 0.
        assert_eq!(kept_for("two", &all).roles, [
            (sampler::Role::Sympathetic, 0),
            (sampler::Role::PedalNoise, 0)
        ]);

        // An instrument nobody has touched keeps nothing of its own but the plugin state.
        let untouched = kept_for("three", &all);
        assert!(untouched.envelope.is_none() && untouched.roles.is_empty());
    }
}

//! What the engine can play, and putting one of them into the graph. Three sources make one list:
//! Logic's Studio Piano files, the files in the instruments folder the user chose, and the Audio
//! Unit instruments installed on the Mac. Every entry carries an opaque id, so the webview never
//! learns what a component description or a file path is.

use crate::audio::Instrument;
use crate::audio::mac::{Chosen, GRAPH};
use block2::RcBlock;
use objc2::AnyThread;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_audio_toolbox::{AUAudioUnit, AudioComponentDescription, AudioComponentInstantiationOptions};
use objc2_avf_audio::{AVAudioUnit, AVAudioUnitComponentManager, AVAudioUnitMIDIInstrument};
use objc2_foundation::{
    NSData, NSDataBase64DecodingOptions, NSDataBase64EncodingOptions, NSDictionary, NSError,
    NSPropertyListFormat, NSPropertyListMutabilityOptions, NSPropertyListSerialization, NSString,
};
use std::path::{Path, PathBuf};

/// Where Logic keeps the Studio Piano inside its sound library bundle in `~/Music`.
const STUDIO_PIANO: &str = "Plug-In Settings/Sampler/z_Internal/Studio Piano";
/// The Studio Piano instruments AUSampler can load. Vintage Upright is left out: its file stores
/// percent-encoded sample paths the sampler cannot resolve.
const LOGIC_PIANOS: [&str; 2] = ["Concert Grand Piano", "Studio Grand Piano"];
/// What the sampler opens out of the instruments folder.
const FILE_KINDS: [&str; 2] = ["sf2", "exs"];
/// Component type `aumu`: the Audio Unit instruments.
const MUSIC_DEVICE: u32 = u32::from_be_bytes(*b"aumu");
/// Apple's DLSMusicDevice and AUMIDISynth, General MIDI players that add nothing over a file in
/// the sampler.
const NOT_LISTED: [u32; 2] = [u32::from_be_bytes(*b"dls "), u32::from_be_bytes(*b"msyn")];
/// How long instantiating a plugin may take before the load gives up on it.
const PATIENCE: std::time::Duration = std::time::Duration::from_secs(60);

/// Every instrument the engine can play right now, in source order, with the load state of the one
/// that is loaded (or that failed to).
pub fn list(folder: &str) -> Vec<Instrument> {
    let mut all = files(&music_folder(), Path::new(folder));
    all.extend(plugins());
    let chosen = GRAPH.lock().unwrap().as_ref().and_then(|graph| graph.chosen().cloned());
    if let Some(chosen) = chosen {
        for entry in all.iter_mut().filter(|entry| entry.id == chosen.id) {
            entry.loaded = chosen.failure.is_none();
            entry.reason = chosen.failure.clone().unwrap_or_default();
        }
    }
    all
}

/// Loads the instrument an id names, restoring a plugin's stored state onto it. Everything
/// sounding is let go first, so a switch never leaves a note ringing.
pub fn load(id: &str, state: Option<&str>) -> Result<(), String> {
    let mut held = GRAPH.lock().unwrap();
    let graph = held.as_mut().ok_or("The sound engine did not start")?;
    graph.release_all();

    let (name, outcome) = match path_of(id) {
        Some(path) => (stem(&path), graph.load_file(&path)),
        None => match plugin_desc(id).and_then(component) {
            None => (id.to_string(), Err("That instrument is not installed".into())),
            Some((desc, name)) => (
                name,
                instantiate(desc).map(|unit| {
                    if let Some(state) = state {
                        apply_state(&unit, state);
                    }
                    graph.set_plugin(unit);
                }),
            ),
        },
    };
    graph.choose(Chosen { id: id.into(), name, failure: outcome.clone().err() });
    outcome
}

/// The plugin state to store with the instrument choice: `fullState` as a property list, base64 so
/// that it crosses the command boundary as a plain string.
pub fn state_of(unit: &AUAudioUnit) -> Option<String> {
    unsafe {
        let full = unit.fullState()?;
        let plist: &AnyObject = &full;
        let data = NSPropertyListSerialization::dataWithPropertyList_format_options_error(
            plist,
            NSPropertyListFormat::BinaryFormat_v1_0,
            0,
        )
        .ok()?;
        Some(data.base64EncodedStringWithOptions(NSDataBase64EncodingOptions::empty()).to_string())
    }
}

/// The other direction, on a freshly instantiated unit. A blob the plugin no longer understands is
/// dropped rather than reported: the instrument still plays, at its own defaults.
fn apply_state(unit: &AVAudioUnitMIDIInstrument, state: &str) {
    unsafe {
        let Some(data) = NSData::initWithBase64EncodedString_options(
            NSData::alloc(),
            &NSString::from_str(state),
            NSDataBase64DecodingOptions::empty(),
        ) else {
            return;
        };
        let Ok(plist) = NSPropertyListSerialization::propertyListWithData_options_format_error(
            &data,
            NSPropertyListMutabilityOptions::empty(),
            std::ptr::null_mut(),
        ) else {
            return;
        };
        let dict: *const NSDictionary<NSString, AnyObject> = Retained::as_ptr(&plist).cast();
        let au: &AVAudioUnit = unit;
        au.AUAudioUnit().setFullState(Some(&*dict));
    }
}

/// The file instruments: Logic's two pianos, then whatever the instruments folder holds.
fn files(music: &Path, folder: &Path) -> Vec<Instrument> {
    let mut all = logic_pianos(music);
    let mut own: Vec<Instrument> = read_dir(folder)
        .filter(|path| {
            path.extension()
                .is_some_and(|kind| FILE_KINDS.contains(&kind.to_string_lossy().to_lowercase().as_str()))
        })
        .map(|path| {
            let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
            file_entry(&path, name)
        })
        .collect();
    own.sort_by(|a, b| a.name.cmp(&b.name));
    all.append(&mut own);
    all
}

/// Logic's Studio Piano, read in place out of its sound library bundle. No Logic on the Mac means
/// no bundle, no entries and nothing to report.
fn logic_pianos(music: &Path) -> Vec<Instrument> {
    read_dir(music)
        .filter(|path| path.extension().is_some_and(|kind| kind == "bundle"))
        .flat_map(|bundle| {
            LOGIC_PIANOS.map(|name| bundle.join(STUDIO_PIANO).join(format!("{name}.exs")))
        })
        .filter(|path| path.is_file())
        .map(|path| file_entry(&path, stem(&path)))
        .collect()
}

/// The installed Audio Unit instruments, by manufacturer and name.
fn plugins() -> Vec<Instrument> {
    let mut all = Vec::new();
    unsafe {
        let manager = AVAudioUnitComponentManager::sharedAudioUnitComponentManager();
        for component in manager.componentsMatchingDescription(wildcard()).iter() {
            let desc = component.audioComponentDescription();
            if NOT_LISTED.contains(&desc.componentSubType) {
                continue;
            }
            all.push(Instrument {
                id: plugin_id(&desc),
                name: titled(&component.manufacturerName().to_string(), &component.name().to_string()),
                kind: "plugin".into(),
                loaded: false,
                reason: String::new(),
            });
        }
    }
    all
}

/// The description and display name of an installed component, or nothing when the plugin an id
/// names is no longer on the Mac.
fn component(wanted: AudioComponentDescription) -> Option<(AudioComponentDescription, String)> {
    unsafe {
        let manager = AVAudioUnitComponentManager::sharedAudioUnitComponentManager();
        manager.componentsMatchingDescription(wanted).iter().next().map(|component| {
            (
                component.audioComponentDescription(),
                titled(&component.manufacturerName().to_string(), &component.name().to_string()),
            )
        })
    }
}

/// Builds the Audio Unit behind a description. Apple hands the unit back on a queue of its own
/// choosing, so the load waits here for it.
pub(in crate::audio) fn instantiate(
    desc: AudioComponentDescription,
) -> Result<Retained<AVAudioUnitMIDIInstrument>, String> {
    /// The unit, already retained inside the completion handler, on its way to the waiting load.
    struct Handoff(*mut AVAudioUnitMIDIInstrument, Option<String>);
    // Nothing else holds the unit while it travels, and only the receiver ever touches it.
    unsafe impl Send for Handoff {}

    let (post, wait) = std::sync::mpsc::channel::<Handoff>();
    let handler = RcBlock::new(move |unit: *mut AVAudioUnit, error: *mut NSError| {
        let handoff = unsafe {
            match Retained::retain(unit).and_then(|unit| unit.downcast::<AVAudioUnitMIDIInstrument>().ok()) {
                Some(unit) => Handoff(Retained::into_raw(unit), None),
                None => Handoff(
                    std::ptr::null_mut(),
                    Some(Retained::retain(error).map_or_else(
                        || "The instrument could not be built".to_string(),
                        |error| error.localizedDescription().to_string(),
                    )),
                ),
            }
        };
        post.send(handoff).ok();
    });
    unsafe {
        AVAudioUnit::instantiateWithComponentDescription_options_completionHandler(
            desc,
            AudioComponentInstantiationOptions::empty(),
            &handler,
        );
    }
    let handoff = wait.recv_timeout(PATIENCE).map_err(|_| "The instrument took too long to load")?;
    match unsafe { Retained::from_raw(handoff.0) } {
        Some(unit) => Ok(unit),
        None => Err(handoff.1.unwrap_or_else(|| "The instrument could not be built".into())),
    }
}

fn wildcard() -> AudioComponentDescription {
    AudioComponentDescription {
        componentType: MUSIC_DEVICE,
        componentSubType: 0,
        componentManufacturer: 0,
        componentFlags: 0,
        componentFlagsMask: 0,
    }
}

fn plugin_id(desc: &AudioComponentDescription) -> String {
    format!(
        "au:{:08x}:{:08x}:{:08x}",
        desc.componentType, desc.componentSubType, desc.componentManufacturer
    )
}

fn plugin_desc(id: &str) -> Option<AudioComponentDescription> {
    let codes: Vec<u32> = id
        .strip_prefix("au:")?
        .split(':')
        .filter_map(|code| u32::from_str_radix(code, 16).ok())
        .collect();
    let [component_type, sub, manufacturer] = codes[..] else { return None };
    Some(AudioComponentDescription {
        componentType: component_type,
        componentSubType: sub,
        componentManufacturer: manufacturer,
        componentFlags: 0,
        componentFlagsMask: 0,
    })
}

fn file_entry(path: &Path, name: String) -> Instrument {
    Instrument {
        id: format!("file:{}", path.to_string_lossy()),
        name,
        kind: "file".into(),
        loaded: false,
        reason: String::new(),
    }
}

fn path_of(id: &str) -> Option<PathBuf> {
    id.strip_prefix("file:").map(PathBuf::from)
}

fn stem(path: &Path) -> String {
    path.file_stem().unwrap_or_default().to_string_lossy().into_owned()
}

/// A plugin's display name. Makers who put their own name in the plugin's name get one of it.
fn titled(manufacturer: &str, name: &str) -> String {
    if name.starts_with(manufacturer) { name.into() } else { format!("{manufacturer} {name}") }
}

/// The paths inside a folder, and nothing at all when the folder is not there.
fn read_dir(folder: &Path) -> impl Iterator<Item = PathBuf> {
    std::fs::read_dir(folder).into_iter().flatten().flatten().map(|entry| entry.path())
}

fn music_folder() -> PathBuf {
    std::env::home_dir().unwrap_or_default().join("Music")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::mac::{Graph, status};

    /// The same few kilobytes of SoundFont the graph's own tests play.
    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/sine.sf2");

    fn write(folder: &Path, name: &str) {
        std::fs::create_dir_all(folder.parent().unwrap_or(folder)).unwrap();
        std::fs::create_dir_all(folder).unwrap();
        std::fs::write(folder.join(name), b"not really an instrument").unwrap();
    }

    #[test]
    fn the_instruments_folder_lists_sound_fonts_and_sampler_instruments_and_nothing_else() {
        let music = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        for name in ["piano.sf2", "strings.exs", "SHOUTED.SF2", "notes.txt", "cover.png"] {
            write(folder.path(), name);
        }

        let found = files(music.path(), folder.path());
        assert_eq!(
            found.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(),
            ["SHOUTED.SF2", "piano.sf2", "strings.exs"]
        );
        assert!(found.iter().all(|entry| entry.kind == "file" && !entry.loaded));
        assert_eq!(found[1].id, format!("file:{}", folder.path().join("piano.sf2").display()));
    }

    #[test]
    fn a_mac_without_logic_lists_no_pianos_and_says_nothing_about_it() {
        let music = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        assert!(files(music.path(), folder.path()).is_empty());
        assert!(files(&music.path().join("gone"), &folder.path().join("gone")).is_empty());
    }

    #[test]
    fn logics_two_pianos_are_listed_and_the_vintage_upright_is_not() {
        let music = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let pianos = music.path().join("Logic Pro Library.bundle").join(STUDIO_PIANO);
        for name in [
            "Concert Grand Piano.exs",
            "Studio Grand Piano.exs",
            "Vintage Upright Piano.exs",
            "Studio Grand Piano (One Mic).exs",
        ] {
            write(&pianos, name);
        }

        let found = files(music.path(), folder.path());
        assert_eq!(
            found.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(),
            ["Concert Grand Piano", "Studio Grand Piano"]
        );
    }

    #[test]
    fn an_id_survives_the_trip_out_to_the_webview_and_back() {
        let desc = wildcard();
        let back = plugin_desc(&plugin_id(&desc)).unwrap();
        assert_eq!(back.componentType, MUSIC_DEVICE);
        assert_eq!(back.componentSubType, 0);
        assert!(plugin_desc("file:/tmp/piano.sf2").is_none());
        assert!(plugin_desc("au:nonsense").is_none());
    }

    #[test]
    fn a_plugin_reads_as_its_maker_and_its_name_without_saying_the_maker_twice() {
        assert_eq!(titled("Apple", "AUSampler"), "Apple AUSampler");
        assert_eq!(titled("FabFilter", "FabFilter Pro-R 2"), "FabFilter Pro-R 2");
    }

    /// The one test that plays through the app's own graph, so it holds every step the Audio
    /// dialog takes: pick a broken file, read the reason, pick a good one, hear that it is loaded.
    #[test]
    fn a_file_that_is_no_instrument_reports_why_in_the_picker_and_in_the_status_line() {
        let mut graph = Graph::build().unwrap();
        graph.start_offline(4096).unwrap();
        *GRAPH.lock().unwrap() = Some(graph);

        let folder = tempfile::tempdir().unwrap();
        write(folder.path(), "broken.sf2");
        let broken = format!("file:{}", folder.path().join("broken.sf2").display());

        let failure = load(&broken, None).unwrap_err();
        assert_eq!(failure, "That file is not a SoundFont");
        let said = status();
        assert!(!said.available);
        assert_eq!(said.reason, format!("broken did not load: {failure}"));

        let listed = list(&folder.path().to_string_lossy());
        let entry = listed.iter().find(|entry| entry.id == broken).unwrap();
        assert!(!entry.loaded);
        assert_eq!(entry.reason, failure);

        load(&format!("file:{FIXTURE}"), None).unwrap();
        assert!(status().available);
    }

    /// Apple's DLSMusicDevice is the one Audio Unit instrument on every Mac that sounds with
    /// nothing loaded into it. The picker leaves it out; a test that needs a real plugin takes it.
    fn apple_instrument() -> AudioComponentDescription {
        AudioComponentDescription {
            componentType: MUSIC_DEVICE,
            componentSubType: u32::from_be_bytes(*b"dls "),
            componentManufacturer: u32::from_be_bytes(*b"appl"),
            componentFlags: 0,
            componentFlagsMask: 0,
        }
    }

    #[test]
    fn a_hosted_audio_unit_plays_in_the_samplers_place_and_hands_over_its_state() {
        let unit = instantiate(apple_instrument()).unwrap();
        let mut graph = Graph::build().unwrap();
        graph.set_plugin(unit);
        graph.start_offline(4096).unwrap();
        graph.note_on(60, 100);
        assert!(graph.render_peak(4410).unwrap() > 0.01);

        let state = unsafe { state_of(&graph.plugin().unwrap().AUAudioUnit()) }.unwrap();
        let fresh = instantiate(apple_instrument()).unwrap();
        apply_state(&fresh, &state);
        assert_eq!(unsafe { state_of(&fresh.AUAudioUnit()) }.unwrap(), state);
    }

    #[test]
    fn a_plugin_that_is_no_longer_installed_says_so_instead_of_loading() {
        assert!(component(apple_instrument()).is_some());
        assert!(component(AudioComponentDescription { componentManufacturer: 1, ..wildcard() }).is_none());
    }

    #[test]
    fn the_installed_audio_unit_instruments_are_listed_without_apples_general_midi_players() {
        let found = plugins();
        assert!(
            found.iter().any(|entry| entry.name.contains("AUSampler")),
            "every Mac has Apple's sampler: {found:?}"
        );
        assert!(found.iter().all(|entry| entry.kind == "plugin"));
        for gone in ["DLSMusicDevice", "AUMIDISynth"] {
            assert!(!found.iter().any(|entry| entry.name.contains(gone)), "{gone} is listed");
        }
    }
}

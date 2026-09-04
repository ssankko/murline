//! What the engine can play, and putting one of them into the graph. Three sources make one list:
//! Logic's Studio Piano files, the files in the instruments folder the user chose, and the Audio
//! Unit instruments installed on the Mac. Every entry carries an opaque id, so the webview never
//! learns what a component description or a file path is.

use crate::audio::NO_ENGINE;
use crate::audio::mac::{self, Chosen};
use crate::audio::{Instrument, Kept, Status};
use block2::RcBlock;
use objc2::AnyThread;
use objc2::rc::Retained;
use objc2_audio_toolbox::{AudioComponentDescription, AudioComponentInstantiationOptions};
use objc2_avf_audio::{AVAudioUnit, AVAudioUnitComponentManager, AVAudioUnitMIDIInstrument};
use objc2_foundation::{
    NSData, NSDataBase64DecodingOptions, NSDataBase64EncodingOptions, NSDictionary, NSError,
    NSPropertyListFormat, NSPropertyListMutabilityOptions, NSPropertyListSerialization, NSString,
};
use std::path::{Path, PathBuf};

/// Where Logic keeps the Studio Piano under a sound library root: the first is the layout of a
/// library relocated to a bundle, the second the layout of one left where the installer put it.
const STUDIO_PIANO: [&str; 2] =
    ["Plug-In Settings/Sampler/z_Internal/Studio Piano", "Sampler Instruments/z_Internal/Studio Piano"];
/// The sound library root Logic uses until the user relocates it.
const LOGIC_LIBRARY: &str = "/Library/Application Support/Logic";
/// The Studio Piano instruments the engine plays. Vintage Upright is left out: its file stores
/// percent-encoded sample paths that resolve to no sample on disk.
const LOGIC_PIANOS: [&str; 2] = ["Concert Grand Piano", "Studio Grand Piano"];
/// The instrument files the voice engine reads out of the instruments folder.
const FILE_KINDS: [&str; 2] = ["sf2", "exs"];
/// Component type `aumu`: the Audio Unit instruments.
const MUSIC_DEVICE: u32 = u32::from_be_bytes(*b"aumu");
/// Apple's DLSMusicDevice and AUMIDISynth, General MIDI players that add nothing over a file the
/// voice engine plays.
const NOT_LISTED: [u32; 2] = [u32::from_be_bytes(*b"dls "), u32::from_be_bytes(*b"msyn")];
/// How long instantiating a plugin may take before the load gives up on it.
const PATIENCE: std::time::Duration = std::time::Duration::from_mins(1);

/// Every instrument the engine can play right now, in source order, with the load state of the one
/// that is loaded (or that failed to).
pub fn list(folder: &str) -> Vec<Instrument> {
    let mut all = files(&music_folder(), Path::new(LOGIC_LIBRARY), Path::new(folder));
    all.extend(plugins());
    let chosen = mac::graph().and_then(|graph| graph.chosen().cloned());
    if let Some(chosen) = chosen {
        for entry in all.iter_mut().filter(|entry| entry.id == chosen.id) {
            entry.loaded = chosen.failure.is_none();
            entry.reason = chosen.failure.clone().unwrap_or_default();
        }
    }
    all
}

/// Loads the instrument an id names, with everything the window keeps for it, and answers the
/// engine's status. The file read or the plugin instantiate happens with no graph lock held, so a
/// key pressed while it runs plays on the Instrument still in; the lock is taken only to swap the
/// built one in. A build that fails leaves the old Instrument playing and answers why.
pub fn load(id: &str, kept: &Kept) -> Result<Status, String> {
    let voices = mac::voices().ok_or(NO_ENGINE)?;
    let (name, made) = build(id, kept.state.as_deref(), voices);

    let mut graph = mac::graph().ok_or(NO_ENGINE)?;
    let outcome = made.map(|made| {
        match made {
            Made::File(instrument) => graph.load_instrument(instrument),
            Made::Plugin(unit) => graph.set_plugin(unit),
        }
        // Inside the swap, so the first note that can reach the new Instrument already has them.
        graph.restore(kept);
    });
    let failure = outcome.clone().err();
    graph.choose(Chosen { id: id.into(), name, failure, kept: kept.clone() });
    outcome?;
    Ok(graph.status())
}

/// Takes whatever is loaded out of the graph and answers the engine's status, which from here on
/// names no instrument.
pub fn unload() -> Result<Status, String> {
    let mut graph = mac::graph().ok_or(NO_ENGINE)?;
    graph.unload();
    Ok(graph.status())
}

/// An Instrument built and ready to take the head: the samples the voice engine plays, or the
/// hosted Audio Unit that plays itself.
enum Made {
    File(std::sync::Arc<crate::audio::sampler::Instrument>),
    Plugin(Retained<AVAudioUnitMIDIInstrument>),
}

/// Reads the file or builds the plugin an id names, with a plugin's stored state on it. Nothing of
/// the graph is touched here, which is what lets the load run this outside the lock. Answers the
/// name to show whether it worked or not, so a failed choice is still named in the picker.
fn build(id: &str, state: Option<&str>, voices: usize) -> (String, Result<Made, String>) {
    match path_of(id) {
        Some(path) => (stem(&path), mac::read_file(&path, voices).map(Made::File)),
        None => match plugin_desc(id).and_then(component) {
            None => (id.to_string(), Err("That instrument is not installed".into())),
            Some((desc, name)) => (
                name,
                instantiate::<AVAudioUnitMIDIInstrument>(desc).map(|unit| {
                    if let Some(state) = state {
                        apply_state(&unit, state);
                    }
                    Made::Plugin(unit)
                }),
            ),
        },
    }
}

/// A hosted unit's whole state as a base64 property list, the one string the webview keeps for it,
/// whether the unit plays as the instrument or sits in the effect chain.
pub(in crate::audio) fn state_of(unit: &AVAudioUnit) -> Option<String> {
    unsafe {
        let full = unit.AUAudioUnit().fullState()?;
        let data = NSPropertyListSerialization::dataWithPropertyList_format_options_error(
            &full,
            NSPropertyListFormat::BinaryFormat_v1_0,
            0,
        )
        .ok()?;
        Some(data.base64EncodedStringWithOptions(NSDataBase64EncodingOptions::empty()).to_string())
    }
}

/// The other direction, on a freshly built unit. A blob the plugin no longer understands is
/// dropped rather than reported: the unit still plays, at its own defaults.
pub(in crate::audio) fn apply_state(unit: &AVAudioUnit, state: &str) {
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
            NSPropertyListMutabilityOptions::Immutable,
            std::ptr::null_mut(),
        ) else {
            return;
        };
        if let Ok(state) = plist.downcast::<NSDictionary>() {
            unit.AUAudioUnit().setFullState(Some(state.cast_unchecked()));
        }
    }
}

/// The file instruments: Logic's two pianos, then whatever the instruments folder holds.
fn files(music: &Path, library: &Path, folder: &Path) -> Vec<Instrument> {
    let mut all = logic_pianos(music, library);
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

/// Logic's Studio Piano, read in place out of its sound library. A library relocated to a bundle
/// in `~/Music` answers before the default root, and one library answers for all: the first root
/// holding the pianos ends the search, so a relocation that left the old files behind lists them
/// once. No Logic on the Mac means no entries and nothing to report.
fn logic_pianos(music: &Path, library: &Path) -> Vec<Instrument> {
    let bundles = read_dir(music).filter(|path| path.extension().is_some_and(|kind| kind == "bundle"));
    for root in bundles.chain(std::iter::once(library.to_path_buf())) {
        let found: Vec<Instrument> = STUDIO_PIANO
            .iter()
            .flat_map(|place| LOGIC_PIANOS.map(|name| root.join(place).join(format!("{name}.exs"))))
            .filter(|path| path.is_file())
            .map(|path| file_entry(&path, stem(&path)))
            .collect();
        if !found.is_empty() {
            return found;
        }
    }
    Vec::new()
}

/// The installed Audio Unit instruments, by manufacturer and name.
fn plugins() -> Vec<Instrument> {
    let mut all = Vec::new();
    unsafe {
        let manager = AVAudioUnitComponentManager::sharedAudioUnitComponentManager();
        for component in &manager.componentsMatchingDescription(wildcard()) {
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

/// Builds the Audio Unit behind a description, instrument or effect, and hands it back as the
/// class it is. Out of process, the way Logic hosts a plugin: the unit runs inside Apple's hosting
/// service, so one that crashes costs that service and not the app, and the crash arrives here as
/// a plain failure with the system's own words. Apple hands the unit back on a queue of its own
/// choosing, so the load waits here for it.
pub(in crate::audio) fn instantiate<T: objc2::DowncastTarget>(
    desc: AudioComponentDescription,
) -> Result<Retained<T>, String> {
    /// The unit, already retained inside the completion handler, on its way to the waiting load.
    struct Handoff<T>(*mut T, Option<String>);
    // Nothing else holds the unit while it travels, and only the receiver ever touches it.
    unsafe impl<T> Send for Handoff<T> {}

    let (post, wait) = std::sync::mpsc::channel::<Handoff<T>>();
    let handler = RcBlock::new(move |unit: *mut AVAudioUnit, error: *mut NSError| {
        let handoff = unsafe {
            match Retained::retain(unit).and_then(|unit| unit.downcast::<T>().ok()) {
                Some(unit) => Handoff(Retained::into_raw(unit), None),
                None => Handoff(
                    std::ptr::null_mut(),
                    Some(Retained::retain(error).map_or_else(
                        || "The plugin could not be built".to_string(),
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
            AudioComponentInstantiationOptions::LoadOutOfProcess,
            &handler,
        );
    }
    let handoff = wait.recv_timeout(PATIENCE).map_err(|_| "The plugin took too long to load")?;
    match unsafe { Retained::from_raw(handoff.0) } {
        Some(unit) => Ok(unit),
        None => Err(handoff.1.unwrap_or_else(|| "The plugin could not be built".into())),
    }
}

/// Apple's DLSMusicDevice: the one Audio Unit instrument on every Mac that sounds with nothing
/// loaded into it, so a test that needs a real plugin can take it. The picker leaves it out.
#[cfg(test)]
pub(in crate::audio) const APPLE_INSTRUMENT: AudioComponentDescription = AudioComponentDescription {
    componentType: MUSIC_DEVICE,
    componentSubType: u32::from_be_bytes(*b"dls "),
    componentManufacturer: u32::from_be_bytes(*b"appl"),
    componentFlags: 0,
    componentFlagsMask: 0,
};

/// The Studio Piano files on this Mac, wherever its sound library sits, for the tests that read a
/// real Logic instrument.
#[cfg(test)]
pub(in crate::audio) fn logic_piano_paths() -> Vec<PathBuf> {
    logic_pianos(&music_folder(), Path::new(LOGIC_LIBRARY))
        .iter()
        .filter_map(|entry| path_of(&entry.id))
        .collect()
}

#[cfg(test)]
pub(in crate::audio) fn hosted_instrument() -> Retained<AVAudioUnitMIDIInstrument> {
    instantiate(APPLE_INSTRUMENT).unwrap()
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
    use crate::audio::mac::{Graph, graph as running};

    /// The same few kilobytes of SoundFont the graph's own tests play.
    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/sine.sf2");

    /// A sound library root that holds nothing, for the tests that are about the other roots.
    fn nowhere() -> PathBuf {
        PathBuf::from("/nonexistent/Logic")
    }

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

        let found = files(music.path(), &nowhere(), folder.path());
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
        assert!(files(music.path(), &nowhere(), folder.path()).is_empty());
        assert!(
            files(&music.path().join("gone"), &nowhere(), &folder.path().join("gone")).is_empty()
        );
    }

    #[test]
    fn logics_two_pianos_are_listed_and_the_vintage_upright_is_not() {
        let music = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let pianos = music.path().join("Logic Pro Library.bundle").join(STUDIO_PIANO[0]);
        for name in [
            "Concert Grand Piano.exs",
            "Studio Grand Piano.exs",
            "Vintage Upright Piano.exs",
            "Studio Grand Piano (One Mic).exs",
        ] {
            write(&pianos, name);
        }

        let found = files(music.path(), &nowhere(), folder.path());
        assert_eq!(
            found.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(),
            ["Concert Grand Piano", "Studio Grand Piano"]
        );
    }

    /// A sound library the user never relocated stays under `/Library/Application Support/Logic`,
    /// where the pianos sit in `Sampler Instruments` rather than under `Plug-In Settings`.
    #[test]
    fn a_sound_library_left_where_logic_installed_it_lists_the_same_two_pianos() {
        let music = tempfile::tempdir().unwrap();
        let library = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let pianos = library.path().join("Sampler Instruments/z_Internal/Studio Piano");
        for name in ["Concert Grand Piano.exs", "Studio Grand Piano.exs", "Vintage Upright Piano.exs"] {
            write(&pianos, name);
        }

        let found = files(music.path(), library.path(), folder.path());
        assert_eq!(
            found.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(),
            ["Concert Grand Piano", "Studio Grand Piano"]
        );
        assert_eq!(found[0].id, format!("file:{}", pianos.join("Concert Grand Piano.exs").display()));
    }

    /// Relocating a library copies the pianos without always clearing the old root, and the app
    /// plays one instrument, not two of each.
    #[test]
    fn pianos_in_both_roots_are_listed_once() {
        let music = tempfile::tempdir().unwrap();
        let library = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let bundle = music.path().join("Logic Pro Library.bundle").join(STUDIO_PIANO[0]);
        for name in ["Concert Grand Piano.exs", "Studio Grand Piano.exs"] {
            write(&bundle, name);
            write(&library.path().join(STUDIO_PIANO[1]), name);
        }

        let found = files(music.path(), library.path(), folder.path());
        assert_eq!(
            found.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(),
            ["Concert Grand Piano", "Studio Grand Piano"]
        );
        assert!(found.iter().all(|entry| entry.id.contains(".bundle")), "{found:?}");
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
    /// dialog takes: pick a broken file, read the reason, pick a good one, hear that it is loaded,
    /// take it out again and hear nothing. One test, because the installed graph is one global.
    #[test]
    fn a_file_that_is_no_instrument_reports_why_in_the_picker_and_in_the_status_line() {
        let mut graph = Graph::build().unwrap();
        graph.start_offline(4096).unwrap();
        mac::install(graph);

        let folder = tempfile::tempdir().unwrap();
        write(folder.path(), "broken.sf2");
        let broken = format!("file:{}", folder.path().join("broken.sf2").display());

        let failure = load(&broken, &Kept::default()).unwrap_err();
        assert_eq!(failure, "That file is not a SoundFont");
        let said = running().expect("the installed graph").status();
        assert!(!said.available);
        assert_eq!(said.reason, format!("broken did not load: {failure}"));

        let listed = list(&folder.path().to_string_lossy());
        let entry = listed.iter().find(|entry| entry.id == broken).unwrap();
        assert!(!entry.loaded);
        assert_eq!(entry.reason, failure);

        // A good file, with the Envelope and the Role level the user left this instrument at: both
        // go on inside the swap, so the first note after the switch already answers as it should.
        let kept = Kept {
            envelope: Some(crate::audio::Envelope {
                attack: 0.4,
                decay: 0.1,
                sustain: 0.5,
                release: 0.9,
            }),
            roles: vec![(crate::audio::sampler::Role::Release, 0)],
            ..Kept::default()
        };
        let said = load(&format!("file:{FIXTURE}"), &kept).unwrap();
        assert!(said.available, "the load answers the engine's status: {}", said.reason);
        assert_eq!(running().expect("the installed graph").envelope(), kept.envelope);

        // Taking the instrument out: nothing is named in the status line and no key sounds, while
        // the engine itself keeps running.
        let said = unload().unwrap();
        assert!(!said.available);
        assert_eq!(said.reason, "No instrument chosen");
        assert_eq!(said.instrument, "");
        assert_eq!(said.instrument_rate, 0.0);
        assert!(running().expect("the installed graph").chosen().is_none());

        // The order to give the samples up is taken up at the next block, so one pass goes by
        // before the key that must now be silent.
        mac::peak(4096);
        running().expect("the installed graph").note_on(60, 100);
        assert!(mac::peak(4096) < 0.001);
    }

    #[test]
    fn a_hosted_audio_unit_plays_in_the_samplers_place_and_hands_over_its_state() {
        let unit = hosted_instrument();
        let mut graph = Graph::build().unwrap();
        graph.set_plugin(unit);
        graph.start_offline(4096).unwrap();
        graph.note_on(60, 100);
        assert!(graph.render_peak(4410).unwrap() > 0.01);

        let state = state_of(graph.plugin().unwrap()).unwrap();
        let fresh = hosted_instrument();
        apply_state(&fresh, &state);
        assert_eq!(state_of(&fresh).unwrap(), state);
    }

    /// Hosted the way Logic hosts a plugin: the unit runs inside Apple's hosting service, so the
    /// app's process is not where a crash inside the plugin lands.
    #[test]
    fn a_hosted_unit_runs_outside_the_app() {
        let unit = hosted_instrument();
        assert!(!unsafe { unit.AUAudioUnit().isLoadedInProcess() });
    }

    /// A plugin that will not build is a load that failed and nothing more: the app is still
    /// running to read the reason, and the reason is the system's own words. This is the path a
    /// plugin that crashes inside its own load takes, the crash costing the hosting service.
    #[test]
    fn a_plugin_that_will_not_build_answers_the_systems_reason_and_takes_nothing_down() {
        let nowhere = AudioComponentDescription {
            componentSubType: u32::from_be_bytes(*b"zzzz"),
            ..APPLE_INSTRUMENT
        };
        let why = instantiate::<AVAudioUnitMIDIInstrument>(nowhere).unwrap_err();
        assert!(!why.is_empty(), "the system says why the plugin did not build: {why}");
    }

    /// A crash costs the plugin's own process and not the app's, so the death of the hosting
    /// service arrives as an ordinary failure: the instrument reads as failed with its name and
    /// the reason, which is the line the status bar shows, and the graph plays on.
    #[test]
    fn a_hosted_plugin_whose_process_dies_names_itself_in_the_status_and_the_graph_plays_on() {
        let mut graph = Graph::build().unwrap();
        graph.set_plugin(hosted_instrument());
        graph.start_offline(4096).unwrap();
        graph.choose(Chosen {
            id: "au:00000000:00000000:00000000".into(),
            name: "Apple DLSMusicDevice".into(),
            failure: None,
            kept: Kept::default(),
        });
        assert!(graph.status().available);

        // Another unit's death is not this one's: an effect that stops leaves the instrument in.
        let other = hosted_instrument();
        let elsewhere = Retained::as_ptr(&unsafe { other.AUAudioUnit() }).addr();
        assert!(!graph.plugin_stopped(elsewhere));
        assert!(graph.status().available);

        let mine = Retained::as_ptr(&unsafe { graph.plugin().unwrap().AUAudioUnit() }).addr();
        assert!(graph.plugin_stopped(mine));
        let said = graph.status();
        assert!(!said.available);
        assert_eq!(said.reason, "Apple DLSMusicDevice did not load: It stopped running");
        assert_eq!(said.instrument, "");
        graph.render_peak(4410).expect("the graph renders on without the plugin");
    }

    #[test]
    fn a_plugin_that_is_no_longer_installed_says_so_instead_of_loading() {
        assert!(component(APPLE_INSTRUMENT).is_some());
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

//! The effect chain: the ordered Audio Unit effects between the instrument and the mixer, and the
//! windows their plugins draw for themselves.
//!
//! The chain the webview sends is the whole truth; `set_chain` diffs it against what is held, keeps
//! every node it can, and rewires the path. A slot whose plugin is not installed keeps its place
//! and its state blob and is simply left out of the wiring, as a bypassed one is, so nothing about
//! the instrument stops when either changes.

use crate::audio::mac::{GRAPH, Graph};
use crate::audio::{Effect, Slot};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{AllocAnyThread, MainThreadMarker, MainThreadOnly, Message, msg_send, sel};
use objc2_app_kit::{
    NSBackingStoreType, NSView, NSViewController, NSWindow, NSWindowStyleMask,
    NSWindowWillCloseNotification,
};
use objc2_audio_toolbox::{
    AudioComponentDescription, AudioUnitCocoaViewInfo, AudioUnitGetProperty,
    kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global,
};
use objc2_avf_audio::{AVAudioNode, AVAudioUnit, AVAudioUnitComponentManager, AVAudioUnitEffect};
use objc2_foundation::{
    NSBundle, NSData, NSDataBase64DecodingOptions, NSDataBase64EncodingOptions, NSDictionary,
    NSNotificationCenter, NSObjectProtocol, NSPoint, NSPropertyListFormat,
    NSPropertyListMutabilityOptions, NSPropertyListSerialization, NSRect, NSSize, NSString, NSURL,
};
use std::cell::RefCell;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

/// Audio Unit effects, the one component type this chain hosts.
const EFFECT: u32 = u32::from_be_bytes(*b"aufx");
/// The event the webview listens on to write the chain back to its setting, carrying the whole
/// chain as `audio_chain` would answer it.
const CHANGED: &str = "audio-chain-changed";

/// One slot of the chain as the engine holds it: what the webview asked for, plus the node playing
/// it when the plugin is installed.
pub struct Held {
    id: String,
    name: String,
    bypass: bool,
    /// The blob the slot came with, kept so a slot whose plugin is missing does not lose the
    /// settings it had when the plugin was still there.
    state: String,
    unit: Option<Retained<AVAudioUnitEffect>>,
}

// The plugin windows on screen, by the address of the unit each one edits, so a reorder never
// points a window at another plugin. Only the main thread ever touches AppKit, so this lives with
// it instead of in a lock; the unit is held beside its window so a slot removed while its window is
// open cannot leave the view behind a dead plugin.
thread_local! {
    static WINDOWS: RefCell<HashMap<usize, Open>> = RefCell::new(HashMap::new());
}

/// A plugin window and the unit it edits, which it keeps alive for as long as it is on screen.
type Open = (Retained<NSWindow>, Retained<AVAudioUnitEffect>);

/// Every installed Audio Unit effect, Apple's own included, by manufacturer and name.
pub fn effects() -> Vec<Effect> {
    let mut list: Vec<Effect> = components(description(EFFECT, 0, 0))
        .iter()
        .map(|component| unsafe {
            Effect {
                id: id_of(component.audioComponentDescription()),
                name: component.name().to_string(),
                manufacturer: component.manufacturerName().to_string(),
            }
        })
        .collect();
    list.sort_by(|one, two| {
        (&one.manufacturer, &one.name).cmp(&(&two.manufacturer, &two.name))
    });
    list
}

/// The chain as it stands, with every installed plugin's state read out of it as it is now, so the
/// answer carries whatever the user has just done in a plugin's own window.
pub fn chain() -> Vec<Slot> {
    match GRAPH.lock().unwrap().as_ref() {
        Some(graph) => slots(graph),
        None => Vec::new(),
    }
}

/// Takes the whole chain and makes the graph match it, keeping every node whose plugin is still in
/// the list so a reorder, a bypass or a removal never reloads a plugin or stops the instrument.
/// Answers with the chain as it ended up: names as the plugins call themselves, and the slots whose
/// plugin is not installed marked missing.
pub fn set_chain(wanted: Vec<Slot>) -> Result<Vec<Slot>, String> {
    let mut held = GRAPH.lock().unwrap();
    let graph = held.as_mut().ok_or("The sound engine did not start")?;
    Ok(apply(graph, wanted))
}

/// What `set_chain` does to one graph, which is the whole of it apart from finding the graph.
pub fn apply(graph: &mut Graph, wanted: Vec<Slot>) -> Vec<Slot> {
    // Building a plugin and wiring it in both open files and start it up inside CoreAudio, which
    // two at once in one process do not survive, so a chain change takes the same turn a sampler
    // load does.
    let _turn = crate::audio::mac::LOADING.lock().unwrap();
    let engine = graph.engine.clone();
    let max_frames = graph.offline_frames;
    let wired = wiring(&graph.chain);
    let mut spare = std::mem::take(&mut graph.chain);

    for slot in wanted {
        // The plugin is asked for by name before it is built: a description no component answers to
        // makes AVFoundation throw, and a slot for an uninstalled plugin is an ordinary thing.
        let installed = description_of(&slot.id).and_then(|desc| Some((desc, installed_name(desc)?)));
        let reused = spare
            .iter()
            .position(|old| old.id == slot.id && old.unit.is_some())
            .map(|at| spare.remove(at));
        let unit = match (reused, &installed) {
            (Some(old), _) => old.unit,
            (None, Some((desc, _))) => {
                let unit = unsafe {
                    AVAudioUnitEffect::initWithAudioComponentDescription(
                        AVAudioUnitEffect::alloc(),
                        *desc,
                    )
                };
                unsafe {
                    // Offline rendering asks for more frames in one pass than a device ever would,
                    // and a unit that was not told so refuses to render them.
                    if max_frames > 0 {
                        unit.AUAudioUnit().setMaximumFramesToRender(max_frames);
                    }
                    engine.attachNode(&unit);
                }
                if !slot.state.is_empty() {
                    apply_state(&unit, &slot.state);
                }
                Some(unit)
            }
            (None, None) => None,
        };
        // The plugin's own bypass, not a hole in the wiring: switching it costs no reconnection, so
        // a note sounding while the user compares with and without it plays on.
        if let Some(unit) = &unit {
            unsafe { unit.setBypass(slot.bypass) };
        }
        graph.chain.push(Held {
            name: installed.map(|(_, name)| name).unwrap_or(slot.name),
            id: slot.id,
            bypass: slot.bypass,
            state: slot.state,
            unit,
        });
    }

    for gone in spare {
        if let Some(unit) = gone.unit {
            unsafe { engine.detachNode(&unit) };
        }
    }
    // AVAudioEngine flushes every sounding voice when a connection changes, so the path is touched
    // only when it is really another one: a bypass or a state change alone never interrupts a note.
    if wiring(&graph.chain) != wired {
        rewire(graph);
    }
    slots(graph)
}

/// The nodes the sound runs through, by address: two chains wired the same way answer the same.
fn wiring(chain: &[Held]) -> Vec<usize> {
    chain
        .iter()
        .filter_map(|held| held.unit.as_ref().map(|unit| Retained::as_ptr(unit) as usize))
        .collect()
}

/// Opens the plugin's own window for one slot. The window is the user's to close; closing it hands
/// the plugin's settings back through the chain-changed event.
pub fn show_effect(app: AppHandle, index: usize) -> Result<(), String> {
    {
        let held = GRAPH.lock().unwrap();
        let graph = held.as_ref().ok_or("The sound engine did not start")?;
        let slot = graph.chain.get(index).ok_or("There is no such effect")?;
        if slot.unit.is_none() {
            return Err(format!("{} is not installed", slot.name));
        }
    }
    let handle = app.clone();
    app.run_on_main_thread(move || open_window(handle, index))
        .map_err(|error| error.to_string())
}

fn slots(graph: &Graph) -> Vec<Slot> {
    graph
        .chain
        .iter()
        .map(|held| Slot {
            id: held.id.clone(),
            name: held.name.clone(),
            bypass: held.bypass,
            state: match &held.unit {
                Some(unit) => read_state(unit).unwrap_or_else(|| held.state.clone()),
                None => held.state.clone(),
            },
            missing: held.unit.is_none(),
        })
        .collect()
}

/// Connects the instrument through every installed plugin to the mixer. A slot whose plugin is
/// missing is left out; a bypassed one stays in the path and passes its sound through untouched.
fn rewire(graph: &Graph) {
    let engine = &graph.engine;
    unsafe {
        engine.disconnectNodeOutput(&graph.sampler);
        for held in &graph.chain {
            if let Some(unit) = &held.unit {
                engine.disconnectNodeOutput(unit);
            }
        }
        let mixer = engine.mainMixerNode();
        let mut path: Vec<&AVAudioNode> = vec![&graph.sampler];
        for held in &graph.chain {
            if let Some(unit) = &held.unit {
                path.push(unit);
            }
        }
        path.push(&mixer);
        for pair in path.windows(2) {
            engine.connect_to_format(pair[0], pair[1], Some(&graph.format));
        }
    }
}

/// The plugin's whole state as a base64 property list, the one string the webview keeps for it.
fn read_state(unit: &AVAudioUnit) -> Option<String> {
    unsafe {
        let state = unit.AUAudioUnit().fullState()?;
        let data = NSPropertyListSerialization::dataWithPropertyList_format_options_error(
            &state,
            NSPropertyListFormat::BinaryFormat_v1_0,
            0,
        )
        .ok()?;
        Some(
            data.base64EncodedStringWithOptions(NSDataBase64EncodingOptions::empty())
                .to_string(),
        )
    }
}

/// The other way round, for a plugin that has just been loaded. A blob the plugin will not read is
/// no reason to refuse the slot: it plays at its defaults instead.
fn apply_state(unit: &AVAudioUnit, blob: &str) {
    unsafe {
        let Some(data) = NSData::initWithBase64EncodedString_options(
            NSData::alloc(),
            &NSString::from_str(blob),
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
            unit.AUAudioUnit()
                .setFullState(Some(state.cast_unchecked()));
        }
    }
}

fn components(
    desc: AudioComponentDescription,
) -> Retained<objc2_foundation::NSArray<objc2_avf_audio::AVAudioUnitComponent>> {
    unsafe {
        AVAudioUnitComponentManager::sharedAudioUnitComponentManager()
            .componentsMatchingDescription(desc)
    }
}

/// What the plugin calls itself, and by answering at all, that it is installed.
fn installed_name(desc: AudioComponentDescription) -> Option<String> {
    components(desc)
        .firstObject()
        .map(|component| unsafe { component.name() }.to_string())
}

fn description(kind: u32, sub: u32, manufacturer: u32) -> AudioComponentDescription {
    AudioComponentDescription {
        componentType: kind,
        componentSubType: sub,
        componentManufacturer: manufacturer,
        componentFlags: 0,
        componentFlagsMask: 0,
    }
}

/// A plugin id: the three four-character codes of its component description, which is the one name
/// for a plugin that holds across machines and versions.
fn id_of(desc: AudioComponentDescription) -> String {
    format!(
        "{}:{}:{}",
        code(desc.componentType),
        code(desc.componentSubType),
        code(desc.componentManufacturer)
    )
}

fn description_of(id: &str) -> Option<AudioComponentDescription> {
    let mut parts = id.split(':');
    let desc = description(
        uncode(parts.next()?)?,
        uncode(parts.next()?)?,
        uncode(parts.next()?)?,
    );
    parts.next().is_none().then_some(desc)
}

/// A four-character code as its characters, or as hex for the rare unit whose code is not text.
fn code(value: u32) -> String {
    let bytes = value.to_be_bytes();
    match bytes.iter().all(|byte| (0x20..0x7f).contains(byte)) {
        true => String::from_utf8_lossy(&bytes).into_owned(),
        false => format!("{value:08x}"),
    }
}

fn uncode(text: &str) -> Option<u32> {
    match text.as_bytes() {
        [a, b, c, d] => Some(u32::from_be_bytes([*a, *b, *c, *d])),
        _ => u32::from_str_radix(text, 16).ok(),
    }
}

// Everything below is AppKit, so everything below runs on the main thread and nowhere else.

fn open_window(app: AppHandle, index: usize) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let Some(unit) = held_unit(index) else { return };
    let key = Retained::as_ptr(&unit) as usize;
    let known = WINDOWS.with_borrow(|windows| windows.get(&key).map(|(window, _)| window.clone()));
    if let Some(window) = known {
        window.makeKeyAndOrderFront(None);
        return;
    }

    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(640.0, 400.0)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable | NSWindowStyleMask::Resizable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str(&held_name(index)));
    WINDOWS.with_borrow_mut(|windows| windows.insert(key, (window.clone(), unit.clone())));
    watch_close(app, key, &window);
    fill(&window, &unit, mtm);
    window.center();
    window.makeKeyAndOrderFront(None);
}

/// The plugin's own view in the window: the AUv3 view controller when the plugin has one, else the
/// Cocoa view an AUv2 publishes, else Apple's generic view of its parameters.
fn fill(window: &NSWindow, unit: &AVAudioUnitEffect, mtm: MainThreadMarker) {
    let audio_unit = unsafe { unit.AUAudioUnit() };
    let asks_a_view_controller =
        audio_unit.respondsToSelector(sel!(requestViewControllerWithCompletionHandler:));
    if asks_a_view_controller {
        let window = window.retain();
        let unit = unit.retain();
        // Apple hands the view controller back whenever it is ready, so the window is on screen
        // before it arrives and fills in when it does.
        let handler = RcBlock::new(move |controller: *mut NSViewController| {
            let Some(mtm) = MainThreadMarker::new() else { return };
            match unsafe { controller.as_ref() } {
                Some(controller) => {
                    window.setContentViewController(Some(controller));
                    fit(&window);
                }
                None => cocoa_or_generic(&window, &unit, mtm),
            }
        });
        unsafe {
            let _: () = msg_send![
                &*audio_unit,
                requestViewControllerWithCompletionHandler: &*handler
            ];
        }
        return;
    }
    cocoa_or_generic(window, unit, mtm);
}

fn cocoa_or_generic(window: &NSWindow, unit: &AVAudioUnitEffect, mtm: MainThreadMarker) {
    let view = cocoa_view(unit, mtm).or_else(|| generic_view(unit, mtm));
    if let Some(view) = view {
        window.setContentView(Some(&view));
        fit(window);
    }
}

/// The view an AUv2 publishes: a bundle and a class name, which the host loads and asks for a view.
fn cocoa_view(unit: &AVAudioUnitEffect, _mtm: MainThreadMarker) -> Option<Retained<NSView>> {
    unsafe {
        let audio_unit = unit.audioUnit();
        let mut info = std::mem::MaybeUninit::<AudioUnitCocoaViewInfo>::zeroed();
        let mut size = std::mem::size_of::<AudioUnitCocoaViewInfo>() as u32;
        let status = AudioUnitGetProperty(
            audio_unit,
            kAudioUnitProperty_CocoaUI,
            kAudioUnitScope_Global,
            0,
            std::ptr::NonNull::new(info.as_mut_ptr().cast()).unwrap(),
            std::ptr::NonNull::from(&mut size),
        );
        if status != 0 {
            return None;
        }
        let info = info.assume_init();
        let url: Retained<NSURL> = Retained::retain(info.mCocoaAUViewBundleLocation.as_ptr().cast())?;
        let class_name: Retained<NSString> = Retained::retain(info.mCocoaAUViewClass[0].as_ptr().cast())?;
        let bundle = NSBundle::bundleWithURL(&url)?;
        bundle.load();
        let class = AnyClass::get(&std::ffi::CString::new(class_name.to_string()).ok()?)?;
        let factory: Retained<AnyObject> = msg_send![class, new];
        let view: *mut NSView = msg_send![
            &*factory,
            uiViewForAudioUnit: audio_unit,
            withSize: NSSize::new(640.0, 400.0),
        ];
        Retained::retain(view)
    }
}

/// Apple's own view of a plugin's parameters, for the plugin that draws none of its own. It lives
/// in CoreAudioKit, which nothing else in the app needs, so it is loaded the first time it is.
fn generic_view(unit: &AVAudioUnitEffect, _mtm: MainThreadMarker) -> Option<Retained<NSView>> {
    unsafe {
        let name = c"AUGenericView";
        let class = AnyClass::get(name).or_else(|| {
            let path = NSString::from_str("/System/Library/Frameworks/CoreAudioKit.framework");
            NSBundle::bundleWithPath(&path)?.load().then_some(())?;
            AnyClass::get(name)
        })?;
        let view: *mut NSView = msg_send![class, alloc];
        let view: *mut NSView = msg_send![view, initWithAudioUnit: unit.audioUnit()];
        // An init hands its one reference over, unlike the view an AUv2 factory lends out.
        Retained::from_raw(view)
    }
}

/// Sizes the window to whatever the plugin's view wants to be.
fn fit(window: &NSWindow) {
    let Some(view) = window.contentView() else { return };
    let wanted = view.frame().size;
    if wanted.width > 1.0 && wanted.height > 1.0 {
        window.setContentSize(wanted);
    }
}

/// Reads the plugin's settings out when the user closes its window and tells the webview, which is
/// what keeps them across launches.
fn watch_close(app: AppHandle, key: usize, window: &NSWindow) {
    let centre = NSNotificationCenter::defaultCenter();
    let token: std::rc::Rc<RefCell<Option<Retained<AnyObject>>>> =
        std::rc::Rc::new(RefCell::new(None));
    let held = token.clone();
    let handler = RcBlock::new(move |_: std::ptr::NonNull<objc2_foundation::NSNotification>| {
        WINDOWS.with_borrow_mut(|windows| windows.remove(&key));
        if let Some(token) = held.borrow_mut().take() {
            unsafe { NSNotificationCenter::defaultCenter().removeObserver(&token) };
        }
        app.emit(CHANGED, chain()).ok();
    });
    let observer = unsafe {
        centre.addObserverForName_object_queue_usingBlock(
            Some(NSWindowWillCloseNotification),
            Some(window),
            None,
            &handler,
        )
    };
    *token.borrow_mut() = unsafe { Retained::cast_unchecked::<AnyObject>(observer) }.into();
}

fn held_unit(index: usize) -> Option<Retained<AVAudioUnitEffect>> {
    GRAPH.lock().unwrap().as_ref()?.chain.get(index)?.unit.clone()
}

fn held_name(index: usize) -> String {
    GRAPH
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|graph| graph.chain.get(index).map(|held| held.name.clone()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::mac::Graph;
    use objc2_audio_toolbox::AudioUnitSetParameter;
    use std::path::Path;

    /// Apple's reverb: an effect every Mac has, so no test here needs a plugin the user installed.
    const REVERB: &str = "aufx:rvb2:appl";
    /// Apple's delay, for the tests that need two effects to tell an order from.
    const DELAY: &str = "aufx:dely:appl";
    /// Reverb parameter 0 is its dry/wet mix in percent; full wet makes the tail unmistakable.
    const DRY_WET: u32 = 0;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/sine.sf2");
    const PASS: u32 = 4096;
    const LOOK: u32 = 4410;

    fn offline() -> Graph {
        let mut graph = Graph::build().unwrap();
        graph.load_file(Path::new(FIXTURE)).unwrap();
        graph.start_offline(PASS).unwrap();
        graph
    }

    fn slot(id: &str) -> Slot {
        Slot { id: id.into(), name: id.into(), bypass: false, state: String::new(), missing: false }
    }

    /// The dry/wet mix of the effect at one place in the chain, which is what makes a reverb's tail
    /// something a test can hear.
    fn mix(graph: &Graph, index: usize, percent: f32) {
        let unit = graph.chain[index].unit.clone().unwrap();
        let status = unsafe {
            AudioUnitSetParameter(unit.audioUnit(), DRY_WET, kAudioUnitScope_Global, 0, percent, 0)
        };
        assert_eq!(status, 0, "the reverb took its mix");
    }

    /// Plays a note, lets it go, and answers with the loudest sample left once the sampler's own
    /// release has run out: silence with a dry graph, a tail with a reverb in the chain.
    fn tail(graph: &mut Graph) -> f32 {
        graph.note_on(60, 100);
        graph.render_peak(LOOK).unwrap();
        graph.note_off(60);
        graph.render_peak(LOOK).unwrap();
        graph.render_peak(LOOK).unwrap()
    }

    #[test]
    fn apples_own_reverb_is_in_the_list_of_effects() {
        let list = effects();
        let reverb = list.iter().find(|effect| effect.id == REVERB);
        assert!(reverb.is_some(), "AUReverb2 is on every Mac, in {} effects", list.len());
        assert_eq!(reverb.unwrap().manufacturer, "Apple");
        assert!(list.iter().all(|effect| description_of(&effect.id).is_some()));
    }

    #[test]
    fn an_effect_changes_the_sound_and_bypass_gives_the_dry_one_back() {
        let mut graph = offline();
        assert_eq!(tail(&mut graph), 0.0, "a dry graph goes quiet");

        apply(&mut graph, vec![slot(REVERB)]);
        mix(&graph, 0, 100.0);
        assert!(tail(&mut graph) > 0.0, "the reverb rings on");

        apply(&mut graph, vec![Slot { bypass: true, ..slot(REVERB) }]);
        assert_eq!(tail(&mut graph), 0.0, "bypass is the dry graph again");
    }

    #[test]
    fn a_plugins_settings_round_trip_through_the_blob() {
        let mut graph = offline();
        apply(&mut graph, vec![slot(REVERB)]);
        mix(&graph, 0, 42.0);
        let saved = apply(&mut graph, vec![slot(REVERB)]);
        assert!(!saved[0].state.is_empty(), "the reverb has a state to save");

        // The chain is emptied first, so the slot is built again from its blob and not merely kept.
        apply(&mut graph, vec![]);
        apply(&mut graph, vec![Slot { state: saved[0].state.clone(), ..slot(REVERB) }]);
        let unit = graph.chain[0].unit.clone().unwrap();
        let mut mix_back = 0f32;
        let status = unsafe {
            objc2_audio_toolbox::AudioUnitGetParameter(
                unit.audioUnit(),
                DRY_WET,
                kAudioUnitScope_Global,
                0,
                std::ptr::NonNull::from(&mut mix_back),
            )
        };
        assert_eq!(status, 0);
        assert_eq!(mix_back, 42.0);
    }

    #[test]
    fn a_plugin_that_is_not_installed_keeps_its_slot_and_the_rest_plays() {
        let mut graph = offline();
        let ghost = Slot { name: "Pro-R 2".into(), ..slot("aufx:zzzz:zzzz") };
        let chain = apply(&mut graph, vec![ghost, slot(REVERB)]);

        assert!(chain[0].missing, "the plugin is gone");
        assert_eq!(chain[0].name, "Pro-R 2", "and is known by the name it had");
        assert!(!chain[1].missing);
        mix(&graph, 1, 100.0);
        assert!(tail(&mut graph) > 0.0, "the reverb after it still plays");
    }

    #[test]
    fn a_reorder_lands_in_the_new_order_and_the_chain_plays_on() {
        let mut graph = offline();
        apply(&mut graph, vec![slot(REVERB), slot(DELAY)]);

        let chain = apply(&mut graph, vec![slot(DELAY), slot(REVERB)]);
        assert_eq!(chain.iter().map(|slot| slot.id.as_str()).collect::<Vec<_>>(), [DELAY, REVERB]);
        graph.note_on(60, 100);
        assert!(graph.render_peak(LOOK).unwrap() > 0.01, "the reordered chain plays");
    }

    #[test]
    fn a_bypass_never_interrupts_a_sounding_note() {
        let mut graph = offline();
        apply(&mut graph, vec![slot(REVERB)]);
        graph.note_on(60, 100);
        assert!(graph.render_peak(LOOK).unwrap() > 0.01);

        // Only the wiring flushes the instrument's voices, and a bypass changes none of it.
        apply(&mut graph, vec![Slot { bypass: true, ..slot(REVERB) }]);
        assert!(graph.render_peak(LOOK).unwrap() > 0.01, "the note played through the change");
    }

    #[test]
    fn an_id_survives_the_trip_through_a_string() {
        let desc = description_of(REVERB).unwrap();
        assert_eq!(desc.componentType, EFFECT);
        assert_eq!(id_of(desc), REVERB);
        assert_eq!(description_of("aufx:rvb2"), None);
        assert_eq!(id_of(description(EFFECT, 0, 0)), "aufx:00000000:00000000");
        assert_eq!(description_of("aufx:00000000:00000000").unwrap().componentSubType, 0);
    }
}

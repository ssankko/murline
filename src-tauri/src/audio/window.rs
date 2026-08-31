//! The plugin instrument's own window: a native window hosting whichever view the Audio Unit
//! publishes, opened when the user asks for it and closed by the user. Closing it reads the unit's
//! state, which the webview then stores with the instrument choice.
//!
//! Everything here below `show` runs on the main thread, because AppKit allows nothing else.

use crate::audio::instruments::state_of;
use crate::audio::mac::GRAPH;
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObjectProtocol, ProtocolObject};
use objc2::{MainThreadMarker, MainThreadOnly, Message, msg_send, sel};
use objc2_app_kit::{
    NSBackingStoreType, NSView, NSViewController, NSWindow, NSWindowStyleMask,
    NSWindowWillCloseNotification,
};
use objc2_audio_toolbox::{
    AudioUnit, AudioUnitCocoaViewInfo, AudioUnitGetProperty, kAudioUnitProperty_CocoaUI,
    kAudioUnitScope_Global,
};
use objc2_avf_audio::{AVAudioUnit, AVAudioUnitMIDIInstrument};
use objc2_foundation::{
    NSBundle, NSNotification, NSNotificationCenter, NSPoint, NSRect, NSSize, NSString, NSURL,
};
use std::cell::RefCell;
use std::ffi::CString;
use std::ptr::NonNull;
use tauri::async_runtime::Sender;

/// What the window is worth to the webview: the plugin's state when the user closed it, or the
/// reason there was no window to show.
type Reply = Result<Option<String>, String>;

/// The size a plugin view gets when it publishes none of its own.
const FALLBACK: NSSize = NSSize { width: 640.0, height: 400.0 };

// The one open plugin window and the observer watching it close, kept alive here because nothing
// else holds them. Main-thread only, like every AppKit object.
type Watcher = Retained<ProtocolObject<dyn NSObjectProtocol>>;
thread_local! {
    static OPEN: RefCell<Option<(Retained<NSWindow>, Watcher)>> = const { RefCell::new(None) };
}

/// The hosted instrument on its way to the main thread. Only the main thread ever touches it, and
/// it is retained for as long as the window lives.
#[derive(Clone)]
struct Held(Retained<AVAudioUnitMIDIInstrument>);

// The unit crosses one thread boundary, into the main thread, and is used nowhere else after.
unsafe impl Send for Held {}

/// Opens the instrument's own window, and answers when the user closes it again with the state the
/// unit was left in.
pub async fn show_instrument(app: tauri::AppHandle) -> Reply {
    let (unit, title) = {
        let held = GRAPH.lock().unwrap();
        let graph = held.as_ref().ok_or("The sound engine did not start")?;
        let unit = graph.plugin().ok_or("This instrument has no window of its own")?;
        (Held(unit.retain()), graph.instrument().unwrap_or("Instrument").to_string())
    };

    let (post, mut answer) = tauri::async_runtime::channel::<Reply>(1);
    app.run_on_main_thread(move || open(unit, title, post)).map_err(|error| error.to_string())?;
    answer.recv().await.unwrap_or(Ok(None))
}

/// Asks an AUv3 for its view controller, and falls back to the AUv2 paths when it has none.
fn open(unit: Held, title: String, post: Sender<Reply>) {
    let Some(mtm) = MainThreadMarker::new() else {
        post.try_send(Err("The window can only open on the main thread".into())).ok();
        return;
    };
    let au = unsafe { (&*unit.0 as &AVAudioUnit).AUAudioUnit() };
    // The binding for this one is hand-written below, so ask the unit before sending it.
    if !au.respondsToSelector(sel!(requestViewControllerWithCompletionHandler:)) {
        present(None, unit, title, post, mtm);
        return;
    }
    let handler = RcBlock::new(move |controller: *mut NSViewController| {
        let controller = unsafe { Retained::retain(controller) };
        // The completion comes back on the main thread, where it must, but say so out loud.
        if let Some(mtm) = MainThreadMarker::new() {
            present(controller, unit.clone(), title.clone(), post.clone(), mtm);
        }
    });
    unsafe {
        let _: () = msg_send![&*au, requestViewControllerWithCompletionHandler: &*handler];
    }
}

/// Puts the view in a window and watches for its close.
fn present(
    controller: Option<Retained<NSViewController>>,
    unit: Held,
    title: String,
    post: Sender<Reply>,
    mtm: MainThreadMarker,
) {
    let raw = unsafe { (&*unit.0 as &AVAudioUnit).audioUnit() };
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), FALLBACK),
            NSWindowStyleMask::Titled
                | NSWindowStyleMask::Closable
                | NSWindowStyleMask::Miniaturizable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // The window lives as long as this module holds it, not as long as it is on screen.
    unsafe { window.setReleasedWhenClosed(false) };

    match controller {
        Some(controller) => window.setContentViewController(Some(&controller)),
        None => {
            let view = unsafe { cocoa_view(raw, mtm).or_else(|| generic_view(raw)) };
            let Some(view) = view else {
                post.try_send(Err("This instrument has no window of its own".into())).ok();
                return;
            };
            window.setContentSize(view.frame().size);
            window.setContentView(Some(&view));
        }
    }
    window.setTitle(&NSString::from_str(&title));
    window.center();
    window.makeKeyAndOrderFront(None);

    let closing = RcBlock::new(move |_: NonNull<NSNotification>| {
        let state = state_of(&unit.0);
        post.try_send(Ok(state)).ok();
        forget_window();
    });
    // No queue, so the block runs as the window posts, before anything below it stores the new
    // window: a close always clears its own entry and never the next one's.
    let token = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSWindowWillCloseNotification),
            Some(&window),
            None,
            &closing,
        )
    };
    // A second Show while one window stands closes it first, so only ever one is open.
    close_window();
    OPEN.with(|open| *open.borrow_mut() = Some((window, token)));
}

/// Closes the open plugin window. Its own observer is what sends its state on.
fn close_window() {
    let open = OPEN.with(|open| open.borrow().as_ref().map(|(window, _)| window.clone()));
    if let Some(window) = open {
        window.close();
    }
}

fn forget_window() {
    if let Some((_, token)) = OPEN.with(|open| open.borrow_mut().take()) {
        unsafe { NSNotificationCenter::defaultCenter().removeObserver(token.as_ref()) };
    }
}

/// The AUv2 path: the Cocoa view the unit publishes, built by the factory class inside the bundle
/// the unit names.
pub(super) unsafe fn cocoa_view(unit: AudioUnit, mtm: MainThreadMarker) -> Option<Retained<NSView>> {
    unsafe {
        let mut info = std::mem::MaybeUninit::<AudioUnitCocoaViewInfo>::zeroed();
        let mut size = size_of::<AudioUnitCocoaViewInfo>() as u32;
        let status = AudioUnitGetProperty(
            unit,
            kAudioUnitProperty_CocoaUI,
            kAudioUnitScope_Global,
            0,
            NonNull::new(info.as_mut_ptr().cast()).unwrap(),
            NonNull::from(&mut size),
        );
        if status != 0 || size < size_of::<AudioUnitCocoaViewInfo>() as u32 {
            return None;
        }
        let info = info.assume_init();
        // The two fields are toll-free bridged, so the Foundation types read them as they are.
        let location: &NSURL = &*info.mCocoaAUViewBundleLocation.as_ptr().cast();
        let name: &NSString = &*info.mCocoaAUViewClass[0].as_ptr().cast();
        let bundle = NSBundle::bundleWithURL(location)?;
        bundle.load();

        let class = AnyClass::get(&CString::new(name.to_string()).ok()?)?;
        let factory: *mut AnyObject = msg_send![class, alloc];
        let factory: *mut AnyObject = msg_send![factory, init];
        let factory = Retained::from_raw(factory)?;
        let view: *mut NSView = msg_send![&*factory, uiViewForAudioUnit: unit, withSize: FALLBACK];
        let _ = mtm;
        Retained::retain(view)
    }
}

/// The last resort: the parameter view CoreAudioKit builds for any unit at all.
pub(super) unsafe fn generic_view(unit: AudioUnit) -> Option<Retained<NSView>> {
    unsafe {
        let framework =
            NSBundle::bundleWithPath(&NSString::from_str("/System/Library/Frameworks/CoreAudioKit.framework"))?;
        framework.load();
        let class = AnyClass::get(c"AUGenericView")?;
        let view: *mut NSView = msg_send![class, alloc];
        let view: *mut NSView = msg_send![view, initWithAudioUnit: unit];
        Retained::from_raw(view)
    }
}

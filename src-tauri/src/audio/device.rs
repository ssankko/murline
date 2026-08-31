//! The output side of the sound engine: the device the app plays through and everything about it,
//! as one `Output` the graph reads whenever the device or its buffer changes. `Devices` is where
//! those facts come from: `Hal` reads CoreAudio's `AudioObject` properties, and a test writes a
//! `Table` instead. The AVAudioEngine graph that plays into the device lives in `mac.rs`.
//!
//! Devices cross the command boundary as their CoreAudio UID, which is an opaque string to the
//! webview and stays the same across unplugging and plugging back in.

use crate::audio::OutputDevice;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_core_audio::{
    AudioObjectAddPropertyListener, AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize,
    AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyScope,
    AudioObjectPropertySelector, AudioObjectSetPropertyData,
    kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDevicePropertyComposition,
    kAudioDevicePropertyAvailableNominalSampleRates, kAudioDevicePropertyBufferFrameSize,
    kAudioDevicePropertyBufferFrameSizeRange, kAudioDevicePropertyDeviceUID,
    kAudioDevicePropertyIsHidden, kAudioDevicePropertyLatency,
    kAudioDevicePropertyNominalSampleRate, kAudioDevicePropertySafetyOffset,
    kAudioDevicePropertyStreams, kAudioDevicePropertyTransportType,
    kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE,
    kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDevices,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyScopeOutput, kAudioObjectSystemObject, kAudioStreamPropertyLatency,
};
use objc2_core_audio_types::AudioValueRange;
use objc2_foundation::{NSDictionary, NSNumber, NSString};
use std::ffi::c_void;
use std::mem::MaybeUninit;
use std::ptr::{NonNull, null, null_mut};
use std::sync::Mutex;

/// A CoreAudio device id. Valid only while the device is plugged in, which is why the app keeps the
/// user's choice as a UID and looks the id up again every time.
pub type DeviceId = AudioObjectID;

/// The buffer sizes the dialog offers. Which of them a device takes is `Output::buffers`.
pub const FRAME_CHOICES: [u32; 5] = [32, 64, 128, 256, 512];
/// The smallest IO cycle a Bluetooth device is asked for. The radio ships audio in packets of
/// about 20 ms, and a sub-millisecond cycle under that is what makes coreaudiod miss deadlines for
/// every app playing through the device.
const BLUETOOTH_FRAMES: u32 = 256;
/// The fallback line when the device the user picked is not plugged in.
const GONE: &str = "Your chosen output device is not connected; playing through the system default";

/// The device the graph plays through and everything it needs to know about it, read in one go.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Output {
    pub id: DeviceId,
    pub name: String,
    pub uid: Option<String>,
    /// The buffer the device runs, which is not always the one it was asked for.
    pub frames: u32,
    /// The buffer sizes it takes, of the ones the dialog knows, ascending.
    pub buffers: Vec<u32>,
    /// The rates it can be set to, as the spans it reports.
    pub rates: Vec<(f64, f64)>,
    /// The rate it is running at.
    pub rate: f64,
    pub latency_ms: f64,
    /// Why this is not the device the user chose; empty while the choice is honoured.
    pub fallback: String,
}

impl Output {
    /// Whether the device lists `rate` among the ones it runs at.
    pub fn runs_at(&self, rate: f64) -> bool {
        self.rates.iter().any(|&(low, high)| (low..=high).contains(&rate))
    }
}

/// Where the graph learns about output devices, and the one place that asks a device to change.
/// Which device answers a choice is decided here, above both adapters.
pub trait Devices: Send + Sync {
    /// The device with this UID, while it is plugged in and can play.
    fn find(&self, uid: &str) -> Option<DeviceId>;
    fn default_output(&self) -> Result<DeviceId, String>;
    /// Everything about one device. An id that names no device answers the empty value, which
    /// takes no buffer and has no name.
    fn describe(&self, device: DeviceId) -> Output;
    fn set_frames(&self, device: DeviceId, frames: u32) -> Result<(), String>;
    fn set_rate(&self, device: DeviceId, rate: f64) -> Result<(), String>;

    /// The device to play through: the chosen one while it is plugged in, the system default when
    /// it is not, which is the fallback line the status reports. The choice itself is kept by the
    /// caller, so the device is taken up again when it comes back.
    fn open(&self, chosen: Option<&str>) -> Result<Output, String> {
        let wanted = chosen.filter(|id| !id.is_empty());
        if let Some(device) = wanted.and_then(|id| self.find(id)) {
            return Ok(self.describe(device));
        }
        let mut output = self.describe(self.default_output()?);
        if wanted.is_some() {
            output.fallback = GONE.into();
        }
        Ok(output)
    }
}

/// The devices CoreAudio reports, which is what the app itself plays through.
pub struct Hal;

impl Devices for Hal {
    fn find(&self, uid: &str) -> Option<DeviceId> {
        read_all::<AudioObjectID>(SYSTEM, kAudioHardwarePropertyDevices, WHOLE)
            .into_iter()
            .find(|&device| plays(device) && self::uid(device).as_deref() == Some(uid))
    }

    fn default_output(&self) -> Result<DeviceId, String> {
        read(SYSTEM, kAudioHardwarePropertyDefaultOutputDevice, WHOLE)
            .filter(|&device| device != 0)
            .ok_or_else(|| "This Mac has no output device".into())
    }

    fn describe(&self, device: DeviceId) -> Output {
        let frames = buffer_frames(device);
        Output {
            id: device,
            name: name(device),
            uid: uid(device),
            frames,
            buffers: allowed_buffers(buffer_range(device), is_bluetooth(device)),
            rates: sample_rate_ranges(device),
            rate: sample_rate(device),
            latency_ms: latency_ms(device, frames),
            fallback: String::new(),
        }
    }

    fn set_frames(&self, device: DeviceId, frames: u32) -> Result<(), String> {
        write(device, kAudioDevicePropertyBufferFrameSize, frames).map_err(|status| {
            format!("The device refused a buffer of {frames} frames (status {status})")
        })
    }

    /// The change is the system's, so every app playing through the device hears it, and a device
    /// that cannot run at the rate refuses.
    fn set_rate(&self, device: DeviceId, rate: f64) -> Result<(), String> {
        write(device, kAudioDevicePropertyNominalSampleRate, rate)
            .map_err(|status| format!("The device refused a rate of {rate} Hz (status {status})"))
    }
}

/// The buffer sizes a device takes: the ones inside the range it reports, and on Bluetooth nothing
/// under `BLUETOOTH_FRAMES`. A device that reports no range takes none of them.
fn allowed_buffers(range: (u32, u32), bluetooth: bool) -> Vec<u32> {
    let least = if bluetooth { range.0.max(BLUETOOTH_FRAMES) } else { range.0 };
    FRAME_CHOICES.into_iter().filter(|&frames| frames >= least && frames <= range.1).collect()
}

/// The devices a test plugs in, in the HAL's place: one row per device, the first of them the
/// system default. A row taken out of the list is a device unplugged, and a write lands on the row
/// the way it lands on the hardware.
#[cfg(test)]
#[derive(Default)]
pub struct Table {
    plugged: Mutex<Vec<Output>>,
}

#[cfg(test)]
impl Table {
    pub fn of(devices: &[Output]) -> Self {
        Table { plugged: Mutex::new(devices.to_vec()) }
    }

    /// The device list as it stands now, which is what a plug or an unplug leaves behind.
    pub fn plug(&self, devices: &[Output]) {
        *self.plugged.lock().unwrap() = devices.to_vec();
    }
}

#[cfg(test)]
impl Devices for Table {
    fn find(&self, uid: &str) -> Option<DeviceId> {
        let plugged = self.plugged.lock().unwrap();
        plugged.iter().find(|one| one.uid.as_deref() == Some(uid)).map(|one| one.id)
    }

    fn default_output(&self) -> Result<DeviceId, String> {
        let plugged = self.plugged.lock().unwrap();
        plugged.first().map(|one| one.id).ok_or_else(|| "This Mac has no output device".into())
    }

    fn describe(&self, device: DeviceId) -> Output {
        let plugged = self.plugged.lock().unwrap();
        plugged.iter().find(|one| one.id == device).cloned().unwrap_or_default()
    }

    fn set_frames(&self, device: DeviceId, frames: u32) -> Result<(), String> {
        let mut plugged = self.plugged.lock().unwrap();
        let Some(row) = plugged.iter_mut().find(|one| one.id == device) else {
            return Err("The device is not plugged in".into());
        };
        if !row.buffers.contains(&frames) {
            return Err(format!("The device refused a buffer of {frames} frames"));
        }
        row.frames = frames;
        Ok(())
    }

    fn set_rate(&self, device: DeviceId, rate: f64) -> Result<(), String> {
        let mut plugged = self.plugged.lock().unwrap();
        let Some(row) = plugged.iter_mut().find(|one| one.id == device) else {
            return Err("The device is not plugged in".into());
        };
        if !row.runs_at(rate) {
            return Err(format!("The device refused a rate of {rate} Hz"));
        }
        row.rate = rate;
        Ok(())
    }
}

#[cfg(test)]
impl Output {
    /// One device for a table: it takes every buffer the dialog offers, runs the largest of them
    /// and runs at one rate. A test moves whatever it is about to assert on.
    pub fn plugged(id: DeviceId, uid: &str) -> Self {
        Output {
            id,
            name: uid.into(),
            uid: Some(uid.into()),
            frames: 512,
            buffers: FRAME_CHOICES.into(),
            rates: vec![(44100.0, 44100.0)],
            rate: 44100.0,
            latency_ms: 0.0,
            fallback: String::new(),
        }
    }
}

/// The object standing for the machine's audio hardware, and the two scopes read below: the whole
/// device, and the side of it that plays.
const SYSTEM: AudioObjectID = kAudioObjectSystemObject as AudioObjectID;
const WHOLE: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal;
const PLAYING: AudioObjectPropertyScope = kAudioObjectPropertyScopeOutput;

fn address(
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope,
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain,
    }
}

/// One fixed-size property, or `None` when the object does not answer it. A device that has just
/// been unplugged answers nothing, so every read here is allowed to come back empty.
fn read<T: Copy>(
    object: AudioObjectID,
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope,
) -> Option<T> {
    let mut at = address(selector, scope);
    let mut value = MaybeUninit::<T>::uninit();
    let mut size = size_of::<T>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            NonNull::from(&mut at),
            0,
            null(),
            NonNull::from(&mut size),
            NonNull::new_unchecked(value.as_mut_ptr()).cast(),
        )
    };
    (status == 0 && size as usize == size_of::<T>()).then(|| unsafe { value.assume_init() })
}

/// A property whose length the object decides: the device list, and a device's streams.
fn read_all<T: Copy>(
    object: AudioObjectID,
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope,
) -> Vec<T> {
    let mut at = address(selector, scope);
    let mut size = 0u32;
    let sized = unsafe {
        AudioObjectGetPropertyDataSize(object, NonNull::from(&mut at), 0, null(), NonNull::from(&mut size))
    };
    let count = if sized == 0 { size as usize / size_of::<T>() } else { 0 };
    let mut items = Vec::<T>::with_capacity(count);
    if count == 0 {
        return items;
    }
    let read = unsafe {
        AudioObjectGetPropertyData(
            object,
            NonNull::from(&mut at),
            0,
            null(),
            NonNull::from(&mut size),
            NonNull::new_unchecked(items.as_mut_ptr()).cast(),
        )
    };
    if read == 0 {
        unsafe { items.set_len(size as usize / size_of::<T>()) };
    }
    items
}

/// A CFString property. CoreAudio hands one over owned, and a CFString is an NSString, so
/// `Retained` releases it.
fn read_text(
    object: AudioObjectID,
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope,
) -> Option<String> {
    let text: *mut NSString = read(object, selector, scope)?;
    unsafe { Retained::from_raw(text) }.map(|text| text.to_string())
}

/// Every device the user may pick, in the order CoreAudio lists them. A device with no output
/// stream, a microphone, is not one the app can play through, so it is left out.
pub fn outputs() -> Vec<OutputDevice> {
    read_all::<AudioObjectID>(SYSTEM, kAudioHardwarePropertyDevices, WHOLE)
        .into_iter()
        .filter(|&device| plays(device) && offerable(device))
        .filter_map(|device| Some(OutputDevice { id: uid(device)?, name: name(device) }))
        .collect()
}

fn plays(device: DeviceId) -> bool {
    !read_all::<AudioObjectID>(device, kAudioDevicePropertyStreams, PLAYING).is_empty()
}

/// False for a device that is CoreAudio's business and not the user's. The one that turns up here
/// is `CADefaultDeviceAggregate-<pid>-0`, which the HAL mints for any process playing through the
/// system default, this app among them: it has an output stream and a UID like any other device.
/// It does not set the hidden flag, so what marks it is `private` in its aggregate composition.
fn offerable(device: DeviceId) -> bool {
    read::<u32>(device, kAudioDevicePropertyIsHidden, WHOLE).unwrap_or(0) == 0
        && !private_aggregate(device)
}

fn private_aggregate(device: DeviceId) -> bool {
    let composition: Option<*mut NSDictionary<NSString, AnyObject>> =
        read(device, kAudioAggregateDevicePropertyComposition, WHOLE);
    // Anything that is not an aggregate answers nothing, and is the user's to pick.
    let Some(composition) = composition.and_then(|raw| unsafe { Retained::from_raw(raw) }) else {
        return false;
    };
    let key = NSString::from_str(&kAudioAggregateDeviceIsPrivateKey.to_string_lossy());
    composition
        .objectForKey(&key)
        .and_then(|flag| flag.downcast::<NSNumber>().ok())
        .is_some_and(|flag| flag.boolValue())
}

/// The name to show, and the UID when the device will not give one, so a picker row is never blank.
fn name(device: DeviceId) -> String {
    read_text(device, kAudioObjectPropertyName, WHOLE)
        .or_else(|| uid(device))
        .unwrap_or_default()
}

fn uid(device: DeviceId) -> Option<String> {
    read_text(device, kAudioDevicePropertyDeviceUID, WHOLE)
}

/// The rate the device is running at.
fn sample_rate(device: DeviceId) -> f64 {
    read(device, kAudioDevicePropertyNominalSampleRate, WHOLE).unwrap_or(0.0)
}

fn buffer_frames(device: DeviceId) -> u32 {
    read(device, kAudioDevicePropertyBufferFrameSize, WHOLE).unwrap_or(0)
}

/// The smallest and the largest IO cycle the device takes, in frames. A device that answers
/// nothing takes no size at all, which is what an id that no longer names a device does.
fn buffer_range(device: DeviceId) -> (u32, u32) {
    read::<AudioValueRange>(device, kAudioDevicePropertyBufferFrameSizeRange, WHOLE)
        .map_or((0, 0), |range| (range.mMinimum as u32, range.mMaximum as u32))
}

/// The rates the device can be set to, as the spans it reports. A device with a fixed set of rates
/// reports each of them as a span whose ends are the same; one with its own clock reports a span
/// it can run anywhere inside.
fn sample_rate_ranges(device: DeviceId) -> Vec<(f64, f64)> {
    read_all::<AudioValueRange>(device, kAudioDevicePropertyAvailableNominalSampleRates, WHOLE)
        .into_iter()
        .map(|range| (range.mMinimum, range.mMaximum))
        .collect()
}

/// Whether the device plays over Bluetooth, which is what makes a small IO cycle unworkable: the
/// radio ships audio in packets of about 20 ms whatever the buffer says.
fn is_bluetooth(device: DeviceId) -> bool {
    read::<u32>(device, kAudioDevicePropertyTransportType, WHOLE).is_some_and(|transport| {
        transport == kAudioDeviceTransportTypeBluetooth
            || transport == kAudioDeviceTransportTypeBluetoothLE
    })
}

/// One fixed-size property written back, answering the status a refusal comes with.
fn write<T: Copy>(
    device: DeviceId,
    selector: AudioObjectPropertySelector,
    value: T,
) -> Result<(), i32> {
    let mut at = address(selector, WHOLE);
    let status = unsafe {
        AudioObjectSetPropertyData(
            device,
            NonNull::from(&mut at),
            0,
            null(),
            size_of::<T>() as u32,
            NonNull::from(&value).cast(),
        )
    };
    if status == 0 { Ok(()) } else { Err(status) }
}

/// What the device says it costs to get a rendered frame out of the speaker, in milliseconds: the
/// four frame counts CoreAudio reports, at the rate the device runs.
fn latency_ms(device: DeviceId, frames: u32) -> f64 {
    let stream = read_all::<AudioObjectID>(device, kAudioDevicePropertyStreams, PLAYING)
        .first()
        .and_then(|&stream| read::<u32>(stream, kAudioStreamPropertyLatency, WHOLE))
        .unwrap_or(0);
    latency_of(
        read(device, kAudioDevicePropertyLatency, PLAYING).unwrap_or(0),
        read(device, kAudioDevicePropertySafetyOffset, PLAYING).unwrap_or(0),
        stream,
        frames,
        sample_rate(device),
    )
}

/// The arithmetic on its own, so the figure the dialog shows can be checked without hardware. The
/// built-in speakers of a MacBook report 690 frames of stream latency alone, which is where their
/// fixed ~17 ms comes from; an interface reports almost none and the buffer is the whole cost.
fn latency_of(device: u32, safety: u32, stream: u32, frames: u32, rate: f64) -> f64 {
    if rate <= 0.0 {
        return 0.0;
    }
    (device + safety + stream + frames) as f64 * 1000.0 / rate
}

/// What to call when CoreAudio's device list changes, kept for as long as the app runs.
static ON_CHANGE: Mutex<Option<fn()>> = Mutex::new(None);

unsafe extern "C-unwind" fn changed(
    _object: AudioObjectID,
    _count: u32,
    _addresses: NonNull<AudioObjectPropertyAddress>,
    _context: *mut c_void,
) -> i32 {
    if let Some(tell) = *ON_CHANGE.lock().unwrap() {
        tell();
    }
    0
}

/// Calls `tell` on a CoreAudio thread every time a device is plugged in or unplugged, and every
/// time the system default output changes: the second is how a switch made in System Settings
/// reaches an engine that is playing through the default and has seen no plug event. Registered
/// once and never taken off, because the engine wants it for the whole life of the app.
pub fn watch(tell: fn()) {
    let mut listening = ON_CHANGE.lock().unwrap();
    let first = listening.is_none();
    *listening = Some(tell);
    if !first {
        return;
    }
    for selector in [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultOutputDevice] {
        let mut at = address(selector, WHOLE);
        unsafe {
            AudioObjectAddPropertyListener(SYSTEM, NonNull::from(&mut at), Some(changed), null_mut())
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_core_audio::{
        AudioHardwareCreateAggregateDevice, AudioHardwareDestroyAggregateDevice,
        kAudioAggregateDeviceNameKey, kAudioAggregateDeviceSubDeviceListKey,
        kAudioAggregateDeviceUIDKey, kAudioSubDeviceUIDKey,
    };
    use objc2_core_foundation::CFDictionary;
    use objc2_foundation::NSArray;
    use std::ffi::CStr;

    #[test]
    fn the_latency_is_the_four_frame_counts_at_the_devices_rate() {
        // An interface: nothing fixed to pay, so 64 frames at 48 kHz is the buffer and no more.
        assert!((latency_of(0, 0, 0, 64, 48000.0) - 1.3333).abs() < 0.001);

        // This MacBook's built-in speakers: 690 frames of stream latency before any buffer, which
        // is most of the ~17 ms they cost whatever the buffer is.
        let speakers = latency_of(0, 33, 690, 64, 48000.0);
        assert!((speakers - 16.4).abs() < 0.5, "{speakers} ms");

        // Every one of the four counts is in the figure, and a rate of zero is a device that is
        // not answering rather than an infinite latency.
        assert_eq!(latency_of(1, 2, 3, 4, 1000.0), 10.0);
        assert_eq!(latency_of(1, 2, 3, 4, 0.0), 0.0);
    }

    /// The same rule the table tests state, over the machine's own devices, so the HAL's lookup of
    /// a UID and of the system default is checked as well.
    #[test]
    fn a_device_that_is_not_there_falls_back_to_the_system_default() {
        let Ok(default) = Hal.default_output() else {
            return; // A Mac with no output at all: nothing to fall back to and nothing to check.
        };

        let output = Hal.open(Some("no such device")).unwrap();
        assert_eq!(output.id, default);
        assert!(!output.fallback.is_empty(), "the choice was not honoured and the status says so");

        // No choice at all is the system default too, and that is not a fallback.
        for none in [None, Some("")] {
            let output = Hal.open(none).unwrap();
            assert_eq!((output.id, output.fallback.as_str()), (default, ""));
        }

        // The default device's own UID resolves back to it, and honouring a choice is not a
        // fallback either.
        if let Some(id) = uid(default) {
            let output = Hal.open(Some(&id)).unwrap();
            assert_eq!((output.id, output.fallback.as_str()), (default, ""));
            assert_eq!(output.name, name(default));
        }
    }

    #[test]
    fn a_bluetooth_device_is_offered_nothing_under_a_packet() {
        // The range AirPods report: everything the dialog knows is inside it.
        assert_eq!(allowed_buffers((14, 960), false), vec![32, 64, 128, 256, 512]);
        assert_eq!(allowed_buffers((14, 960), true), vec![256, 512]);

        // An interface's range still bounds the list, and a device that reports none takes none.
        assert_eq!(allowed_buffers((64, 256), false), vec![64, 128, 256]);
        assert!(allowed_buffers((0, 0), false).is_empty());
    }

    /// The choice is honoured while the device is there and given up while it is not, and the
    /// device is taken up again when it comes back.
    #[test]
    fn a_choice_that_is_unplugged_falls_back_and_is_taken_up_again() {
        let speakers = Output::plugged(1, "speakers");
        let interface = Output::plugged(2, "interface");
        let table = Table::of(&[speakers.clone(), interface.clone()]);

        assert_eq!(table.open(Some("interface")).unwrap(), interface);

        table.plug(std::slice::from_ref(&speakers));
        let output = table.open(Some("interface")).unwrap();
        assert_eq!(output.id, speakers.id, "the system default plays instead");
        assert_eq!(output.fallback, GONE);

        table.plug(&[speakers, interface.clone()]);
        assert_eq!(table.open(Some("interface")).unwrap(), interface);

        table.plug(&[]);
        assert!(table.open(None).is_err(), "a machine with no output has nothing to open");
    }

    #[test]
    fn every_listed_output_has_an_id_and_a_name() {
        for device in outputs() {
            assert!(!device.id.is_empty());
            assert!(!device.name.is_empty(), "{} has no name", device.id);
        }
    }

    /// The only way to have a private aggregate to filter is to make one, which is a real device on
    /// the machine for as long as the test runs. That is outside what the spec lets an ordinary run
    /// touch, so: `cargo test -- --ignored a_private_aggregate`.
    #[test]
    #[ignore = "makes a real CoreAudio device"]
    fn a_private_aggregate_is_a_device_with_an_output_but_never_a_picker_row() {
        let Ok(default) = Hal.default_output() else {
            return; // A Mac with no output at all: nothing to aggregate over.
        };
        let Some(over) = uid(default) else { return };
        let aggregate = make_private_aggregate("piano-test-aggregate", &over);

        let plays_sound = plays(aggregate);
        let may_be_picked = offerable(aggregate);
        let listed = outputs().iter().any(|device| device.id == "piano-test-aggregate");
        unsafe { AudioHardwareDestroyAggregateDevice(aggregate) };

        assert!(plays_sound, "it has an output stream, so an output filter alone would offer it");
        assert!(!may_be_picked, "but it is CoreAudio's own and must not be a picker row");
        assert!(!listed, "and so the picker never sees it");
    }

    /// One aggregate of the same kind the HAL makes for a process that follows the system default:
    /// private, over one real output device. Made here rather than waited for, so the filter is
    /// checked without starting the engine on a device.
    fn make_private_aggregate(id: &str, over: &str) -> AudioObjectID {
        let key = |text: &CStr| NSString::from_str(&text.to_string_lossy());
        let name = NSString::from_str(id);
        let sub: Retained<NSDictionary<NSString, NSString>> =
            NSDictionary::from_slices(&[&*key(kAudioSubDeviceUIDKey)], &[&*NSString::from_str(over)]);
        let subs = NSArray::from_retained_slice(&[sub]);
        let private = NSNumber::new_bool(true);
        let description: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_slices(
            &[
                &*key(kAudioAggregateDeviceUIDKey),
                &*key(kAudioAggregateDeviceNameKey),
                &*key(kAudioAggregateDeviceIsPrivateKey),
                &*key(kAudioAggregateDeviceSubDeviceListKey),
            ],
            &[&name, &name, &private, &subs],
        );
        // NSDictionary is toll-free bridged with CFDictionary, which is what the HAL takes.
        let description: &CFDictionary =
            unsafe { &*Retained::as_ptr(&description).cast::<CFDictionary>() };
        let mut aggregate: AudioObjectID = 0;
        let status = unsafe {
            AudioHardwareCreateAggregateDevice(description, NonNull::from(&mut aggregate))
        };
        assert_eq!(status, 0, "CoreAudio would not make the test aggregate");
        aggregate
    }
}

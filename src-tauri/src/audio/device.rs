//! The output side of the sound engine: which CoreAudio device the app plays through, the buffer
//! that device runs, and the latency the device reports for that buffer. This is the HAL's
//! `AudioObject` property API; the AVAudioEngine graph that plays into it lives in `mac.rs`.
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
pub fn name(device: DeviceId) -> String {
    read_text(device, kAudioObjectPropertyName, WHOLE)
        .or_else(|| uid(device))
        .unwrap_or_default()
}

pub fn uid(device: DeviceId) -> Option<String> {
    read_text(device, kAudioDevicePropertyDeviceUID, WHOLE)
}

pub fn default_output() -> Result<DeviceId, String> {
    read(SYSTEM, kAudioHardwarePropertyDefaultOutputDevice, WHOLE)
        .filter(|&device| device != 0)
        .ok_or_else(|| "This Mac has no output device".into())
}

/// The device to play through: the chosen one while it is plugged in, the system default when it is
/// not. The flag says a choice was made and could not be honoured, which is the line the status
/// reports; the choice itself is kept, so the device is taken up again when it comes back.
pub fn resolve(chosen: Option<&str>) -> Result<(DeviceId, bool), String> {
    let wanted = chosen.filter(|id| !id.is_empty());
    if let Some(id) = wanted {
        let found = read_all::<AudioObjectID>(SYSTEM, kAudioHardwarePropertyDevices, WHOLE)
            .into_iter()
            .find(|&device| plays(device) && uid(device).as_deref() == Some(id));
        if let Some(device) = found {
            return Ok((device, false));
        }
    }
    Ok((default_output()?, wanted.is_some()))
}

/// The rate the device is running at.
pub fn sample_rate(device: DeviceId) -> f64 {
    read(device, kAudioDevicePropertyNominalSampleRate, WHOLE).unwrap_or(0.0)
}

pub fn buffer_frames(device: DeviceId) -> u32 {
    read(device, kAudioDevicePropertyBufferFrameSize, WHOLE).unwrap_or(0)
}

/// The smallest and the largest IO cycle the device takes, in frames. A device that answers
/// nothing takes no size at all, which is what an id that no longer names a device does.
pub fn buffer_range(device: DeviceId) -> (u32, u32) {
    read::<AudioValueRange>(device, kAudioDevicePropertyBufferFrameSizeRange, WHOLE)
        .map_or((0, 0), |range| (range.mMinimum as u32, range.mMaximum as u32))
}

/// The rates the device can be set to, as the spans it reports. A device with a fixed set of rates
/// reports each of them as a span whose ends are the same; one with its own clock reports a span
/// it can run anywhere inside.
pub fn sample_rate_ranges(device: DeviceId) -> Vec<(f64, f64)> {
    read_all::<AudioValueRange>(device, kAudioDevicePropertyAvailableNominalSampleRates, WHOLE)
        .into_iter()
        .map(|range| (range.mMinimum, range.mMaximum))
        .collect()
}

/// Whether the device plays over Bluetooth, which is what makes a small IO cycle unworkable: the
/// radio ships audio in packets of about 20 ms whatever the buffer says.
pub fn is_bluetooth(device: DeviceId) -> bool {
    read::<u32>(device, kAudioDevicePropertyTransportType, WHOLE).is_some_and(|transport| {
        transport == kAudioDeviceTransportTypeBluetooth
            || transport == kAudioDeviceTransportTypeBluetoothLE
    })
}

pub fn set_buffer_frames(device: DeviceId, frames: u32) -> Result<(), String> {
    let mut at = address(kAudioDevicePropertyBufferFrameSize, WHOLE);
    let status = unsafe {
        AudioObjectSetPropertyData(
            device,
            NonNull::from(&mut at),
            0,
            null(),
            size_of::<u32>() as u32,
            NonNull::from(&frames).cast(),
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("The device refused a buffer of {frames} frames (status {status})"))
    }
}

/// Asks the device to run at `rate`. The change is the system's, so every app playing through
/// the device hears it, and a device that cannot run at the rate refuses.
pub fn set_sample_rate(device: DeviceId, rate: f64) -> Result<(), String> {
    let mut at = address(kAudioDevicePropertyNominalSampleRate, WHOLE);
    let status = unsafe {
        AudioObjectSetPropertyData(
            device,
            NonNull::from(&mut at),
            0,
            null(),
            size_of::<f64>() as u32,
            NonNull::from(&rate).cast(),
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("The device refused a rate of {rate} Hz (status {status})"))
    }
}

/// What the device says it costs to get a rendered frame out of the speaker, in milliseconds: the
/// four frame counts CoreAudio reports, at the rate the device runs.
pub fn latency_ms(device: DeviceId, frames: u32) -> f64 {
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

    #[test]
    fn a_device_that_is_not_there_falls_back_to_the_system_default() {
        let Ok(default) = default_output() else {
            return; // A Mac with no output at all: nothing to fall back to and nothing to check.
        };

        let (device, fell_back) = resolve(Some("no such device")).unwrap();
        assert_eq!(device, default);
        assert!(fell_back, "the choice could not be honoured and the status must say so");

        // No choice at all is the system default too, and that is not a fallback.
        assert_eq!(resolve(None).unwrap(), (default, false));
        assert_eq!(resolve(Some("")).unwrap(), (default, false));

        // The default device's own UID resolves back to it, and honouring a choice is not a
        // fallback either.
        if let Some(id) = uid(default) {
            assert_eq!(resolve(Some(&id)).unwrap(), (default, false));
        }
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
        let Ok(default) = default_output() else {
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

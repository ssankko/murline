//! The sampler's amplitude envelope.
//!
//! AUSampler has no envelope parameter and ignores the sound-controller CCs that ask for one, so
//! the only way in is its whole saved state: a property list holding, for every layer, a
//! seven-stage envelope that the instrument file's own generators fill in. Reading it is cheap.
//! Handing a changed one back costs about a second, whatever is in it, which is why the command
//! that does so runs off the main thread. Notes already sounding play on through the change.

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2_audio_toolbox::AUAudioUnit;
use objc2_avf_audio::{AVAudioUnit, AVAudioUnitSampler};
use objc2_foundation::{
    NSArray, NSDictionary, NSMutableDictionary, NSNumber, NSPropertyListFormat,
    NSPropertyListMutabilityOptions, NSPropertyListSerialization, NSString,
};
use std::ptr::{from_ref, null_mut};

use crate::audio::Envelope;

/// Each layer carries two envelopes: number 0 shapes the loudness and number 1 the filter.
const AMPLITUDE: u32 = 0;

/// Which of the seven stages holds each part. The four the app offers are these; the rest are a
/// delay, a hold and a short tail the sampler keeps to itself, and are left alone.
const ATTACK: u32 = 1;
const DECAY: u32 = 3;
/// The one stage measured in loudness rather than seconds, so it is the one keyed `level`.
const SUSTAIN: u32 = 4;
const RELEASE: u32 = 5;

/// What the instrument's first layer is set to now. This is the file's own envelope until someone
/// writes over it, which is what makes it the right thing to show when the panel first opens.
pub(super) fn read(sampler: &AVAudioUnitSampler) -> Option<Envelope> {
    unsafe {
        let tree = tree(&own_unit(sampler))?;
        let layers = layers(&tree)?;
        let stages = stages_of(&array(&layers).objectAtIndex(0))?;
        let stages = array(&stages);
        let mut envelope = Envelope::default();
        for index in 0..stages.count() {
            let stage = stages.objectAtIndex(index);
            let Some(which) = number(&stage, "stage") else { continue };
            match which as u32 {
                ATTACK => envelope.attack = number(&stage, "time").unwrap_or_default(),
                DECAY => envelope.decay = number(&stage, "time").unwrap_or_default(),
                SUSTAIN => envelope.sustain = number(&stage, "level").unwrap_or_default(),
                RELEASE => envelope.release = number(&stage, "time").unwrap_or_default(),
                _ => {}
            }
        }
        Some(envelope)
    }
}

/// Puts one envelope on every layer, so a note answers the same way wherever on the keyboard and
/// however hard it was struck. A state the sampler will not take leaves the instrument as it was.
pub(super) fn write(sampler: &AVAudioUnitSampler, want: Envelope) {
    unsafe {
        let unit = own_unit(sampler);
        let Some(tree) = tree(&unit) else { return };
        let Some(layers) = layers(&tree) else { return };
        let layers = array(&layers);
        for layer in 0..layers.count() {
            let Some(stages) = stages_of(&layers.objectAtIndex(layer)) else { continue };
            let stages = array(&stages);
            for index in 0..stages.count() {
                let stage = stages.objectAtIndex(index);
                let Some(which) = number(&stage, "stage") else { continue };
                match which as u32 {
                    ATTACK => set(&stage, "time", want.attack),
                    DECAY => set(&stage, "time", want.decay),
                    SUSTAIN => set(&stage, "level", want.sustain),
                    RELEASE => set(&stage, "time", want.release),
                    _ => {}
                }
            }
        }
        let dict: *const NSDictionary<NSString, AnyObject> = Retained::as_ptr(&tree).cast();
        unit.setFullState(Some(&*dict));
    }
}

/// The unit's saved state as a tree that can be changed in place. Round-tripping it through a
/// property list is what makes the containers mutable; `fullState` hands out immutable ones.
unsafe fn tree(unit: &AUAudioUnit) -> Option<Retained<AnyObject>> {
    unsafe {
        let full = unit.fullState()?;
        let plist: &AnyObject = &full;
        let data = NSPropertyListSerialization::dataWithPropertyList_format_options_error(
            plist,
            NSPropertyListFormat::BinaryFormat_v1_0,
            0,
        )
        .ok()?;
        NSPropertyListSerialization::propertyListWithData_options_format_error(
            &data,
            NSPropertyListMutabilityOptions::MutableContainersAndLeaves,
            null_mut(),
        )
        .ok()
    }
}

fn own_unit(sampler: &AVAudioUnitSampler) -> Retained<AUAudioUnit> {
    let node: &AVAudioUnit = sampler;
    unsafe { node.AUAudioUnit() }
}

unsafe fn layers(tree: &AnyObject) -> Option<Retained<AnyObject>> {
    unsafe {
        let instrument = at(tree, "Instrument")?;
        at(&instrument, "Layers")
    }
}

/// The stages of a layer's amplitude envelope, or nothing when it has none.
unsafe fn stages_of(layer: &AnyObject) -> Option<Retained<AnyObject>> {
    unsafe {
        let envelopes = at(layer, "Envelopes")?;
        let envelopes = array(&envelopes);
        (0..envelopes.count())
            .map(|index| envelopes.objectAtIndex(index))
            .find(|envelope| number(envelope, "ID").is_some_and(|id| id as u32 == AMPLITUDE))
            .and_then(|envelope| at(&envelope, "Stages"))
    }
}

unsafe fn at(node: &AnyObject, key: &str) -> Option<Retained<AnyObject>> {
    unsafe { dict(node).objectForKey(&NSString::from_str(key)) }
}

unsafe fn number(node: &AnyObject, key: &str) -> Option<f64> {
    unsafe {
        let value = at(node, key)?;
        let value: &NSNumber = &*Retained::as_ptr(&value).cast();
        Some(value.doubleValue())
    }
}

unsafe fn set(node: &AnyObject, key: &str, value: f64) {
    unsafe {
        let value = NSNumber::numberWithDouble(value);
        let value: &AnyObject = &*Retained::as_ptr(&value).cast();
        let key = NSString::from_str(key);
        dict(node).setObject_forKey(value, ProtocolObject::from_ref(&*key));
    }
}

unsafe fn dict(node: &AnyObject) -> &NSMutableDictionary<NSString, AnyObject> {
    unsafe { &*from_ref(node).cast() }
}

unsafe fn array(node: &AnyObject) -> &NSArray<AnyObject> {
    unsafe { &*from_ref(node).cast() }
}

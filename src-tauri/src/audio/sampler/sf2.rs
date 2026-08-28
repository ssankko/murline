//! Reads a SoundFont into an instrument the voice engine plays. An `.sf2` file is a RIFF form of
//! type `sfbk` holding two lists: `sdta`, whose `smpl` chunk is every sample of the file end to
//! end as 16-bit mono, and `pdta`, whose nine chunks describe presets, instruments and samples as
//! flat record arrays indexed into one another.
//!
//! The file's own envelope generators are ignored: the app's envelope shapes every note it plays.

use std::collections::HashMap;
use std::path::Path;

use super::{Instrument, Role, Sample, Zone};

/// What a file that is no SoundFont at all is answered with, in the words the picker prints.
const NOT_A_SOUND_FONT: &str = "That file is not a SoundFont";

/// Bank 128 is the percussion bank: its presets map a drum to every key rather than one tone
/// across the keyboard.
const PERCUSSION: u16 = 128;

/// The generator operators read here, from the SF2 spec's list. The rest, the file's envelopes and
/// filters among them, are left alone.
const START_OFFSET: u16 = 0;
const END_OFFSET: u16 = 1;
const LOOP_START_OFFSET: u16 = 2;
const LOOP_END_OFFSET: u16 = 3;
const KEY_RANGE: u16 = 43;
const VEL_RANGE: u16 = 44;
const ATTENUATION: u16 = 48;
const COARSE_TUNE: u16 = 51;
const FINE_TUNE: u16 = 52;
const SAMPLE_ID: u16 = 53;
const SAMPLE_MODES: u16 = 54;
const ROOT_KEY: u16 = 58;
/// The one generator that names an instrument, and so the one that ends a preset zone.
const INSTRUMENT: u16 = 41;

/// Record lengths of the `pdta` arrays, each a fixed struct repeated.
const PHDR: usize = 38;
const BAG: usize = 4;
const GEN: usize = 4;
const INST: usize = 22;
const SHDR: usize = 46;

/// The zones and samples of the file's first melodic preset, all of them held in memory.
pub fn read(path: &Path) -> Result<Instrument, String> {
    parse(&std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?)
}

fn parse(bytes: &[u8]) -> Result<Instrument, String> {
    if bytes.get(..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"sfbk") {
        return Err(NOT_A_SOUND_FONT.into());
    }
    let mut smpl: &[u8] = &[];
    let mut pdta = Vec::new();
    for (tag, body) in chunks(bytes.get(12..).unwrap_or_default()) {
        match (&tag, body.get(..4)) {
            (b"LIST", Some(b"sdta")) => {
                smpl = chunks(&body[4..])
                    .into_iter()
                    .find(|(tag, _)| tag == b"smpl")
                    .map_or(&[][..], |(_, data)| data);
            }
            (b"LIST", Some(b"pdta")) => pdta = chunks(&body[4..]),
            _ => {}
        }
    }
    let named = |tag: &[u8; 4]| {
        pdta.iter()
            .find(|(each, _)| each == tag)
            .map(|(_, data)| *data)
            .ok_or_else(|| format!("That SoundFont has no {} chunk", text(tag)))
    };
    let (phdr, inst, shdr) = (named(b"phdr")?, named(b"inst")?, named(b"shdr")?);
    let (pbag, ibag) = (bags(named(b"pbag")?), bags(named(b"ibag")?));
    let (pgen, igen) = (gens(named(b"pgen")?), gens(named(b"igen")?));

    // Every array ends in a terminal record that only marks where the last real one stops.
    let presets: Vec<(u16, u16, usize)> = phdr
        .chunks_exact(PHDR)
        .map(|record| (le16(record, 22), le16(record, 20), le16(record, 24) as usize))
        .collect();
    let chosen = (0..presets.len().saturating_sub(1))
        .filter(|&i| presets[i].0 != PERCUSSION)
        .min_by_key(|&i| (presets[i].0, presets[i].1))
        .ok_or("That SoundFont has no melodic preset")?;

    let instruments: Vec<usize> =
        inst.chunks_exact(INST).map(|record| le16(record, 20) as usize).collect();

    let mut zones = Vec::new();
    let mut samples = Vec::new();
    let mut made: HashMap<u16, usize> = HashMap::new();
    for preset_zone in
        zoned(&pbag, &pgen, presets[chosen].2, presets[chosen + 1].2, INSTRUMENT)
    {
        let Some(which) = value(&preset_zone, INSTRUMENT).map(|which| which as usize) else {
            continue;
        };
        let (Some(&from), Some(&to)) = (instruments.get(which), instruments.get(which + 1)) else {
            continue;
        };
        for zone in zoned(&ibag, &igen, from, to, SAMPLE_ID) {
            let Some(id) = value(&zone, SAMPLE_ID).map(|id| id as u16) else { continue };
            let Some(header) = shdr.get(id as usize * SHDR..).map(|rest| &rest[..SHDR.min(rest.len())])
            else {
                continue;
            };
            if header.len() < SHDR {
                continue;
            }
            let at = match made.get(&id) {
                Some(&at) => at,
                None => {
                    samples.push(sample(header, smpl));
                    made.insert(id, samples.len() - 1);
                    samples.len() - 1
                }
            };
            if let Some(zone) = build(&zone, &preset_zone, header, samples[at].frames, at) {
                zones.push(zone);
            }
        }
    }
    if zones.is_empty() {
        return Err("That SoundFont's first melodic preset plays nothing".into());
    }
    Ok(Instrument::memory(zones, samples))
}

/// One instrument zone, narrowed by the preset zone that reached it. Nothing when the two windows
/// do not overlap, which is a zone the preset never sounds.
fn build(
    zone: &[(u16, i16)],
    preset: &[(u16, i16)],
    header: &[u8],
    frames: usize,
    sample: usize,
) -> Option<Zone> {
    let (key_lo, key_hi) = narrow(range(zone, KEY_RANGE), range(preset, KEY_RANGE));
    let (vel_lo, vel_hi) = narrow(range(zone, VEL_RANGE), range(preset, VEL_RANGE));
    if key_lo > key_hi || vel_lo > vel_hi {
        return None;
    }
    // The preset zone's tuning and attenuation add to the instrument zone's own.
    let added = |op| i32::from(value(zone, op).unwrap_or(0)) + i32::from(value(preset, op).unwrap_or(0));
    let start = value(zone, START_OFFSET).unwrap_or(0).max(0) as usize;
    let end = frames.saturating_add_signed(value(zone, END_OFFSET).unwrap_or(0) as isize);
    let loop_ = (value(zone, SAMPLE_MODES).unwrap_or(0) & 1 != 0).then(|| {
        let sample_start = le32(header, 20) as usize;
        let at = |field, offset| {
            (le32(header, field) as usize).saturating_sub(sample_start).saturating_add_signed(
                value(zone, offset).unwrap_or(0) as isize,
            )
        };
        (at(28, LOOP_START_OFFSET).min(frames), at(32, LOOP_END_OFFSET).min(frames))
    });
    Some(Zone {
        role: Role::Sustain,
        key_lo,
        key_hi,
        vel_lo,
        vel_hi,
        // A root key the zone does not override is the pitch the sample was recorded at.
        root: match value(zone, ROOT_KEY) {
            Some(key @ 0..=127) => key as u8,
            _ => header[40],
        },
        tune_cents: added(COARSE_TUNE) * 100 + added(FINE_TUNE) + i32::from(header[41] as i8),
        // Attenuation runs the other way from gain, in tenths of a decibel.
        gain_db: -(added(ATTENUATION) as f32) / 10.0,
        sample,
        start: start.min(frames),
        end: end.min(frames),
        loop_,
    })
}

/// One sample header's own frames out of the file's sample block, mono doubled into the
/// interleaved stereo every zone is played from.
/// ponytail: a stereo pair is read as two mono samples, so a zone naming one plays that half on
/// both channels; follow `sampleLink` if a font that records in pairs ever matters.
fn sample(header: &[u8], smpl: &[u8]) -> Sample {
    let (start, end) = (le32(header, 20) as usize, le32(header, 24) as usize);
    let data = smpl
        .get(start * 2..end * 2)
        .unwrap_or_default()
        .chunks_exact(2)
        .flat_map(|frame| {
            let one = i16::from_le_bytes([frame[0], frame[1]]);
            [one, one]
        })
        .collect();
    Sample::memory(f64::from(le32(header, 36)), data)
}

/// The zones of one bag range, each carrying its range's global zone in front of its own
/// generators, so a lookup that takes the last match reads the zone's own value first. `ends` is
/// the generator that every real zone of the range finishes with; a first zone without it is the
/// global one.
fn zoned(
    bags: &[usize],
    gens: &[(u16, i16)],
    from: usize,
    to: usize,
    ends: u16,
) -> Vec<Vec<(u16, i16)>> {
    let mut zones = Vec::new();
    let mut global: Vec<(u16, i16)> = Vec::new();
    for i in from..to {
        let start = bags.get(i).copied().unwrap_or(0);
        let stop = bags.get(i + 1).copied().unwrap_or(gens.len()).max(start);
        let own = gens.get(start..stop).unwrap_or_default();
        if i == from && !own.iter().any(|&(op, _)| op == ends) {
            global = own.to_vec();
            continue;
        }
        zones.push(global.iter().chain(own).copied().collect());
    }
    zones
}

/// The chunks of a RIFF body: a four-byte tag, a length, and that many bytes, each chunk padded to
/// an even length.
fn chunks(body: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut found = Vec::new();
    let mut at = 0;
    while at + 8 <= body.len() {
        let tag: [u8; 4] = body[at..at + 4].try_into().unwrap_or_default();
        let size = le32(body, at + 4) as usize;
        let Some(data) = body.get(at + 8..at + 8 + size) else { break };
        found.push((tag, data));
        at += 8 + size + size % 2;
    }
    found
}

fn bags(data: &[u8]) -> Vec<usize> {
    data.chunks_exact(BAG).map(|record| le16(record, 0) as usize).collect()
}

fn gens(data: &[u8]) -> Vec<(u16, i16)> {
    data.chunks_exact(GEN).map(|record| (le16(record, 0), le16(record, 2) as i16)).collect()
}

/// The value a generator was last given, which is the zone's own where it set one and its global
/// zone's where it did not.
fn value(gens: &[(u16, i16)], op: u16) -> Option<i16> {
    gens.iter().rev().find(|&&(each, _)| each == op).map(|&(_, value)| value)
}

/// A range generator, whose two bytes are the low and the high end. A zone that sets none answers
/// to every key and every velocity.
fn range(gens: &[(u16, i16)], op: u16) -> (u8, u8) {
    value(gens, op).map_or((0, 127), |both| (both as u8, (both as u16 >> 8) as u8))
}

fn narrow(zone: (u8, u8), preset: (u8, u8)) -> (u8, u8) {
    (zone.0.max(preset.0), zone.1.min(preset.1))
}

fn le16(record: &[u8], at: usize) -> u16 {
    record.get(at..at + 2).and_then(|two| two.try_into().ok()).map_or(0, u16::from_le_bytes)
}

fn le32(record: &[u8], at: usize) -> u32 {
    record.get(at..at + 4).and_then(|four| four.try_into().ok()).map_or(0, u32::from_le_bytes)
}

fn text(tag: &[u8; 4]) -> String {
    String::from_utf8_lossy(tag).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One looped sine mapped across the keyboard, which `fixtures/make-sine-sf2.py` writes.
    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/sine.sf2");
    /// What the fixture holds: ten periods of 100 frames, at the pitch A4 stands for.
    const FRAMES: usize = 1000;

    #[test]
    fn the_fixture_reads_as_one_looped_zone_across_the_keyboard() {
        let instrument = read(Path::new(FIXTURE)).unwrap();
        assert_eq!(instrument.zones, vec![Zone {
            role: Role::Sustain,
            key_lo: 0,
            key_hi: 127,
            vel_lo: 0,
            vel_hi: 127,
            root: 69,
            tune_cents: 0,
            gain_db: 0.0,
            sample: 0,
            start: 0,
            end: FRAMES,
            loop_: Some((0, FRAMES)),
        }]);

        let sample = &instrument.samples[0];
        assert_eq!(sample.rate, 44100.0);
        assert_eq!(sample.frames, FRAMES, "the sample stops before the spec's silent tail");
        let data = sample.data.as_ref().unwrap();
        assert_eq!(data.len(), FRAMES * 2, "mono doubled into stereo");
        assert_eq!(data[50 * 2], data[50 * 2 + 1], "both channels carry the one recording");
        assert!(data.iter().any(|&one| one > 29000), "and it is the sine, at the level it was written at");
    }

    #[test]
    fn a_file_that_is_no_sound_font_says_so_rather_than_playing_nothing() {
        assert_eq!(parse(b"not really an instrument").err().unwrap(), NOT_A_SOUND_FONT);

        let mut headless = b"RIFF\0\0\0\0sfbk".to_vec();
        headless.extend(b"LIST\x04\0\0\0pdta");
        assert_eq!(parse(&headless).err().unwrap(), "That SoundFont has no phdr chunk");
    }
}

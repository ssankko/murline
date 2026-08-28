//! Reads a Logic EXS instrument file into zones. An EXS file is a flat list of chunks, each an
//! 84-byte header followed by a body; the low nibble of the header's first dword says what the
//! chunk is. Zones (0x01) and samples (0x03) carry what the voice engine needs; groups (0x02)
//! gate the zones that name them.
//!
//! The zone and sample field offsets come from the renoise-exs24 reader; the group offsets come
//! from ConvertWithMoss's `EXS24Group` (de.mossgrabers.convertwithmoss.format.exs), which is the
//! only published reader that decodes them.

use std::fs;
use std::path::{Path, PathBuf};

use super::{Role, Zone};

/// One sample file the EXS names, and how many frames of it the zones may use.
#[derive(Clone, Debug, PartialEq)]
pub struct SampleRef {
    pub path: std::path::PathBuf,
    pub frames: usize,
}

/// What a group demands of the zones that name it. Logic's Sampler keeps the trigger, the
/// velocity and key windows and the "Enable by" condition here rather than on the zone.
#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    pub name: String,
    /// Decibels every zone of the group adds to its own gain.
    pub volume: i8,
    /// The group sounds when the key is let go, not when it is struck.
    pub release_trigger: bool,
    pub vel_lo: u8,
    pub vel_hi: u8,
    pub key_lo: u8,
    pub key_hi: u8,
    /// What else must hold for the group to sound: 0 nothing, 1 note, 2 round robin, 3 controller,
    /// 4 bender, 5 channel, 6 articulation, 7 tempo.
    pub enable_by: u8,
    /// The controller number `enable_by` 3 watches; 64 is the sustain pedal.
    pub enable_control: u8,
    /// Place in the round-robin cycle, -1 for a group outside one.
    pub round_robin: i32,
    /// How many zones name this group, counted before any of them are dropped.
    pub zones: usize,
}

/// The zones, groups and sample files an EXS file describes. `Zone::sample` indexes `samples`.
#[derive(Debug)]
pub struct Exs {
    pub zones: Vec<Zone>,
    /// Already applied to `zones`; kept so a caller can say what an instrument holds.
    #[allow(dead_code)]
    pub groups: Vec<Group>,
    pub samples: Vec<SampleRef>,
}

pub fn read(path: &Path) -> Result<Exs, String> {
    let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse(&bytes, path)
}

const HEADER: usize = 84;

/// The `enable_by` code for a group Logic picks with an articulation ID.
const ARTICULATION: u8 = 6;

fn parse(bytes: &[u8], path: &Path) -> Result<Exs, String> {
    let magic = bytes.get(16..20).ok_or("not an EXS file: too short")?;
    let big_endian = match magic {
        b"SOBT" | b"SOBJ" => true,
        b"TBOS" | b"JBOS" => false,
        _ => return Err(format!("not an EXS file: magic {magic:?}")),
    };
    let file = Rdr { bytes, big_endian };
    // Files written with the expanded size flag carry it in the top bit of every chunk size.
    let expanded = file.u32(4) > 0x8000;

    let mut zones = Vec::new();
    let mut groups: Vec<Group> = Vec::new();
    let mut samples = Vec::new();
    let mut i = 0usize;
    while i + HEADER < bytes.len() {
        let sig = file.u32(i);
        let mut size = file.u32(i + 4) as usize;
        if expanded && size > 0x8000 {
            size -= 0x8000;
        }
        let end = i + HEADER + size;
        let body = bytes.get(i..end).ok_or("chunk runs past the end of the file")?;
        let chunk = Rdr { bytes: body, big_endian };
        match (sig & 0x0F00_0000) >> 24 {
            0x01 if size >= 104 => zones.push(read_zone(&chunk)),
            // Every group is kept, short body or not, because a zone names its group by position.
            0x02 => groups.push(read_group(&chunk)),
            0x03 => samples.push(read_sample(&chunk, path)),
            _ => {}
        }
        i = end;
    }

    for (_, _, group) in &zones {
        if let Some(group) = groups.get_mut(*group as usize) {
            group.zones += 1;
        }
    }

    // ponytail: a key-down sounds only the Sustain articulation, so the rest are dropped whole;
    // play the Release and Key Off groups on note-off instead.
    let sustain = |group: &Group| group.name.to_lowercase().starts_with("sustain");
    let articulated = groups.iter().any(|g| g.enable_by == ARTICULATION && sustain(g));

    let count = samples.len() as u32;
    let zones = zones
        .into_iter()
        .filter_map(|(mut zone, sample, group)| {
            // A zone naming a sample the file does not hold has nothing to play.
            if sample >= count {
                return None;
            }
            if let Some(group) = groups.get(group as usize) {
                // A release group answers a note-off, so none of its zones belongs to a key-down.
                if group.release_trigger {
                    return None;
                }
                if articulated && group.enable_by == ARTICULATION && !sustain(group) {
                    return None;
                }
                zone.gain_db += group.volume as f32;
                zone.vel_lo = zone.vel_lo.max(group.vel_lo);
                zone.vel_hi = zone.vel_hi.min(group.vel_hi);
                zone.key_lo = zone.key_lo.max(group.key_lo);
                zone.key_hi = zone.key_hi.min(group.key_hi);
                if zone.vel_lo > zone.vel_hi || zone.key_lo > zone.key_hi {
                    return None;
                }
            }
            zone.sample = sample as usize;
            Some(zone)
        })
        .collect();
    Ok(Exs { zones, groups, samples })
}

/// Returns the zone and the indexes of the sample chunk it plays and the group that gates it;
/// `Zone::sample` is filled in once the whole chunk list is known.
fn read_zone(c: &Rdr) -> (Zone, u32, u32) {
    let opts = c.u8(84);
    let velocity_range_on = opts & (1 << 3) != 0;
    let loop_on = c.u8(117) & 1 != 0;
    let zone = Zone {
        role: Role::Sustain,
        key_lo: c.u8(90),
        key_hi: c.u8(91),
        vel_lo: if velocity_range_on { c.u8(93) } else { 0 },
        vel_hi: if velocity_range_on { c.u8(94) } else { 127 },
        root: c.u8(85),
        tune_cents: c.i8(164) as i32 * 100 + c.i8(86) as i32,
        gain_db: c.i8(88) as f32,
        sample: 0,
        start: c.u32(96) as usize,
        end: c.u32(100) as usize,
        loop_: loop_on.then(|| (c.u32(104) as usize, c.u32(108) as usize)),
    };
    (zone, c.u32(176), c.u32(172))
}

/// Reads a group chunk, whose offsets are the ones ConvertWithMoss's `EXS24Group` names.
fn read_group(c: &Rdr) -> Group {
    Group {
        name: c.text(20, 64),
        volume: c.i8(84),
        vel_lo: c.u8(89),
        vel_hi: c.u8(90),
        release_trigger: c.u8(157) != 0,
        round_robin: c.u32(164) as i32,
        enable_by: c.u8(168),
        enable_control: c.u8(169),
        key_lo: c.u8(172),
        key_hi: c.u8(173),
        zones: 0,
    }
}

fn read_sample(c: &Rdr, exs: &Path) -> SampleRef {
    // The long file name sits past the 336-byte body of the oldest chunk layout; shorter chunks
    // only have the 64-byte name field.
    let name = if c.bytes.len() > 420 { c.text(420, 256) } else { c.text(20, 64) };
    let stored = PathBuf::from(c.text(164, 256)).join(&name);
    let path = if stored.exists() {
        stored
    } else {
        // Logic ships instruments whose stored paths point at where the samples were installed on
        // another machine, so fall back to the name inside this library's own Samples folder.
        samples_root(exs)
            .and_then(|root| find_file(&root, &name))
            .unwrap_or(stored)
    };
    SampleRef { path, frames: c.u32(88) as usize }
}

/// The `Samples` folder of the Logic library bundle the instrument lives in.
fn samples_root(exs: &Path) -> Option<PathBuf> {
    exs.ancestors()
        .find(|d| d.extension().is_some_and(|e| e == "bundle"))
        .map(|bundle| bundle.join("Samples"))
}

fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    let mut subdirs = Vec::new();
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            subdirs.push(path);
        } else if entry.file_name() == name {
            return Some(path);
        }
    }
    subdirs.iter().find_map(|d| find_file(d, name))
}

/// Reads the scalar fields of a chunk, in whichever byte order the file's magic declared.
struct Rdr<'a> {
    bytes: &'a [u8],
    big_endian: bool,
}

impl Rdr<'_> {
    fn u8(&self, at: usize) -> u8 {
        self.bytes.get(at).copied().unwrap_or(0)
    }

    fn i8(&self, at: usize) -> i8 {
        self.u8(at) as i8
    }

    fn u32(&self, at: usize) -> u32 {
        let word: [u8; 4] = match self.bytes.get(at..at + 4).and_then(|s| s.try_into().ok()) {
            Some(word) => word,
            None => return 0,
        };
        if self.big_endian { u32::from_be_bytes(word) } else { u32::from_le_bytes(word) }
    }

    fn text(&self, at: usize, len: usize) -> String {
        let field = self.bytes.get(at..at + len).unwrap_or_default();
        let field = &field[..field.iter().position(|&b| b == 0).unwrap_or(field.len())];
        String::from_utf8_lossy(field).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a little-endian EXS holding a header chunk, one zone, one group per field set and
    /// one sample. Every group starts out open on every key and velocity.
    fn blob(zone_fields: &[(usize, &[u8])], groups: &[&[(usize, &[u8])]]) -> Vec<u8> {
        let groups = if groups.is_empty() { &[&[][..]][..] } else { groups };
        let mut out =
            vec![0u8; HEADER + 88 + HEADER + 148 + (HEADER + 144) * groups.len() + HEADER + 600];
        out[16..20].copy_from_slice(b"TBOS");
        out[4..8].copy_from_slice(&88u32.to_le_bytes());
        let zone = HEADER + 88;
        out[zone..zone + 4].copy_from_slice(&0x0100_0000u32.to_le_bytes());
        out[zone + 4..zone + 8].copy_from_slice(&148u32.to_le_bytes());
        for (index, fields) in groups.iter().enumerate() {
            let group = zone + HEADER + 148 + (HEADER + 144) * index;
            out[group..group + 4].copy_from_slice(&0x0200_0000u32.to_le_bytes());
            out[group + 4..group + 8].copy_from_slice(&144u32.to_le_bytes());
            out[group + 90] = 127; // highest velocity
            out[group + 173] = 127; // highest key
            write(&mut out, group, fields);
        }
        let sample = zone + HEADER + 148 + (HEADER + 144) * groups.len();
        out[sample..sample + 4].copy_from_slice(&0x0300_0000u32.to_le_bytes());
        out[sample + 4..sample + 8].copy_from_slice(&600u32.to_le_bytes());
        write(&mut out, zone, zone_fields);
        out
    }

    fn write(out: &mut [u8], chunk: usize, fields: &[(usize, &[u8])]) {
        for (offset, value) in fields {
            let at = chunk + offset;
            out[at..at + value.len()].copy_from_slice(value);
        }
    }

    #[test]
    fn walks_the_chunk_list() {
        let bytes = blob(
            &[
                (84, &[1 << 3]),           // velocity range on
                (85, &[60]),               // root key
                (86, &[(-7i8) as u8]),     // fine tuning
                (88, &[(-3i8) as u8]),     // volume
                (90, &[48, 72]),           // key range
                (93, &[100, 127]),         // velocity range
                (96, &1000u32.to_le_bytes()),
                (100, &2000u32.to_le_bytes()),
                (164, &[2]), // coarse tuning
            ],
            &[],
        );
        let exs = parse(&bytes, Path::new("/nowhere/x.exs")).unwrap();
        assert_eq!(exs.samples.len(), 1);
        assert_eq!(
            exs.zones,
            vec![Zone {
                role: Role::Sustain,
                key_lo: 48,
                key_hi: 72,
                vel_lo: 100,
                vel_hi: 127,
                root: 60,
                tune_cents: 193,
                gain_db: -3.0,
                sample: 0,
                start: 1000,
                end: 2000,
                loop_: None,
            }]
        );
    }

    #[test]
    fn a_zone_without_a_velocity_range_answers_every_velocity() {
        let exs = parse(&blob(&[(93, &[100, 127])], &[]), Path::new("/nowhere/x.exs")).unwrap();
        assert_eq!((exs.zones[0].vel_lo, exs.zones[0].vel_hi), (0, 127));
    }

    #[test]
    fn a_looping_zone_carries_its_loop() {
        let exs = parse(
            &blob(&[(104, &10u32.to_le_bytes()), (108, &20u32.to_le_bytes()), (117, &[1])], &[]),
            Path::new("/nowhere/x.exs"),
        )
        .unwrap();
        assert_eq!(exs.zones[0].loop_, Some((10, 20)));
    }

    #[test]
    fn a_release_triggered_group_takes_its_zones_away() {
        let exs = parse(&blob(&[], &[&[(157, &[1])]]), Path::new("/nowhere/x.exs")).unwrap();
        assert!(exs.zones.is_empty());
        assert_eq!(exs.groups[0].zones, 1, "the group still counts the zone it took away");
        assert!(exs.groups[0].release_trigger);
    }

    #[test]
    fn a_group_narrows_the_velocities_of_its_zones() {
        let exs = parse(
            &blob(&[(84, &[1 << 3]), (93, &[40, 100])], &[&[(89, &[60, 80])]]),
            Path::new("/nowhere/x.exs"),
        )
        .unwrap();
        assert_eq!((exs.zones[0].vel_lo, exs.zones[0].vel_hi), (60, 80));
    }

    #[test]
    fn a_zone_outside_its_group_velocities_has_nothing_to_answer() {
        let exs = parse(
            &blob(&[(84, &[1 << 3]), (93, &[10, 20])], &[&[(89, &[60, 80])]]),
            Path::new("/nowhere/x.exs"),
        )
        .unwrap();
        assert!(exs.zones.is_empty());
    }

    #[test]
    fn a_group_adds_its_volume_to_the_gain_of_its_zones() {
        let exs = parse(
            &blob(&[(88, &[(-3i8) as u8])], &[&[(84, &[(-9i8) as u8])]]),
            Path::new("/nowhere/x.exs"),
        )
        .unwrap();
        assert_eq!(exs.zones[0].gain_db, -12.0);
    }

    #[test]
    fn articulations_leave_only_the_sustain_group() {
        let articulated: &[&[(usize, &[u8])]] = &[
            &[(20, b"Sustain"), (168, &[ARTICULATION])],
            &[(20, b"Key Off"), (168, &[ARTICULATION])],
        ];
        let sustain = parse(&blob(&[], articulated), Path::new("/nowhere/x.exs")).unwrap();
        assert_eq!(sustain.zones.len(), 1, "the zone of the Sustain group stays");

        let key_off = parse(
            &blob(&[(172, &1u32.to_le_bytes())], articulated),
            Path::new("/nowhere/x.exs"),
        )
        .unwrap();
        assert!(key_off.zones.is_empty());
    }

    #[test]
    fn articulations_without_a_sustain_group_leave_every_zone() {
        let exs = parse(
            &blob(&[], &[&[(20, b"Key Off"), (168, &[ARTICULATION])]]),
            Path::new("/nowhere/x.exs"),
        )
        .unwrap();
        assert_eq!(exs.zones.len(), 1);
    }

    /// The keys and velocities of 21..=108 and 1..=127 no zone answers, as (key, lowest, highest)
    /// velocity runs.
    fn uncovered(zones: &[Zone]) -> Vec<(u8, u8, u8)> {
        let mut gaps: Vec<(u8, u8, u8)> = Vec::new();
        for key in 21..=108u8 {
            for vel in 1..=127u8 {
                let answered = zones.iter().any(|z| {
                    z.key_lo <= key && key <= z.key_hi && z.vel_lo <= vel && vel <= z.vel_hi
                });
                if answered {
                    continue;
                }
                match gaps.last_mut() {
                    Some(gap) if gap.0 == key && gap.2 + 1 == vel => gap.2 = vel,
                    _ => gaps.push((key, vel, vel)),
                }
            }
        }
        gaps
    }

    #[test]
    #[ignore = "needs the Logic sample library"]
    fn reads_the_logic_pianos() {
        const ENABLE_BY: [&str; 8] = [
            "nothing",
            "note",
            "round robin",
            "controller",
            "bender",
            "channel",
            "articulation",
            "tempo",
        ];
        let library = PathBuf::from(std::env::var("HOME").unwrap()).join(
            "Music/Logic Pro Library.bundle/Plug-In Settings/Sampler/z_Internal/Studio Piano",
        );
        for name in ["Concert Grand Piano", "Studio Grand Piano"] {
            let exs = read(&library.join(format!("{name}.exs"))).unwrap();
            println!("\n{name}");
            for group in &exs.groups {
                println!(
                    "  {:<20} {:<8} vel {:>3}..{:<3} key {:>3}..{:<3} by {:<12} \
                     round robin {:<3} {:>4} zones",
                    group.name,
                    if group.release_trigger { "release" } else { "key down" },
                    group.vel_lo,
                    group.vel_hi,
                    group.key_lo,
                    group.key_hi,
                    match group.enable_by {
                        3 => format!("controller {}", group.enable_control),
                        code => ENABLE_BY.get(code as usize).copied().unwrap_or("?").to_string(),
                    },
                    group.round_robin,
                    group.zones,
                );
            }
            for sample in &exs.samples {
                println!("  {} ({} frames)", sample.path.display(), sample.frames);
                assert!(sample.path.exists(), "unresolved sample");
            }
            let named: usize = exs.groups.iter().map(|g| g.zones).sum();
            println!("  {} of {named} zones remain", exs.zones.len());
            println!("  uncovered (key, velocities): {:?}", uncovered(&exs.zones));

            let zone = exs
                .zones
                .iter()
                .find(|z| z.key_lo <= 60 && 60 <= z.key_hi && z.vel_lo <= 127 && 127 <= z.vel_hi)
                .expect("middle C at full velocity");
            println!("  middle C: {} dB, {zone:?}", zone.gain_db);
            assert_eq!(zone.root, 60);
            if name == "Concert Grand Piano" {
                assert_eq!(zone.start, 405875712);
                assert!(
                    exs.samples[zone.sample].path.ends_with("Concert Grand Piano_consolidated.caf"),
                    "{}",
                    exs.samples[zone.sample].path.display()
                );
            }
        }
    }
}

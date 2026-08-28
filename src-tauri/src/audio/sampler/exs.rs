//! Reads a Logic EXS instrument file into zones. An EXS file is a flat list of chunks, each an
//! 84-byte header followed by a body; the low nibble of the header's first dword says what the
//! chunk is. Only zones (0x01) and samples (0x03) carry anything the voice engine needs.

use std::fs;
use std::path::{Path, PathBuf};

use super::Zone;

/// One sample file the EXS names, and how many frames of it the zones may use.
#[derive(Clone, Debug, PartialEq)]
pub struct SampleRef {
    pub path: std::path::PathBuf,
    pub frames: usize,
}

/// The zones and the sample files an EXS file describes. `Zone::sample` indexes `samples`.
#[derive(Debug)]
pub struct Exs {
    pub zones: Vec<Zone>,
    pub samples: Vec<SampleRef>,
}

pub fn read(path: &Path) -> Result<Exs, String> {
    let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse(&bytes, path)
}

const HEADER: usize = 84;

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
            0x03 => samples.push(read_sample(&chunk, path)),
            _ => {}
        }
        i = end;
    }

    // A zone naming a sample the file does not hold has nothing to play.
    let count = samples.len() as u32;
    zones.retain(|(_, sample)| *sample < count);
    let zones = zones
        .into_iter()
        .map(|(mut zone, sample)| {
            zone.sample = sample as usize;
            zone
        })
        .collect();
    Ok(Exs { zones, samples })
}

/// Returns the zone and the index of the sample chunk it plays; `Zone::sample` is filled in once
/// the whole chunk list is known.
fn read_zone(c: &Rdr) -> (Zone, u32) {
    let opts = c.u8(84);
    let velocity_range_on = opts & (1 << 3) != 0;
    let loop_on = c.u8(117) & 1 != 0;
    let zone = Zone {
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
    (zone, c.u32(176))
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

    /// Builds a little-endian EXS holding a header chunk, one zone and one sample.
    fn blob(fields: &[(usize, &[u8])]) -> Vec<u8> {
        let mut out = vec![0u8; HEADER + 88 + HEADER + 148 + HEADER + 600];
        out[16..20].copy_from_slice(b"TBOS");
        out[4..8].copy_from_slice(&88u32.to_le_bytes());
        let zone = HEADER + 88;
        out[zone..zone + 4].copy_from_slice(&0x0100_0000u32.to_le_bytes());
        out[zone + 4..zone + 8].copy_from_slice(&148u32.to_le_bytes());
        let sample = zone + HEADER + 148;
        out[sample..sample + 4].copy_from_slice(&0x0300_0000u32.to_le_bytes());
        out[sample + 4..sample + 8].copy_from_slice(&600u32.to_le_bytes());
        for (at, value) in fields {
            let at = zone + at;
            out[at..at + value.len()].copy_from_slice(value);
        }
        out
    }

    #[test]
    fn walks_the_chunk_list() {
        let bytes = blob(&[
            (84, &[1 << 3]),           // velocity range on
            (85, &[60]),               // root key
            (86, &[(-7i8) as u8]),     // fine tuning
            (88, &[(-3i8) as u8]),     // volume
            (90, &[48, 72]),           // key range
            (93, &[100, 127]),         // velocity range
            (96, &1000u32.to_le_bytes()),
            (100, &2000u32.to_le_bytes()),
            (164, &[2]), // coarse tuning
        ]);
        let exs = parse(&bytes, Path::new("/nowhere/x.exs")).unwrap();
        assert_eq!(exs.samples.len(), 1);
        assert_eq!(
            exs.zones,
            vec![Zone {
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
        let exs = parse(&blob(&[(93, &[100, 127])]), Path::new("/nowhere/x.exs")).unwrap();
        assert_eq!((exs.zones[0].vel_lo, exs.zones[0].vel_hi), (0, 127));
    }

    #[test]
    fn a_looping_zone_carries_its_loop() {
        let exs = parse(
            &blob(&[(104, &10u32.to_le_bytes()), (108, &20u32.to_le_bytes()), (117, &[1])]),
            Path::new("/nowhere/x.exs"),
        )
        .unwrap();
        assert_eq!(exs.zones[0].loop_, Some((10, 20)));
    }

    #[test]
    #[ignore = "needs the Logic sample library"]
    fn reads_the_concert_grand() {
        let home = std::env::var("HOME").unwrap();
        let path = PathBuf::from(home).join(
            "Music/Logic Pro Library.bundle/Plug-In Settings/Sampler/z_Internal/Studio Piano/\
             Concert Grand Piano.exs",
        );
        let exs = read(&path).unwrap();
        println!("{} zones, {} samples", exs.zones.len(), exs.samples.len());
        for sample in &exs.samples {
            println!("  {} ({} frames)", sample.path.display(), sample.frames);
            assert!(sample.path.exists(), "unresolved sample");
        }

        let zone = exs
            .zones
            .iter()
            .find(|z| z.key_lo <= 60 && 60 <= z.key_hi && z.vel_lo <= 127 && 127 <= z.vel_hi)
            .expect("middle C at full velocity");
        println!("{zone:?}");
        assert_eq!(zone.root, 60);
        assert_eq!(zone.start, 405875712);
        assert!(
            exs.samples[zone.sample].path.ends_with("Concert Grand Piano_consolidated.caf"),
            "{}",
            exs.samples[zone.sample].path.display()
        );
    }
}

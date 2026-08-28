//! Turns the sample files an EXS names into playable PCM. Each file is decoded once with
//! ExtAudioFile into a raw interleaved stereo cache next to the other app caches, and every load
//! after that is a memory map of it.

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::ptr::{self, NonNull};

use memmap2::Mmap;
use objc2_audio_toolbox::{
    ExtAudioFileDispose, ExtAudioFileGetProperty, ExtAudioFileOpenURL, ExtAudioFileRead,
    ExtAudioFileRef, ExtAudioFileSetProperty, kExtAudioFileProperty_ClientDataFormat,
    kExtAudioFileProperty_FileDataFormat,
};
use objc2_core_audio_types::{
    AudioBuffer, AudioBufferList, AudioStreamBasicDescription, kAudioFormatFlagIsPacked,
    kAudioFormatFlagIsSignedInteger, kAudioFormatLinearPCM,
};
use objc2_core_foundation::{CFString, CFURL, CFURLPathStyle};

use super::exs::Exs;
use super::{Instrument, Sample};

/// Decodes every sample the EXS names, caching the PCM on disk, and returns the instrument the
/// voice engine plays.
///
/// ponytail: the whole instrument stays resident, which costs about 4 bytes per frame per sample
/// file. Disk streaming, keeping only each zone's attack in memory, is the upgrade when a library
/// no longer fits in RAM.
pub fn load(exs: &Exs) -> Result<Instrument, String> {
    let dir = cache_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;

    let mut samples = Vec::with_capacity(exs.samples.len());
    for sample in &exs.samples {
        let stem = sample
            .path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| format!("{}: no file name", sample.path.display()))?;
        let cache = dir.join(format!("{stem}-{}.pcm", sample.frames));

        let (file, rate) = open(&sample.path)?;
        let decoded = if cache.exists() { Ok(()) } else { decode(file, rate, &cache) };
        unsafe { ExtAudioFileDispose(file) };
        decoded?;

        samples.push(Sample { rate, data: Box::new(map(&cache)?) });
    }
    Ok(Instrument { zones: exs.zones.clone(), samples })
}

fn cache_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join("Library/Caches/piano/samples"))
}

/// Raw interleaved stereo PCM, mapped straight out of the cache file.
struct Pcm(Mmap);

impl AsRef<[i16]> for Pcm {
    fn as_ref(&self) -> &[i16] {
        // A mapping begins on a page boundary, so its bytes are aligned for i16.
        unsafe { std::slice::from_raw_parts(self.0.as_ptr().cast::<i16>(), self.0.len() / 2) }
    }
}

fn map(cache: &Path) -> Result<Pcm, String> {
    let file = File::open(cache).map_err(|e| format!("{}: {e}", cache.display()))?;
    let map = unsafe { Mmap::map(&file) }.map_err(|e| format!("{}: {e}", cache.display()))?;
    if map.len() % 2 != 0 {
        return Err(format!("{}: half a frame at the end", cache.display()));
    }
    let pcm = Pcm(map);
    // Fault the pages in here; the audio thread must never wait on the disk.
    let mut sum = 0i64;
    for &frame in pcm.as_ref() {
        sum = sum.wrapping_add(frame as i64);
    }
    std::hint::black_box(sum);
    Ok(pcm)
}

const NO_ERROR: i32 = 0;

/// Opens an audio file and reads the rate it was recorded at. The caller disposes the handle.
fn open(path: &Path) -> Result<(ExtAudioFileRef, f64), String> {
    let text = path.to_str().ok_or_else(|| format!("{}: path is not UTF-8", path.display()))?;
    let url = CFURL::with_file_system_path(
        None,
        Some(&CFString::from_str(text)),
        CFURLPathStyle::CFURLPOSIXPathStyle,
        false,
    )
    .ok_or_else(|| format!("{}: not a usable path", path.display()))?;

    let mut file: ExtAudioFileRef = ptr::null_mut();
    ck(unsafe { ExtAudioFileOpenURL(&url, NonNull::from(&mut file)) }, &path.display())?;

    // Every field is a plain integer, so a zeroed description is a valid one to read into.
    let mut format: AudioStreamBasicDescription = unsafe { std::mem::zeroed() };
    let mut size = size_of::<AudioStreamBasicDescription>() as u32;
    let status = unsafe {
        ExtAudioFileGetProperty(
            file,
            kExtAudioFileProperty_FileDataFormat,
            NonNull::from(&mut size),
            NonNull::from(&mut format).cast(),
        )
    };
    ck(status, &"reading the file format")?;
    Ok((file, format.mSampleRate))
}

/// Decodes the whole file into `cache`. The client format keeps the file's own rate, so
/// ExtAudioFile only unpacks the codec and never resamples.
fn decode(file: ExtAudioFileRef, rate: f64, cache: &Path) -> Result<(), String> {
    let client = AudioStreamBasicDescription {
        mSampleRate: rate,
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 4,
        mFramesPerPacket: 1,
        mBytesPerFrame: 4,
        mChannelsPerFrame: 2,
        mBitsPerChannel: 16,
        mReserved: 0,
    };
    let status = unsafe {
        ExtAudioFileSetProperty(
            file,
            kExtAudioFileProperty_ClientDataFormat,
            size_of::<AudioStreamBasicDescription>() as u32,
            NonNull::from(&client).cast(),
        )
    };
    ck(status, &"setting the client format")?;

    // A half-written cache must never be mapped, so build it beside the real name and rename.
    let temp = cache.with_extension(format!("part{}", std::process::id()));
    let written = write_pcm(file, &temp);
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written?;
    fs::rename(&temp, cache).map_err(|e| format!("{}: {e}", cache.display()))
}

fn write_pcm(file: ExtAudioFileRef, temp: &Path) -> Result<(), String> {
    const CHUNK: usize = 1 << 18;
    let mut out =
        BufWriter::new(File::create(temp).map_err(|e| format!("{}: {e}", temp.display()))?);
    let mut buffer = vec![0i16; CHUNK * 2];
    loop {
        let mut list = AudioBufferList {
            mNumberBuffers: 1,
            mBuffers: [AudioBuffer {
                mNumberChannels: 2,
                mDataByteSize: (CHUNK * 4) as u32,
                mData: buffer.as_mut_ptr().cast(),
            }],
        };
        let mut frames = CHUNK as u32;
        let status = unsafe {
            ExtAudioFileRead(file, NonNull::from(&mut frames), NonNull::from(&mut list))
        };
        ck(status, &"decoding")?;
        if frames == 0 {
            return out.flush().map_err(|e| format!("{}: {e}", temp.display()));
        }
        let bytes =
            unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), frames as usize * 4) };
        out.write_all(bytes).map_err(|e| format!("{}: {e}", temp.display()))?;
    }
}

fn ck(status: i32, what: &dyn std::fmt::Display) -> Result<(), String> {
    if status == NO_ERROR { Ok(()) } else { Err(format!("{what}: OSStatus {status}")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::sampler::exs::SampleRef;

    fn wav(frames: &[i16], rate: u32) -> Vec<u8> {
        let data: Vec<u8> = frames.iter().flat_map(|f| f.to_le_bytes()).collect();
        let mut out = Vec::new();
        out.extend(b"RIFF");
        out.extend((36 + data.len() as u32).to_le_bytes());
        out.extend(b"WAVEfmt ");
        out.extend(16u32.to_le_bytes());
        out.extend(1u16.to_le_bytes()); // PCM
        out.extend(2u16.to_le_bytes()); // channels
        out.extend(rate.to_le_bytes());
        out.extend((rate * 4).to_le_bytes());
        out.extend(4u16.to_le_bytes()); // bytes per frame
        out.extend(16u16.to_le_bytes());
        out.extend(b"data");
        out.extend((data.len() as u32).to_le_bytes());
        out.extend(data);
        out
    }

    #[test]
    fn decodes_a_file_and_maps_its_cache() {
        let dir = tempfile::tempdir().unwrap();
        let stem = format!("piano-decode-test-{}", std::process::id());
        let path = dir.path().join(format!("{stem}.wav"));
        let pcm: Vec<i16> = (0..1000i16).flat_map(|i| [i, -i]).collect();
        fs::write(&path, wav(&pcm, 32000)).unwrap();

        let exs = Exs { zones: Vec::new(), samples: vec![SampleRef { path, frames: 1000 }] };
        let instrument = load(&exs).unwrap();
        let cache = cache_dir().unwrap().join(format!("{stem}-1000.pcm"));

        let sample = &instrument.samples[0];
        assert_eq!(sample.rate, 32000.0);
        assert_eq!(sample.frames(), 1000);
        assert_eq!((*sample.data).as_ref(), pcm.as_slice());
        assert_eq!(fs::metadata(&cache).unwrap().len(), 4000);
        fs::remove_file(&cache).unwrap();
    }

    #[test]
    #[ignore = "needs the Logic sample library"]
    fn loads_the_concert_grand() {
        let home = std::env::var("HOME").unwrap();
        let path = PathBuf::from(home).join(
            "Music/Logic Pro Library.bundle/Plug-In Settings/Sampler/z_Internal/Studio Piano/\
             Concert Grand Piano.exs",
        );
        let exs = crate::audio::sampler::exs::read(&path).unwrap();

        let started = std::time::Instant::now();
        let instrument = load(&exs).unwrap();
        println!("{} samples loaded in {:?}", instrument.samples.len(), started.elapsed());

        let mut consolidated = None;
        for (reference, sample) in exs.samples.iter().zip(&instrument.samples) {
            let name = reference.path.file_name().unwrap().to_string_lossy();
            println!(
                "  {name}: {} frames at {} Hz, {} MB cached",
                sample.frames(),
                sample.rate,
                sample.frames() * 4 / 1_000_000
            );
            if name == "Concert Grand Piano_consolidated.caf" {
                consolidated = Some(sample);
            }
        }

        let pcm = (*consolidated.expect("the consolidated file").data).as_ref();
        let at = 405875712 * 2;
        assert_eq!((pcm[at], pcm[at + 1]), (3, -17));
    }
}

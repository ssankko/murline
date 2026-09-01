//! Keeps an EXS instrument's sample files open and playing. A load decodes each zone's head into
//! RAM and leaves the rest on disk; one reader thread per instrument then serves the voices out of
//! the files while they sound. Nothing is written anywhere.

use std::path::Path;
use std::ptr::{self, NonNull};
use std::sync::{Arc, Weak};
use std::thread;
use std::time::Duration;

use objc2_audio_toolbox::{
    ExtAudioFileDispose, ExtAudioFileGetProperty, ExtAudioFileOpenURL, ExtAudioFileRead,
    ExtAudioFileRef, ExtAudioFileSeek, ExtAudioFileSetProperty,
    kExtAudioFileProperty_ClientDataFormat, kExtAudioFileProperty_FileDataFormat,
};
use objc2_core_audio_types::{
    AudioBuffer, AudioBufferList, AudioStreamBasicDescription, kAudioFormatFlagIsPacked,
    kAudioFormatFlagIsSignedInteger, kAudioFormatLinearPCM,
};
use objc2_core_foundation::{CFString, CFURL, CFURLPathStyle};

use super::exs::{Exs, SampleRef};
use super::{HEAD, Instrument, Sample, Stream, Zone};

/// Frames one read takes off the disk, about a fifth of a second: long enough that a voice costs
/// the reader a handful of reads a second, short enough that one read never holds the others up.
const CHUNK: usize = 8192;

/// Frames each voice's ring holds, near a second and a half at 44.1 kHz.
const RING: usize = 1 << 16;

/// How long the reader waits when every voice is served. Each voice has its head plus its ring in
/// hand, so this is nowhere near the time it has to answer in.
/// ponytail: a poll rather than a wakeup, which costs one idle look every few milliseconds; a
/// semaphore is the upgrade if the reader ever has to be woken faster than this.
const POLL: Duration = Duration::from_millis(2);

/// Reads an EXS's zones and the head of each one, and starts the reader that serves the rest.
/// `slots` is how many voices the engine can sound at once, one ring each.
pub fn load(exs: &Exs, slots: usize) -> Result<Instrument, String> {
    build(exs.zones.clone(), &exs.samples, slots)
}

fn build(zones: Vec<Zone>, files: &[SampleRef], slots: usize) -> Result<Instrument, String> {
    let mut readers = Vec::with_capacity(files.len());
    let mut samples = Vec::with_capacity(files.len());
    for reference in files {
        let reader = Reader::open(&reference.path)?;
        samples.push(Sample { rate: reader.rate, frames: reference.frames, data: None });
        readers.push(reader);
    }

    let mut heads = vec![Vec::new(); zones.len()];
    // In the order the files hold them, so the heads of one file are read front to back rather
    // than in whatever order the zones happen to be listed in.
    let mut order: Vec<usize> = (0..zones.len()).collect();
    order.sort_by_key(|&i| (zones[i].sample, zones[i].start));
    for i in order {
        let zone = &zones[i];
        let Some(reader) = readers.get_mut(zone.sample) else { continue };
        let frames = samples[zone.sample].frames;
        let start = zone.start.min(frames);
        let want = (HEAD * reader.rate) as usize;
        heads[i] = reader.frames(start, want.min(zone.end.min(frames).saturating_sub(start)))?;
    }

    let stream = Arc::new(Stream::new(slots, RING));
    let watch = Arc::downgrade(&stream);
    thread::Builder::new()
        .name("sample reader".into())
        .spawn(move || serve(&watch, readers))
        .map_err(|e| format!("the sample reader would not start: {e}"))?;
    Ok(Instrument::new(zones, samples, heads, Some(stream)))
}

/// The reader thread. It serves every voice waiting on it a chunk at a time, round after round, so
/// a note struck while another is filling waits at most one chunk. It ends when the instrument is
/// dropped and the last strong reference to the stream goes with it.
fn serve(stream: &Weak<Stream>, mut readers: Vec<Reader>) {
    let mut jobs: Vec<Option<super::Fill>> = Vec::new();
    let mut chunk = vec![0i16; CHUNK * 2];
    loop {
        let Some(stream) = stream.upgrade() else { return };
        jobs.resize(stream.slots(), None);
        let worked = round(&stream, &mut readers, &mut jobs, &mut chunk);
        drop(stream);
        if !worked {
            thread::sleep(POLL);
        }
    }
}

/// One round of the reader: takes the new orders and reads one chunk for every voice with room
/// for it. False when there was nothing to do, which is when the thread may rest.
fn round(
    stream: &Stream,
    readers: &mut [Reader],
    jobs: &mut [Option<super::Fill>],
    chunk: &mut [i16],
) -> bool {
    while let Some(fill) = stream.order() {
        if stream.open(&fill) {
            jobs[fill.slot] = Some(fill);
        }
    }

    let mut worked = false;
    for (slot, job) in jobs.iter_mut().enumerate() {
        let Some(fill) = job else { continue };
        if stream.stale(fill) || fill.from >= fill.to {
            *job = None;
            continue;
        }
        let want = CHUNK.min(fill.to - fill.from);
        if stream.room(slot) < want {
            continue;
        }
        let read = readers
            .get_mut(fill.sample)
            .map_or(Ok(0), |reader| reader.read(fill.from, &mut chunk[..want * 2]));
        match read {
            // A file that stops early or errs has nothing more for this voice.
            Ok(0) | Err(_) => *job = None,
            Ok(frames) => {
                stream.feed(fill, &chunk[..frames * 2]);
                fill.from += frames;
                worked = true;
            }
        }
    }
    worked
}

/// One sample file, open and decoding to interleaved 16-bit stereo at the rate it was recorded at.
struct Reader {
    file: ExtAudioFileRef,
    rate: f64,
    /// Where the next read starts, so a voice reading on through a file never seeks.
    at: usize,
}

// The handle is only ever used by whichever thread owns the reader.
unsafe impl Send for Reader {}

impl Drop for Reader {
    fn drop(&mut self) {
        unsafe { ExtAudioFileDispose(self.file) };
    }
}

impl Reader {
    fn open(path: &Path) -> Result<Self, String> {
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
        let mut reader = Reader { file, rate: 0.0, at: 0 };

        // Every field is a plain integer, so a zeroed description is a valid one to read into.
        let mut format: AudioStreamBasicDescription = unsafe { std::mem::zeroed() };
        let mut size = size_of::<AudioStreamBasicDescription>() as u32;
        ck(
            unsafe {
                ExtAudioFileGetProperty(
                    file,
                    kExtAudioFileProperty_FileDataFormat,
                    NonNull::from(&mut size),
                    NonNull::from(&mut format).cast(),
                )
            },
            &"reading the file format",
        )?;
        reader.rate = format.mSampleRate;

        // The client format keeps the file's own rate, so ExtAudioFile unpacks the codec and never
        // resamples; the voice does the pitch itself.
        let client = AudioStreamBasicDescription {
            mSampleRate: reader.rate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: 2,
            mBitsPerChannel: 16,
            mReserved: 0,
        };
        ck(
            unsafe {
                ExtAudioFileSetProperty(
                    file,
                    kExtAudioFileProperty_ClientDataFormat,
                    size_of::<AudioStreamBasicDescription>() as u32,
                    NonNull::from(&client).cast(),
                )
            },
            &"setting the client format",
        )?;
        Ok(reader)
    }

    /// Decodes from `from` into `out`, which holds two values per frame. Answers the frames it
    /// got, which is fewer than asked for at the end of the file and can be fewer anywhere else.
    fn read(&mut self, from: usize, out: &mut [i16]) -> Result<usize, String> {
        if out.is_empty() {
            return Ok(0);
        }
        if self.at != from {
            let at = i64::try_from(from).unwrap_or(i64::MAX);
            ck(unsafe { ExtAudioFileSeek(self.file, at) }, &"seeking")?;
            self.at = from;
        }
        let mut frames = (out.len() / 2) as u32;
        let mut list = AudioBufferList {
            mNumberBuffers: 1,
            mBuffers: [AudioBuffer {
                mNumberChannels: 2,
                mDataByteSize: (out.len() * 2) as u32,
                mData: out.as_mut_ptr().cast(),
            }],
        };
        let status = unsafe {
            ExtAudioFileRead(self.file, NonNull::from(&mut frames), NonNull::from(&mut list))
        };
        ck(status, &"decoding")?;
        self.at += frames as usize;
        Ok(frames as usize)
    }

    /// The frames from `from` on, as interleaved stereo, reading until it has them all.
    fn frames(&mut self, from: usize, count: usize) -> Result<Vec<i16>, String> {
        let mut out = vec![0i16; count * 2];
        let mut got = 0;
        while got < count {
            let read = self.read(from + got, &mut out[got * 2..])?;
            if read == 0 {
                out.truncate(got * 2);
                break;
            }
            got += read;
        }
        Ok(out)
    }
}

const NO_ERROR: i32 = 0;

fn ck(status: i32, what: &dyn std::fmt::Display) -> Result<(), String> {
    if status == NO_ERROR { Ok(()) } else { Err(format!("{what}: OSStatus {status}")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::sampler::{Fill, Role};
    use std::path::PathBuf;
    use std::time::Instant;

    const RATE: u32 = 32000;

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

    /// A file longer than one head, so the load keeps the front of it and the reader has to fetch
    /// the rest from where the head stops.
    #[test]
    fn a_load_keeps_the_head_and_the_reader_brings_the_rest() {
        let frames = RATE as usize / 2;
        let pcm: Vec<i16> = (0..i16::try_from(frames).unwrap()).flat_map(|i| [i, -i]).collect();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("head-and-tail.wav");
        std::fs::write(&path, wav(&pcm, RATE)).unwrap();

        let zone = Zone {
            role: Role::Sustain,
            key_lo: 0,
            key_hi: 127,
            vel_lo: 0,
            vel_hi: 127,
            root: 60,
            tune_cents: 0,
            gain_db: 0.0,
            sample: 0,
            start: 0,
            end: frames,
            loop_: None,
        };
        let instrument = build(vec![zone], &[SampleRef { path: path.clone(), frames }], 4).unwrap();

        let head = (HEAD * f64::from(RATE)) as usize;
        assert_eq!(instrument.samples[0].rate, f64::from(RATE));
        assert!(instrument.samples[0].data.is_none(), "nothing but the head is held");
        assert_eq!(instrument.heads[0], pcm[..head * 2], "and the head is the front of the file");

        // The reader's rounds, run here rather than on its thread, until one finds nothing to do.
        let stream = Stream::new(4, RING);
        let mut readers = vec![Reader::open(&path).unwrap()];
        let mut jobs = vec![None; 4];
        let mut chunk = vec![0i16; CHUNK * 2];
        let generation =
            stream.start(Fill { slot: 1, sample: 0, from: head, to: frames, ..Fill::default() });
        while round(&stream, &mut readers, &mut jobs, &mut chunk) {}

        let mut got = Vec::new();
        let mut frame = [0i16; 2];
        while stream.read(1, generation, &mut frame) {
            got.extend(frame);
        }
        assert_eq!(got, pcm[head * 2..], "the reader carries on where the head stopped");
        assert_eq!(stream.underruns(), 1, "and the one at the end is the file running out");
    }

    /// Loading is a seek and a short read per zone, not a decode of the whole library: the numbers
    /// this prints are the load time and what it costs in memory.
    /// Run it and read them: `cargo test -- --ignored loads_the_concert_grand`.
    #[test]
    #[ignore = "needs the Logic sample library"]
    fn loads_the_concert_grand() {
        let home = std::env::var("HOME").unwrap();
        let path = PathBuf::from(home).join(
            "Music/Logic Pro Library.bundle/Plug-In Settings/Sampler/z_Internal/Studio Piano/\
             Concert Grand Piano.exs",
        );
        let exs = crate::audio::sampler::exs::read(&path).unwrap();

        let started = Instant::now();
        let instrument = load(&exs, 128).unwrap();
        let took = started.elapsed();
        let kept: usize = instrument.heads.iter().map(|head| head.len() * 2).sum();
        println!(
            "{} zones over {} files in {took:?}, {} MB of heads",
            instrument.zones.len(),
            instrument.samples.len(),
            kept / 1_000_000
        );
        assert!(took < Duration::from_secs(3), "loaded in {took:?}");

        // Middle C at the hardest strike, whose first frame is known.
        let at = exs
            .zones
            .iter()
            .position(|zone| zone.start == 405_875_712)
            .expect("the zone middle C at velocity 127 plays");
        let head = &instrument.heads[at];
        println!("zone {at} covers keys {}..{}", exs.zones[at].key_lo, exs.zones[at].key_hi);
        assert_eq!((head[0], head[1]), (3, -17));
    }
}

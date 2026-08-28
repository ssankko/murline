//! The frames a streamed zone plays once its head runs out: one ring per voice slot, written by
//! the instrument's reader thread and read on the audio thread. Nothing here allocates, locks or
//! blocks after `Stream::new`, so both ends are safe to call from where they are.

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use Ordering::{Acquire, Relaxed, Release};

/// A single-producer single-consumer ring. Both sides hold it by shared reference: the writer only
/// moves `write` and the reader only moves `read`, so neither ever waits for the other. The two
/// counters run on without wrapping and the slot they name is `counter & mask`.
pub(crate) struct Ring<T> {
    slots: UnsafeCell<Box<[T]>>,
    mask: usize,
    write: AtomicUsize,
    read: AtomicUsize,
}

// One writer and one reader, each touching only the half of the ring the counters give it.
unsafe impl<T: Send> Send for Ring<T> {}
unsafe impl<T: Send> Sync for Ring<T> {}

impl<T: Copy + Default> Ring<T> {
    /// Room for at least `capacity` items, rounded up to the power of two the mask needs.
    pub(crate) fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1).next_power_of_two();
        Self {
            slots: UnsafeCell::new(vec![T::default(); capacity].into_boxed_slice()),
            mask: capacity - 1,
            write: AtomicUsize::new(0),
            read: AtomicUsize::new(0),
        }
    }

    fn ready(&self) -> usize {
        self.write.load(Acquire) - self.read.load(Relaxed)
    }

    fn room(&self) -> usize {
        self.mask + 1 - (self.write.load(Relaxed) - self.read.load(Acquire))
    }

    /// Writer side. Answers how many items went in, which is fewer than asked when the ring fills.
    pub(crate) fn push(&self, items: &[T]) -> usize {
        let write = self.write.load(Relaxed);
        let take = items.len().min(self.room());
        let slots = unsafe { &mut *self.slots.get() };
        for (i, item) in items[..take].iter().enumerate() {
            slots[(write + i) & self.mask] = *item;
        }
        self.write.store(write + take, Release);
        take
    }

    /// Reader side. Answers how many items came out, which is fewer than asked when it runs dry.
    pub(crate) fn pop(&self, out: &mut [T]) -> usize {
        let read = self.read.load(Relaxed);
        let take = out.len().min(self.ready());
        let slots = unsafe { &*self.slots.get() };
        for (i, slot) in out[..take].iter_mut().enumerate() {
            *slot = slots[(read + i) & self.mask];
        }
        self.read.store(read + take, Release);
        take
    }

    /// Throws away everything unread. Only the writer calls it, and only for a slot whose voice is
    /// gone, so no reader is inside the ring at the time.
    fn empty(&self) {
        self.read.store(self.write.load(Acquire), Release);
    }
}

/// One voice slot: the frames waiting for it and the two generations that say whose they are.
struct Slot {
    frames: Ring<i16>,
    /// The generation the reader is serving. A voice reads only while this is its own, which is
    /// what keeps it off the frames left by the voice before it.
    serving: AtomicU64,
    /// The generation the audio thread wants, bumped by every voice start and every voice end.
    wanted: AtomicU64,
}

/// One order to the reader: fill `slot` with `sample` from frame `from` up to frame `to`.
#[derive(Clone, Copy, Default)]
pub struct Fill {
    pub slot: usize,
    pub sample: usize,
    pub from: usize,
    pub to: usize,
    pub generation: u64,
}

/// The rings of one loaded instrument, shared by the audio thread and the reader thread.
pub struct Stream {
    slots: Vec<Slot>,
    orders: Ring<Fill>,
    underruns: AtomicU64,
}

impl Stream {
    /// One ring of `frames` stereo frames per voice slot, all of it allocated here.
    pub fn new(slots: usize, frames: usize) -> Self {
        Self {
            slots: (0..slots)
                .map(|_| Slot {
                    frames: Ring::new(frames * 2),
                    serving: AtomicU64::new(0),
                    wanted: AtomicU64::new(0),
                })
                .collect(),
            // A start can only come from a voice, so a slot's worth of orders is always room.
            orders: Ring::new(slots),
            underruns: AtomicU64::new(0),
        }
    }

    pub fn slots(&self) -> usize {
        self.slots.len()
    }

    /// Frames a voice has been given and not yet read. What a test waits on.
    #[cfg(test)]
    pub fn ready(&self, slot: usize) -> usize {
        self.slots.get(slot).map_or(0, |slot| slot.frames.ready() / 2)
    }

    pub fn underruns(&self) -> u64 {
        self.underruns.load(Relaxed)
    }

    // Audio thread.

    /// Asks the reader for a voice's frames and answers the generation the voice reads under.
    pub fn start(&self, mut fill: Fill) -> u64 {
        let Some(slot) = self.slots.get(fill.slot) else { return 0 };
        fill.generation = slot.wanted.fetch_add(1, Release) + 1;
        self.orders.push(&[fill]);
        fill.generation
    }

    /// The voice in this slot is over, so whatever is still being read for it is wasted work.
    pub fn end(&self, slot: usize) {
        if let Some(slot) = self.slots.get(slot) {
            slot.wanted.fetch_add(1, Release);
        }
    }

    /// The voice's next frame. False when nothing is there, which is silence and an underrun.
    pub fn read(&self, slot: usize, generation: u64, frame: &mut [i16; 2]) -> bool {
        let served = self
            .slots
            .get(slot)
            .filter(|slot| slot.serving.load(Acquire) == generation)
            .is_some_and(|slot| slot.frames.pop(frame) == 2);
        if !served {
            self.underruns.fetch_add(1, Relaxed);
        }
        served
    }

    // Reader thread.

    /// The next voice to fill, or nothing while every voice is served.
    pub fn order(&self) -> Option<Fill> {
        let mut fill = [Fill::default(); 1];
        (self.orders.pop(&mut fill) == 1).then_some(fill[0])
    }

    /// Clears the slot for this fill. False when the voice went away before the reader got to it.
    pub fn open(&self, fill: &Fill) -> bool {
        let Some(slot) = self.slots.get(fill.slot).filter(|_| !self.stale(fill)) else {
            return false;
        };
        slot.frames.empty();
        true
    }

    /// True once the voice this fill was for has gone, which is when to stop reading for it.
    pub fn stale(&self, fill: &Fill) -> bool {
        self.slots
            .get(fill.slot)
            .is_none_or(|slot| slot.wanted.load(Acquire) != fill.generation)
    }

    /// Frames the slot's ring has room for.
    pub fn room(&self, slot: usize) -> usize {
        self.slots.get(slot).map_or(0, |slot| slot.frames.room() / 2)
    }

    /// Hands the voice the frames read for it. Answers how many stereo frames went in.
    pub fn feed(&self, fill: &Fill, frames: &[i16]) -> usize {
        let Some(slot) = self.slots.get(fill.slot).filter(|_| !self.stale(fill)) else {
            return 0;
        };
        let taken = slot.frames.push(frames);
        slot.serving.store(fill.generation, Release);
        taken / 2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ring_gives_back_what_went_in_and_stops_at_its_capacity() {
        let ring = Ring::<i16>::new(4);
        assert_eq!(ring.push(&[1, 2, 3, 4, 5, 6]), 4, "a full ring takes no more");
        let mut out = [0i16; 6];
        assert_eq!(ring.pop(&mut out), 4);
        assert_eq!(out, [1, 2, 3, 4, 0, 0]);
        assert_eq!(ring.pop(&mut out), 0, "and an empty one gives nothing");

        // The counters run past the capacity, so the slots have to be reused in order.
        assert_eq!(ring.push(&[7, 8, 9]), 3);
        assert_eq!(ring.pop(&mut out[..3]), 3);
        assert_eq!(out[..3], [7, 8, 9]);
    }

    #[test]
    fn a_voice_reads_only_the_frames_read_for_it() {
        let stream = Stream::new(2, 64);
        let first = stream.start(Fill { slot: 0, sample: 0, from: 0, to: 100, ..Fill::default() });
        let fill = stream.order().expect("the order the start queued");
        assert!(stream.open(&fill));
        assert_eq!(stream.feed(&fill, &[5, 6]), 1);

        let mut frame = [0i16; 2];
        assert!(stream.read(0, first, &mut frame));
        assert_eq!(frame, [5, 6]);
        assert!(!stream.read(0, first, &mut frame), "an empty ring is an underrun");
        assert_eq!(stream.underruns(), 1);

        // The next voice in the slot cannot be given what was read for the one before it.
        stream.end(0);
        let second = stream.start(Fill { slot: 0, sample: 0, from: 0, to: 100, ..Fill::default() });
        assert!(stream.stale(&fill), "the reader is told to drop the fill it was on");
        assert_eq!(stream.feed(&fill, &[7, 8]), 0);
        assert!(!stream.read(0, second, &mut frame));
    }
}

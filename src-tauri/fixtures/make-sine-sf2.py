#!/usr/bin/env python3
"""Writes fixtures/sine.sf2: one looped sine sample mapped across the whole keyboard.

The test fixture the sound engine loads into AVAudioUnitSampler. Regenerate with
`python3 fixtures/make-sine-sf2.py` from src-tauri.
"""

import math
import struct
from pathlib import Path

RATE = 44100
PERIOD = 100  # frames, so the loop joins seamlessly at RATE / PERIOD = 441 Hz ≈ A4
FRAMES = PERIOD * 10
ROOT_KEY = 69  # A4, the pitch 441 Hz stands for

# SoundFont generator operators, from the SF2 spec's list.
GEN_RELEASE_VOL_ENV = 38
GEN_INSTRUMENT = 41
GEN_SAMPLE_ID = 53
GEN_SAMPLE_MODES = 54


def chunk(tag: bytes, body: bytes) -> bytes:
    return tag + struct.pack("<I", len(body)) + body + (b"\0" if len(body) % 2 else b"")


def name(text: str) -> bytes:
    return text.encode("ascii").ljust(20, b"\0")[:20]


samples = b"".join(
    struct.pack("<h", int(30000 * math.sin(2 * math.pi * i / PERIOD))) for i in range(FRAMES)
)
# The spec asks for 46 silent frames after every sample so the interpolator never reads live data.
sdta = chunk(b"LIST", b"sdta" + chunk(b"smpl", samples + b"\0" * (46 * 2)))

info = chunk(
    b"LIST",
    b"INFO"
    + chunk(b"ifil", struct.pack("<HH", 2, 1))
    + chunk(b"isng", b"EMU8000\0")
    + chunk(b"INAM", b"Sine test\0"),
)

phdr = chunk(
    b"phdr",
    name("Sine") + struct.pack("<HHHIII", 0, 0, 0, 0, 0, 0)
    + name("EOP") + struct.pack("<HHHIII", 0, 0, 1, 0, 0, 0),
)
pbag = chunk(b"pbag", struct.pack("<HH", 0, 0) + struct.pack("<HH", 1, 0))
pmod = chunk(b"pmod", b"\0" * 10)
pgen = chunk(b"pgen", struct.pack("<HH", GEN_INSTRUMENT, 0) + struct.pack("<HH", 0, 0))
inst = chunk(b"inst", name("Sine") + struct.pack("<H", 0) + name("EOI") + struct.pack("<H", 1))
ibag = chunk(b"ibag", struct.pack("<HH", 0, 0) + struct.pack("<HH", 3, 0))
imod = chunk(b"imod", b"\0" * 10)
igen = chunk(
    b"igen",
    # A one-millisecond release, so a note off is silence within a buffer or two.
    struct.pack("<Hh", GEN_RELEASE_VOL_ENV, -12000)
    + struct.pack("<HH", GEN_SAMPLE_MODES, 1)
    + struct.pack("<HH", GEN_SAMPLE_ID, 0)
    + struct.pack("<HH", 0, 0),
)
shdr = chunk(
    b"shdr",
    name("Sine")
    + struct.pack("<IIIIIBbHH", 0, FRAMES, 0, FRAMES, RATE, ROOT_KEY, 0, 0, 1)
    + name("EOS")
    + struct.pack("<IIIIIBbHH", 0, 0, 0, 0, 0, 0, 0, 0, 0),
)
pdta = chunk(b"LIST", b"pdta" + phdr + pbag + pmod + pgen + inst + ibag + imod + igen + shdr)

out = Path(__file__).with_name("sine.sf2")
out.write_bytes(chunk(b"RIFF", b"sfbk" + info + sdta + pdta))
print(f"{out} — {out.stat().st_size} bytes")

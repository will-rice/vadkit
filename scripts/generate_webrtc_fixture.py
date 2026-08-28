#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["webrtcvad==2.0.10", "setuptools<81"]
# ///
"""Golden per-frame decisions for the WebRTC VAD provider.

Reference: py-webrtcvad, which wraps the upstream WebRTC VAD C sources
directly — an implementation independent of the vendored libfvad wasm
build. The algorithm is fixed-point integer arithmetic, so the TypeScript
test asserts bit-exact equality across every aggressiveness mode.

Run: uv run scripts/generate_webrtc_fixture.py
"""

import json
import os
import wave

import webrtcvad

HERE = os.path.dirname(os.path.abspath(__file__))
FRAME_MS = 10
SAMPLE_RATE = 16000
FRAME_BYTES = SAMPLE_RATE * FRAME_MS // 1000 * 2


def main():
    with wave.open(os.path.join(HERE, "..", "tests", "assets", "hello_en.wav")) as f:
        assert f.getframerate() == SAMPLE_RATE
        assert f.getnchannels() == 1
        assert f.getsampwidth() == 2
        pcm = f.readframes(f.getnframes())

    modes = {}
    for mode in range(4):
        vad = webrtcvad.Vad(mode)
        decisions = []
        for i in range(0, len(pcm) - FRAME_BYTES + 1, FRAME_BYTES):
            decisions.append(int(vad.is_speech(pcm[i : i + FRAME_BYTES], SAMPLE_RATE)))
        modes[str(mode)] = decisions

    out = os.path.join(HERE, "..", "tests", "fixtures", "webrtc.json")
    with open(out, "w") as f:
        json.dump(
            {"wav": "hello_en.wav", "frameMs": FRAME_MS, "modes": modes},
            f,
            separators=(",", ":"),
        )
        f.write("\n")
    print(f"wrote {out} ({len(modes['0'])} frames x {len(modes)} modes)")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["silero-vad==5.1.2", "soundfile", "numpy", "onnxruntime", "torch"]
# ///
"""Golden per-window probabilities from the silero-vad package (ONNX mode).

Reference: silero_vad.load_silero_vad(onnx=True) called per 512-sample
window, exactly as the package's VADIterator does (including its 64-sample
context handling).
"""

import json
import os

import numpy as np
import soundfile as sf
import torch
from silero_vad import load_silero_vad

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    wav, sr = sf.read(
        os.path.join(HERE, "..", "tests", "assets", "hello_en.wav"), dtype="int16")
    assert sr == 16000
    pcm = (wav / 32768.0).astype(np.float32)

    model = load_silero_vad(onnx=True)
    model.reset_states()
    probs = []
    for i in range(0, len(pcm) - 511, 512):
        chunk = torch.from_numpy(pcm[i:i + 512])
        probs.append(float(model(chunk, 16000).item()))

    out = os.path.join(HERE, "..", "tests", "fixtures", "silero.json")
    with open(out, "w") as f:
        json.dump({"wav": "hello_en.wav", "windowSamples": 512, "probs": probs}, f)
    print(f"wrote {out} ({len(probs)} windows)")


if __name__ == "__main__":
    main()

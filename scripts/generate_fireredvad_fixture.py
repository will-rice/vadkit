#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["onnxruntime", "soundfile", "numpy"]
# ///
"""Golden per-frame probabilities for the FireRedVAD provider.

Reference: the fireredvad_stream_vad_e2e.onnx model run with Python
onnxruntime over the full utterance (zero initial caches). The model's own
parity with the FireRedVAD Python pipeline is established in that repo's
tests; this fixture pins the TypeScript glue (framing, cache threading).
"""

import json
import os

import numpy as np
import onnxruntime
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    wav, sr = sf.read(
        os.path.join(HERE, "..", "tests", "assets", "hello_en.wav"), dtype="int16")
    assert sr == 16000
    pcm = (wav / 32768.0).astype(np.float32)[None, :]

    sess = onnxruntime.InferenceSession(
        os.path.join(HERE, "..", "models", "fireredvad_stream_vad_e2e.onnx"))
    caches = np.zeros((1, 1024, 19), dtype=np.float32)
    (probs,) = sess.run(["probs"], {"pcm": pcm, "caches_packed": caches})

    out = os.path.join(HERE, "..", "tests", "fixtures", "fireredvad.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump({"wav": "hello_en.wav", "probs": probs[0, :, 0].tolist()}, f)
    print(f"wrote {out} ({probs.shape[1]} frames)")


if __name__ == "__main__":
    main()

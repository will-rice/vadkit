#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["fireredvad[cpu]==0.0.2", "huggingface-hub"]
# ///
"""Golden per-frame probabilities from the FireRedVAD Python pipeline.

Reference: FireRedStreamVad.detect_full over the full utterance with zero
initial caches, using the Stream-VAD weights from
huggingface.co/FireRedTeam/FireRedVAD. This drives the real feature
frontend (kaldi fbank + CMVN) and the torch DFSMN, so the fixture checks
vadkit's e2e ONNX provider against upstream rather than against a second
driver of the same ONNX graph.

The wav path is handed to upstream rather than decoded here on purpose:
AudioFeat.extract reads int16 and the fbank expects that scale, so letting
upstream read the file removes any scaling ambiguity.

This mirrors detect_full (full utterance, zero initial caches) but reads the
model output directly instead of going through the postprocessor, which
rounds raw_prob to 3 decimals for display
(fireredvad/core/stream_vad_postprocessor.py:69). Both objects used here are
upstream's own -- only the rounding is bypassed.

Run: npm run fixtures
"""

import json
import os

from fireredvad import FireRedStreamVad
from huggingface_hub import snapshot_download

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    model_dir = snapshot_download("FireRedTeam/FireRedVAD", allow_patterns=["Stream-VAD/*"])
    vad = FireRedStreamVad.from_pretrained(os.path.join(model_dir, "Stream-VAD"))

    wav = os.path.join(HERE, "..", "tests", "assets", "hello_en.wav")
    feats, _ = vad.audio_feat.extract(wav)
    raw_probs, _ = vad.vad_model.forward(feats.unsqueeze(0))
    probs = [float(p) for p in raw_probs.squeeze().tolist()]

    out = os.path.join(HERE, "..", "tests", "fixtures", "fireredvad.json")
    with open(out, "w") as f:
        json.dump({"wav": "hello_en.wav", "probs": probs}, f, separators=(",", ":"))
        f.write("\n")
    print(f"wrote {out} ({len(probs)} frames)")


if __name__ == "__main__":
    main()

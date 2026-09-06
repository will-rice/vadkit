#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "soundfile", "onnxruntime", "kaldi-native-fbank",
#                 "huggingface-hub"]
# ///
"""Golden per-frame speech probabilities from the FunASR FSMN-VAD pipeline.

Reference: funasr_onnx.utils.frontend.WavFrontend's feature extraction
(kaldi_native_fbank with FunASR's own options, apply_lfr m=5 n=1, CMVN)
feeding upstream's published model.onnx from
huggingface.co/funasr/fsmn-vad-onnx, with zero initial caches. Driving
upstream's real frontend rather than our exported graph is the point: the
fixture checks vadkit's e2e ONNX against FunASR, not against a second driver
of our own export.

Speech probability is 1 - P(silence) over the 248 monophone posteriors,
which is how FunASR reads the model (vad.yaml: silence_pdf_num 1,
sil_pdf_ids [0]). Its E2EVadModel postprocessor -- SNR gates, decibel
thresholds, the segment state machine -- is bypassed on purpose: vadkit's
segmenter replaces it, so only the per-frame probability is comparable.

Two reference series are recorded, from the same frontend and graph:

`probs` runs the LFR without padding, so its frames align 1:1 with vadkit's
and it is the parity reference proper.

`paddedProbs` is FunASR verbatim. apply_lfr pads lfrLead frames at each end
(copies of the first and last fbank frames) so the output keeps the input
frame count; a causal stream can produce neither, and vadkit's frame k is
FunASR's frame k + lfrLead. Those two padded frames perturb FunASR's first
RECEPTIVE_FIELD frames -- the DFSMN's memory blocks stack, so the network
sees fsmn_layers * (lorder - 1) frames back -- after which both series agree
to float32 noise. The test asserts that convergence.

Run: npm run fixtures
"""

import itertools
import json
import os

import kaldi_native_fbank as knf
import numpy as np
import onnxruntime as ort
import soundfile as sf
from huggingface_hub import hf_hub_download

REPO = "funasr/fsmn-vad-onnx"
SAMPLE_RATE = 16000
N_MELS = 80
LFR_M = 5
LFR_LEAD = (LFR_M - 1) // 2  # frames of FunASR left-padding vadkit cannot emit
FSMN_LAYERS = 4  # vad.yaml encoder_conf
LORDER = 20
RECEPTIVE_FIELD = FSMN_LAYERS * (LORDER - 1)  # frames of stacked DFSMN memory
CACHE_DIMS = (1, 128, 19, 1)

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    wav, sr = sf.read(os.path.join(HERE, "..", "tests", "assets", "hello_en.wav"), dtype="float32")
    if sr != SAMPLE_RATE:
        raise ValueError(f"expected {SAMPLE_RATE} Hz, got {sr}")

    means, varis = load_cmvn()
    feat = fbank(wav)
    session = ort.InferenceSession(hf_hub_download(REPO, "model.onnx"))

    def speech_probs(stacked: np.ndarray) -> list[float]:
        feats = ((stacked + means) * varis).astype(np.float32)
        caches = {f"in_cache{i}": np.zeros(CACHE_DIMS, dtype=np.float32) for i in range(4)}
        posteriors = session.run(None, {"speech": feats[None], **caches})[0]
        return [float(p) for p in 1.0 - posteriors[0, :, 0]]

    probs = speech_probs(stack_causal(feat))
    padded_probs = speech_probs(apply_lfr(feat))

    out = os.path.join(HERE, "..", "tests", "fixtures", "fsmnvad.json")
    with open(out, "w") as f:
        json.dump(
            {
                "wav": "hello_en.wav",
                "lfrLead": LFR_LEAD,
                "receptiveFieldFrames": RECEPTIVE_FIELD,
                "probs": probs,
                "paddedProbs": padded_probs,
            },
            f,
            separators=(",", ":"),
        )
        f.write("\n")
    print(f"wrote {out} ({len(probs)} causal, {len(padded_probs)} padded frames)")


def fbank(wav: np.ndarray) -> np.ndarray:
    """80-dim Kaldi fbank with funasr_onnx's WavFrontend options."""
    opts = knf.FbankOptions()
    opts.frame_opts.samp_freq = SAMPLE_RATE
    opts.frame_opts.dither = 0.0
    opts.frame_opts.window_type = "hamming"
    opts.frame_opts.frame_shift_ms = 10.0
    opts.frame_opts.frame_length_ms = 25.0
    opts.frame_opts.snip_edges = True
    opts.mel_opts.num_bins = N_MELS
    opts.mel_opts.debug_mel = False
    opts.energy_floor = 0

    extractor = knf.OnlineFbank(opts)
    extractor.accept_waveform(SAMPLE_RATE, (wav * (1 << 15)).tolist())
    return np.stack([extractor.get_frame(i) for i in range(extractor.num_frames_ready)]).astype(
        np.float32
    )


def stack_causal(feat: np.ndarray) -> np.ndarray:
    """LFR m=5, n=1 without padding: frame k stacks fbank frames k..k+4."""
    return np.concatenate([feat[i : len(feat) - (LFR_M - 1) + i] for i in range(LFR_M)], axis=1)


def apply_lfr(feat: np.ndarray) -> np.ndarray:
    """Transcription of funasr_onnx WavFrontend.apply_lfr for lfr_m=5, lfr_n=1.

    Kept as upstream's frame-at-a-time loop rather than vectorized: this is
    the reference half of a parity fixture, so reading like the original
    matters more than speed on a 2-second clip.
    """
    padded = np.vstack([np.tile(feat[0], (LFR_LEAD, 1)), feat])
    total = len(padded)
    frames = []
    for i in range(len(feat)):
        if LFR_M <= total - i:
            frames.append(padded[i : i + LFR_M].reshape(-1))
        else:
            tail = np.tile(padded[-1], LFR_M - (total - i))
            frames.append(np.concatenate([padded[i:].reshape(-1), tail]))
    return np.stack(frames).astype(np.float32)


def load_cmvn() -> tuple[np.ndarray, np.ndarray]:
    """Means and vars from upstream's Kaldi nnet CMVN file, as funasr reads it."""
    with open(hf_hub_download(REPO, "vad.mvn"), encoding="utf-8") as f:
        lines = f.readlines()
    stats = {}
    for tag, line in itertools.pairwise(lines):
        fields = line.split()
        if tag.startswith(("<AddShift>", "<Rescale>")) and fields[0] == "<LearnRateCoef>":
            stats[tag.split()[0]] = np.array(fields[3:-1], dtype=np.float32)
    return stats["<AddShift>"], stats["<Rescale>"]


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "onnx", "torch", "torchaudio", "huggingface-hub"]
# ///
"""Export a PCM-in FSMN-VAD ONNX by welding a feature frontend onto upstream's graph.

funasr/fsmn-vad-onnx publishes `model.onnx`, which takes LFR+CMVN fbank
features (`speech [1, T, 400]`) and returns per-frame monophone posteriors
(`logits [1, T, 248]`, softmax already in the graph). FunASR computes those
features in Python with kaldi_native_fbank, so a browser consumer would have
to reimplement a Kaldi frontend in TypeScript.

Instead this builds the frontend as an ONNX graph and merges it in front of
upstream's, the way models/fireredvad_stream_vad_e2e.onnx does, producing:

    pcm [1, num_samples] + in_cache0..3 -> probs [1, n, 1] + out_cache0..3

Upstream's encoder graph is merged in unmodified -- only the frontend and the
1 - P(silence) reduction are ours.

The frontend mirrors funasr_onnx.utils.frontend.WavFrontend exactly:
int16 scaling, Kaldi fbank (hamming, 80 mels, 25 ms / 10 ms, dither 0,
snip_edges), LFR m=5 n=1, then CMVN as (x + means) * vars.

Two deliberate departures, both required to make the frontend causal:

1. No LFR left-padding. FunASR prepends (lfr_m - 1) // 2 = 2 copies of the
   first fbank frame so the output frame count matches the input's. A stream
   cannot know the first frame in advance, so output frame k here stacks
   fbank frames k..k+4 -- i.e. FunASR's LFR frame k + 2. vadkit's frame k
   corresponds to FunASR's frame k + 2, and FunASR's two padded edge frames
   have no counterpart.
2. No LFR tail-padding, for the same reason: a partial final stack needs
   frames the stream has not produced yet.

Kaldi's per-frame preprocessing (DC removal, preemphasis, windowing) and the
DFT are all linear, so they fold into a single [514, 400] matrix applied as
one strided Conv -- framing included.

Run: npm run models
"""

import hashlib
import itertools
import os

import numpy as np
import onnx
from huggingface_hub import hf_hub_download
from onnx import TensorProto, helper, numpy_helper
from torchaudio.compliance import kaldi

REPO = "funasr/fsmn-vad-onnx"
SAMPLE_RATE = 16000
FRAME_LENGTH = 400  # 25 ms
FRAME_SHIFT = 160  # 10 ms
N_FFT = 512
N_MELS = 80
N_BINS = N_FFT // 2 + 1
LFR_M = 5  # stacked fbank frames per output frame
PREEMPHASIS = 0.97
LOW_FREQ = 20.0
HIGH_FREQ = 0.0  # 0 means Nyquist
FEATURE_DIM = N_MELS * LFR_M  # 400, the encoder's input_size
LOG_FLOOR = float(np.finfo(np.float32).eps)  # Kaldi's mel floor
INT16_SCALE = 1 << 15
CACHE_DIMS = [1, 128, 19, 1]  # 4 DFSMN caches, lorder - 1 = 19
OPSET = 14
IR_VERSION = 7
INT64_MAX = np.iinfo(np.int64).max

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "models", "fsmn_vad_e2e.onnx")


def main():
    frontend = build_frontend(analysis_kernel(), mel_matrix(), *load_cmvn())
    encoder = onnx.load(hf_hub_download(REPO, "model.onnx"))
    model = onnx.compose.merge_models(
        frontend,
        with_speech_probability(encoder),
        io_map=[("feats", "speech")],
    )
    model.doc_string = f"FSMN-VAD ({REPO}) with a Kaldi fbank + LFR + CMVN frontend in-graph"
    onnx.checker.check_model(model, full_check=True)
    onnx.save(model, OUT)

    with open(OUT, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    print(f"wrote {OUT} ({os.path.getsize(OUT) / 1e6:.2f} MB)")
    print(f"sha256: {digest}")


def analysis_kernel() -> np.ndarray:
    """Conv kernel [2 * N_BINS, 1, FRAME_LENGTH] for framing through the DFT.

    Kaldi processes each frame as DC removal, then preemphasis (with the
    frame's first sample replicated as the predecessor), then windowing. All
    three are linear, as is the DFT, so their composition is one matrix; a
    strided Conv then applies it to every frame at once. The int16 scaling
    FunASR does on the waveform folds in as well.
    """
    dc_removal = np.eye(FRAME_LENGTH) - 1.0 / FRAME_LENGTH

    preemphasis = np.eye(FRAME_LENGTH)
    preemphasis[np.arange(1, FRAME_LENGTH), np.arange(FRAME_LENGTH - 1)] = -PREEMPHASIS
    preemphasis[0, 0] = 1.0 - PREEMPHASIS

    n = np.arange(FRAME_LENGTH)
    window = 0.54 - 0.46 * np.cos(2 * np.pi * n / (FRAME_LENGTH - 1))  # Kaldi hamming
    angle = 2 * np.pi * np.arange(N_BINS)[None, :] * n[:, None] / N_FFT
    dft = window[:, None] * np.concatenate([np.cos(angle), -np.sin(angle)], axis=1)

    kernel = INT16_SCALE * (dc_removal.T @ preemphasis.T @ dft)
    return kernel.T.reshape(2 * N_BINS, 1, FRAME_LENGTH).astype(np.float32)


def mel_matrix() -> np.ndarray:
    """Kaldi triangular mel filterbank [N_BINS, N_MELS], from torchaudio's port."""
    banks, _ = kaldi.get_mel_banks(
        N_MELS, N_FFT, SAMPLE_RATE, LOW_FREQ, HIGH_FREQ, 100.0, -500.0, 1.0
    )
    # get_mel_banks omits the Nyquist bin, which Kaldi never fills.
    return np.pad(banks.numpy(), ((0, 0), (0, 1))).T.astype(np.float32)


def load_cmvn() -> tuple[np.ndarray, np.ndarray]:
    """Means and vars from upstream's Kaldi nnet CMVN file, as funasr reads it."""
    with open(hf_hub_download(REPO, "vad.mvn"), encoding="utf-8") as f:
        lines = f.readlines()
    stats = {}
    for tag, line in itertools.pairwise(lines):
        fields = line.split()
        if tag.startswith(("<AddShift>", "<Rescale>")) and fields[0] == "<LearnRateCoef>":
            stats[tag.split()[0]] = np.array(fields[3:-1], dtype=np.float32)
    means, varis = stats["<AddShift>"], stats["<Rescale>"]
    if means.shape != (FEATURE_DIM,) or varis.shape != (FEATURE_DIM,):
        raise ValueError(f"expected {FEATURE_DIM}-dim CMVN, got {means.shape} and {varis.shape}")
    return means, varis


def build_frontend(kernel, mel, means, varis) -> onnx.ModelProto:
    """pcm [1, num_samples] -> feats [1, n, FEATURE_DIM], matching WavFrontend."""
    frames = "(num_samples - 400) / 160 + 1"
    initializers = [
        numpy_helper.from_array(kernel, "analysis_kernel"),
        numpy_helper.from_array(mel, "mel_matrix"),
        numpy_helper.from_array(means.reshape(1, 1, FEATURE_DIM), "cmvn_means"),
        numpy_helper.from_array(varis.reshape(1, 1, FEATURE_DIM), "cmvn_vars"),
        numpy_helper.from_array(np.array([LOG_FLOOR], dtype=np.float32), "log_floor"),
        numpy_helper.from_array(np.array([1, 1, -1], dtype=np.int64), "pcm_shape"),
        numpy_helper.from_array(np.array([1], dtype=np.int64), "time_axis"),
    ]
    nodes = [
        helper.make_node("Reshape", ["pcm", "pcm_shape"], ["pcm_nchw"]),
        # Framing, DC removal, preemphasis, windowing and the DFT in one op.
        helper.make_node(
            "Conv", ["pcm_nchw", "analysis_kernel"], ["spectrum"], strides=[FRAME_SHIFT]
        ),
        helper.make_node("Mul", ["spectrum", "spectrum"], ["spectrum_squared"]),
        helper.make_node("Split", ["spectrum_squared"], ["real_squared", "imag_squared"], axis=1),
        helper.make_node("Add", ["real_squared", "imag_squared"], ["power"]),
        helper.make_node("Transpose", ["power"], ["power_nlc"], perm=[0, 2, 1]),
        helper.make_node("MatMul", ["power_nlc", "mel_matrix"], ["mel_energy"]),
        helper.make_node("Clip", ["mel_energy", "log_floor"], ["mel_floored"]),
        helper.make_node("Log", ["mel_floored"], ["fbank"]),
    ]
    # LFR m=5, n=1 without padding: output frame k stacks fbank frames k..k+4.
    for i in range(LFR_M):
        end = i - (LFR_M - 1) if i < LFR_M - 1 else INT64_MAX
        initializers += [
            numpy_helper.from_array(np.array([i], dtype=np.int64), f"lfr_start{i}"),
            numpy_helper.from_array(np.array([end], dtype=np.int64), f"lfr_end{i}"),
        ]
        nodes.append(
            helper.make_node(
                "Slice",
                ["fbank", f"lfr_start{i}", f"lfr_end{i}", "time_axis"],
                [f"lfr_slice{i}"],
            )
        )
    nodes += [
        helper.make_node("Concat", [f"lfr_slice{i}" for i in range(LFR_M)], ["stacked"], axis=2),
        helper.make_node("Add", ["stacked", "cmvn_means"], ["shifted"]),
        helper.make_node("Mul", ["shifted", "cmvn_vars"], ["feats"]),
    ]
    graph = helper.make_graph(
        nodes,
        "fsmn_vad_frontend",
        [helper.make_tensor_value_info("pcm", TensorProto.FLOAT, [1, "num_samples"])],
        [
            helper.make_tensor_value_info(
                "feats", TensorProto.FLOAT, [1, f"{frames} - 4", FEATURE_DIM]
            )
        ],
        initializer=initializers,
    )
    model = helper.make_model(
        graph, opset_imports=[helper.make_opsetid("", OPSET)], ir_version=IR_VERSION
    )
    onnx.checker.check_model(model, full_check=True)
    return model


def with_speech_probability(encoder: onnx.ModelProto) -> onnx.ModelProto:
    """Replace the 248-way `logits` output with probs = 1 - P(silence).

    FunASR reads speech probability off the posteriors as one minus the
    silence pdfs (vad.yaml: silence_pdf_num 1, sil_pdf_ids [0]). Doing it in
    the graph keeps the provider's output the scalar-per-frame shape the
    other vadkit ONNX providers return.
    """
    graph = encoder.graph
    graph.initializer.extend(
        [
            numpy_helper.from_array(np.array([0], dtype=np.int64), "sil_pdf_start"),
            numpy_helper.from_array(np.array([1], dtype=np.int64), "sil_pdf_end"),
            numpy_helper.from_array(np.array([2], dtype=np.int64), "sil_pdf_axis"),
            numpy_helper.from_array(np.array(1.0, dtype=np.float32), "one"),
        ]
    )
    graph.node.extend(
        [
            helper.make_node(
                "Slice",
                ["logits", "sil_pdf_start", "sil_pdf_end", "sil_pdf_axis"],
                ["silence_prob"],
            ),
            helper.make_node("Sub", ["one", "silence_prob"], ["probs"]),
        ]
    )
    logits = next(o for o in graph.output if o.name == "logits")
    graph.output.remove(logits)
    graph.output.insert(0, helper.make_tensor_value_info("probs", TensorProto.FLOAT, [1, "n", 1]))
    return encoder


if __name__ == "__main__":
    main()

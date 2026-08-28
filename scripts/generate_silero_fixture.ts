// Golden per-window probabilities for the Silero VAD provider.
//
// Reference: the silero_vad.onnx v5.1.2 model driven with onnxruntime-node
// exactly as the silero-vad package's OnnxWrapper does — 512-sample windows
// with the previous window's last 64 samples prepended as context, LSTM
// state threaded between calls. Wrapper semantics transcribed from:
// https://github.com/snakers4/silero-vad/blob/v5.1.2/src/silero_vad/utils_vad.py
// (class OnnxWrapper). Deliberately independent of src/providers/silero.ts
// so the fixture does not share the provider's implementation.
//
// Run: npm run fixtures

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-node";

import { readWav16kMono } from "../tests/wav.ts";

const WINDOW = 512;
const CONTEXT = 64;

const HERE = path.dirname(fileURLToPath(import.meta.url));

const wavBuf = readFileSync(path.join(HERE, "..", "tests", "assets", "hello_en.wav"));
const pcm = readWav16kMono(
  wavBuf.buffer.slice(wavBuf.byteOffset, wavBuf.byteOffset + wavBuf.byteLength),
);

const session = await ort.InferenceSession.create(
  path.join(HERE, "..", "models", "silero_vad.onnx"),
);
const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
let state: ort.Tensor = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
let context = new Float32Array(CONTEXT);

const probs: number[] = [];
for (let i = 0; i + WINDOW <= pcm.length; i += WINDOW) {
  const window = pcm.subarray(i, i + WINDOW);
  const input = new Float32Array(CONTEXT + WINDOW);
  input.set(context);
  input.set(window, CONTEXT);
  const outputs = await session.run({
    input: new ort.Tensor("float32", input, [1, input.length]),
    state,
    sr,
  });
  const output = outputs.output;
  const stateN = outputs.stateN;
  if (output === undefined || stateN === undefined) {
    throw new Error("model did not return output and stateN");
  }
  state = stateN;
  context = window.slice(WINDOW - CONTEXT);
  probs.push((output.data as Float32Array)[0] ?? NaN);
}

const out = path.join(HERE, "..", "tests", "fixtures", "silero.json");
writeFileSync(out, JSON.stringify({ wav: "hello_en.wav", windowSamples: WINDOW, probs }) + "\n");
console.log(`wrote ${out} (${String(probs.length)} windows)`);

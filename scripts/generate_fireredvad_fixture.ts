// Golden per-frame probabilities for the FireRedVAD provider.
//
// Reference: the fireredvad_stream_vad_e2e.onnx model run with
// onnxruntime-node (the same native ONNX Runtime core as Python
// onnxruntime) over the full utterance with zero initial caches. The
// model's own parity with the FireRedVAD Python pipeline is established in
// that repo's tests; this fixture pins the TypeScript glue (framing, cache
// threading) against an independent runtime.
//
// Run: npm run fixtures

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-node";

import { readWav16kMono } from "../tests/wav.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const wavBuf = readFileSync(path.join(HERE, "..", "tests", "assets", "hello_en.wav"));
const pcm = readWav16kMono(
  wavBuf.buffer.slice(wavBuf.byteOffset, wavBuf.byteOffset + wavBuf.byteLength),
);

const session = await ort.InferenceSession.create(
  path.join(HERE, "..", "models", "fireredvad_stream_vad_e2e.onnx"),
);
const outputs = await session.run({
  pcm: new ort.Tensor("float32", pcm, [1, pcm.length]),
  caches_packed: new ort.Tensor("float32", new Float32Array(1024 * 19), [1, 1024, 19]),
});
const probs = outputs.probs;
if (probs === undefined) throw new Error("model did not return probs");

const out = path.join(HERE, "..", "tests", "fixtures", "fireredvad.json");
writeFileSync(
  out,
  JSON.stringify({ wav: "hello_en.wav", probs: Array.from(probs.data as Float32Array) }) + "\n",
);
console.log(`wrote ${out} (${String(probs.dims[1])} frames)`);

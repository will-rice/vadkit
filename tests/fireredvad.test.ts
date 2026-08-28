import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { createVad } from "../src/index.js";
import { fireRedVad } from "../src/providers/fireredvad.js";
import { readWav16kMono } from "./wav.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadPcm(): Float32Array {
  const buf = readFileSync(path.join(HERE, "assets", "hello_en.wav"));
  return readWav16kMono(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function loadModel(): Uint8Array {
  return readFileSync(path.join(HERE, "..", "models", "fireredvad_stream_vad_e2e.onnx"));
}

test("matches the FireRedVAD Python pipeline frame by frame", async () => {
  const fixture = JSON.parse(
    readFileSync(path.join(HERE, "fixtures", "fireredvad.json"), "utf-8"),
  ) as { wav: string; probs: number[] };
  const vad = await createVad(fireRedVad({ model: loadModel() }));

  const pcm = loadPcm();
  const frames = [];
  for (let i = 0; i < pcm.length; i += 512) {
    frames.push(...(await vad.processChunk(pcm.subarray(i, i + 512))));
  }
  expect(frames.length).toBe(fixture.probs.length);
  for (let i = 0; i < frames.length; i++) {
    const expected = fixture.probs[i] ?? NaN;
    // ort-web vs Python onnxruntime on the same graph: kernel noise only.
    expect(Math.abs((frames[i]?.probability ?? NaN) - expected), `frame ${i}`).toBeLessThanOrEqual(
      1e-5 + 1e-3 * Math.abs(expected),
    );
  }
});

test("detects the utterance with default options", async () => {
  const starts: number[] = [];
  const ends: number[] = [];
  const vad = await createVad(fireRedVad({ model: loadModel() }), {
    speechThreshold: 0.4,
    onSpeechStart: (t) => starts.push(t),
    onSpeechEnd: (u) => ends.push(u.endTime),
  });
  await vad.processChunk(loadPcm());
  // Python pipeline reference for this clip: speech ~0.28-1.83 s.
  expect(starts).toHaveLength(1);
  expect(starts[0]).toBeGreaterThanOrEqual(0.1);
  expect(starts[0]).toBeLessThanOrEqual(0.45);
  expect(ends.length).toBeLessThanOrEqual(1); // trailing speech may not have ended
});

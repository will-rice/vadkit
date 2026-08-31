import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { createVad } from "../src/index.js";
import { sileroVad } from "../src/providers/silero.js";
import { readWav16kMono } from "./wav.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("matches the silero-vad package frame by frame", async () => {
  const fixture = JSON.parse(readFileSync(path.join(HERE, "fixtures", "silero.json"), "utf-8")) as {
    wav: string;
    windowSamples: number;
    probs: number[];
  };
  const model = readFileSync(path.join(HERE, "..", "models", "silero_vad.onnx"));
  const vad = await createVad(sileroVad({ model }));

  const buf = readFileSync(path.join(HERE, "assets", "hello_en.wav"));
  const pcm = readWav16kMono(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  const frames = [];
  for (let i = 0; i < pcm.length; i += 700) {
    // deliberately not a multiple of 512
    frames.push(...(await vad.processChunk(pcm.subarray(i, i + 700))));
  }
  expect(frames.length).toBe(fixture.probs.length);
  for (let i = 0; i < frames.length; i++) {
    const expected = fixture.probs[i] ?? NaN;
    expect(Math.abs((frames[i]?.probability ?? NaN) - expected), `window ${i}`).toBeLessThanOrEqual(
      1e-4 + 1e-3 * Math.abs(expected),
    );
  }
});

test("dispose releases the ONNX session", async () => {
  const model = readFileSync(path.join(HERE, "..", "models", "silero_vad.onnx"));
  const vad = await createVad(sileroVad({ model }));
  await vad.processChunk(new Float32Array(1024));
  await vad.dispose();
});

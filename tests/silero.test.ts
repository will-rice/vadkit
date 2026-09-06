import { expect, test } from "vite-plus/test";

import { createVad } from "#index.ts";
import { sileroVad } from "#providers/silero.ts";

import { loadFixture, loadModel, loadPcm } from "./helpers.ts";

test("matches the silero-vad package frame by frame", async () => {
  const fixture = (await loadFixture("silero.json")) as {
    wav: string;
    windowSamples: number;
    probs: number[];
  };
  const vad = await createVad(sileroVad({ model: await loadModel("silero_vad.onnx") }));
  const pcm = await loadPcm();

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
  const vad = await createVad(sileroVad({ model: await loadModel("silero_vad.onnx") }));
  await vad.processChunk(new Float32Array(1024));
  await vad.dispose();
});

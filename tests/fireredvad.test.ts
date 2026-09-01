import { expect, test } from "vite-plus/test";

import { createVad } from "#index.ts";
import { fireRedVad } from "#providers/fireredvad.ts";

import { loadFixture, loadPcm, loadModel } from "./helpers.ts";

test("matches the FireRedVAD Python pipeline frame by frame", async () => {
  const fixture = loadFixture("fireredvad.json") as { wav: string; probs: number[] };
  const vad = await createVad(fireRedVad({ model: loadModel("fireredvad_stream_vad_e2e.onnx") }));

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
  const vad = await createVad(fireRedVad({ model: loadModel("fireredvad_stream_vad_e2e.onnx") }), {
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

import { expect, test } from "vite-plus/test";

import { createVad } from "../src/index.js";
import type { VadProvider } from "../src/types.js";

/** Deterministic fake: probability = mean(|samples|) of each frame's window. */
function fakeProvider(windowSamples = 400, hopSamples = 160): VadProvider {
  return {
    windowSamples,
    hopSamples,
    frameSec: hopSamples / 16000,
    process(samples: Float32Array): Promise<Float32Array> {
      const n = Math.floor((samples.length - windowSamples) / hopSamples) + 1;
      const probs = new Float32Array(n);
      for (let t = 0; t < n; t++) {
        const window = samples.subarray(t * hopSamples, t * hopSamples + windowSamples);
        let sum = 0;
        for (const v of window) sum += Math.abs(v);
        probs[t] = Math.min(1, sum / windowSamples);
      }
      return Promise.resolve(probs);
    },
    reset(): void {
      // stateless
    },
    dispose(): Promise<void> {
      return Promise.resolve();
    },
  };
}

const OPTS = {
  smoothWindowSec: 0.01,
  riseDelaySec: 0.03,
  fallDelaySec: 0.05,
  prePadSec: 0,
  speechThreshold: 0.5,
};

test("frames and events flow from chunks of arbitrary size", async () => {
  const starts: number[] = [];
  const ends: number[] = [];
  const vad = await createVad(() => Promise.resolve(fakeProvider()), {
    ...OPTS,
    onSpeechStart: (t) => starts.push(t),
    onSpeechEnd: (u) => ends.push(u.endTime),
  });
  // 0.5 s silence, 0.5 s "speech" (amplitude 0.9), 0.5 s silence, in 313-sample chunks.
  const pcm = new Float32Array(24000);
  pcm.fill(0.9, 8000, 16000);
  const frames = [];
  for (let i = 0; i < pcm.length; i += 313) {
    frames.push(...(await vad.processChunk(pcm.subarray(i, i + 313))));
  }
  expect(frames.length).toBe(Math.floor((24000 - 400) / 160) + 1);
  // Frame windows overlap the filled region before/after its edges, so allow
  // one window (25 ms) of slack around the 0.5 s and 1.0 s boundaries.
  expect(starts).toHaveLength(1);
  expect(starts[0]).toBeGreaterThanOrEqual(0.45);
  expect(starts[0]).toBeLessThanOrEqual(0.55);
  expect(ends).toHaveLength(1);
  expect(ends[0]).toBeGreaterThanOrEqual(0.95);
  expect(ends[0]).toBeLessThanOrEqual(1.05);
});

test("un-awaited overlapping calls equal sequential results", async () => {
  const mk = () => createVad(() => Promise.resolve(fakeProvider()), OPTS);
  const pcm = new Float32Array(8000).map(() => Math.random());
  const chunks = [];
  for (let i = 0; i < pcm.length; i += 313) chunks.push(pcm.subarray(i, i + 313));

  const seqVad = await mk();
  const sequential = [];
  for (const c of chunks) sequential.push(...(await seqVad.processChunk(c)));

  const parVad = await mk();
  const overlapping = (await Promise.all(chunks.map((c) => parVad.processChunk(c)))).flat();
  expect(overlapping).toEqual(sequential);
});

test("reset is ordered behind in-flight calls and restarts frame indexing", async () => {
  const vad = await createVad(() => Promise.resolve(fakeProvider()), OPTS);
  const first = await vad.processChunk(new Float32Array(1000));
  await vad.reset();
  const second = await vad.processChunk(new Float32Array(1000));
  expect(second.map((f) => f.index)).toEqual(first.map((f) => f.index));
});

import { expect, test } from "vitest";

import { createVad } from "../src/index.js";
import type { AudioSource, Utterance } from "../src/index.js";
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
  };
}

function fakeSource(pcm: Float32Array, sampleRate: number, chunkSize: number): AudioSource {
  return {
    start(onChunk): Promise<void> {
      for (let i = 0; i < pcm.length; i += chunkSize) {
        onChunk(pcm.subarray(i, i + chunkSize), sampleRate);
      }
      return Promise.resolve();
    },
    stop(): Promise<void> {
      return Promise.resolve();
    },
  };
}

const OPTS = {
  smoothWindowSec: 0.01,
  riseDelaySec: 0.03,
  fallDelaySec: 0.05,
  prePadSec: 0.02,
  speechThreshold: 0.5,
};

// 0.5 s silence, 0.5 s "speech" (amplitude 0.9), 0.5 s silence.
function speechPcm(): Float32Array {
  const pcm = new Float32Array(24000);
  pcm.fill(0.9, 8000, 16000);
  return pcm;
}

test("onSpeechEnd delivers the exact utterance audio", async () => {
  const utterances: Utterance[] = [];
  const vad = await createVad(() => Promise.resolve(fakeProvider()), {
    ...OPTS,
    onSpeechEnd: (u) => utterances.push(u),
  });
  const pcm = speechPcm();
  for (let i = 0; i < pcm.length; i += 313) {
    await vad.processChunk(pcm.subarray(i, i + 313));
  }
  expect(utterances).toHaveLength(1);
  const u = utterances[0];
  expect(u).toBeDefined();
  if (u === undefined) return;
  expect(u.endTime).toBeGreaterThan(u.startTime);
  const startSample = Math.round(u.startTime * 16000);
  const endSample = Math.round(u.endTime * 16000);
  expect(u.audio.length).toBe(endSample - startSample);
  expect(u.audio).toEqual(pcm.slice(startSample, endSample));
  // The pre-pad reaches back before the amplitude step at 0.5 s.
  expect(u.startTime).toBeLessThan(0.5);
  expect(u.endTime).toBeGreaterThan(0.95);
});

test("start(source) drives the session and stop() ends it", async () => {
  const utterances: Utterance[] = [];
  const vad = await createVad(() => Promise.resolve(fakeProvider()), {
    ...OPTS,
    onSpeechEnd: (u) => utterances.push(u),
  });
  await vad.start(fakeSource(speechPcm(), 16000, 512));
  await vad.processChunk(new Float32Array(0)); // barrier: drain the serialized queue
  await vad.stop();
  expect(utterances).toHaveLength(1);
});

test("a 32 kHz source is resampled and yields the same events", async () => {
  const starts: number[] = [];
  const vad = await createVad(() => Promise.resolve(fakeProvider()), {
    ...OPTS,
    onSpeechStart: (t) => starts.push(t),
  });
  // Same signal at 32 kHz: every sample doubled in time.
  const pcm32 = new Float32Array(48000);
  pcm32.fill(0.9, 16000, 32000);
  await vad.start(fakeSource(pcm32, 32000, 1024));
  await vad.processChunk(new Float32Array(0));
  expect(starts).toHaveLength(1);
  const start = starts[0] ?? NaN;
  expect(start).toBeGreaterThanOrEqual(0.4);
  expect(start).toBeLessThanOrEqual(0.6);
});

test("start twice throws", async () => {
  const vad = await createVad(() => Promise.resolve(fakeProvider()), OPTS);
  await vad.start(fakeSource(new Float32Array(1000), 16000, 500));
  await expect(vad.start(fakeSource(new Float32Array(1000), 16000, 500))).rejects.toThrow(
    /already started/,
  );
});

import { expect, test } from "vite-plus/test";

import { createVad } from "../src/index.js";
import type { AudioSource, Utterance, VadOptions, VadSessionCallbacks } from "../src/index.js";
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

test("a single chunk far larger than the ring still delivers correct utterances", async () => {
  const utterances: Utterance[] = [];
  const vad = await createVad(() => Promise.resolve(fakeProvider()), {
    ...OPTS,
    onSpeechEnd: (u) => utterances.push(u),
  });
  // 40 s in one call, speech at 1.0-1.5 s: the ring (~31 s) evicts that
  // region long before the call returns unless writes are bounded.
  const pcm = new Float32Array(40 * 16000);
  pcm.fill(0.9, 16000, 24000);
  await vad.processChunk(pcm);
  expect(utterances).toHaveLength(1);
  const u = utterances[0];
  if (u === undefined) return;
  const startSample = Math.round(u.startTime * 16000);
  const endSample = Math.round(u.endTime * 16000);
  expect(u.audio).toEqual(pcm.slice(startSample, endSample));
});

test("a failed start clears the source so the session can start again", async () => {
  const vad = await createVad(() => Promise.resolve(fakeProvider()), OPTS);
  const failing: AudioSource = {
    start: () => Promise.reject(new Error("denied")),
    stop: () => Promise.resolve(),
  };
  await expect(vad.start(failing)).rejects.toThrow("denied");
  await vad.start(fakeSource(speechPcm(), 16000, 512)); // must not throw
  await vad.stop();
});

test("explicitly-undefined options do not clobber defaults", async () => {
  const starts: number[] = [];
  // Simulate a plain-JS caller, for whom exactOptionalPropertyTypes does
  // not exist and undefined values reach the merge at runtime.
  const jsCallerOptions = {
    ...OPTS,
    speechThreshold: undefined,
    maxSpeechSec: undefined,
    onSpeechStart: (t: number) => starts.push(t),
  } as unknown as Partial<VadOptions> & VadSessionCallbacks;
  const vad = await createVad(() => Promise.resolve(fakeProvider()), jsCallerOptions);
  await vad.processChunk(speechPcm());
  expect(starts).toHaveLength(1); // default threshold 0.5 applies
});

test("non-finite options are rejected with a concise error", async () => {
  await expect(
    createVad(() => Promise.resolve(fakeProvider()), { maxSpeechSec: Infinity }),
  ).rejects.toThrow(/maxSpeechSec must be a finite/);
});

test("a provider probability outside [0, 1] rejects instead of poisoning the stream", async () => {
  const provider = fakeProvider();
  const broken: VadProvider = {
    ...provider,
    process: () => Promise.resolve(Float32Array.from([0.5, NaN, 0.5])),
  };
  const vad = await createVad(() => Promise.resolve(broken), OPTS);
  await expect(vad.processChunk(new Float32Array(1000))).rejects.toThrow(/outside \[0, 1\]/);
});

test("flush() delivers an utterance still open and returns it", async () => {
  const utterances: Utterance[] = [];
  const vad = await createVad(() => Promise.resolve(fakeProvider()), {
    ...OPTS,
    onSpeechEnd: (u) => utterances.push(u),
  });
  // 0.5 s silence then speech running to the end of the audio: no trailing
  // silence, so only a flush can close the segment.
  const pcm = new Float32Array(16000);
  pcm.fill(0.9, 8000);
  await vad.processChunk(pcm);
  expect(utterances).toHaveLength(0);
  const flushed = await vad.flush();
  expect(utterances).toHaveLength(1);
  expect(flushed).toBe(utterances[0]);
  const u = utterances[0];
  if (u === undefined) return;
  expect(u.sampleRate).toBe(16000);
  expect(u.startTime).toBeLessThan(0.55);
  expect(u.endTime).toBeGreaterThan(0.95);
  expect(u.audio).toEqual(
    pcm.slice(Math.round(u.startTime * 16000), Math.round(u.endTime * 16000)),
  );
  // Nothing left open: a second flush is a no-op.
  expect(await vad.flush()).toBeNull();
});

test("stop() flushes the open utterance captured from a source", async () => {
  const utterances: Utterance[] = [];
  const vad = await createVad(() => Promise.resolve(fakeProvider()), {
    ...OPTS,
    onSpeechEnd: (u) => utterances.push(u),
  });
  const pcm = new Float32Array(16000);
  pcm.fill(0.9, 8000);
  await vad.start(fakeSource(pcm, 16000, 512));
  await vad.processChunk(new Float32Array(0)); // barrier: drain the serialized queue
  expect(utterances).toHaveLength(0);
  await vad.stop();
  expect(utterances).toHaveLength(1);
});

test("dispose() flushes, then releases the provider", async () => {
  let disposed = false;
  const provider = fakeProvider();
  const tracked: VadProvider = {
    ...provider,
    dispose(): Promise<void> {
      disposed = true;
      return Promise.resolve();
    },
  };
  const utterances: Utterance[] = [];
  const vad = await createVad(() => Promise.resolve(tracked), {
    ...OPTS,
    onSpeechEnd: (u) => utterances.push(u),
  });
  const pcm = new Float32Array(16000);
  pcm.fill(0.9, 8000);
  await vad.processChunk(pcm);
  await vad.dispose();
  expect(disposed).toBe(true);
  expect(utterances).toHaveLength(1);
});

test("reset between un-awaited chunks restarts cleanly", async () => {
  const vad = await createVad(() => Promise.resolve(fakeProvider()), OPTS);
  const p1 = vad.processChunk(speechPcm());
  const resetDone = vad.reset();
  const p2 = vad.processChunk(speechPcm());
  const [first, , second] = await Promise.all([p1, resetDone, p2]);
  expect(second.map((f) => f.index)).toEqual(first.map((f) => f.index));
});

# vadkit Session Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The batteries-included session layer — microphone capture, an audio ring buffer, and the utterance's raw audio delivered on `onSpeechEnd` — plus a side-by-side FireRed/Silero demo.

**Architecture:** `VadStream` becomes a pure engine (frames in, frames+events out; its callbacks move up a layer). A new `VadSession` wraps it with an absolute-indexed `AudioRingBuffer`, callback dispatch, resampling, and `start(source)`/`stop()` over a minimal `AudioSource` interface. `micSource()` implements `AudioSource` with getUserMedia + an AudioWorklet whose code ships as an inline blob URL (no asset-shipping problem). `createVad` now returns a `VadSession`.

**Tech Stack:** Same as core (TypeScript strict/NodeNext, vitest, onnxruntime-web under Node for tests); vite for the demo.

**Spec:** `docs/superpowers/specs/2026-08-28-vadkit-design.md`

## Global Constraints

- Conventional commit subjects; husky hooks run prettier/eslint/typecheck/commitlint automatically.
- `erasableSyntaxOnly`: no enums, no constructor parameter properties.
- `isolatedDeclarations` (build tsconfig): explicit return types on every export in `src/`.
- `noUncheckedIndexedAccess`: narrow indexed reads with explicit `undefined` checks (never `!`, never `as`).
- `exactOptionalPropertyTypes`: optional callback properties are typed `| undefined`.
- Explicit `.js` extensions in relative imports in `src/`; `.ts` extensions in `scripts/` and demo.
- `npm install` one package at a time (npm 10.9.4 arborist crash).
- Spec deviations locked in here: `AudioSource.start(onChunk)` passes `(pcm, sampleRate)` per chunk instead of exposing a `sampleRate` property (a mic's true rate is unknown until its AudioContext exists), and the utterance payload is `{ audio, startTime, endTime }` (not the spec sketch's `{ audio, start, end }`) for consistency with `VadEvent.startTime`.

---

### Task 1: AudioRingBuffer

**Files:**
- Create: `src/engine/ringBuffer.ts`
- Test: `tests/ringBuffer.test.ts`

**Interfaces:**
- Produces:
```ts
export class AudioRingBuffer {
  constructor(capacity: number);
  readonly capacity: number;
  get totalWritten(): number;           // absolute sample count ever written
  write(pcm: Float32Array): void;
  slice(startSample: number, endSample: number): Float32Array; // absolute indices; throws if evicted/out of range
  reset(): void;
}
```

- [ ] **Step 1: Write the failing test**

`tests/ringBuffer.test.ts`:
```ts
import { expect, test } from "vitest";

import { AudioRingBuffer } from "../src/engine/ringBuffer.js";

function ramp(start: number, length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => start + i);
}

test("slices across the wrap boundary by absolute index", () => {
  const ring = new AudioRingBuffer(8);
  ring.write(ramp(0, 6)); // samples 0-5
  ring.write(ramp(6, 6)); // samples 6-11; 0-3 evicted
  expect(ring.totalWritten).toBe(12);
  expect(Array.from(ring.slice(4, 12))).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  expect(Array.from(ring.slice(6, 9))).toEqual([6, 7, 8]);
});

test("a write larger than capacity keeps only the newest samples", () => {
  const ring = new AudioRingBuffer(4);
  ring.write(ramp(0, 10)); // only samples 6-9 retained; totalWritten counts all 10
  expect(ring.totalWritten).toBe(10);
  expect(Array.from(ring.slice(6, 10))).toEqual([6, 7, 8, 9]);
});

test("throws on evicted or out-of-range slices", () => {
  const ring = new AudioRingBuffer(4);
  ring.write(ramp(0, 8)); // samples 4-7 retained
  expect(() => ring.slice(3, 6)).toThrow(/evicted/);
  expect(() => ring.slice(6, 9)).toThrow(/beyond/);
  expect(() => ring.slice(6, 5)).toThrow(/after/);
});

test("reset restarts absolute indexing", () => {
  const ring = new AudioRingBuffer(4);
  ring.write(ramp(0, 3));
  ring.reset();
  expect(ring.totalWritten).toBe(0);
  ring.write(ramp(9, 2));
  expect(Array.from(ring.slice(0, 2))).toEqual([9, 10]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ringBuffer.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/engine/ringBuffer.ts`:
```ts
/** Fixed-capacity ring of the most recent samples, addressed by absolute index. */
export class AudioRingBuffer {
  readonly capacity: number;
  private readonly data: Float32Array;
  private written = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity);
  }

  get totalWritten(): number {
    return this.written;
  }

  write(pcm: Float32Array): void {
    let start = 0;
    if (pcm.length > this.capacity) {
      // Older samples in this write would be overwritten immediately.
      start = pcm.length - this.capacity;
      this.written += start;
    }
    for (let i = start; i < pcm.length; ) {
      const pos = this.written % this.capacity;
      const n = Math.min(pcm.length - i, this.capacity - pos);
      this.data.set(pcm.subarray(i, i + n), pos);
      i += n;
      this.written += n;
    }
  }

  /** Copy samples [startSample, endSample) out of the ring. */
  slice(startSample: number, endSample: number): Float32Array {
    const oldest = Math.max(0, this.written - this.capacity);
    if (startSample < oldest) {
      throw new Error(`sample ${String(startSample)} evicted (oldest is ${String(oldest)})`);
    }
    if (endSample > this.written) {
      throw new Error(`sample ${String(endSample)} beyond written ${String(this.written)}`);
    }
    if (startSample > endSample) {
      throw new Error("slice start after end");
    }
    const out = new Float32Array(endSample - startSample);
    for (let i = startSample; i < endSample; ) {
      const pos = i % this.capacity;
      const n = Math.min(endSample - i, this.capacity - pos);
      out.set(this.data.subarray(pos, pos + n), i - startSample);
      i += n;
    }
    return out;
  }

  reset(): void {
    this.written = 0;
  }
}
```

- [ ] **Step 4: Run tests, verify pass, commit**

Run: `npx vitest run tests/ringBuffer.test.ts` → PASS
```bash
git add -A && git commit -m "feat: add absolute-indexed audio ring buffer"
```

---

### Task 2: VadSession + engine purification

**Files:**
- Create: `src/engine/session.ts`
- Modify: `src/engine/vadStream.ts` (remove callbacks; engine returns frames only)
- Modify: `src/index.ts` (export session types; `createVad` moves to session.ts)
- Modify: `tests/vadStream.test.ts`, `tests/fireredvad.test.ts`, `tests/crossProvider.test.ts` (callback payload `e.time` → `e.endTime`; utterance audio assertions)
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: `VadStream` (Task 5 of core plan), `AudioRingBuffer` (Task 1), `LinearResampler`, `Segmenter` types, `SAMPLE_RATE`.
- Produces:
```ts
export interface AudioSource {
  start(onChunk: (pcm: Float32Array, sampleRate: number) => void): Promise<void>;
  stop(): Promise<void>;
}
export interface Utterance { audio: Float32Array; startTime: number; endTime: number }
export interface VadSessionCallbacks {
  onFrame?: ((frame: VadFrame) => void) | undefined;
  onSpeechStart?: ((time: number) => void) | undefined;
  onSpeechEnd?: ((utterance: Utterance) => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
}
export class VadSession {
  readonly stream: VadStream;
  processChunk(pcm: Float32Array): Promise<VadFrame[]>; // serialized; 16 kHz input
  start(source: AudioSource): Promise<void>;            // resamples if needed
  stop(): Promise<void>;
  reset(): void;
}
export function createVad(
  factory: ProviderFactory,
  options?: Partial<VadOptions> & VadSessionCallbacks,
): Promise<VadSession>;
```
- `VadStream` loses `VadCallbacks` entirely: `constructor(provider, options)`, `processChunk` returns frames, `reset()` unchanged. `createVad` moves out of vadStream.ts.

- [ ] **Step 1: Write the failing session test**

`tests/session.test.ts`:
```ts
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
  minSpeechSec: 0.03,
  minSilenceSec: 0.05,
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/session.test.ts` → FAIL (exports missing).

- [ ] **Step 3: Purify VadStream**

In `src/engine/vadStream.ts`: delete the `VadCallbacks` interface, the `callbacks` field/constructor parameter, the callback dispatch inside `processContiguous` (keep frame collection), and the `createVad` function. Resulting public surface:

```ts
export class VadStream {
  readonly provider: VadProvider;
  readonly options: VadOptions;
  private readonly buffer: ChunkBuffer;
  private readonly segmenter: Segmenter;
  private pending: Promise<void> = Promise.resolve();

  constructor(provider: VadProvider, options: VadOptions) { ... }
  processChunk(pcm: Float32Array): Promise<VadFrame[]> { ... }  // unchanged
  reset(): void { ... }                                          // unchanged
  private async processContiguous(pcm: Float32Array): Promise<VadFrame[]> {
    const run = this.buffer.push(pcm);
    if (run === null) return [];
    const probs = await this.provider.process(run);
    const frames: VadFrame[] = [];
    for (const p of probs) frames.push(this.segmenter.process(p));
    return frames;
  }
}
```

- [ ] **Step 4: Implement VadSession and createVad**

`src/engine/session.ts`:
```ts
import { SAMPLE_RATE } from "../types.js";
import type { ProviderFactory } from "../types.js";
import { LinearResampler } from "./resampler.js";
import { AudioRingBuffer } from "./ringBuffer.js";
import { DEFAULT_VAD_OPTIONS } from "./segmenter.js";
import type { VadFrame, VadOptions } from "./segmenter.js";
import { VadStream } from "./vadStream.js";

/** A push source of PCM chunks (e.g. a microphone). */
export interface AudioSource {
  /** Begin delivering chunks; resolves once capture is running. */
  start(onChunk: (pcm: Float32Array, sampleRate: number) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface Utterance {
  audio: Float32Array;
  startTime: number;
  endTime: number;
}

export interface VadSessionCallbacks {
  onFrame?: ((frame: VadFrame) => void) | undefined;
  onSpeechStart?: ((time: number) => void) | undefined;
  onSpeechEnd?: ((utterance: Utterance) => void) | undefined;
  /** Receives failures from source-driven processing; unhandled otherwise. */
  onError?: ((error: unknown) => void) | undefined;
}

/** Batteries-included streaming VAD: engine + audio retention + events. */
export class VadSession {
  readonly stream: VadStream;
  private readonly callbacks: VadSessionCallbacks;
  private readonly ring: AudioRingBuffer;
  private resampler: LinearResampler | null = null;
  private source: AudioSource | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(stream: VadStream, callbacks: VadSessionCallbacks) {
    this.stream = stream;
    this.callbacks = callbacks;
    const o = stream.options;
    this.ring = new AudioRingBuffer(
      Math.ceil((o.maxSpeechSec + o.prePadSec + o.minSilenceSec + 1) * SAMPLE_RATE),
    );
  }

  /**
   * Feed 16 kHz PCM of any length; returns one VadFrame per completed frame.
   * Calls are serialized internally, like VadStream.processChunk.
   */
  processChunk(pcm: Float32Array): Promise<VadFrame[]> {
    const result = this.pending.then(() => this.processContiguous(pcm));
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Capture from a source until stop(); chunks are resampled if needed. */
  async start(source: AudioSource): Promise<void> {
    if (this.source !== null) throw new Error("session already started");
    this.source = source;
    await source.start((pcm, sampleRate) => {
      const chunk = sampleRate === SAMPLE_RATE ? pcm : this.resample(pcm, sampleRate);
      const result = this.processChunk(chunk);
      const onError = this.callbacks.onError;
      if (onError) {
        result.catch(onError);
      } else {
        void result;
      }
    });
  }

  async stop(): Promise<void> {
    await this.source?.stop();
    this.source = null;
  }

  /** Start a new utterance stream. Ordered behind in-flight processing. */
  reset(): void {
    this.stream.reset();
    this.pending = this.pending.then(() => {
      this.ring.reset();
      this.resampler = null;
    });
  }

  private async processContiguous(pcm: Float32Array): Promise<VadFrame[]> {
    this.ring.write(pcm);
    const frames = await this.stream.processChunk(pcm);
    for (const frame of frames) {
      this.callbacks.onFrame?.(frame);
      for (const event of frame.events) {
        if (event.type === "speech_start") {
          this.callbacks.onSpeechStart?.(event.time);
        } else {
          this.callbacks.onSpeechEnd?.({
            audio: this.ring.slice(
              Math.round(event.startTime * SAMPLE_RATE),
              Math.round(event.time * SAMPLE_RATE),
            ),
            startTime: event.startTime,
            endTime: event.time,
          });
        }
      }
    }
    return frames;
  }

  private resample(pcm: Float32Array, sampleRate: number): Float32Array {
    this.resampler ??= new LinearResampler(sampleRate);
    return this.resampler.process(pcm);
  }
}

export async function createVad(
  factory: ProviderFactory,
  options: Partial<VadOptions> & VadSessionCallbacks = {},
): Promise<VadSession> {
  const { onFrame, onSpeechStart, onSpeechEnd, onError, ...opts } = options;
  const provider = await factory();
  const stream = new VadStream(provider, { ...DEFAULT_VAD_OPTIONS, ...opts });
  return new VadSession(stream, { onFrame, onSpeechStart, onSpeechEnd, onError });
}
```

Update `src/index.ts`:
```ts
export { ChunkBuffer } from "./engine/chunkBuffer.js";
export { LinearResampler } from "./engine/resampler.js";
export { AudioRingBuffer } from "./engine/ringBuffer.js";
export { DEFAULT_VAD_OPTIONS, Segmenter } from "./engine/segmenter.js";
export type { VadEvent, VadFrame, VadOptions } from "./engine/segmenter.js";
export { createVad, VadSession } from "./engine/session.js";
export type { AudioSource, Utterance, VadSessionCallbacks } from "./engine/session.js";
export { VadStream } from "./engine/vadStream.js";
export { micSource } from "./micSource.js"; // added in Task 3; omit until then
export type { MicSourceOptions } from "./micSource.js"; // added in Task 3; omit until then
export { SAMPLE_RATE } from "./types.js";
export type { ProviderFactory, VadProvider } from "./types.js";
```
(The two micSource lines belong to Task 3 — leave them out in this task.)

- [ ] **Step 5: Update existing tests to the new payload**

- `tests/vadStream.test.ts`: `onSpeechEnd: (e) => ends.push(e.time)` → `onSpeechEnd: (u) => ends.push(u.endTime)`. Everything else is unchanged (createVad still exposes `processChunk`, `reset`, and the callbacks).
- `tests/fireredvad.test.ts`: same one-line change in the second test.
- `tests/crossProvider.test.ts`: no `onSpeechEnd` used; no change expected — verify.

- [ ] **Step 6: Run the full suite, verify pass, commit**

Run: `npx vitest run` → all PASS (30 tests: 22 from the core plan + 4 ring buffer + 4 session, with the updated vadStream/provider tests green through the session).
```bash
git add -A && git commit -m "feat: add VadSession with utterance audio capture"
```

---

### Task 3: micSource

**Files:**
- Create: `src/micSource.ts`
- Modify: `src/index.ts` (add the two micSource export lines shown in Task 2)

**Interfaces:**
- Consumes: `AudioSource` (Task 2), `SAMPLE_RATE`.
- Produces: `micSource(options?: MicSourceOptions): AudioSource` with `MicSourceOptions = { constraints?: MediaTrackConstraints | boolean | undefined }`.

No Node test exists for this file (AudioContext/getUserMedia are browser-only); it is exercised by the demo in Task 4. Keep it free of logic beyond wiring — anything testable belongs in VadSession.

- [ ] **Step 1: Implement**

`src/micSource.ts`:
```ts
import type { AudioSource } from "./engine/session.js";
import { SAMPLE_RATE } from "./types.js";

// Inlined as a blob URL so consumers' bundlers need no worklet asset config.
const WORKLET_CODE = `
const BATCH_SAMPLES = 2048;
class VadkitRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.length = 0;
  }
  process(inputs) {
    const channel = inputs[0][0];
    if (channel) {
      this.chunks.push(channel.slice());
      this.length += channel.length;
      if (this.length >= BATCH_SAMPLES) {
        const batch = new Float32Array(this.length);
        let offset = 0;
        for (const chunk of this.chunks) {
          batch.set(chunk, offset);
          offset += chunk.length;
        }
        this.port.postMessage(batch, [batch.buffer]);
        this.chunks = [];
        this.length = 0;
      }
    }
    return true;
  }
}
registerProcessor("vadkit-recorder", VadkitRecorder);
`;

export interface MicSourceOptions {
  /** Passed to getUserMedia as the audio constraint. Default: true. */
  constraints?: MediaTrackConstraints | boolean | undefined;
}

/** Microphone AudioSource: getUserMedia + a 16 kHz AudioContext + AudioWorklet. */
export function micSource(options: MicSourceOptions = {}): AudioSource {
  let context: AudioContext | null = null;
  let mediaStream: MediaStream | null = null;
  return {
    async start(onChunk: (pcm: Float32Array, sampleRate: number) => void): Promise<void> {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: options.constraints ?? true,
      });
      context = new AudioContext({ sampleRate: SAMPLE_RATE });
      const url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: "text/javascript" }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const recorder = new AudioWorkletNode(context, "vadkit-recorder");
      const sampleRate = context.sampleRate; // may differ if 16 kHz was not honored
      recorder.port.onmessage = (event: MessageEvent<Float32Array>) => {
        onChunk(event.data, sampleRate);
      };
      context.createMediaStreamSource(mediaStream).connect(recorder);
    },
    async stop(): Promise<void> {
      mediaStream?.getTracks().forEach((track) => track.stop());
      await context?.close();
      context = null;
      mediaStream = null;
    },
  };
}
```

- [ ] **Step 2: Verify typecheck/lint/build and commit**

Run: `npx vitest run && npm run typecheck && npx eslint . && npm run build`
Expected: all PASS (attw/publint still clean; micSource is part of the root export).
```bash
git add -A && git commit -m "feat: add microphone AudioSource with inline worklet"
```

---

### Task 4: Side-by-side demo + README

**Files:**
- Create: `demo/index.html`, `demo/main.ts`, `demo/vite-env.d.ts`, `vite.config.ts`
- Modify: `tsconfig.json` (add `"demo"` and `"vite.config.ts"` to include), `package.json` (add `"demo": "vite"` script), `README.md` (usage + demo sections; create if absent)

**Interfaces:**
- Consumes: `createVad`, `micSource`, `fireRedVad`, `sileroVad`, `VadFrame`, `Utterance`.

- [ ] **Step 1: Install vite (single package, per the npm bug)**

```bash
npm install --save-dev vite
```

- [ ] **Step 2: Write vite config and demo scaffolding**

`vite.config.ts`:
```ts
import { defineConfig } from "vite";

export default defineConfig({
  root: "demo",
  assetsInclude: ["**/*.onnx"],
  // Keep onnxruntime-web unbundled so its import.meta.url-relative wasm
  // assets resolve from node_modules during dev.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
});
```
(Models live inside the repo at `models/`, one level above `demo/` — vite serves parent-of-root files via `/@fs/` automatically for the workspace; if it refuses, add `server: { fs: { allow: [".."] } }`.)

`demo/vite-env.d.ts`:
```ts
/// <reference types="vite/client" />
```

`demo/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>vadkit demo</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0 auto; max-width: 900px; padding: 2rem 1rem;
        background: #14161a; color: #e6e6e6;
        font-family: system-ui, -apple-system, sans-serif;
      }
      h1 { font-size: 1.3rem; font-weight: 600; }
      button {
        padding: 0.55rem 1.4rem; border: 0; border-radius: 6px;
        background: #4f7cff; color: #fff; font-size: 1rem; cursor: pointer;
      }
      button:disabled { background: #555; cursor: default; }
      .provider { margin: 1.2rem 0; }
      .provider h2 { font-size: 1rem; margin: 0.4rem 0; display: flex; gap: 0.8rem; align-items: center; }
      .status {
        padding: 0.15rem 0.7rem; border-radius: 999px; font-size: 0.8rem;
        background: #2a2d34; color: #9aa0aa;
      }
      .status.speech { background: #1d5c33; color: #b8f5cd; }
      canvas { width: 100%; height: 90px; background: #0e0f12; border-radius: 8px; }
      .utterances { font-family: ui-monospace, monospace; font-size: 0.85rem; color: #9aa0aa; min-height: 1.2em; }
      #info { color: #9aa0aa; font-size: 0.85rem; }
    </style>
  </head>
  <body>
    <h1>vadkit &mdash; providers side by side</h1>
    <p id="info">Loading models&hellip;</p>
    <button id="toggle" disabled>Start microphone</button>
    <div id="panels"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Write demo/main.ts**

```ts
import fireRedModelUrl from "../models/fireredvad_stream_vad_e2e.onnx?url";
import sileroModelUrl from "../models/silero_vad.onnx?url";
import { createVad, micSource } from "../src/index.ts";
import type { AudioSource, Utterance, VadFrame } from "../src/index.ts";
import { fireRedVad } from "../src/providers/fireredvad.ts";
import { sileroVad } from "../src/providers/silero.ts";

const HISTORY_SEC = 8;
const THRESHOLD = 0.4;

interface Panel {
  history: VadFrame[];
  maxFrames: number;
  segments: string[];
  canvas: HTMLCanvasElement;
  status: HTMLDivElement;
  utterances: HTMLDivElement;
}

const info = document.getElementById("info") as HTMLParagraphElement;
const toggle = document.getElementById("toggle") as HTMLButtonElement;
const panelsRoot = document.getElementById("panels") as HTMLDivElement;
const panels = new Map<string, Panel>();

function makePanel(name: string, frameSec: number): void {
  const root = document.createElement("div");
  root.className = "provider";
  root.innerHTML = `
    <h2>${name} <span class="status">silence</span></h2>
    <canvas width="1700" height="180"></canvas>
    <div class="utterances">&mdash;</div>`;
  panelsRoot.append(root);
  panels.set(name, {
    history: [],
    maxFrames: Math.round(HISTORY_SEC / frameSec),
    segments: [],
    canvas: root.querySelector("canvas") as HTMLCanvasElement,
    status: root.querySelector(".status") as HTMLDivElement,
    utterances: root.querySelector(".utterances") as HTMLDivElement,
  });
}

function draw(panel: Panel): void {
  const ctx = panel.canvas.getContext("2d");
  if (ctx === null) return;
  const { width, height } = panel.canvas;
  const frames = panel.history.slice(-panel.maxFrames);
  const x = (i: number): number => (i / panel.maxFrames) * width;
  const y = (p: number): number => height - p * height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(46, 160, 90, 0.25)";
  for (let i = 0; i < frames.length; i++) {
    if (frames[i]?.isSpeech === true) {
      ctx.fillRect(x(i), 0, width / panel.maxFrames + 1, height);
    }
  }
  ctx.strokeStyle = "#5a5f6a";
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(0, y(THRESHOLD));
  ctx.lineTo(width, y(THRESHOLD));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = "#4f7cff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < frames.length; i++) {
    const py = y(frames[i]?.smoothedProbability ?? 0);
    if (i === 0) ctx.moveTo(x(i), py);
    else ctx.lineTo(x(i), py);
  }
  ctx.stroke();
}

function callbacksFor(name: string): {
  onFrame: (frame: VadFrame) => void;
  onSpeechEnd: (utterance: Utterance) => void;
} {
  return {
    onFrame: (frame): void => {
      const panel = panels.get(name);
      if (panel === undefined) return;
      panel.history.push(frame);
      panel.status.textContent = frame.isSpeech ? "speech" : "silence";
      panel.status.classList.toggle("speech", frame.isSpeech);
      draw(panel);
    },
    onSpeechEnd: (utterance): void => {
      const panel = panels.get(name);
      if (panel === undefined) return;
      const dur = utterance.audio.length / 16000;
      panel.segments.push(
        `${utterance.startTime.toFixed(2)}\u2013${utterance.endTime.toFixed(2)} (${dur.toFixed(2)}s audio)`,
      );
      panel.utterances.textContent = panel.segments.join("  |  ");
    },
  };
}

/**
 * Split one AudioSource into n AudioSources sharing its start/stop: the
 * underlying source starts once all consumers started and stops once all
 * consumers stopped. Keeps resampling inside VadSession.start.
 */
function teeSource(source: AudioSource, count: number): AudioSource[] {
  const listeners: ((pcm: Float32Array, sampleRate: number) => void)[] = [];
  let started = 0;
  let stopped = 0;
  return Array.from({ length: count }, () => ({
    async start(onChunk: (pcm: Float32Array, sampleRate: number) => void): Promise<void> {
      listeners.push(onChunk);
      started += 1;
      if (started === count) {
        await source.start((pcm, sampleRate) => {
          for (const listener of listeners) listener(pcm, sampleRate);
        });
      }
    },
    async stop(): Promise<void> {
      stopped += 1;
      if (stopped === count) {
        started = 0;
        stopped = 0;
        listeners.length = 0;
        await source.stop();
      }
    },
  }));
}

const fireRedSession = await createVad(fireRedVad({ model: fireRedModelUrl }), {
  speechThreshold: THRESHOLD,
  ...callbacksFor("FireRedVAD (10 ms)"),
});
const sileroSession = await createVad(sileroVad({ model: sileroModelUrl }), {
  speechThreshold: THRESHOLD,
  ...callbacksFor("Silero VAD (32 ms)"),
});
makePanel("FireRedVAD (10 ms)", 0.01);
makePanel("Silero VAD (32 ms)", 0.032);

info.textContent = "Models loaded. Audio never leaves this page.";
toggle.disabled = false;
let running = false;

toggle.onclick = (): void => {
  void (async (): Promise<void> => {
    if (running) {
      running = false;
      toggle.textContent = "Start microphone";
      await fireRedSession.stop();
      await sileroSession.stop(); // last tee stop stops the mic
      return;
    }
    toggle.disabled = true;
    try {
      const tees = teeSource(micSource(), 2);
      const [teeA, teeB] = tees;
      if (teeA === undefined || teeB === undefined) throw new Error("teeSource returned too few");
      await fireRedSession.start(teeA);
      await sileroSession.start(teeB); // this one actually opens the mic
      running = true;
      toggle.textContent = "Stop microphone";
    } finally {
      toggle.disabled = false;
    }
  })();
};

// Seam for driving the demo without a microphone (e.g. an AudioBufferSource
// routed through a MediaStreamDestination wrapped as an AudioSource).
(window as unknown as Record<string, unknown>).demo = {
  teeSource,
  sessions: { fireRedSession, sileroSession },
};
```

- [ ] **Step 4: Wire tsconfig, package script, README**

- `tsconfig.json` include: `["src", "tests", "scripts", "demo", "tsdown.config.ts", "vite.config.ts", "vitest.config.ts"]`
- `package.json` scripts: add `"demo": "vite"`.
- `README.md`: sections — what vadkit is (one paragraph), install (npm i vadkit onnxruntime-web), quickstart (createVad + micSource + onSpeechEnd example matching the real API), provider table (FireRed/Silero with geometry + model licenses), development (npm test / typecheck / build / fixtures / demo), roadmap note (WebRTC and TEN-VAD per the spec).

- [ ] **Step 5: Verify in the browser**

```bash
npm run demo
```
Then (Claude: via the Browser pane; human: manually) on http://localhost:5173:
1. Page loads with both panels and "Models loaded".
2. No console errors.
3. Drive the pipeline without a mic: from the console, build an
   `AudioBufferSourceNode` playing `tests/assets/hello_en.wav` into a
   `MediaStreamAudioDestinationNode`, wrap `{ start, stop }` around it as an
   AudioSource, and `session.start(...)` both sessions with a tee — expect one
   utterance ~0.3–1.9 s on both panels, with `audio.length` consistent with
   `(endTime - startTime) * 16000`.
4. With a real mic (human): both meters move, utterance list fills on pauses.

- [ ] **Step 6: Full verification and commit**

Run: `npx vitest run && npm run typecheck && npx eslint . && npm run build`
Expected: all PASS.
```bash
git add -A && git commit -m "feat: add side-by-side provider demo and README"
```

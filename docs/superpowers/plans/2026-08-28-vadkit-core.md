# vadkit Core (Engine + FireRed + Silero) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The vadkit streaming engine plus two working providers (FireRedVAD, Silero), each parity-tested against a committed reference fixture.

**Architecture:** A provider-agnostic engine (chunk buffering, promise-chain serialization, seconds-denominated segmenter) drives `VadProvider` implementations that own model sessions and recurrent state. Providers live behind subpath exports; onnxruntime-web is a peer dependency used only by providers.

**Tech Stack:** TypeScript 5.6+ (strict, NodeNext ESM), vitest 3, onnxruntime-web ^1.22 (runs under Node ≥20 for tests), Python via `uv run` for fixture generation.

**Spec:** `docs/superpowers/specs/2026-08-28-vadkit-design.md`

## Global Constraints

- Package name `vadkit`, license MIT (models keep their own licenses in `models/NOTICE`).
- All PCM is `Float32Array`, mono, 16 kHz, values in [-1, 1].
- ESM only; explicit `.js` extensions in all relative imports (NodeNext); `"type": "module"`.
- `src/index.ts` must not import any provider (tree-shaking boundary).
- Every stateful object's mutations are ordered through its promise chain; no public method may race another.
- Fixture JSONs are committed; the scripts that generate them are committed next to them and name their reference implementation and version.
- Frame timestamps are `index * hopSamples / 16000`, seconds, start-of-hop.

---

### Task 1: Repo scaffolding + WAV test helper

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`
- Create: `tests/wav.ts`, `tests/assets/hello_en.wav` (copied from the FireRedVAD repo)
- Test: `tests/wav.test.ts`

**Interfaces:**
- Produces: `readWav16kMono(buffer: ArrayBuffer): Float32Array` used by every fixture test.

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "vadkit",
  "version": "0.1.0",
  "description": "Multi-provider voice activity detection for the browser",
  "license": "MIT",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "models"],
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./fireredvad": { "types": "./dist/providers/fireredvad.d.ts", "default": "./dist/providers/fireredvad.js" },
    "./silero": { "types": "./dist/providers/silero.d.ts", "default": "./dist/providers/silero.js" }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": { "onnxruntime-web": ">=1.17.0" },
  "peerDependenciesMeta": { "onnxruntime-web": { "optional": true } },
  "devDependencies": {
    "onnxruntime-web": "^1.22.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { testTimeout: 60000 },
});
```

`.gitignore`:
```
node_modules/
dist/
.DS_Store
```

`LICENSE`: MIT text with `Copyright (c) 2026 Will Rice`.

- [ ] **Step 2: Copy the test asset and install**

```bash
cp ~/Documents/projects/FireRedVAD/assets/hello_en.wav tests/assets/hello_en.wav
npm install --no-audit --no-fund
```

- [ ] **Step 3: Write the WAV helper and its failing test**

`tests/wav.ts` — same logic as fireredvad-web's helper:
```ts
/** Minimal WAV reader for 16 kHz 16-bit mono PCM test assets. */
export function readWav16kMono(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== 0x52494646) throw new Error("not a RIFF file");
  let offset = 12;
  let dataOffset = -1;
  let dataLength = -1;
  while (offset + 8 <= view.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 0x666d7420) { // "fmt "
      const format = view.getUint16(offset + 8, true);
      const channels = view.getUint16(offset + 10, true);
      const sampleRate = view.getUint32(offset + 12, true);
      const bits = view.getUint16(offset + 22, true);
      if (format !== 1 || channels !== 1 || sampleRate !== 16000 || bits !== 16) {
        throw new Error(`expected 16 kHz 16-bit mono PCM, got ${format}/${channels}/${sampleRate}/${bits}`);
      }
    } else if (chunkId === 0x64617461) { // "data"
      dataOffset = offset + 8;
      dataLength = chunkSize;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (dataOffset < 0) throw new Error("no data chunk");
  const pcm = new Float32Array(dataLength / 2);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = view.getInt16(dataOffset + 2 * i, true) / 32768;
  }
  return pcm;
}
```

`tests/wav.test.ts`:
```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { readWav16kMono } from "./wav.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("reads hello_en.wav as 16 kHz mono float PCM", () => {
  const buf = readFileSync(path.join(HERE, "assets", "hello_en.wav"));
  const pcm = readWav16kMono(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  expect(pcm.length).toBe(35840); // 2.24 s at 16 kHz
  expect(Math.max(...pcm)).toBeLessThanOrEqual(1);
  expect(Math.min(...pcm)).toBeGreaterThanOrEqual(-1);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/wav.test.ts`
Expected: PASS (helper and test land together; the checked expectation `35840` is the known length of this asset — if it fails, read the actual length from the error and confirm against `soxi`/`ffprobe` before changing the test).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Scaffold vadkit package with WAV test helper"
```

---

### Task 2: Provider types + ChunkBuffer

**Files:**
- Create: `src/types.ts`, `src/engine/chunkBuffer.ts`
- Test: `tests/chunkBuffer.test.ts`

**Interfaces:**
- Produces:
```ts
// src/types.ts
export interface VadProvider {
  readonly windowSamples: number;
  readonly hopSamples: number;
  readonly frameSec: number;
  process(samples: Float32Array): Promise<Float32Array>;
  reset(): void;
}
export type ProviderFactory = () => Promise<VadProvider>;
```
- `ChunkBuffer.push(pcm): Float32Array | null` returns a maximal `window + k*hop` run.

- [ ] **Step 1: Write src/types.ts**

```ts
export const SAMPLE_RATE = 16000;

/** A VAD backend: owns its model session and recurrent state. */
export interface VadProvider {
  /** Samples of context consumed per output frame. */
  readonly windowSamples: number;
  /** Samples advanced per output frame. */
  readonly hopSamples: number;
  /** Seconds per output frame: hopSamples / SAMPLE_RATE. */
  readonly frameSec: number;
  /**
   * Run inference on contiguous 16 kHz PCM holding an integer number of
   * frames: samples.length === windowSamples + (n - 1) * hopSamples, n >= 1.
   * Returns n speech probabilities in [0, 1]. Stateful across calls.
   */
  process(samples: Float32Array): Promise<Float32Array>;
  /** Clear recurrent state for a new stream. */
  reset(): void;
}

export type ProviderFactory = () => Promise<VadProvider>;
```

- [ ] **Step 2: Write the failing ChunkBuffer test**

`tests/chunkBuffer.test.ts`:
```ts
import { expect, test } from "vitest";
import { ChunkBuffer } from "../src/engine/chunkBuffer.js";

function ramp(start: number, length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => start + i);
}

test("buffers until one full window is available", () => {
  const buf = new ChunkBuffer(400, 160);
  expect(buf.push(ramp(0, 399))).toBeNull();
  const run = buf.push(ramp(399, 1));
  expect(run).not.toBeNull();
  expect(run!.length).toBe(400);
  expect(run![0]).toBe(0);
});

test("returns maximal runs and carries the overlap", () => {
  const buf = new ChunkBuffer(400, 160);
  // 1000 samples: n = floor((1000-400)/160)+1 = 4 frames -> run 400+3*160 = 880,
  // consumed 4*160 = 640, retained 360.
  const run1 = buf.push(ramp(0, 1000))!;
  expect(run1.length).toBe(880);
  // 360 retained + 240 new = 600: n = 2 -> run 560, first sample is index 640.
  const run2 = buf.push(ramp(1000, 240))!;
  expect(run2.length).toBe(560);
  expect(run2[0]).toBe(640);
});

test("window == hop providers get exact multiples", () => {
  const buf = new ChunkBuffer(512, 512);
  // 1200 samples: n = floor((1200-512)/512)+1 = 2 -> run 1024, retained 176.
  const run = buf.push(ramp(0, 1200))!;
  expect(run.length).toBe(1024);
  // 176 + 340 = 516 >= 512 -> exactly one more window.
  expect(buf.push(ramp(1200, 340))!.length).toBe(512);
});

test("reset drops buffered samples", () => {
  const buf = new ChunkBuffer(400, 160);
  buf.push(ramp(0, 399));
  buf.reset();
  expect(buf.push(ramp(0, 399))).toBeNull();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/chunkBuffer.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement ChunkBuffer**

`src/engine/chunkBuffer.ts`:
```ts
/** Slices arbitrary-size PCM chunks into maximal window+k*hop runs. */
export class ChunkBuffer {
  private buffer = new Float32Array(0);

  constructor(
    readonly windowSamples: number,
    readonly hopSamples: number,
  ) {}

  /** Append pcm; return the maximal contiguous run, or null if not enough. */
  push(pcm: Float32Array): Float32Array | null {
    const audio = new Float32Array(this.buffer.length + pcm.length);
    audio.set(this.buffer);
    audio.set(pcm, this.buffer.length);
    if (audio.length < this.windowSamples) {
      this.buffer = audio;
      return null;
    }
    const numFrames =
      Math.floor((audio.length - this.windowSamples) / this.hopSamples) + 1;
    const runLength = this.windowSamples + (numFrames - 1) * this.hopSamples;
    this.buffer = audio.slice(numFrames * this.hopSamples);
    return audio.subarray(0, runLength);
  }

  reset(): void {
    this.buffer = new Float32Array(0);
  }
}
```

- [ ] **Step 5: Run tests, verify pass, commit**

Run: `npx vitest run tests/chunkBuffer.test.ts` → PASS
```bash
git add -A && git commit -m "Add provider types and ChunkBuffer"
```

---

### Task 3: Streaming resampler

**Files:**
- Create: `src/engine/resampler.ts`
- Test: `tests/resampler.test.ts`

**Interfaces:**
- Produces: `new LinearResampler(fromRate: number)`, `.process(input: Float32Array): Float32Array`, `.reset(): void`. Identity when `fromRate === 16000`.

- [ ] **Step 1: Write the failing test**

`tests/resampler.test.ts`:
```ts
import { expect, test } from "vitest";
import { LinearResampler } from "../src/engine/resampler.js";

test("identity at 16 kHz", () => {
  const r = new LinearResampler(16000);
  const input = Float32Array.from([1, 2, 3]);
  expect(r.process(input)).toBe(input);
});

test("halves the rate from 32 kHz with no discontinuity across chunks", () => {
  const r = new LinearResampler(32000);
  // A pure ramp resamples to a pure ramp regardless of chunk boundaries.
  const a = r.process(Float32Array.from({ length: 100 }, (_, i) => i));
  const b = r.process(Float32Array.from({ length: 100 }, (_, i) => 100 + i));
  const all = [...a, ...b];
  expect(all.length).toBeGreaterThanOrEqual(98);
  for (let i = 1; i < all.length; i++) {
    expect(all[i] - all[i - 1]).toBeCloseTo(2, 6);
  }
});

test("output length converges to input * 16000 / fromRate", () => {
  const r = new LinearResampler(48000);
  let out = 0;
  for (let c = 0; c < 50; c++) out += r.process(new Float32Array(480)).length;
  expect(out).toBeGreaterThanOrEqual(7998); // 50*480/3 = 8000, minus edge samples
  expect(out).toBeLessThanOrEqual(8000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/resampler.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement (adapted from the fireredvad-web demo, plus reset)**

`src/engine/resampler.ts`:
```ts
import { SAMPLE_RATE } from "../types.js";

/** Streaming linear-interpolation resampler to 16 kHz with fractional carry. */
export class LinearResampler {
  private readonly step: number;
  private position = 0;
  private tail = new Float32Array(0);

  constructor(fromRate: number) {
    this.step = fromRate / SAMPLE_RATE;
  }

  process(input: Float32Array): Float32Array {
    if (this.step === 1) return input;
    const src = new Float32Array(this.tail.length + input.length);
    src.set(this.tail);
    src.set(input, this.tail.length);

    const out: number[] = [];
    let pos = this.position;
    while (pos < src.length - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      out.push(src[i] * (1 - frac) + src[i + 1] * frac);
      pos += this.step;
    }
    const consumed = Math.floor(pos);
    this.tail = src.slice(consumed);
    this.position = pos - consumed;
    return Float32Array.from(out);
  }

  reset(): void {
    this.position = 0;
    this.tail = new Float32Array(0);
  }
}
```

- [ ] **Step 4: Run tests, verify pass, commit**

Run: `npx vitest run tests/resampler.test.ts` → PASS
```bash
git add -A && git commit -m "Add streaming linear resampler"
```

---

### Task 4: Segmenter

**Files:**
- Create: `src/engine/segmenter.ts`
- Test: `tests/segmenter.test.ts`

**Interfaces:**
- Produces:
```ts
export interface VadOptions {
  speechThreshold: number; smoothWindowSec: number; minSpeechSec: number;
  minSilenceSec: number; prePadSec: number; maxSpeechSec: number;
}
export const DEFAULT_VAD_OPTIONS: VadOptions; // 0.5 / 0.05 / 0.08 / 0.2 / 0.1 / 30
export type VadEvent =
  | { type: "speech_start"; time: number }
  | { type: "speech_end"; time: number; startTime: number };
export interface VadFrame {
  index: number; time: number; probability: number;
  smoothedProbability: number; isSpeech: boolean; events: VadEvent[];
}
export class Segmenter {
  constructor(options: VadOptions, frameSec: number);
  process(probability: number): VadFrame;
  reset(): void;
}
```

- [ ] **Step 1: Write the failing test**

`tests/segmenter.test.ts` (frameSec 0.01 → frames are 10 ms; config picked so counts are small and exact):
```ts
import { expect, test } from "vitest";
import { DEFAULT_VAD_OPTIONS, Segmenter } from "../src/engine/segmenter.js";

const OPTS = {
  ...DEFAULT_VAD_OPTIONS,
  speechThreshold: 0.5,
  smoothWindowSec: 0.01, // 1 frame -> smoothing off
  minSpeechSec: 0.03,    // 3 frames
  minSilenceSec: 0.05,   // 5 frames
  prePadSec: 0.02,       // 2 frames
  maxSpeechSec: 30,
};

function feed(seg: Segmenter, probs: number[]) {
  return probs.map((p) => seg.process(p));
}

test("emits speech_start after minSpeechSec of voiced frames, pre-padded", () => {
  const seg = new Segmenter(OPTS, 0.01);
  const frames = feed(seg, [0, 0, 0, 0, 0.9, 0.9, 0.9, 0.9]);
  const starts = frames.flatMap((f) => f.events).filter((e) => e.type === "speech_start");
  expect(starts).toHaveLength(1);
  // voiced run starts at index 4 (t=0.04); minus prePad 0.02 -> 0.02
  expect(starts[0].time).toBeCloseTo(0.02, 9);
  expect(frames[6].isSpeech).toBe(true); // 3rd voiced frame flips state
  expect(frames[5].isSpeech).toBe(false);
});

test("a blip shorter than minSpeechSec never starts speech", () => {
  const seg = new Segmenter(OPTS, 0.01);
  const frames = feed(seg, [0.9, 0.9, 0, 0, 0, 0, 0, 0]);
  expect(frames.flatMap((f) => f.events)).toHaveLength(0);
  expect(frames.every((f) => !f.isSpeech)).toBe(true);
});

test("emits speech_end after minSilenceSec, at the first silent frame", () => {
  const seg = new Segmenter(OPTS, 0.01);
  const probs = [0.9, 0.9, 0.9, 0.9, 0, 0, 0, 0, 0, 0];
  const frames = feed(seg, probs);
  const ends = frames.flatMap((f) => f.events).filter((e) => e.type === "speech_end");
  expect(ends).toHaveLength(1);
  expect(ends[0].time).toBeCloseTo(0.04, 9); // first silent frame t=0.04
  expect(ends[0].startTime).toBeCloseTo(0, 9); // prePad clamped at 0
});

test("short silence inside speech does not end the segment", () => {
  const seg = new Segmenter(OPTS, 0.01);
  const probs = [0.9, 0.9, 0.9, 0, 0, 0.9, 0.9, 0.9];
  const frames = feed(seg, probs);
  expect(frames.flatMap((f) => f.events).filter((e) => e.type === "speech_end")).toHaveLength(0);
  expect(frames[7].isSpeech).toBe(true);
});

test("maxSpeechSec force-splits a long segment", () => {
  const seg = new Segmenter({ ...OPTS, maxSpeechSec: 0.06 }, 0.01);
  const frames = feed(seg, new Array(12).fill(0.9));
  const events = frames.flatMap((f) => f.events);
  expect(events.filter((e) => e.type === "speech_end").length).toBeGreaterThanOrEqual(1);
  expect(events.filter((e) => e.type === "speech_start").length).toBeGreaterThanOrEqual(2);
});

test("speech_start never precedes the previous speech_end", () => {
  const seg = new Segmenter(OPTS, 0.01);
  const probs = [0.9, 0.9, 0.9, 0, 0, 0, 0, 0, 0.9, 0.9, 0.9, 0.9];
  const events = feed(seg, probs).flatMap((f) => f.events);
  const end = events.find((e) => e.type === "speech_end")!;
  const secondStart = events.filter((e) => e.type === "speech_start")[1]!;
  expect(secondStart.time).toBeGreaterThanOrEqual(end.time);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/segmenter.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement Segmenter**

`src/engine/segmenter.ts`:
```ts
export interface VadOptions {
  /** Smoothed probability at/above this is voiced. Default 0.5. */
  speechThreshold: number;
  /** Trailing moving-average window in seconds. Default 0.05. */
  smoothWindowSec: number;
  /** Voiced run needed to start a segment. Default 0.08. */
  minSpeechSec: number;
  /** Silent run needed to end a segment. Default 0.2. */
  minSilenceSec: number;
  /** Reported segment start precedes the voiced run by this much. Default 0.1. */
  prePadSec: number;
  /** Segments are force-split at this length. Default 30. */
  maxSpeechSec: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  speechThreshold: 0.5,
  smoothWindowSec: 0.05,
  minSpeechSec: 0.08,
  minSilenceSec: 0.2,
  prePadSec: 0.1,
  maxSpeechSec: 30,
};

export type VadEvent =
  | { type: "speech_start"; time: number }
  | { type: "speech_end"; time: number; startTime: number };

export interface VadFrame {
  index: number;
  time: number;
  probability: number;
  smoothedProbability: number;
  /** In-segment state (includes hangover), not the instantaneous threshold. */
  isSpeech: boolean;
  events: VadEvent[];
}

enum State { SILENCE, POSSIBLE_SPEECH, SPEECH, POSSIBLE_SILENCE }

/** Hangover state machine over per-frame probabilities, config in seconds. */
export class Segmenter {
  private readonly frameSec: number;
  private readonly options: VadOptions;
  private readonly smoothFrames: number;
  private readonly minSpeechFrames: number;
  private readonly minSilenceFrames: number;

  private index = -1;
  private window: number[] = [];
  private windowSum = 0;
  private state = State.SILENCE;
  private voicedRunStart = -1;
  private silenceRunStart = -1;
  private segmentStartTime = -1;
  private lastEndTime = 0;

  constructor(options: VadOptions, frameSec: number) {
    this.options = options;
    this.frameSec = frameSec;
    const frames = (sec: number) => Math.max(1, Math.round(sec / frameSec));
    this.smoothFrames = frames(options.smoothWindowSec);
    this.minSpeechFrames = frames(options.minSpeechSec);
    this.minSilenceFrames = frames(options.minSilenceSec);
  }

  reset(): void {
    this.index = -1;
    this.window = [];
    this.windowSum = 0;
    this.state = State.SILENCE;
    this.voicedRunStart = -1;
    this.silenceRunStart = -1;
    this.segmentStartTime = -1;
    this.lastEndTime = 0;
  }

  process(probability: number): VadFrame {
    this.index += 1;
    const time = this.index * this.frameSec;
    const smoothed = this.smooth(probability);
    const voiced = smoothed >= this.options.speechThreshold;
    const events: VadEvent[] = [];

    switch (this.state) {
      case State.SILENCE:
        if (voiced) {
          this.state = State.POSSIBLE_SPEECH;
          this.voicedRunStart = this.index;
        }
        break;
      case State.POSSIBLE_SPEECH:
        if (!voiced) {
          this.state = State.SILENCE;
        } else if (this.index - this.voicedRunStart + 1 >= this.minSpeechFrames) {
          this.state = State.SPEECH;
          this.segmentStartTime = Math.max(
            0,
            this.lastEndTime,
            this.voicedRunStart * this.frameSec - this.options.prePadSec);
          events.push({ type: "speech_start", time: this.segmentStartTime });
        }
        break;
      case State.SPEECH:
        if (!voiced) {
          this.state = State.POSSIBLE_SILENCE;
          this.silenceRunStart = this.index;
        }
        break;
      case State.POSSIBLE_SILENCE:
        if (voiced) {
          this.state = State.SPEECH;
        } else if (this.index - this.silenceRunStart + 1 >= this.minSilenceFrames) {
          this.state = State.SILENCE;
          const endTime = this.silenceRunStart * this.frameSec;
          events.push({ type: "speech_end", time: endTime, startTime: this.segmentStartTime });
          this.lastEndTime = endTime;
          this.segmentStartTime = -1;
        }
        break;
    }

    // Force-split overlong segments.
    if ((this.state === State.SPEECH || this.state === State.POSSIBLE_SILENCE) &&
        time - this.segmentStartTime >= this.options.maxSpeechSec) {
      events.push({ type: "speech_end", time, startTime: this.segmentStartTime });
      events.push({ type: "speech_start", time });
      this.segmentStartTime = time;
      this.lastEndTime = time;
      this.state = State.SPEECH;
    }

    const isSpeech = this.state === State.SPEECH || this.state === State.POSSIBLE_SILENCE;
    return { index: this.index, time, probability, smoothedProbability: smoothed, isSpeech, events };
  }

  private smooth(probability: number): number {
    if (this.smoothFrames <= 1) return probability;
    this.window.push(probability);
    this.windowSum += probability;
    if (this.window.length > this.smoothFrames) {
      this.windowSum -= this.window.shift() as number;
    }
    return this.windowSum / this.window.length;
  }
}
```

- [ ] **Step 4: Run tests, verify pass, commit**

Run: `npx vitest run tests/segmenter.test.ts` → PASS
```bash
git add -A && git commit -m "Add seconds-denominated hangover segmenter"
```

---

### Task 5: VadStream + createVad (engine assembly)

**Files:**
- Create: `src/engine/vadStream.ts`, `src/index.ts`
- Test: `tests/vadStream.test.ts`

**Interfaces:**
- Consumes: `VadProvider`, `ProviderFactory` (Task 2), `ChunkBuffer` (Task 2), `Segmenter`, `VadOptions`, `VadFrame`, `VadEvent`, `DEFAULT_VAD_OPTIONS` (Task 4).
- Produces:
```ts
export interface VadCallbacks {
  onFrame?: (frame: VadFrame) => void;
  onSpeechStart?: (time: number) => void;
  onSpeechEnd?: (event: { time: number; startTime: number }) => void;
}
export class VadStream {
  readonly provider: VadProvider;
  readonly options: VadOptions;
  processChunk(pcm: Float32Array): Promise<VadFrame[]>; // serialized
  reset(): void; // queued behind in-flight calls
}
export function createVad(
  factory: ProviderFactory,
  options?: Partial<VadOptions> & VadCallbacks,
): Promise<VadStream>;
```

- [ ] **Step 1: Write the failing test with a fake provider**

`tests/vadStream.test.ts`:
```ts
import { expect, test } from "vitest";
import { createVad } from "../src/index.js";
import type { VadProvider } from "../src/types.js";

/** Deterministic fake: probability = mean(|samples|) of each frame's window. */
function fakeProvider(windowSamples = 400, hopSamples = 160): VadProvider & { calls: number[] } {
  const calls: number[] = [];
  return {
    windowSamples, hopSamples, frameSec: hopSamples / 16000, calls,
    async process(samples) {
      calls.push(samples.length);
      const n = Math.floor((samples.length - windowSamples) / hopSamples) + 1;
      const probs = new Float32Array(n);
      for (let t = 0; t < n; t++) {
        let sum = 0;
        for (let i = 0; i < windowSamples; i++) sum += Math.abs(samples[t * hopSamples + i]);
        probs[t] = Math.min(1, sum / windowSamples);
      }
      return probs;
    },
    reset() {},
  };
}

const OPTS = { smoothWindowSec: 0.01, minSpeechSec: 0.03, minSilenceSec: 0.05, prePadSec: 0, speechThreshold: 0.5 };

test("frames and events flow from chunks of arbitrary size", async () => {
  const starts: number[] = [];
  const ends: number[] = [];
  const vad = await createVad(async () => fakeProvider(), {
    ...OPTS,
    onSpeechStart: (t) => starts.push(t),
    onSpeechEnd: (e) => ends.push(e.time),
  });
  // 0.5 s silence, 0.5 s "speech" (amplitude 0.9), 0.5 s silence, fed in 313-sample chunks.
  const pcm = new Float32Array(24000);
  pcm.fill(0.9, 8000, 16000);
  const frames = [];
  for (let i = 0; i < pcm.length; i += 313) {
    frames.push(...await vad.processChunk(pcm.subarray(i, i + 313)));
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
  const mk = () => createVad(async () => fakeProvider(), OPTS);
  const pcm = new Float32Array(8000).map(() => Math.random());
  const chunks = [];
  for (let i = 0; i < pcm.length; i += 313) chunks.push(pcm.subarray(i, i + 313));

  const seqVad = await mk();
  const sequential = [];
  for (const c of chunks) sequential.push(...await seqVad.processChunk(c));

  const parVad = await mk();
  const overlapping = (await Promise.all(chunks.map((c) => parVad.processChunk(c)))).flat();
  expect(overlapping).toEqual(sequential);
});

test("reset is ordered behind in-flight calls and restarts frame indexing", async () => {
  const vad = await createVad(async () => fakeProvider(), OPTS);
  const first = await vad.processChunk(new Float32Array(1000));
  vad.reset();
  const second = await vad.processChunk(new Float32Array(1000));
  expect(second.map((f) => f.index)).toEqual(first.map((f) => f.index));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vadStream.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement VadStream and index.ts**

`src/engine/vadStream.ts`:
```ts
import type { ProviderFactory, VadProvider } from "../types.js";
import { ChunkBuffer } from "./chunkBuffer.js";
import { DEFAULT_VAD_OPTIONS, Segmenter, type VadFrame, type VadOptions } from "./segmenter.js";

export interface VadCallbacks {
  onFrame?: (frame: VadFrame) => void;
  onSpeechStart?: (time: number) => void;
  onSpeechEnd?: (event: { time: number; startTime: number }) => void;
}

/** Streaming VAD over one provider; all state changes are serialized. */
export class VadStream {
  readonly provider: VadProvider;
  readonly options: VadOptions;
  private readonly callbacks: VadCallbacks;
  private readonly buffer: ChunkBuffer;
  private readonly segmenter: Segmenter;
  private pending: Promise<void> = Promise.resolve();

  constructor(provider: VadProvider, options: VadOptions, callbacks: VadCallbacks) {
    this.provider = provider;
    this.options = options;
    this.callbacks = callbacks;
    this.buffer = new ChunkBuffer(provider.windowSamples, provider.hopSamples);
    this.segmenter = new Segmenter(options, provider.frameSec);
  }

  /** Feed PCM of any length; returns one VadFrame per completed frame. */
  processChunk(pcm: Float32Array): Promise<VadFrame[]> {
    const result = this.pending.then(() => this.processContiguous(pcm));
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Start a new stream. Ordered behind in-flight processChunk calls. */
  reset(): void {
    this.pending = this.pending.then(() => {
      this.buffer.reset();
      this.segmenter.reset();
      this.provider.reset();
    });
  }

  private async processContiguous(pcm: Float32Array): Promise<VadFrame[]> {
    const run = this.buffer.push(pcm);
    if (run === null) return [];
    const probs = await this.provider.process(run);
    const frames: VadFrame[] = [];
    for (const p of probs) {
      const frame = this.segmenter.process(p);
      frames.push(frame);
      this.callbacks.onFrame?.(frame);
      for (const event of frame.events) {
        if (event.type === "speech_start") this.callbacks.onSpeechStart?.(event.time);
        else this.callbacks.onSpeechEnd?.({ time: event.time, startTime: event.startTime });
      }
    }
    return frames;
  }
}

export async function createVad(
  factory: ProviderFactory,
  options: Partial<VadOptions> & VadCallbacks = {},
): Promise<VadStream> {
  const { onFrame, onSpeechStart, onSpeechEnd, ...opts } = options;
  const provider = await factory();
  return new VadStream(provider, { ...DEFAULT_VAD_OPTIONS, ...opts }, { onFrame, onSpeechStart, onSpeechEnd });
}
```

`src/index.ts`:
```ts
export { ChunkBuffer } from "./engine/chunkBuffer.js";
export { LinearResampler } from "./engine/resampler.js";
export {
  DEFAULT_VAD_OPTIONS,
  Segmenter,
  type VadEvent,
  type VadFrame,
  type VadOptions,
} from "./engine/segmenter.js";
export { createVad, VadStream, type VadCallbacks } from "./engine/vadStream.js";
export { SAMPLE_RATE, type ProviderFactory, type VadProvider } from "./types.js";
```

- [ ] **Step 4: Run all tests and typecheck, verify pass, commit**

Run: `npx vitest run && npx tsc --noEmit` → PASS
```bash
git add -A && git commit -m "Add VadStream engine and createVad entry point"
```

---

### Task 6: FireRedVAD provider + parity fixture

**Files:**
- Create: `src/providers/fireredvad.ts`, `models/fireredvad_stream_vad_e2e.onnx` (copied), `models/NOTICE`
- Create: `scripts/generate_fireredvad_fixture.py`, `tests/fixtures/fireredvad.json`
- Test: `tests/fireredvad.test.ts`

**Interfaces:**
- Consumes: `VadProvider`, `ProviderFactory`, `SAMPLE_RATE` (Task 2), `createVad` (Task 5).
- Produces: `fireRedVad(options?: { model?: string | Uint8Array; sessionOptions?: ort.InferenceSession.SessionOptions }): ProviderFactory`.

- [ ] **Step 1: Copy the model and write the NOTICE**

```bash
mkdir -p models
cp ~/Documents/projects/FireRedVAD/.claude/worktrees/browser-compatibility-options-f227ca/pretrained_models/onnx_models/fireredvad_stream_vad_e2e.onnx models/
```

`models/NOTICE`:
```
fireredvad_stream_vad_e2e.onnx
  FireRedVAD (https://github.com/FireRedTeam/FireRedVAD), Apache-2.0.
  Single-file export with the fbank+CMVN frontend inside the graph.
```

- [ ] **Step 2: Write and run the fixture generator**

`scripts/generate_fireredvad_fixture.py`:
```python
#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["onnxruntime", "soundfile", "numpy"]
# ///
"""Golden per-frame probabilities for the FireRedVAD provider.

Reference: the fireredvad_stream_vad_e2e.onnx model run with Python
onnxruntime over the full utterance (zero initial caches). The model's own
parity with the FireRedVAD Python pipeline is established in that repo's
tests; this fixture pins the TypeScript glue (framing, cache threading).
"""
import json
import os

import numpy as np
import onnxruntime
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))

wav, sr = sf.read(os.path.join(HERE, "..", "tests", "assets", "hello_en.wav"), dtype="int16")
assert sr == 16000
pcm = (wav / 32768.0).astype(np.float32)[None, :]

sess = onnxruntime.InferenceSession(
    os.path.join(HERE, "..", "models", "fireredvad_stream_vad_e2e.onnx"))
caches = np.zeros((1, 1024, 19), dtype=np.float32)
probs, = sess.run(["probs"], {"pcm": pcm, "caches_packed": caches})

out = os.path.join(HERE, "..", "tests", "fixtures", "fireredvad.json")
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w") as f:
    json.dump({"wav": "hello_en.wav", "probs": probs[0, :, 0].tolist()}, f)
print(f"wrote {out} ({probs.shape[1]} frames)")
```

Run: `uv run scripts/generate_fireredvad_fixture.py`
Expected: `wrote .../fireredvad.json (222 frames)`

- [ ] **Step 3: Write the failing provider test**

`tests/fireredvad.test.ts`:
```ts
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

test("matches the Python onnxruntime reference frame by frame", async () => {
  const fixture = JSON.parse(
    readFileSync(path.join(HERE, "fixtures", "fireredvad.json"), "utf-8"));
  const model = readFileSync(path.join(HERE, "..", "models", "fireredvad_stream_vad_e2e.onnx"));
  const vad = await createVad(fireRedVad({ model }));

  const pcm = loadPcm();
  const frames = [];
  for (let i = 0; i < pcm.length; i += 512) {
    frames.push(...await vad.processChunk(pcm.subarray(i, i + 512)));
  }
  expect(frames.length).toBe(fixture.probs.length);
  for (let i = 0; i < frames.length; i++) {
    // ort-web vs Python onnxruntime on the same graph: kernel noise only.
    expect(Math.abs(frames[i].probability - fixture.probs[i]), `frame ${i}`)
      .toBeLessThanOrEqual(1e-5 + 1e-3 * Math.abs(fixture.probs[i]));
  }
});

test("detects the utterance with default options", async () => {
  const model = readFileSync(path.join(HERE, "..", "models", "fireredvad_stream_vad_e2e.onnx"));
  const starts: number[] = [];
  const ends: number[] = [];
  const vad = await createVad(fireRedVad({ model }), {
    speechThreshold: 0.4,
    onSpeechStart: (t) => starts.push(t),
    onSpeechEnd: (e) => ends.push(e.time),
  });
  await vad.processChunk(loadPcm());
  // Python pipeline reference for this clip: speech ~0.28–1.83 s.
  expect(starts).toHaveLength(1);
  expect(starts[0]).toBeGreaterThanOrEqual(0.1);
  expect(starts[0]).toBeLessThanOrEqual(0.45);
  expect(ends.length).toBeLessThanOrEqual(1); // trailing speech may not have ended
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/fireredvad.test.ts` → FAIL (module not found).

- [ ] **Step 5: Implement the provider**

`src/providers/fireredvad.ts`:
```ts
import * as ort from "onnxruntime-web";

import type { ProviderFactory, VadProvider } from "../types.js";
import { SAMPLE_RATE } from "../types.js";

const WINDOW = 400;
const HOP = 160;
const PACKED_CACHE_SIZE = 1024;
const CACHE_LEN = 19;

export interface FireRedVadOptions {
  /** Model URL or bytes; defaults to the bundled model resolved via import.meta.url. */
  model?: string | Uint8Array;
  sessionOptions?: ort.InferenceSession.SessionOptions;
}

/** FireRedVAD streaming provider (PCM-in e2e ONNX, 10 ms frames). */
export function fireRedVad(options: FireRedVadOptions = {}): ProviderFactory {
  return async () => {
    const model = options.model ??
      new URL("../../models/fireredvad_stream_vad_e2e.onnx", import.meta.url).toString();
    const session = await ort.InferenceSession.create(
      model as string, options.sessionOptions);
    return new FireRedProvider(session);
  };
}

class FireRedProvider implements VadProvider {
  readonly windowSamples = WINDOW;
  readonly hopSamples = HOP;
  readonly frameSec = HOP / SAMPLE_RATE;
  private caches = zeroCaches();

  constructor(private readonly session: ort.InferenceSession) {}

  async process(samples: Float32Array): Promise<Float32Array> {
    const outputs = await this.session.run({
      pcm: new ort.Tensor("float32", samples, [1, samples.length]),
      caches_packed: this.caches,
    });
    this.caches = outputs.new_caches_packed;
    return outputs.probs.data as Float32Array;
  }

  reset(): void {
    this.caches = zeroCaches();
  }
}

function zeroCaches(): ort.Tensor {
  return new ort.Tensor(
    "float32",
    new Float32Array(PACKED_CACHE_SIZE * CACHE_LEN),
    [1, PACKED_CACHE_SIZE, CACHE_LEN]);
}
```

- [ ] **Step 6: Run tests, verify pass, commit**

Run: `npx vitest run tests/fireredvad.test.ts` → PASS
```bash
git add -A && git commit -m "Add FireRedVAD provider with onnxruntime parity fixture"
```

---

### Task 7: Silero provider + parity fixture

**Files:**
- Create: `src/providers/silero.ts`, `models/silero_vad.onnx` (downloaded), append to `models/NOTICE`
- Create: `scripts/generate_silero_fixture.py`, `tests/fixtures/silero.json`
- Test: `tests/silero.test.ts`

**Interfaces:**
- Consumes: `VadProvider`, `ProviderFactory`, `SAMPLE_RATE` (Task 2), `createVad` (Task 5).
- Produces: `sileroVad(options?: { model?: string | Uint8Array; sessionOptions?: ort.InferenceSession.SessionOptions }): ProviderFactory`.

- [ ] **Step 1: Download the pinned model and verify its interface**

```bash
curl -L -o models/silero_vad.onnx \
  https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx
shasum -a 256 models/silero_vad.onnx  # record in models/NOTICE
uv run --with onnx python -c "
import onnx
m = onnx.load('models/silero_vad.onnx')
print('inputs:', [(i.name, [d.dim_param or d.dim_value for d in i.type.tensor_type.shape.dim]) for i in m.graph.input])
print('outputs:', [o.name for o in m.graph.output])"
```

Expected (verify, do not assume): inputs `input` [batch, samples], `state` [2, batch, 128], `sr` scalar int64; outputs `output` [batch, 1], `stateN` [2, batch, 128]. The v5 model consumes 64 samples of leading context per 512-sample window — the Python wrapper prepends the previous window's last 64 samples, so `input` is fed as [1, 576]. **Confirm against the wrapper source** (`src/silero_vad/utils_vad.py`, class `OnnxWrapper`, `_context` handling, at tag v5.1.2) before implementing; if the interface differs from this description, update provider and fixture code to match the wrapper exactly — the wrapper is the reference, this plan text is not.

Append to `models/NOTICE`:
```
silero_vad.onnx
  Silero VAD v5.1.2 (https://github.com/snakers4/silero-vad), MIT.
  sha256: <recorded hash>
```

- [ ] **Step 2: Write and run the fixture generator**

`scripts/generate_silero_fixture.py`:
```python
#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["silero-vad==5.1.2", "soundfile", "numpy", "onnxruntime"]
# ///
"""Golden per-window probabilities from the silero-vad package (ONNX mode).

Reference: silero_vad.load_silero_vad(onnx=True) called per 512-sample
window, exactly as the package's VADIterator does.
"""
import json
import os

import numpy as np
import soundfile as sf
import torch
from silero_vad import load_silero_vad

HERE = os.path.dirname(os.path.abspath(__file__))

wav, sr = sf.read(os.path.join(HERE, "..", "tests", "assets", "hello_en.wav"), dtype="int16")
assert sr == 16000
pcm = (wav / 32768.0).astype(np.float32)

model = load_silero_vad(onnx=True)
model.reset_states()
probs = []
for i in range(0, len(pcm) - 511, 512):
    chunk = torch.from_numpy(pcm[i:i + 512])
    probs.append(float(model(chunk, 16000).item()))

out = os.path.join(HERE, "..", "tests", "fixtures", "silero.json")
with open(out, "w") as f:
    json.dump({"wav": "hello_en.wav", "windowSamples": 512, "probs": probs}, f)
print(f"wrote {out} ({len(probs)} windows)")
```

Run: `uv run scripts/generate_silero_fixture.py`
Expected: `wrote .../silero.json (70 windows)` (35840 // 512 = 70).

- [ ] **Step 3: Write the failing provider test**

`tests/silero.test.ts`:
```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createVad } from "../src/index.js";
import { sileroVad } from "../src/providers/silero.js";
import { readWav16kMono } from "./wav.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("matches the silero-vad package frame by frame", async () => {
  const fixture = JSON.parse(readFileSync(path.join(HERE, "fixtures", "silero.json"), "utf-8"));
  const model = readFileSync(path.join(HERE, "..", "models", "silero_vad.onnx"));
  const vad = await createVad(sileroVad({ model }));

  const buf = readFileSync(path.join(HERE, "assets", "hello_en.wav"));
  const pcm = readWav16kMono(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  const frames = [];
  for (let i = 0; i < pcm.length; i += 700) { // deliberately not a multiple of 512
    frames.push(...await vad.processChunk(pcm.subarray(i, i + 700)));
  }
  expect(frames.length).toBe(fixture.probs.length);
  for (let i = 0; i < frames.length; i++) {
    expect(Math.abs(frames[i].probability - fixture.probs[i]), `window ${i}`)
      .toBeLessThanOrEqual(1e-4 + 1e-3 * Math.abs(fixture.probs[i]));
  }
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/silero.test.ts` → FAIL (module not found).

- [ ] **Step 5: Implement the provider (per the verified interface)**

`src/providers/silero.ts` (adjust to Step 1's findings if they differ):
```ts
import * as ort from "onnxruntime-web";

import type { ProviderFactory, VadProvider } from "../types.js";
import { SAMPLE_RATE } from "../types.js";

const WINDOW = 512;
const CONTEXT = 64;
const STATE_DIMS = [2, 1, 128];

export interface SileroVadOptions {
  model?: string | Uint8Array;
  sessionOptions?: ort.InferenceSession.SessionOptions;
}

/** Silero VAD v5 provider (512-sample windows, 32 ms frames). */
export function sileroVad(options: SileroVadOptions = {}): ProviderFactory {
  return async () => {
    const model = options.model ??
      new URL("../../models/silero_vad.onnx", import.meta.url).toString();
    const session = await ort.InferenceSession.create(model as string, options.sessionOptions);
    return new SileroProvider(session);
  };
}

class SileroProvider implements VadProvider {
  readonly windowSamples = WINDOW;
  readonly hopSamples = WINDOW;
  readonly frameSec = WINDOW / SAMPLE_RATE;
  private state = zeroState();
  private context = new Float32Array(CONTEXT);
  private readonly sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);

  constructor(private readonly session: ort.InferenceSession) {}

  async process(samples: Float32Array): Promise<Float32Array> {
    const numWindows = samples.length / WINDOW;
    const probs = new Float32Array(numWindows);
    for (let w = 0; w < numWindows; w++) {
      const window = samples.subarray(w * WINDOW, (w + 1) * WINDOW);
      const input = new Float32Array(CONTEXT + WINDOW);
      input.set(this.context);
      input.set(window, CONTEXT);
      const outputs = await this.session.run({
        input: new ort.Tensor("float32", input, [1, input.length]),
        state: this.state,
        sr: this.sr,
      });
      this.state = outputs.stateN;
      this.context = window.slice(WINDOW - CONTEXT);
      probs[w] = (outputs.output.data as Float32Array)[0];
    }
    return probs;
  }

  reset(): void {
    this.state = zeroState();
    this.context = new Float32Array(CONTEXT);
  }
}

function zeroState(): ort.Tensor {
  return new ort.Tensor(
    "float32",
    new Float32Array(STATE_DIMS[0] * STATE_DIMS[1] * STATE_DIMS[2]),
    STATE_DIMS);
}
```

- [ ] **Step 6: Run tests, verify pass, commit**

Run: `npx vitest run tests/silero.test.ts` → PASS. If probabilities disagree beyond tolerance, diff the provider against `OnnxWrapper.__call__` in the pinned silero-vad source (context handling and state threading are the usual culprits) before touching tolerances.
```bash
git add -A && git commit -m "Add Silero VAD provider with silero-vad parity fixture"
```

---

### Task 8: Cross-provider invariant + build check

**Files:**
- Create: `tests/crossProvider.test.ts`
- Modify: `package.json` (no changes expected; verify `exports` resolve)

**Interfaces:**
- Consumes: `createVad` (Task 5), `fireRedVad` (Task 6), `sileroVad` (Task 7).

- [ ] **Step 1: Write the cross-provider test**

`tests/crossProvider.test.ts`:
```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createVad } from "../src/index.js";
import { fireRedVad } from "../src/providers/fireredvad.js";
import { sileroVad } from "../src/providers/silero.js";
import { readWav16kMono } from "./wav.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("both providers agree the utterance is roughly 0.3-1.8 s", async () => {
  const buf = readFileSync(path.join(HERE, "assets", "hello_en.wav"));
  const pcm = readWav16kMono(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  const factories = {
    fireRedVad: fireRedVad({ model: readFileSync(path.join(HERE, "..", "models", "fireredvad_stream_vad_e2e.onnx")) }),
    sileroVad: sileroVad({ model: readFileSync(path.join(HERE, "..", "models", "silero_vad.onnx")) }),
  };
  for (const [name, factory] of Object.entries(factories)) {
    const starts: number[] = [];
    const vad = await createVad(factory, {
      speechThreshold: 0.4,
      onSpeechStart: (t) => starts.push(t),
    });
    await vad.processChunk(pcm);
    expect(starts, name).toHaveLength(1);
    expect(starts[0], name).toBeGreaterThanOrEqual(0.0);
    expect(starts[0], name).toBeLessThanOrEqual(0.6);
  }
});
```

- [ ] **Step 2: Run the full suite, typecheck, and build**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all PASS; `dist/` contains `index.js`, `providers/fireredvad.js`, `providers/silero.js`.

- [ ] **Step 3: Verify the built package resolves in bare Node**

```bash
node -e "import('./dist/index.js').then(m => console.log('core:', Object.keys(m).length))"
node -e "import('./dist/providers/fireredvad.js').then(m => console.log('firered:', Object.keys(m)))"
```
Expected: both print export lists without resolution errors.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Add cross-provider invariant test and verify package build"
```

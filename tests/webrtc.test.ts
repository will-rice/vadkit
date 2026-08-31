import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { createVad } from "#index.ts";
import { webrtcVad } from "#providers/webrtc.ts";

import { readWav16kMono } from "./wav.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadPcm(): Float32Array {
  const buf = readFileSync(path.join(HERE, "assets", "hello_en.wav"));
  return readWav16kMono(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

const fixture = JSON.parse(readFileSync(path.join(HERE, "fixtures", "webrtc.json"), "utf-8")) as {
  wav: string;
  frameMs: number;
  modes: Record<string, number[]>;
};

for (const mode of [0, 1, 2, 3] as const) {
  test(`mode ${String(mode)} matches py-webrtcvad bit-exactly`, async () => {
    const expected = fixture.modes[String(mode)];
    expect(expected).toBeDefined();
    if (expected === undefined) return;

    const vad = await createVad(webrtcVad({ aggressiveness: mode }));
    const pcm = loadPcm();
    const frames = [];
    for (let i = 0; i < pcm.length; i += 700) {
      // deliberately not a multiple of the 160-sample frame
      frames.push(...(await vad.processChunk(pcm.subarray(i, i + 700))));
    }
    expect(frames.length).toBe(expected.length);
    for (let i = 0; i < frames.length; i++) {
      expect(frames[i]?.probability, `frame ${String(i)}`).toBe(expected[i]);
    }
  });
}

test("binary decisions drive the segmenter through smoothing", async () => {
  const starts: number[] = [];
  const vad = await createVad(webrtcVad({ aggressiveness: 3 }), {
    speechThreshold: 0.5,
    onSpeechStart: (t) => starts.push(t),
  });
  await vad.processChunk(loadPcm());
  expect(starts.length).toBeGreaterThanOrEqual(1);
  const start = starts[0] ?? NaN;
  expect(start).toBeGreaterThanOrEqual(0.0);
  expect(start).toBeLessThanOrEqual(0.7);
});

test("reset restores initial state bit-exactly", async () => {
  const expected = fixture.modes["3"];
  expect(expected).toBeDefined();
  if (expected === undefined) return;

  const vad = await createVad(webrtcVad({ aggressiveness: 3 }));
  const pcm = loadPcm();
  const first = (await vad.processChunk(pcm)).map((f) => f.probability);
  await vad.reset();
  const second = (await vad.processChunk(pcm)).map((f) => f.probability);
  expect(second).toEqual(first);
  expect(first).toEqual(expected);
});

test("20 ms frames use 320-sample geometry", async () => {
  const vad = await createVad(webrtcVad({ aggressiveness: 2, frameMs: 20 }));
  const frames = await vad.processChunk(loadPcm());
  expect(frames.length).toBe(112); // 35840 / 320
  expect(vad.stream.provider.hopSamples).toBe(320);
  expect(vad.stream.provider.frameSec).toBeCloseTo(0.02, 9);
});

test("dispose frees the wasm instance and frame buffer", async () => {
  const vad = await createVad(webrtcVad());
  await vad.processChunk(loadPcm());
  await vad.dispose(); // must not throw; frees _fvad_new + _malloc allocations
});

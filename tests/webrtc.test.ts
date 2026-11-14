import { expect, test } from "vite-plus/test";

import { createVad } from "#index.ts";
import type { FvadModule } from "#providers/libfvad/fvad.js";
import { webrtcVad } from "#providers/webrtc.ts";

import { loadFixture, loadPcm } from "./helpers.ts";

const fixture = (await loadFixture("webrtc.json")) as {
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
    const pcm = await loadPcm();
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
  await vad.processChunk(await loadPcm());
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
  const pcm = await loadPcm();
  const first = (await vad.processChunk(pcm)).map((f) => f.probability);
  await vad.reset();
  const second = (await vad.processChunk(pcm)).map((f) => f.probability);
  expect(second).toEqual(first);
  expect(first).toEqual(expected);
});

test("20 ms frames use 320-sample geometry", async () => {
  const vad = await createVad(webrtcVad({ aggressiveness: 2, frameMs: 20 }));
  const frames = await vad.processChunk(await loadPcm());
  expect(frames.length).toBe(112); // 35840 / 320
  expect(vad.stream.provider.hopSamples).toBe(320);
  expect(vad.stream.provider.frameSec).toBeCloseTo(0.02, 9);
});

test("dispose frees the wasm instance and frame buffer", async () => {
  const vad = await createVad(webrtcVad());
  await vad.processChunk(await loadPcm());
  // The provider's two heap blocks, read from its private fields: the wasm
  // heap has no other window, and src carries no test hook.
  const { module, instance, frameBuffer } = vad.stream.provider as unknown as {
    module: FvadModule;
    instance: number;
    frameBuffer: number;
  };
  await vad.dispose();
  // The allocator hands a freed block back to the next request of its
  // size; a block still held would force a fresh address instead.
  expect(module._fvad_new()).toBe(instance);
  expect(module._malloc(vad.stream.provider.windowSamples * 2)).toBe(frameBuffer);
});

test("unsupported aggressiveness or frameMs is rejected before any wasm allocation", () => {
  // Plain-JS callers get no type check on these unions.
  expect(() => webrtcVad({ aggressiveness: 4 as 3 })).toThrow(
    /aggressiveness must be 0, 1, 2 or 3/,
  );
  expect(() => webrtcVad({ frameMs: 15 as 10 })).toThrow(/frameMs must be 10, 20 or 30/);
});

import { expect, test } from "vite-plus/test";

import { micSource } from "#micSource.ts";

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = (): void => {
      if (predicate()) resolve();
      else if (performance.now() - started > timeoutMs) reject(new Error("timed out"));
      else setTimeout(tick, 20);
    };
    tick();
  });
}

test("captures Float32Array chunks from the microphone and stop() ends delivery", async () => {
  const chunks: Float32Array[] = [];
  const source = micSource();
  await source.start((pcm) => chunks.push(pcm));
  await waitFor(() => chunks.length >= 3);
  expect(chunks[0]).toBeInstanceOf(Float32Array);
  expect(chunks.every((c) => c.length > 0)).toBe(true);

  await source.stop();
  const delivered = chunks.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(chunks.length).toBe(delivered);
});

test("start() can be called again after stop()", async () => {
  const source = micSource();
  await source.start(() => undefined);
  await source.stop();
  await source.start(() => undefined);
  await source.stop();
});

test("start() rejects when the browser does not honor 16 kHz, instead of delivering it", async () => {
  // A real AudioContext that ignores the requested rate, as a browser that
  // cannot open the device at 16 kHz would.
  const Native = AudioContext;
  class Fixed48k extends Native {
    constructor() {
      super({ sampleRate: 48000 });
    }
  }
  globalThis.AudioContext = Fixed48k;
  try {
    const chunks: Float32Array[] = [];
    await expect(micSource().start((pcm) => chunks.push(pcm))).rejects.toThrow(/16 kHz/);
    expect(chunks).toHaveLength(0);
  } finally {
    globalThis.AudioContext = Native;
  }
});

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

test("overlapping stop() calls all resolve", async () => {
  const source = micSource();
  await source.start(() => undefined);
  await Promise.all([source.stop(), source.stop()]);
});

test("stop() during a pending start() rejects the start and leaves no capture running", async () => {
  const chunks: Float32Array[] = [];
  const source = micSource();
  const started = source.start((pcm) => chunks.push(pcm));
  const outcome = started.then(
    () => "resolved",
    (error: unknown) => String(error),
  );
  await source.stop();
  const delivered = chunks.length;
  expect(await outcome).toMatch(/stopped before start\(\) completed/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(chunks.length).toBe(delivered);
});

test("a start() during a stop() in flight waits for it and releases every stream it opened", async () => {
  const devices = navigator.mediaDevices;
  const native = devices.getUserMedia.bind(devices);
  // Opened up front and handed out without delay, so the restart's stream
  // always arrives while the stop is still draining the worklet.
  const streams = [await native({ audio: true }), await native({ audio: true })];
  let opened = 0;
  devices.getUserMedia = (): Promise<MediaStream> => {
    const stream = streams[opened];
    opened += 1;
    return stream === undefined
      ? Promise.reject(new Error("unexpected getUserMedia call"))
      : Promise.resolve(stream);
  };
  try {
    const chunks: Float32Array[] = [];
    const source = micSource();
    await source.start(() => undefined);
    const stopped = source.stop();
    const restarted = source.start((pcm) => chunks.push(pcm));
    await stopped;
    await restarted;
    await waitFor(() => chunks.length >= 1);
    await source.stop();
  } finally {
    devices.getUserMedia = native;
  }
  const states = streams.flatMap((stream) => stream.getTracks().map((track) => track.readyState));
  expect(states).toEqual(["ended", "ended"]);
});

test("start() while already started rejects and leaves the capture running", async () => {
  const chunks: Float32Array[] = [];
  const source = micSource();
  await source.start((pcm) => chunks.push(pcm));
  try {
    await expect(source.start(() => undefined)).rejects.toThrow("microphone already started");
    const delivered = chunks.length;
    await waitFor(() => chunks.length > delivered);
  } finally {
    await source.stop();
  }
});

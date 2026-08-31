import { expect, test } from "vite-plus/test";

import { ChunkBuffer } from "#engine/chunkBuffer.ts";

function ramp(start: number, length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => start + i);
}

test("buffers until one full window is available", () => {
  const buf = new ChunkBuffer(400, 160);
  expect(buf.push(ramp(0, 399))).toBeNull();
  const run = buf.push(ramp(399, 1));
  expect(run?.length).toBe(400);
  expect(run?.[0]).toBe(0);
});

test("returns maximal runs and carries the overlap", () => {
  const buf = new ChunkBuffer(400, 160);
  // 1000 samples: n = floor((1000-400)/160)+1 = 4 frames -> run 400+3*160 = 880,
  // consumed 4*160 = 640, retained 360.
  const run1 = buf.push(ramp(0, 1000));
  expect(run1?.length).toBe(880);
  // 360 retained + 240 new = 600: n = 2 -> run 560, first sample is index 640.
  const run2 = buf.push(ramp(1000, 240));
  expect(run2?.length).toBe(560);
  expect(run2?.[0]).toBe(640);
});

test("window == hop providers get exact multiples", () => {
  const buf = new ChunkBuffer(512, 512);
  // 1200 samples: n = floor((1200-512)/512)+1 = 2 -> run 1024, retained 176.
  const run = buf.push(ramp(0, 1200));
  expect(run?.length).toBe(1024);
  // 176 + 340 = 516 >= 512 -> exactly one more window.
  expect(buf.push(ramp(1200, 340))?.length).toBe(512);
});

test("reset drops buffered samples", () => {
  const buf = new ChunkBuffer(400, 160);
  buf.push(ramp(0, 399));
  buf.reset();
  expect(buf.push(ramp(0, 399))).toBeNull();
});

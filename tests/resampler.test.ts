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
    expect((all[i] ?? NaN) - (all[i - 1] ?? NaN)).toBeCloseTo(2, 6);
  }
});

test("output length converges to input * 16000 / fromRate", () => {
  const r = new LinearResampler(48000);
  let out = 0;
  for (let c = 0; c < 50; c++) out += r.process(new Float32Array(480)).length;
  expect(out).toBeGreaterThanOrEqual(7998); // 50*480/3 = 8000, minus edge samples
  expect(out).toBeLessThanOrEqual(8000);
});

test("reset clears carried state", () => {
  const r = new LinearResampler(48000);
  const first = r.process(Float32Array.from({ length: 99 }, (_, i) => i));
  r.reset();
  const second = r.process(Float32Array.from({ length: 99 }, (_, i) => i));
  expect(second).toEqual(first);
});

test("carries overshoot across batches: no drift at 48 kHz with 2048-sample batches", () => {
  const r = new LinearResampler(48000);
  const out: number[] = [];
  for (let b = 0; b < 8; b++) {
    out.push(...r.process(Float32Array.from({ length: 2048 }, (_, i) => b * 2048 + i)));
  }
  // A pure ramp must resample to a pure ramp: every output exactly 3 apart,
  // and the last output anchored to its true input position.
  for (let i = 1; i < out.length; i++) {
    expect((out[i] ?? NaN) - (out[i - 1] ?? NaN)).toBeCloseTo(3, 6);
  }
  expect(out[out.length - 1] ?? NaN).toBeCloseTo(3 * (out.length - 1), 6);
});

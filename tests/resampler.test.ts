import { expect, test } from "vite-plus/test";

import { LinearResampler } from "../src/engine/resampler.js";

function tone(frequency: number, sampleRate: number, length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) =>
    Math.sin((2 * Math.PI * frequency * i) / sampleRate),
  );
}

function rms(samples: ArrayLike<number>, from = 0): number {
  let sum = 0;
  for (let i = from; i < samples.length; i++) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / (samples.length - from));
}

test("identity at 16 kHz", () => {
  const r = new LinearResampler(16000);
  const input = Float32Array.from([1, 2, 3]);
  expect(r.process(input)).toBe(input);
});

test("halves the rate from 32 kHz with no discontinuity across chunks", () => {
  const r = new LinearResampler(32000);
  // A pure ramp resamples to a pure ramp regardless of chunk boundaries
  // (the anti-alias filter has unity DC gain and its delay is compensated),
  // once past the filter's zero-primed warm-up.
  const a = r.process(Float32Array.from({ length: 200 }, (_, i) => i));
  const b = r.process(Float32Array.from({ length: 200 }, (_, i) => 200 + i));
  const all = [...a, ...b];
  expect(all.length).toBeGreaterThanOrEqual(180);
  const warmup = 40;
  for (let i = warmup; i < all.length; i++) {
    expect((all[i] ?? NaN) - (all[i - 1] ?? NaN)).toBeCloseTo(2, 3);
  }
});

test("output length converges to input * 16000 / fromRate", () => {
  const r = new LinearResampler(48000);
  let out = 0;
  for (let c = 0; c < 50; c++) out += r.process(new Float32Array(480)).length;
  // 50*480/3 = 8000, minus the filter's compensated group delay and edges.
  expect(out).toBeGreaterThanOrEqual(7960);
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
  // A pure ramp must resample to a pure ramp: outputs 3 apart, and the last
  // output anchored to its true input position — group delay is compensated,
  // so timestamps do not shift.
  const warmup = 60;
  for (let i = warmup; i < out.length; i++) {
    expect((out[i] ?? NaN) - (out[i - 1] ?? NaN)).toBeCloseTo(3, 2);
  }
  expect(out[out.length - 1] ?? NaN).toBeCloseTo(3 * (out.length - 1), 1);
});

test("48 kHz content above the output Nyquist is attenuated, not aliased", () => {
  // 15 kHz at 48 kHz would fold to 1 kHz at 16 kHz — right in the speech
  // band — without an anti-alias filter (plain linear interpolation keeps
  // ~40% of its amplitude). The filter must remove nearly all of it.
  const r = new LinearResampler(48000);
  const out = r.process(tone(15000, 48000, 48000));
  expect(rms(out, 200)).toBeLessThan(0.01);
});

test("48 kHz speech-band content passes through at full level", () => {
  const r = new LinearResampler(48000);
  const out = r.process(tone(1000, 48000, 48000));
  const expected = Math.SQRT1_2; // RMS of a unit sine
  expect(rms(out, 200)).toBeGreaterThan(expected * 0.95);
  expect(rms(out, 200)).toBeLessThan(expected * 1.05);
});

test("44.1 kHz (non-integer ratio) preserves the speech band and rejects the alias band", () => {
  const r = new LinearResampler(44100);
  const pass = r.process(tone(2000, 44100, 44100));
  expect(rms(pass, 200)).toBeGreaterThan(Math.SQRT1_2 * 0.95);
  r.reset();
  const stop = r.process(tone(12000, 44100, 44100));
  expect(rms(stop, 200)).toBeLessThan(0.01);
});

test("upsampling from 8 kHz still works (no filter needed)", () => {
  const r = new LinearResampler(8000);
  const out = r.process(tone(1000, 8000, 8000));
  expect(out.length).toBeGreaterThanOrEqual(15998);
  expect(rms(out, 10)).toBeGreaterThan(Math.SQRT1_2 * 0.9);
});

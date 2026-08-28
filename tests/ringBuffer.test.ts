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

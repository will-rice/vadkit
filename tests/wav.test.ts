import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { encodeWav } from "#wav.ts";

import { readWav16kMono } from "./wav.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("reads hello_en.wav as 16 kHz mono float PCM", () => {
  const buf = readFileSync(path.join(HERE, "assets", "hello_en.wav"));
  const pcm = readWav16kMono(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  expect(pcm.length).toBe(35840); // 2.24 s at 16 kHz
  expect(Math.max(...pcm)).toBeLessThanOrEqual(1);
  expect(Math.min(...pcm)).toBeGreaterThanOrEqual(-1);
});

test("encodeWav round-trips through the reader within 16-bit precision", () => {
  const pcm = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7) * 0.8);
  const decoded = readWav16kMono(encodeWav(pcm));
  expect(decoded.length).toBe(pcm.length);
  for (const [i, sample] of decoded.entries()) {
    expect(Math.abs(sample - (pcm[i] ?? NaN))).toBeLessThanOrEqual(1 / 32768);
  }
});

test("encodeWav clips out-of-range samples instead of wrapping", () => {
  const decoded = readWav16kMono(encodeWav(Float32Array.from([2, -2, 1, -1])));
  expect(decoded[0]).toBeCloseTo(32767 / 32768, 9);
  expect(decoded[1]).toBe(-1);
  expect(decoded[2]).toBeCloseTo(32767 / 32768, 9);
  expect(decoded[3]).toBe(-1);
});

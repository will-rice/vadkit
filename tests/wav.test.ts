import { expect, test } from "vite-plus/test";

import { encodeWav } from "#wav.ts";

import { loadPcm, readWav16kMono } from "./helpers.ts";

test("reads hello_en.wav as 16 kHz mono float PCM", async () => {
  const pcm = await loadPcm();
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

test.for([
  [[], 16000],
  [[8000], 8000],
] as const)("encodeWav(pcm, ...%j) writes a canonical %i Hz header", ([rateArgs, rate]) => {
  const buffer = encodeWav(new Float32Array(1000), ...rateArgs);
  const view = new DataView(buffer);
  expect(buffer.byteLength).toBe(44 + 2000);
  const header = {
    riff: view.getUint32(0),
    riffSize: view.getUint32(4, true),
    wave: view.getUint32(8),
    fmt: view.getUint32(12),
    fmtSize: view.getUint32(16, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: view.getUint32(36),
    dataSize: view.getUint32(40, true),
  };
  expect(header).toEqual({
    riff: 0x52494646,
    riffSize: 36 + 2000,
    wave: 0x57415645,
    fmt: 0x666d7420,
    fmtSize: 16,
    format: 1,
    channels: 1,
    sampleRate: rate,
    byteRate: rate * 2,
    blockAlign: 2,
    bitsPerSample: 16,
    data: 0x64617461,
    dataSize: 2000,
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { readWav16kMono } from "./wav.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("reads hello_en.wav as 16 kHz mono float PCM", () => {
  const buf = readFileSync(path.join(HERE, "assets", "hello_en.wav"));
  const pcm = readWav16kMono(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  expect(pcm.length).toBe(35840); // 2.24 s at 16 kHz
  expect(Math.max(...pcm)).toBeLessThanOrEqual(1);
  expect(Math.min(...pcm)).toBeGreaterThanOrEqual(-1);
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { createVad } from "../src/index.js";
import { fireRedVad } from "../src/providers/fireredvad.js";
import { sileroVad } from "../src/providers/silero.js";
import { readWav16kMono } from "./wav.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("both providers agree the utterance starts around 0.3 s", async () => {
  const buf = readFileSync(path.join(HERE, "assets", "hello_en.wav"));
  const pcm = readWav16kMono(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  const factories = {
    fireRedVad: fireRedVad({
      model: readFileSync(path.join(HERE, "..", "models", "fireredvad_stream_vad_e2e.onnx")),
    }),
    sileroVad: sileroVad({
      model: readFileSync(path.join(HERE, "..", "models", "silero_vad.onnx")),
    }),
  };
  for (const [name, factory] of Object.entries(factories)) {
    const starts: number[] = [];
    const vad = await createVad(factory, {
      speechThreshold: 0.4,
      onSpeechStart: (t) => starts.push(t),
    });
    await vad.processChunk(pcm);
    expect(starts, name).toHaveLength(1);
    expect(starts[0], name).toBeGreaterThanOrEqual(0.0);
    expect(starts[0], name).toBeLessThanOrEqual(0.6);
  }
});

test("concurrent processChunk across ONNX providers is serialized safely", async () => {
  const buf = readFileSync(path.join(HERE, "assets", "hello_en.wav"));
  const pcm = readWav16kMono(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  const [fireRed, silero] = await Promise.all([
    createVad(
      fireRedVad({
        model: readFileSync(path.join(HERE, "..", "models", "fireredvad_stream_vad_e2e.onnx")),
      }),
    ),
    createVad(
      sileroVad({ model: readFileSync(path.join(HERE, "..", "models", "silero_vad.onnx")) }),
    ),
  ]);
  // Interleave un-awaited chunks across both providers, like an app driving
  // two VADs from one AudioWorklet callback.
  const pending: Promise<unknown>[] = [];
  for (let i = 0; i < pcm.length; i += 1600) {
    const chunk = pcm.subarray(i, i + 1600);
    pending.push(fireRed.processChunk(chunk), silero.processChunk(chunk));
  }
  await Promise.all(pending); // must not reject with ort "Session already started"
});

import { expect, test } from "vite-plus/test";

import { createVad } from "#index.ts";
import { fireRedVad } from "#providers/fireredvad.ts";
import { sileroVad } from "#providers/silero.ts";

import { loadModel, loadPcm } from "./helpers.ts";

test("both providers agree the utterance starts around 0.3 s", async () => {
  const pcm = await loadPcm();
  const factories = {
    fireRedVad: fireRedVad({ model: await loadModel("fireredvad_stream_vad_e2e.onnx") }),
    sileroVad: sileroVad({ model: await loadModel("silero_vad.onnx") }),
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
  const pcm = await loadPcm();
  const [fireRed, silero] = await Promise.all([
    createVad(fireRedVad({ model: await loadModel("fireredvad_stream_vad_e2e.onnx") })),
    createVad(sileroVad({ model: await loadModel("silero_vad.onnx") })),
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

import { expect, test } from "vite-plus/test";

import { createVad } from "#index.ts";
import { fireRedVad } from "#providers/fireredvad.ts";
import { fsmnVad } from "#providers/fsmn.ts";
import { sileroVad } from "#providers/silero.ts";

import { loadModel, loadPcm } from "./helpers.ts";

// Thresholds are per-provider because the models are calibrated differently:
// FSMN-VAD sits near 0.5 on non-speech, and FunASR reads it against 0.6. The
// invariant under test is geometry and units, not calibration.
const THRESHOLDS: Record<string, number> = { fsmnVad: 0.7 };

test("every provider agrees the utterance starts around 0.3 s", async () => {
  const pcm = await loadPcm();
  const factories = {
    fireRedVad: fireRedVad({ model: await loadModel("fireredvad_stream_vad_e2e.onnx") }),
    sileroVad: sileroVad({ model: await loadModel("silero_vad.onnx") }),
    fsmnVad: fsmnVad({ model: await loadModel("fsmn_vad_e2e.onnx") }),
  };
  for (const [name, factory] of Object.entries(factories)) {
    const starts: number[] = [];
    const vad = await createVad(factory, {
      speechThreshold: THRESHOLDS[name] ?? 0.4,
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
  const vads = await Promise.all([
    createVad(fireRedVad({ model: await loadModel("fireredvad_stream_vad_e2e.onnx") })),
    createVad(sileroVad({ model: await loadModel("silero_vad.onnx") })),
    createVad(fsmnVad({ model: await loadModel("fsmn_vad_e2e.onnx") })),
  ]);
  // Interleave un-awaited chunks across every provider, like an app driving
  // several VADs from one AudioWorklet callback.
  const pending: Promise<unknown>[] = [];
  for (let i = 0; i < pcm.length; i += 1600) {
    const chunk = pcm.subarray(i, i + 1600);
    pending.push(...vads.map((vad) => vad.processChunk(chunk)));
  }
  await Promise.all(pending); // must not reject with ort "Session already started"
});

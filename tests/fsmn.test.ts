import { expect, test } from "vite-plus/test";

import { createVad } from "#index.ts";
import { fsmnVad } from "#providers/fsmn.ts";

import { loadFixture, loadModel, loadPcm } from "./helpers.ts";

interface Fixture {
  wav: string;
  lfrLead: number;
  receptiveFieldFrames: number;
  probs: number[];
  paddedProbs: number[];
}

// ort-web vs Python onnxruntime, plus our in-graph fbank vs
// kaldi_native_fbank's: float32 rounding only, measured at ~1.5e-6.
function expectClose(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(1e-5 + 1e-3 * Math.abs(expected));
}

async function probabilities(): Promise<number[]> {
  const vad = await createVad(fsmnVad({ model: await loadModel("fsmn_vad_e2e.onnx") }));
  const pcm = await loadPcm();
  const probs: number[] = [];
  for (let i = 0; i < pcm.length; i += 512) {
    for (const f of await vad.processChunk(pcm.subarray(i, i + 512))) probs.push(f.probability);
  }
  await vad.dispose();
  return probs;
}

test("matches the FunASR FSMN-VAD pipeline frame by frame", async () => {
  const fixture = (await loadFixture("fsmnvad.json")) as Fixture;
  const probs = await probabilities();

  expect(probs.length).toBe(fixture.probs.length);
  for (let i = 0; i < probs.length; i++) {
    expectClose(probs[i] ?? NaN, fixture.probs[i] ?? NaN, `frame ${i}`);
  }
});

test("converges on FunASR's padded output past the DFSMN receptive field", async () => {
  const fixture = (await loadFixture("fsmnvad.json")) as Fixture;
  const probs = await probabilities();

  // FunASR's apply_lfr pads lfrLead frames at each end so its output keeps the
  // input frame count; a causal stream can produce neither, so our frame k is
  // its frame k + lfrLead. Those padded frames perturb everything within the
  // DFSMN's receptive field -- the 4 layers' memory blocks stack, each looking
  // back lorder - 1 frames -- and nothing after it.
  const lead = fixture.lfrLead;
  expect(probs.length).toBe(fixture.paddedProbs.length - 2 * lead);
  for (let i = fixture.receptiveFieldFrames; i < probs.length; i++) {
    expectClose(probs[i] ?? NaN, fixture.paddedProbs[i + lead] ?? NaN, `frame ${i}`);
  }
});

test("detects the utterance with default options", async () => {
  const starts: number[] = [];
  const ends: number[] = [];
  const vad = await createVad(fsmnVad({ model: await loadModel("fsmn_vad_e2e.onnx") }), {
    // FSMN-VAD sits near 0.5 on non-speech; FunASR reads it against 0.6.
    speechThreshold: 0.7,
    onSpeechStart: (t) => starts.push(t),
    onSpeechEnd: (u) => ends.push(u.endTime),
  });
  await vad.processChunk(await loadPcm());
  // Python pipeline reference for this clip: speech ~0.28-1.83 s.
  expect(starts).toHaveLength(1);
  expect(starts[0]).toBeGreaterThanOrEqual(0.1);
  expect(starts[0]).toBeLessThanOrEqual(0.45);
  expect(ends.length).toBeLessThanOrEqual(1); // trailing speech may not have ended
});

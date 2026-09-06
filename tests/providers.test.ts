import { expect, test } from "vite-plus/test";

import { createVad } from "#index.ts";
import { fireRedVad } from "#providers/fireredvad.ts";
import { fsmnVad } from "#providers/fsmn.ts";
import { sileroVad } from "#providers/silero.ts";
import { webrtcVad } from "#providers/webrtc.ts";
import type { ProviderFactory } from "#types.ts";

import { loadModel, loadPcm } from "./helpers.ts";

const pcm = await loadPcm();
const PROVIDERS: Record<string, ProviderFactory> = {
  fireRedVad: fireRedVad({ model: await loadModel("fireredvad_stream_vad_e2e.onnx") }),
  sileroVad: sileroVad({ model: await loadModel("silero_vad.onnx") }),
  fsmnVad: fsmnVad({ model: await loadModel("fsmn_vad_e2e.onnx") }),
  webrtcVad: webrtcVad(),
};

async function probabilities(factory: ProviderFactory, chunkSize: number): Promise<number[]> {
  const vad = await createVad(factory);
  const out: number[] = [];
  for (let i = 0; i < pcm.length; i += chunkSize) {
    for (const f of await vad.processChunk(pcm.subarray(i, i + chunkSize))) out.push(f.probability);
  }
  await vad.dispose();
  return out;
}

for (const [name, factory] of Object.entries(PROVIDERS)) {
  test(`${name}: chunk size does not change the frames`, async () => {
    const whole = await probabilities(factory, pcm.length);
    expect(whole.length).toBeGreaterThan(0);
    for (const size of [1, 7, 160, 4096]) {
      const chunked = await probabilities(factory, size);
      expect(chunked.length, `size ${size}`).toBe(whole.length);
      for (const [i, p] of chunked.entries()) {
        // Same model, same state, different run lengths: kernel noise only.
        expect(Math.abs(p - (whole[i] ?? NaN)), `size ${size} frame ${i}`).toBeLessThanOrEqual(
          1e-4,
        );
      }
    }
  });

  test(`${name}: reset() restores the initial state exactly`, async () => {
    const vad = await createVad(factory);
    const first = (await vad.processChunk(pcm)).map((f) => f.probability);
    await vad.reset();
    const second = (await vad.processChunk(pcm)).map((f) => f.probability);
    await vad.dispose();
    expect(second).toEqual(first);
  });
}

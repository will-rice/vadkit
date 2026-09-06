import * as ort from "onnxruntime-web";

import { createSession, runInference } from "#providers/session.ts";
import { SAMPLE_RATE } from "#types.ts";
import type { ProviderFactory, VadProvider } from "#types.ts";

// One output frame stacks 5 consecutive 25 ms fbank frames (LFR m=5, n=1),
// so a frame needs its own 400 samples plus 4 hops of following context.
const WINDOW = 1040;
const HOP = 160;
const CACHE_COUNT = 4; // one per FSMN layer
const CACHE_DIMS = [1, 128, 19, 1]; // proj_dim 128, lorder - 1 = 19

export interface FsmnVadOptions {
  /** Model URL or bytes; defaults to the bundled model resolved via import.meta.url. */
  model?: string | Uint8Array | undefined;
  sessionOptions?: ort.InferenceSession.SessionOptions | undefined;
}

/**
 * FSMN-VAD streaming provider (PCM-in e2e ONNX, 10 ms frames).
 *
 * Probabilities run hot on non-speech compared to the other providers --
 * FunASR's own configuration reads them against 0.6 -- so raise
 * `speechThreshold` above the 0.5 default if onsets trigger early.
 */
export function fsmnVad(options: FsmnVadOptions = {}): ProviderFactory {
  return async (): Promise<VadProvider> => {
    const model =
      options.model ?? new URL("../../models/fsmn_vad_e2e.onnx", import.meta.url).toString();
    const session = await createSession(model, options.sessionOptions);
    return new FsmnProvider(session);
  };
}

class FsmnProvider implements VadProvider {
  readonly windowSamples = WINDOW;
  readonly hopSamples = HOP;
  readonly frameSec = HOP / SAMPLE_RATE;
  private readonly session: ort.InferenceSession;
  private caches = zeroCaches();

  constructor(session: ort.InferenceSession) {
    this.session = session;
  }

  async process(samples: Float32Array): Promise<Float32Array> {
    const outputs = await runInference(this.session, {
      pcm: new ort.Tensor("float32", samples, [1, samples.length]),
      ...this.caches,
    });
    const probs = outputs.probs;
    if (probs === undefined) throw new Error("model did not return probs");
    const caches: Record<string, ort.Tensor> = {};
    for (let i = 0; i < CACHE_COUNT; i++) {
      const cache = outputs[`out_cache${i}`];
      if (cache === undefined) throw new Error(`model did not return out_cache${i}`);
      caches[`in_cache${i}`] = cache;
    }
    this.caches = caches;
    return probs.data as Float32Array;
  }

  reset(): void {
    this.caches = zeroCaches();
  }

  dispose(): Promise<void> {
    return this.session.release();
  }
}

function zeroCaches(): Record<string, ort.Tensor> {
  const size = CACHE_DIMS.reduce((a, b) => a * b, 1);
  const caches: Record<string, ort.Tensor> = {};
  for (let i = 0; i < CACHE_COUNT; i++) {
    caches[`in_cache${i}`] = new ort.Tensor("float32", new Float32Array(size), CACHE_DIMS);
  }
  return caches;
}

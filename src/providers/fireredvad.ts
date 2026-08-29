import * as ort from "onnxruntime-web";

import { SAMPLE_RATE } from "../types.js";
import type { ProviderFactory, VadProvider } from "../types.js";
import { createSession, runInference } from "./session.js";

const WINDOW = 400;
const HOP = 160;
const PACKED_CACHE_SIZE = 1024;
const CACHE_LEN = 19;

export interface FireRedVadOptions {
  /** Model URL or bytes; defaults to the bundled model resolved via import.meta.url. */
  model?: string | Uint8Array | undefined;
  sessionOptions?: ort.InferenceSession.SessionOptions | undefined;
}

/** FireRedVAD streaming provider (PCM-in e2e ONNX, 10 ms frames). */
export function fireRedVad(options: FireRedVadOptions = {}): ProviderFactory {
  return async (): Promise<VadProvider> => {
    const model =
      options.model ??
      new URL("../../models/fireredvad_stream_vad_e2e.onnx", import.meta.url).toString();
    const session = await createSession(model, options.sessionOptions);
    return new FireRedProvider(session);
  };
}

class FireRedProvider implements VadProvider {
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
      caches_packed: this.caches,
    });
    const caches = outputs.new_caches_packed;
    const probs = outputs.probs;
    if (caches === undefined || probs === undefined) {
      throw new Error("model did not return probs and new_caches_packed");
    }
    this.caches = caches;
    return probs.data as Float32Array;
  }

  reset(): void {
    this.caches = zeroCaches();
  }
}

function zeroCaches(): ort.Tensor {
  return new ort.Tensor("float32", new Float32Array(PACKED_CACHE_SIZE * CACHE_LEN), [
    1,
    PACKED_CACHE_SIZE,
    CACHE_LEN,
  ]);
}

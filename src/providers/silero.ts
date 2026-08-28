import * as ort from "onnxruntime-web";

import { SAMPLE_RATE } from "../types.js";
import type { ProviderFactory, VadProvider } from "../types.js";
import { createSession } from "./session.js";

const WINDOW = 512;
const CONTEXT = 64;
const STATE_DIMS = [2, 1, 128];

export interface SileroVadOptions {
  /** Model URL or bytes; defaults to the bundled model resolved via import.meta.url. */
  model?: string | Uint8Array | undefined;
  sessionOptions?: ort.InferenceSession.SessionOptions | undefined;
}

/** Silero VAD v5 provider (512-sample windows, 32 ms frames). */
export function sileroVad(options: SileroVadOptions = {}): ProviderFactory {
  return async (): Promise<VadProvider> => {
    const model = options.model ?? new URL("../../models/silero_vad.onnx", import.meta.url).toString();
    const session = await createSession(model, options.sessionOptions);
    return new SileroProvider(session);
  };
}

class SileroProvider implements VadProvider {
  readonly windowSamples = WINDOW;
  readonly hopSamples = WINDOW;
  readonly frameSec = WINDOW / SAMPLE_RATE;
  private readonly session: ort.InferenceSession;
  private readonly sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
  private state = zeroState();
  private context = new Float32Array(CONTEXT);

  constructor(session: ort.InferenceSession) {
    this.session = session;
  }

  async process(samples: Float32Array): Promise<Float32Array> {
    const numWindows = samples.length / WINDOW;
    const probs = new Float32Array(numWindows);
    for (let w = 0; w < numWindows; w++) {
      const window = samples.subarray(w * WINDOW, (w + 1) * WINDOW);
      const input = new Float32Array(CONTEXT + WINDOW);
      input.set(this.context);
      input.set(window, CONTEXT);
      const outputs = await this.session.run({
        input: new ort.Tensor("float32", input, [1, input.length]),
        state: this.state,
        sr: this.sr,
      });
      const output = outputs.output;
      const stateN = outputs.stateN;
      if (output === undefined || stateN === undefined) {
        throw new Error("model did not return output and stateN");
      }
      this.state = stateN;
      this.context = window.slice(WINDOW - CONTEXT);
      probs[w] = (output.data as Float32Array)[0] ?? NaN;
    }
    return probs;
  }

  reset(): void {
    this.state = zeroState();
    this.context = new Float32Array(CONTEXT);
  }
}

function zeroState(): ort.Tensor {
  return new ort.Tensor(
    "float32",
    new Float32Array(STATE_DIMS.reduce((a, b) => a * b, 1)),
    STATE_DIMS,
  );
}

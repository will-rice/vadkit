import { SAMPLE_RATE } from "../types.js";
import type { ProviderFactory, VadProvider } from "../types.js";
import createFvadModule from "./libfvad/fvad.js";
import type { FvadModule } from "./libfvad/fvad.js";

export interface WebrtcVadOptions {
  /** WebRTC VAD mode: 0 = most permissive ... 3 = most aggressive. Default 0. */
  aggressiveness?: 0 | 1 | 2 | 3 | undefined;
  /** Native frame size in milliseconds. Default 10. */
  frameMs?: 10 | 20 | 30 | undefined;
}

/**
 * WebRTC VAD provider (libfvad compiled to wasm; no model file).
 *
 * Emits hard 0/1 decisions as probabilities of exactly 0 and 1: the
 * segmenter's smoothing turns them into a fraction-of-recent-frames-voiced
 * value, so `speechThreshold` reads as "fraction of the smoothing window
 * that is voiced". Tune sensitivity primarily via `aggressiveness`.
 */
export function webrtcVad(options: WebrtcVadOptions = {}): ProviderFactory {
  const aggressiveness = options.aggressiveness ?? 0;
  const frameMs = options.frameMs ?? 10;
  return async (): Promise<VadProvider> => {
    const module = await createFvadModule();
    return new WebrtcProvider(module, aggressiveness, (SAMPLE_RATE * frameMs) / 1000);
  };
}

class WebrtcProvider implements VadProvider {
  readonly windowSamples: number;
  readonly hopSamples: number;
  readonly frameSec: number;
  private readonly module: FvadModule;
  private readonly aggressiveness: number;
  private readonly instance: number;
  private readonly frameBuffer: number;

  constructor(module: FvadModule, aggressiveness: number, frameSamples: number) {
    this.module = module;
    this.aggressiveness = aggressiveness;
    this.windowSamples = frameSamples;
    this.hopSamples = frameSamples;
    this.frameSec = frameSamples / SAMPLE_RATE;
    this.instance = module._fvad_new();
    this.frameBuffer = module._malloc(frameSamples * 2);
    this.configure();
  }

  process(samples: Float32Array): Promise<Float32Array> {
    const numFrames = samples.length / this.windowSamples;
    const probs = new Float32Array(numFrames);
    const heapOffset = this.frameBuffer >> 1;
    for (let w = 0; w < numFrames; w++) {
      const frame = samples.subarray(w * this.windowSamples, (w + 1) * this.windowSamples);
      for (const [i, sample] of frame.entries()) {
        const scaled = Math.round(sample * 32768);
        this.module.HEAP16[heapOffset + i] = Math.max(-32768, Math.min(32767, scaled));
      }
      const decision = this.module._fvad_process(
        this.instance,
        this.frameBuffer,
        this.windowSamples,
      );
      if (decision < 0) throw new Error("fvad_process rejected the frame");
      probs[w] = decision;
    }
    return Promise.resolve(probs);
  }

  reset(): void {
    this.module._fvad_reset(this.instance);
    this.configure();
  }

  dispose(): Promise<void> {
    this.module._free(this.frameBuffer);
    this.module._fvad_free(this.instance);
    return Promise.resolve();
  }

  private configure(): void {
    if (this.module._fvad_set_sample_rate(this.instance, SAMPLE_RATE) !== 0) {
      throw new Error("fvad_set_sample_rate failed");
    }
    if (this.module._fvad_set_mode(this.instance, this.aggressiveness) !== 0) {
      throw new Error(`fvad_set_mode rejected ${String(this.aggressiveness)}`);
    }
  }
}

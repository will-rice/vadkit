import type { VadProvider } from "../types.js";
import { ChunkBuffer } from "./chunkBuffer.js";
import { Segmenter } from "./segmenter.js";
import type { VadFrame, VadOptions } from "./segmenter.js";
import { SerialQueue } from "./serialQueue.js";

/** Streaming VAD engine over one provider; all state changes are serialized. */
export class VadStream {
  readonly provider: VadProvider;
  readonly options: VadOptions;
  private readonly buffer: ChunkBuffer;
  private readonly segmenter: Segmenter;
  private readonly queue = new SerialQueue();

  constructor(provider: VadProvider, options: VadOptions) {
    for (const [key, value] of Object.entries(options)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${key} must be a finite non-negative number`);
      }
    }
    this.provider = provider;
    this.options = options;
    this.buffer = new ChunkBuffer(provider.windowSamples, provider.hopSamples);
    this.segmenter = new Segmenter(options, provider.frameSec);
  }

  /**
   * Feed PCM of any length; returns one VadFrame per completed frame.
   *
   * Calls are serialized internally, so calling again before the previous
   * call resolves (e.g. from an AudioWorklet message handler) is safe.
   */
  processChunk(pcm: Float32Array): Promise<VadFrame[]> {
    return this.queue.run(() => this.processContiguous(pcm));
  }

  /** Start a new stream. Ordered behind in-flight processChunk calls. */
  reset(): Promise<void> {
    return this.queue.run(() => {
      this.buffer.reset();
      this.segmenter.reset();
      this.provider.reset();
    });
  }

  private async processContiguous(pcm: Float32Array): Promise<VadFrame[]> {
    const run = this.buffer.push(pcm);
    if (run === null) return [];
    const probs = await this.provider.process(run);
    const frames: VadFrame[] = [];
    for (const p of probs) {
      if (!(p >= 0 && p <= 1)) {
        throw new Error(`provider returned probability ${String(p)} outside [0, 1]`);
      }
      frames.push(this.segmenter.process(p));
    }
    return frames;
  }
}

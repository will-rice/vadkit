import type { VadProvider } from "../types.js";
import { ChunkBuffer } from "./chunkBuffer.js";
import { Segmenter } from "./segmenter.js";
import type { VadFrame, VadOptions } from "./segmenter.js";

/** Streaming VAD engine over one provider; all state changes are serialized. */
export class VadStream {
  readonly provider: VadProvider;
  readonly options: VadOptions;
  private readonly buffer: ChunkBuffer;
  private readonly segmenter: Segmenter;
  private pending: Promise<void> = Promise.resolve();

  constructor(provider: VadProvider, options: VadOptions) {
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
    const result = this.pending.then(() => this.processContiguous(pcm));
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Start a new stream. Ordered behind in-flight processChunk calls. */
  reset(): void {
    this.pending = this.pending.then(() => {
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
    for (const p of probs) frames.push(this.segmenter.process(p));
    return frames;
  }
}

import type { ProviderFactory, VadProvider } from "../types.js";
import { ChunkBuffer } from "./chunkBuffer.js";
import { DEFAULT_VAD_OPTIONS, Segmenter } from "./segmenter.js";
import type { VadFrame, VadOptions } from "./segmenter.js";

export interface VadCallbacks {
  onFrame?: ((frame: VadFrame) => void) | undefined;
  onSpeechStart?: ((time: number) => void) | undefined;
  onSpeechEnd?: ((event: { time: number; startTime: number }) => void) | undefined;
}

/** Streaming VAD over one provider; all state changes are serialized. */
export class VadStream {
  readonly provider: VadProvider;
  readonly options: VadOptions;
  private readonly callbacks: VadCallbacks;
  private readonly buffer: ChunkBuffer;
  private readonly segmenter: Segmenter;
  private pending: Promise<void> = Promise.resolve();

  constructor(provider: VadProvider, options: VadOptions, callbacks: VadCallbacks) {
    this.provider = provider;
    this.options = options;
    this.callbacks = callbacks;
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
    for (const p of probs) {
      const frame = this.segmenter.process(p);
      frames.push(frame);
      this.callbacks.onFrame?.(frame);
      for (const event of frame.events) {
        if (event.type === "speech_start") this.callbacks.onSpeechStart?.(event.time);
        else this.callbacks.onSpeechEnd?.({ time: event.time, startTime: event.startTime });
      }
    }
    return frames;
  }
}

export async function createVad(
  factory: ProviderFactory,
  options: Partial<VadOptions> & VadCallbacks = {},
): Promise<VadStream> {
  const { onFrame, onSpeechStart, onSpeechEnd, ...opts } = options;
  const provider = await factory();
  return new VadStream(
    provider,
    { ...DEFAULT_VAD_OPTIONS, ...opts },
    { onFrame, onSpeechStart, onSpeechEnd },
  );
}

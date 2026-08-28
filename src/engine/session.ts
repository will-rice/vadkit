import { SAMPLE_RATE } from "../types.js";
import type { ProviderFactory } from "../types.js";
import { LinearResampler } from "./resampler.js";
import { AudioRingBuffer } from "./ringBuffer.js";
import { DEFAULT_VAD_OPTIONS } from "./segmenter.js";
import type { VadFrame, VadOptions } from "./segmenter.js";
import { VadStream } from "./vadStream.js";

/** A push source of PCM chunks (e.g. a microphone). */
export interface AudioSource {
  /** Begin delivering chunks; resolves once capture is running. */
  start(onChunk: (pcm: Float32Array, sampleRate: number) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface Utterance {
  audio: Float32Array;
  startTime: number;
  endTime: number;
}

export interface VadSessionCallbacks {
  onFrame?: ((frame: VadFrame) => void) | undefined;
  onSpeechStart?: ((time: number) => void) | undefined;
  onSpeechEnd?: ((utterance: Utterance) => void) | undefined;
  /** Receives failures from source-driven processing; unhandled otherwise. */
  onError?: ((error: unknown) => void) | undefined;
}

/** Batteries-included streaming VAD: engine + audio retention + events. */
export class VadSession {
  readonly stream: VadStream;
  private readonly callbacks: VadSessionCallbacks;
  private readonly ring: AudioRingBuffer;
  private resampler: LinearResampler | null = null;
  private source: AudioSource | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(stream: VadStream, callbacks: VadSessionCallbacks) {
    this.stream = stream;
    this.callbacks = callbacks;
    const o = stream.options;
    this.ring = new AudioRingBuffer(
      Math.ceil((o.maxSpeechSec + o.prePadSec + o.fallDelaySec + 1) * SAMPLE_RATE),
    );
  }

  /**
   * Feed 16 kHz PCM of any length; returns one VadFrame per completed frame.
   * Calls are serialized internally, like VadStream.processChunk.
   */
  processChunk(pcm: Float32Array): Promise<VadFrame[]> {
    const result = this.pending.then(() => this.processContiguous(pcm));
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Capture from a source until stop(); chunks are resampled if needed. */
  async start(source: AudioSource): Promise<void> {
    if (this.source !== null) throw new Error("session already started");
    this.source = source;
    await source.start((pcm, sampleRate) => {
      const chunk = sampleRate === SAMPLE_RATE ? pcm : this.resample(pcm, sampleRate);
      const result = this.processChunk(chunk);
      const onError = this.callbacks.onError;
      if (onError) {
        result.catch(onError);
      } else {
        void result;
      }
    });
  }

  async stop(): Promise<void> {
    await this.source?.stop();
    this.source = null;
  }

  /** Start a new utterance stream. Ordered behind in-flight processing. */
  reset(): void {
    this.stream.reset();
    this.pending = this.pending.then(() => {
      this.ring.reset();
      this.resampler = null;
    });
  }

  private async processContiguous(pcm: Float32Array): Promise<VadFrame[]> {
    this.ring.write(pcm);
    const frames = await this.stream.processChunk(pcm);
    for (const frame of frames) {
      this.callbacks.onFrame?.(frame);
      for (const event of frame.events) {
        if (event.type === "speech_start") {
          this.callbacks.onSpeechStart?.(event.time);
        } else {
          this.callbacks.onSpeechEnd?.({
            audio: this.ring.slice(
              Math.round(event.startTime * SAMPLE_RATE),
              Math.round(event.time * SAMPLE_RATE),
            ),
            startTime: event.startTime,
            endTime: event.time,
          });
        }
      }
    }
    return frames;
  }

  private resample(pcm: Float32Array, sampleRate: number): Float32Array {
    this.resampler ??= new LinearResampler(sampleRate);
    return this.resampler.process(pcm);
  }
}

export async function createVad(
  factory: ProviderFactory,
  options: Partial<VadOptions> & VadSessionCallbacks = {},
): Promise<VadSession> {
  const { onFrame, onSpeechStart, onSpeechEnd, onError, ...opts } = options;
  const provider = await factory();
  const stream = new VadStream(provider, { ...DEFAULT_VAD_OPTIONS, ...opts });
  return new VadSession(stream, { onFrame, onSpeechStart, onSpeechEnd, onError });
}

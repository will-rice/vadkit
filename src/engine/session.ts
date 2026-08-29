import { SAMPLE_RATE } from "../types.js";
import type { ProviderFactory } from "../types.js";
import { LinearResampler } from "./resampler.js";
import { AudioRingBuffer } from "./ringBuffer.js";
import { DEFAULT_VAD_OPTIONS } from "./segmenter.js";
import type { VadFrame, VadOptions } from "./segmenter.js";
import { SerialQueue } from "./serialQueue.js";
import { VadStream } from "./vadStream.js";

// Each serialized write/dispatch step advances the ring by at most this many
// samples, so events always slice audio the ring still retains — the ring's
// capacity slack is sized for it in the constructor below.
const MAX_WRITE_SAMPLES = SAMPLE_RATE;

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
  private readonly queue = new SerialQueue();
  private resampler: LinearResampler | null = null;
  private source: AudioSource | null = null;

  constructor(stream: VadStream, callbacks: VadSessionCallbacks) {
    this.stream = stream;
    this.callbacks = callbacks;
    const o = stream.options;
    this.ring = new AudioRingBuffer(
      Math.ceil((o.maxSpeechSec + o.prePadSec + o.fallDelaySec) * SAMPLE_RATE + MAX_WRITE_SAMPLES),
    );
  }

  /**
   * Feed 16 kHz PCM of any length; returns one VadFrame per completed frame.
   * Calls are serialized internally, like VadStream.processChunk.
   */
  processChunk(pcm: Float32Array): Promise<VadFrame[]> {
    return this.queue.run(() => this.processContiguous(pcm));
  }

  /** Capture from a source until stop(); chunks are resampled if needed. */
  async start(source: AudioSource): Promise<void> {
    if (this.source !== null) throw new Error("session already started");
    this.source = source;
    try {
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
    } catch (error) {
      this.source = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.source?.stop();
    this.source = null;
  }

  /** Start a new utterance stream. Ordered behind in-flight processing. */
  reset(): Promise<void> {
    return this.queue.run(async () => {
      await this.stream.reset();
      this.ring.reset();
      this.resampler = null;
    });
  }

  private async processContiguous(pcm: Float32Array): Promise<VadFrame[]> {
    const frames: VadFrame[] = [];
    // Bounded writes keep every emitted event's audio within ring retention,
    // no matter how large the caller's chunk is.
    for (let offset = 0; offset === 0 || offset < pcm.length; offset += MAX_WRITE_SAMPLES) {
      const part = pcm.subarray(offset, offset + MAX_WRITE_SAMPLES);
      this.ring.write(part);
      for (const frame of await this.stream.processChunk(part)) {
        frames.push(frame);
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
  // Drop explicitly-undefined overrides so they cannot clobber defaults
  // (plain-JS consumers get no exactOptionalPropertyTypes check).
  const overrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(opts as Record<string, unknown>)) {
    if (value !== undefined) overrides[key] = value;
  }
  const provider = await factory();
  const stream = new VadStream(provider, {
    ...DEFAULT_VAD_OPTIONS,
    ...(overrides as Partial<VadOptions>),
  });
  return new VadSession(stream, { onFrame, onSpeechStart, onSpeechEnd, onError });
}

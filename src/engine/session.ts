import { AudioRingBuffer } from "#engine/ringBuffer.ts";
import { DEFAULT_VAD_OPTIONS } from "#engine/segmenter.ts";
import type { VadFrame, VadOptions } from "#engine/segmenter.ts";
import { SerialQueue } from "#engine/serialQueue.ts";
import { VadStream } from "#engine/vadStream.ts";
import { SAMPLE_RATE } from "#types.ts";
import type { ProviderFactory } from "#types.ts";

// Each serialized write/dispatch step advances the ring by at most this many
// samples, so events always slice audio the ring still retains — the ring's
// capacity slack is sized for it in the constructor below.
const MAX_WRITE_SAMPLES = SAMPLE_RATE;

/** A push source of 16 kHz PCM chunks (e.g. a microphone). */
export interface AudioSource {
  /**
   * Begin delivering 16 kHz chunks; resolves once capture is running. A
   * source that cannot capture at 16 kHz must reject here (micSource does)
   * rather than deliver another rate.
   */
  start(onChunk: (pcm: Float32Array) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface Utterance {
  audio: Float32Array;
  /** Sample rate of `audio`; always 16000. */
  sampleRate: number;
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
  private readonly lifecycle = new SerialQueue();
  private source: AudioSource | null = null;

  constructor(stream: VadStream, callbacks: VadSessionCallbacks) {
    this.stream = stream;
    this.callbacks = callbacks;
    const o = stream.options;
    const { windowSamples, hopSamples } = stream.provider;
    // An event is emitted while processing a frame, and slices from its
    // segment's start. The ring must still hold that start, which is behind
    // the ring's write position by the sum of:
    // - the segment's age at that frame: under maxSpeechSec at the previous
    //   frame (or it was split there) plus one hop, or riseDelaySec +
    //   prePadSec for a segment that starts at this frame;
    // - the frame's lag behind the ring: under one window the stream had
    //   buffered before this write, plus the write itself.
    // Frames lost to a failed inference are not checked against maxSpeechSec,
    // so a segment spanning a failure can outgrow this bound.
    this.ring = new AudioRingBuffer(
      Math.ceil(Math.max(o.maxSpeechSec, o.riseDelaySec + o.prePadSec) * SAMPLE_RATE) +
        hopSamples +
        windowSamples +
        MAX_WRITE_SAMPLES,
    );
  }

  /**
   * Feed 16 kHz PCM of any length; returns one VadFrame per completed frame.
   * Calls are serialized internally, like VadStream.processChunk.
   */
  processChunk(pcm: Float32Array): Promise<VadFrame[]> {
    return this.queue.run(() => this.processContiguous(pcm));
  }

  /**
   * Capture from a source until stop(). Starts and stops run one after
   * another, in call order, so neither acts on a half-finished transition.
   */
  start(source: AudioSource): Promise<void> {
    return this.lifecycle.run(async () => {
      if (this.source !== null) throw new Error("session already started");
      await source.start((pcm) => {
        const result = this.queue.run(() => this.processContiguous(pcm));
        const onError = this.callbacks.onError;
        if (onError) {
          result.catch(onError);
        } else {
          void result;
        }
      });
      this.source = source;
    });
  }

  /** Stop capture, then flush so a still-open utterance is delivered. */
  stop(): Promise<void> {
    return this.lifecycle.run(() => this.stopAndFlush());
  }

  /**
   * End any open utterance now, as if the stream ended: it is delivered to
   * onSpeechEnd and returned (null if no utterance was open). Ordered
   * behind in-flight processing.
   */
  flush(): Promise<Utterance | null> {
    return this.queue.run(async () => {
      let utterance: Utterance | null = null;
      for (const event of await this.stream.flush()) {
        if (event.type === "speech_end") utterance = this.emitSpeechEnd(event);
      }
      return utterance;
    });
  }

  /** Stop and flush, then release the provider. Unusable afterwards; repeat calls are no-ops. */
  dispose(): Promise<void> {
    return this.lifecycle.run(async () => {
      if (this.stream.disposed) return;
      try {
        await this.stopAndFlush();
      } finally {
        await this.stream.dispose();
      }
    });
  }

  /** Start a new utterance stream. Ordered behind in-flight processing. */
  reset(): Promise<void> {
    return this.queue.run(async () => {
      await this.stream.reset();
      this.ring.reset();
    });
  }

  /** The body of stop(); callers hold the lifecycle queue. */
  private async stopAndFlush(): Promise<void> {
    try {
      await this.source?.stop();
    } finally {
      this.source = null;
      await this.flush();
    }
  }

  private async processContiguous(pcm: Float32Array): Promise<VadFrame[]> {
    const frames: VadFrame[] = [];
    // A failed inference or a throwing callback must not cost the rest of
    // the chunk its audio, frames or events (the ring and the segmenter have
    // already moved on), so the first failure is rethrown at the end: the
    // rejection for one cause is then the same whatever the chunk length.
    const errors: unknown[] = [];
    // Bounded writes keep every emitted event's audio within ring retention,
    // no matter how large the caller's chunk is.
    for (let offset = 0; offset === 0 || offset < pcm.length; offset += MAX_WRITE_SAMPLES) {
      const part = pcm.subarray(offset, offset + MAX_WRITE_SAMPLES);
      this.ring.write(part);
      let partFrames: VadFrame[];
      try {
        partFrames = await this.stream.processChunk(part);
      } catch (error) {
        errors.push(error);
        continue;
      }
      for (const frame of partFrames) {
        frames.push(frame);
        try {
          this.callbacks.onFrame?.(frame);
        } catch (error) {
          errors.push(error);
        }
        for (const event of frame.events) {
          try {
            if (event.type === "speech_start") {
              this.callbacks.onSpeechStart?.(event.time);
            } else {
              this.emitSpeechEnd(event);
            }
          } catch (error) {
            errors.push(error);
          }
        }
      }
    }
    if (errors.length > 0) throw errors[0];
    return frames;
  }

  private emitSpeechEnd(event: { time: number; startTime: number }): Utterance {
    const utterance: Utterance = {
      audio: this.ring.slice(
        Math.round(event.startTime * SAMPLE_RATE),
        Math.round(event.time * SAMPLE_RATE),
      ),
      sampleRate: SAMPLE_RATE,
      startTime: event.startTime,
      endTime: event.time,
    };
    this.callbacks.onSpeechEnd?.(utterance);
    return utterance;
  }
}

export async function createVad(
  factory: ProviderFactory,
  options: Partial<VadOptions> & VadSessionCallbacks = {},
): Promise<VadSession> {
  const { onFrame, onSpeechStart, onSpeechEnd, onError, ...opts } = options;
  // Drop explicitly-undefined overrides so they cannot clobber defaults
  // (plain-JS consumers get no exactOptionalPropertyTypes check).
  const overrides = Object.fromEntries(
    Object.entries<unknown>(opts).filter(([, value]) => value !== undefined),
  ) as Partial<VadOptions>;
  const provider = await factory();
  let stream: VadStream;
  try {
    stream = new VadStream(provider, { ...DEFAULT_VAD_OPTIONS, ...overrides });
  } catch (error) {
    await provider.dispose();
    throw error;
  }
  return new VadSession(stream, { onFrame, onSpeechStart, onSpeechEnd, onError });
}

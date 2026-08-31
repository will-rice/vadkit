import type { AudioSource } from "#engine/session.ts";
import { SAMPLE_RATE } from "#types.ts";

// Inlined as a blob URL so consumers' bundlers need no worklet asset config.
const WORKLET_CODE = `
const BATCH_SAMPLES = 2048;
class VadkitRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.length = 0;
    // Any message from the main thread means "flush what you have".
    this.port.onmessage = () => {
      this.flush();
      this.port.postMessage("flushed");
    };
  }
  flush() {
    if (this.length === 0) return;
    const batch = new Float32Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      batch.set(chunk, offset);
      offset += chunk.length;
    }
    this.port.postMessage(batch, [batch.buffer]);
    this.chunks = [];
    this.length = 0;
  }
  process(inputs) {
    const channel = inputs[0][0];
    if (channel) {
      this.chunks.push(channel.slice());
      this.length += channel.length;
      if (this.length >= BATCH_SAMPLES) this.flush();
    }
    return true;
  }
}
registerProcessor("vadkit-recorder", VadkitRecorder);
`;

export interface MicSourceOptions {
  /** Passed to getUserMedia as the audio constraint. Default: true. */
  constraints?: MediaTrackConstraints | boolean | undefined;
}

/** Microphone AudioSource: getUserMedia + a 16 kHz AudioContext + AudioWorklet. */
export function micSource(options: MicSourceOptions = {}): AudioSource {
  let context: AudioContext | null = null;
  let mediaStream: MediaStream | null = null;
  let port: MessagePort | null = null;
  let flushResolve: (() => void) | null = null;

  async function release(): Promise<void> {
    mediaStream?.getTracks().forEach((track) => {
      track.stop();
    });
    if (context !== null && context.state !== "closed") await context.close();
    context = null;
    mediaStream = null;
    port = null;
  }

  return {
    async start(onChunk: (pcm: Float32Array, sampleRate: number) => void): Promise<void> {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: options.constraints ?? true,
      });
      try {
        context = new AudioContext({ sampleRate: SAMPLE_RATE });
        const url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: "text/javascript" }));
        try {
          await context.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        const recorder = new AudioWorkletNode(context, "vadkit-recorder");
        const sampleRate = context.sampleRate; // may differ if 16 kHz was not honored
        port = recorder.port;
        port.onmessage = (event: MessageEvent<Float32Array | "flushed">) => {
          if (event.data === "flushed") {
            flushResolve?.();
            flushResolve = null;
            return;
          }
          onChunk(event.data, sampleRate);
        };
        context.createMediaStreamSource(mediaStream).connect(recorder);
        if (context.state !== "running") await context.resume();
        if (context.state !== "running") {
          throw new Error("AudioContext is not running — start the microphone from a user gesture");
        }
      } catch (error) {
        // Never leave a live mic behind a failed start.
        await release();
        throw error;
      }
    },
    async stop(): Promise<void> {
      // Drain the worklet's partial batch so the tail of the last utterance
      // reaches the session before capture ends.
      if (port !== null && context?.state === "running") {
        await new Promise<void>((resolve) => {
          flushResolve = resolve;
          port?.postMessage("flush");
        });
      }
      await release();
    },
  };
}

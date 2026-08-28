import type { AudioSource } from "./engine/session.js";
import { SAMPLE_RATE } from "./types.js";

// Inlined as a blob URL so consumers' bundlers need no worklet asset config.
const WORKLET_CODE = `
const BATCH_SAMPLES = 2048;
class VadkitRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.length = 0;
  }
  process(inputs) {
    const channel = inputs[0][0];
    if (channel) {
      this.chunks.push(channel.slice());
      this.length += channel.length;
      if (this.length >= BATCH_SAMPLES) {
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
  return {
    async start(onChunk: (pcm: Float32Array, sampleRate: number) => void): Promise<void> {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: options.constraints ?? true,
      });
      context = new AudioContext({ sampleRate: SAMPLE_RATE });
      const url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: "text/javascript" }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const recorder = new AudioWorkletNode(context, "vadkit-recorder");
      const sampleRate = context.sampleRate; // may differ if 16 kHz was not honored
      recorder.port.onmessage = (event: MessageEvent<Float32Array>) => {
        onChunk(event.data, sampleRate);
      };
      context.createMediaStreamSource(mediaStream).connect(recorder);
    },
    async stop(): Promise<void> {
      mediaStream?.getTracks().forEach((track) => {
        track.stop();
      });
      await context?.close();
      context = null;
      mediaStream = null;
    },
  };
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { VadProvider } from "#types.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal WAV reader for 16 kHz 16-bit mono PCM test assets. */
export function readWav16kMono(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== 0x52494646) throw new Error("not a RIFF file");
  let offset = 12;
  let dataOffset = -1;
  let dataLength = -1;
  while (offset + 8 <= view.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 0x666d7420) {
      // "fmt "
      const format = view.getUint16(offset + 8, true);
      const channels = view.getUint16(offset + 10, true);
      const sampleRate = view.getUint32(offset + 12, true);
      const bits = view.getUint16(offset + 22, true);
      if (format !== 1 || channels !== 1 || sampleRate !== 16000 || bits !== 16) {
        throw new Error(
          `expected 16 kHz 16-bit mono PCM, got ${format}/${channels}/${sampleRate}/${bits}`,
        );
      }
    } else if (chunkId === 0x64617461) {
      // "data"
      dataOffset = offset + 8;
      dataLength = chunkSize;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (dataOffset < 0) throw new Error("no data chunk");
  const pcm = new Float32Array(dataLength / 2);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = view.getInt16(dataOffset + 2 * i, true) / 32768;
  }
  return pcm;
}

/** tests/assets/hello_en.wav as 16 kHz float PCM (2.24 s, speech ~0.3-1.8 s). */
export function loadPcm(): Float32Array {
  const buf = readFileSync(path.join(ROOT, "tests", "assets", "hello_en.wav"));
  return readWav16kMono(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** Bytes of a bundled model, so tests never depend on import.meta.url resolution. */
export function loadModel(name: "fireredvad_stream_vad_e2e.onnx" | "silero_vad.onnx"): Uint8Array {
  return readFileSync(path.join(ROOT, "models", name));
}

/** A parity fixture from tests/fixtures; the caller asserts its shape. */
export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(ROOT, "tests", "fixtures", name), "utf-8"));
}

/** Deterministic fake: probability = mean(|samples|) of each frame's window. */
export function fakeProvider(windowSamples = 400, hopSamples = 160): VadProvider {
  return {
    windowSamples,
    hopSamples,
    frameSec: hopSamples / 16000,
    process(samples: Float32Array): Promise<Float32Array> {
      const n = Math.floor((samples.length - windowSamples) / hopSamples) + 1;
      const probs = new Float32Array(n);
      for (let t = 0; t < n; t++) {
        const window = samples.subarray(t * hopSamples, t * hopSamples + windowSamples);
        let sum = 0;
        for (const v of window) sum += Math.abs(v);
        probs[t] = Math.min(1, sum / windowSamples);
      }
      return Promise.resolve(probs);
    },
    reset(): void {
      // stateless
    },
    dispose(): Promise<void> {
      return Promise.resolve();
    },
  };
}

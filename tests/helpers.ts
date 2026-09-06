import type { VadProvider } from "#types.ts";

// Both Vitest projects run these files: under Node import.meta.url is a
// file: URL, in Chromium it is the dev-server URL, and new URL() resolves
// relative to either. Only the read differs.
const IS_NODE = typeof window === "undefined";

async function readBytes(url: URL): Promise<ArrayBuffer> {
  if (IS_NODE) {
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(url);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.href}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

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
export async function loadPcm(): Promise<Float32Array> {
  return readWav16kMono(await readBytes(new URL("./assets/hello_en.wav", import.meta.url)));
}

/** A parity fixture from tests/fixtures; the caller asserts its shape. */
export async function loadFixture(name: string): Promise<unknown> {
  const bytes = await readBytes(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Model bytes under Node, where ort cannot fetch a file: URL. In the
 * browser returns undefined so the provider resolves its bundled model via
 * import.meta.url — the path a consumer's bundler has to get right.
 */
export async function loadModel(
  name: "fireredvad_stream_vad_e2e.onnx" | "silero_vad.onnx" | "fsmn_vad_e2e.onnx",
): Promise<Uint8Array | undefined> {
  if (!IS_NODE) return undefined;
  return new Uint8Array(await readBytes(new URL(`../models/${name}`, import.meta.url)));
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

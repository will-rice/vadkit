import { SAMPLE_RATE } from "#types.ts";

/**
 * Encode mono PCM in [-1, 1] as a 16-bit PCM WAV file, e.g. an Utterance's
 * audio for upload to an ASR API. Samples outside [-1, 1] are clipped.
 */
export function encodeWav(audio: Float32Array, sampleRate: number = SAMPLE_RATE): ArrayBuffer {
  const dataBytes = audio.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  view.setUint32(0, 0x52494646); // "RIFF"
  view.setUint32(4, 36 + dataBytes, true);
  view.setUint32(8, 0x57415645); // "WAVE"
  view.setUint32(12, 0x666d7420); // "fmt "
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  view.setUint32(36, 0x64617461); // "data"
  view.setUint32(40, dataBytes, true);
  for (const [i, sample] of audio.entries()) {
    const scaled = Math.round(sample * 32768);
    view.setInt16(44 + 2 * i, Math.max(-32768, Math.min(32767, scaled)), true);
  }
  return buffer;
}

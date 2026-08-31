import { SAMPLE_RATE } from "./types.js";

/**
 * Resample a complete buffer to 16 kHz with the browser's native converter
 * (OfflineAudioContext), e.g. a decoded file before feeding processChunk.
 * Browser-only — streaming or Node pipelines own their sample rate and
 * should deliver 16 kHz directly.
 */
export async function resampleTo16k(pcm: Float32Array, fromRate: number): Promise<Float32Array> {
  if (fromRate === SAMPLE_RATE) return pcm;
  const context = new OfflineAudioContext(
    1,
    Math.ceil((pcm.length * SAMPLE_RATE) / fromRate),
    SAMPLE_RATE,
  );
  const buffer = context.createBuffer(1, pcm.length, fromRate);
  buffer.getChannelData(0).set(pcm);
  const bufferSource = context.createBufferSource();
  bufferSource.buffer = buffer;
  bufferSource.connect(context.destination);
  bufferSource.start();
  const rendered = await context.startRendering();
  return rendered.getChannelData(0);
}

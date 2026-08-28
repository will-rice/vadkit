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

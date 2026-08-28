/** Slices arbitrary-size PCM chunks into maximal window+k*hop runs. */
export class ChunkBuffer {
  readonly windowSamples: number;
  readonly hopSamples: number;
  private buffer = new Float32Array(0);

  constructor(windowSamples: number, hopSamples: number) {
    this.windowSamples = windowSamples;
    this.hopSamples = hopSamples;
  }

  /** Append pcm; return the maximal contiguous run, or null if not enough. */
  push(pcm: Float32Array): Float32Array | null {
    const audio = new Float32Array(this.buffer.length + pcm.length);
    audio.set(this.buffer);
    audio.set(pcm, this.buffer.length);
    if (audio.length < this.windowSamples) {
      this.buffer = audio;
      return null;
    }
    const numFrames = Math.floor((audio.length - this.windowSamples) / this.hopSamples) + 1;
    const runLength = this.windowSamples + (numFrames - 1) * this.hopSamples;
    this.buffer = audio.slice(numFrames * this.hopSamples);
    return audio.subarray(0, runLength);
  }

  reset(): void {
    this.buffer = new Float32Array(0);
  }
}

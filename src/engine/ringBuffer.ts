/** Fixed-capacity ring of the most recent samples, addressed by absolute index. */
export class AudioRingBuffer {
  readonly capacity: number;
  private readonly data: Float32Array;
  private written = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity);
  }

  get totalWritten(): number {
    return this.written;
  }

  write(pcm: Float32Array): void {
    let start = 0;
    if (pcm.length > this.capacity) {
      // Older samples in this write would be overwritten immediately.
      start = pcm.length - this.capacity;
      this.written += start;
    }
    for (let i = start; i < pcm.length;) {
      const pos = this.written % this.capacity;
      const n = Math.min(pcm.length - i, this.capacity - pos);
      this.data.set(pcm.subarray(i, i + n), pos);
      i += n;
      this.written += n;
    }
  }

  /** Copy samples [startSample, endSample) out of the ring. */
  slice(startSample: number, endSample: number): Float32Array {
    const oldest = Math.max(0, this.written - this.capacity);
    if (startSample < oldest) {
      throw new Error(`sample ${String(startSample)} evicted (oldest is ${String(oldest)})`);
    }
    if (endSample > this.written) {
      throw new Error(`sample ${String(endSample)} beyond written ${String(this.written)}`);
    }
    if (startSample > endSample) {
      throw new Error("slice start after end");
    }
    const out = new Float32Array(endSample - startSample);
    for (let i = startSample; i < endSample;) {
      const pos = i % this.capacity;
      const n = Math.min(endSample - i, this.capacity - pos);
      out.set(this.data.subarray(pos, pos + n), i - startSample);
      i += n;
    }
    return out;
  }

  reset(): void {
    this.written = 0;
  }
}

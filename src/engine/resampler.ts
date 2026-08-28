import { SAMPLE_RATE } from "../types.js";

/** Streaming linear-interpolation resampler to 16 kHz with fractional carry. */
export class LinearResampler {
  private readonly step: number;
  private position = 0;
  private tail = new Float32Array(0);

  constructor(fromRate: number) {
    this.step = fromRate / SAMPLE_RATE;
  }

  process(input: Float32Array): Float32Array {
    if (this.step === 1) return input;
    const src = new Float32Array(this.tail.length + input.length);
    src.set(this.tail);
    src.set(input, this.tail.length);

    const out: number[] = [];
    let pos = this.position;
    while (pos < src.length - 1) {
      const i = Math.floor(pos);
      const a = src[i];
      const b = src[i + 1];
      if (a === undefined || b === undefined) break;
      const frac = pos - i;
      out.push(a * (1 - frac) + b * frac);
      pos += this.step;
    }
    const consumed = Math.floor(pos);
    this.tail = src.slice(consumed);
    this.position = pos - consumed;
    return Float32Array.from(out);
  }

  reset(): void {
    this.position = 0;
    this.tail = new Float32Array(0);
  }
}

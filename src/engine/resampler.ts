import { SAMPLE_RATE } from "../types.js";

/**
 * Streaming resampler to 16 kHz with fractional-position carry.
 *
 * Downsampling low-passes with a Hamming-windowed-sinc FIR before linear
 * interpolation, so source content above the 8 kHz output Nyquist is
 * attenuated instead of aliasing into the band the VAD models see. The
 * filter's group delay is compensated, so output timestamps stay aligned
 * with the input.
 */
export class LinearResampler {
  private readonly step: number;
  private readonly coeffs: Float64Array | null;
  private readonly groupDelay: number;
  private history: Float32Array;
  private position: number;
  private tail = new Float32Array(0);

  constructor(fromRate: number) {
    this.step = fromRate / SAMPLE_RATE;
    this.coeffs = this.step > 1 ? lowpassCoefficients(this.step) : null;
    this.groupDelay = this.coeffs === null ? 0 : (this.coeffs.length - 1) / 2;
    this.history = new Float32Array(this.coeffs === null ? 0 : this.coeffs.length - 1);
    this.position = this.groupDelay;
  }

  process(input: Float32Array): Float32Array {
    if (this.step === 1) return input;
    const filtered = this.coeffs === null ? input : this.lowpass(input, this.coeffs);
    const src = new Float32Array(this.tail.length + filtered.length);
    src.set(this.tail);
    src.set(filtered, this.tail.length);

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
    // pos may point past the end of src; cap the tail cut so the overshoot
    // carries into position instead of being silently dropped (which would
    // slip the input origin by a sample per batch and drift all timestamps).
    const consumed = Math.min(Math.floor(pos), src.length);
    this.tail = src.slice(consumed);
    this.position = pos - consumed;
    return Float32Array.from(out);
  }

  reset(): void {
    this.position = this.groupDelay;
    this.tail = new Float32Array(0);
    this.history = new Float32Array(this.history.length);
  }

  private lowpass(input: Float32Array, coeffs: Float64Array): Float32Array {
    const src = new Float32Array(this.history.length + input.length);
    src.set(this.history);
    src.set(input, this.history.length);
    const out = new Float32Array(input.length);
    for (let i = 0; i < out.length; i++) {
      let acc = 0;
      for (let k = 0; k < coeffs.length; k++) {
        const c = coeffs[k];
        const v = src[i + k];
        if (c === undefined || v === undefined) break;
        acc += c * v;
      }
      out[i] = acc;
    }
    this.history = src.slice(src.length - this.history.length);
    return out;
  }
}

/** Hamming-windowed-sinc anti-alias filter for decimation by `step`. */
function lowpassCoefficients(step: number): Float64Array {
  // Cutoff at 0.9× the 8 kHz output Nyquist; taps sized so the Hamming
  // transition band (≈ 3.3 / taps of the input rate) ends at that Nyquist.
  const cutoff = 0.45 / step; // cycles per input sample
  const taps = 2 * Math.ceil(16.5 * step) + 1;
  const mid = (taps - 1) / 2;
  const values: number[] = [];
  for (let k = 0; k < taps; k++) {
    const t = 2 * Math.PI * cutoff * (k - mid);
    const sinc = t === 0 ? 1 : Math.sin(t) / t;
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (taps - 1));
    values.push(sinc * hamming);
  }
  const sum = values.reduce((a, b) => a + b, 0);
  return Float64Array.from(values, (v) => v / sum); // unity DC gain
}

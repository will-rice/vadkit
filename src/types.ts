export const SAMPLE_RATE = 16000;

/** A VAD backend: owns its model session and recurrent state. */
export interface VadProvider {
  /** Samples of context consumed per output frame. */
  readonly windowSamples: number;
  /** Samples advanced per output frame. */
  readonly hopSamples: number;
  /** Seconds per output frame: hopSamples / SAMPLE_RATE. */
  readonly frameSec: number;
  /**
   * Run inference on contiguous 16 kHz PCM holding an integer number of
   * frames: samples.length === windowSamples + (n - 1) * hopSamples, n >= 1.
   * Returns n speech probabilities in [0, 1]. Stateful across calls.
   */
  process(samples: Float32Array): Promise<Float32Array>;
  /** Clear recurrent state for a new stream. */
  reset(): void;
  /** Release model/runtime resources. The provider is unusable afterwards. */
  dispose(): Promise<void>;
}

export type ProviderFactory = () => Promise<VadProvider>;

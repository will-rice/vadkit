# vadkit — multi-provider voice activity detection for the browser

Date: 2026-08-28
Status: draft, awaiting review

## Goals

- One TypeScript package that runs multiple VAD models behind a single
  interface: FireRedVAD, Silero VAD, and TEN-VAD in v1.
- Batteries-included session layer: microphone capture, resampling, speech
  start/end events, and the utterance's raw audio delivered on speech end
  (ready for ASR handoff).
- Low-level access preserved: consumers can feed PCM chunks directly and
  read per-frame probabilities.
- Every provider verified against its reference implementation with committed
  fixtures, in the style of fireredvad-web's parity tests.

## Non-goals (v1)

- Node/native execution providers (the interface must not preclude them).
- Training, tuning, or benchmarking tooling beyond a comparison demo.
- Non-16 kHz model support; all v1 providers consume 16 kHz mono PCM.

## Architecture

Three layers; each lower layer is exported and usable alone.

```
Session (mic, ring buffer, events, utterance audio)
  └─ Engine (chunk buffering, serialization, resampling, segmenter)
       └─ VadProvider (model-specific: geometry, state, inference)
```

### Layer 1: VadProvider interface

The only contract a backend must satisfy. Deliberately runtime-agnostic —
providers may use onnxruntime-web, a wasm build, or anything else.

```ts
interface VadProvider {
  /** Samples of context consumed per output frame (window). */
  readonly windowSamples: number;
  /** Samples advanced per output frame (hop). */
  readonly hopSamples: number;
  /** Seconds per output frame: hopSamples / 16000. */
  readonly frameSec: number;
  /**
   * Run inference on contiguous audio holding an integer number of frames:
   * length == windowSamples + (n - 1) * hopSamples for some n >= 1.
   * Returns n speech probabilities in [0, 1]. Stateful across calls.
   */
  process(samples: Float32Array): Promise<Float32Array>;
  /** Clear internal state (recurrent caches) for a new stream. */
  reset(): void;
}
```

Provider factories are functions returning a lazy spec so model loading
happens inside `createVad`:

```ts
fireRedVad(options?: { model?: string | Uint8Array }): ProviderFactory
sileroVad(options?: { model?: string | Uint8Array }): ProviderFactory
tenVad(options?: { model?: string | Uint8Array }): ProviderFactory
```

v1 geometries:

| Provider   | window | hop | frame  | state                          |
|------------|--------|-----|--------|--------------------------------|
| FireRedVAD | 400    | 160 | 10 ms  | packed FSMN caches [1,1024,19] |
| Silero v5  | 512    | 512 | 32 ms  | LSTM state [2,1,128]           |
| TEN-VAD    | 768*   | 256 | 16 ms  | model-internal / hidden states |

\* TEN-VAD geometry to be confirmed during implementation (see Risks).

### Layer 2: Engine

Provider-agnostic streaming core, generalized from fireredvad-web:

- **Chunk buffering**: accepts Float32Array chunks of any length; slices
  maximal `window + k*hop` runs for the provider, carries the remainder.
- **Serialization**: all provider calls and resets are ordered through an
  internal promise chain — overlapping async calls cannot race recurrent
  state (the bug class found in fireredvad-web).
- **Resampling**: streaming linear resampler to 16 kHz with fractional-
  position carry (promoted from the fireredvad-web demo).
- **Segmenter**: generic hangover state machine over (probability, frameSec):
  SILENCE → POSSIBLE_SPEECH → SPEECH → POSSIBLE_SILENCE. Config is
  denominated in **seconds** and converted to frames per provider, so one
  config means the same thing across backends:

```ts
interface VadOptions {
  speechThreshold: number;   // default 0.5
  smoothWindowSec: number;   // moving average; default 0.05
  minSpeechSec: number;      // default 0.08
  minSilenceSec: number;     // default 0.2
  prePadSec: number;         // audio kept before speech start; default 0.1
  maxSpeechSec: number;      // force-end long utterances; default 30
}
```

This is a clean reimplementation, not a port of the FireRed postprocessor:
provider-neutral semantics beat bug-for-bug compatibility here. Apps that
need FireRed's exact Python behavior use fireredvad-web.

### Layer 3: Session

```ts
const vad = await createVad(sileroVad(), {
  ...vadOptions,
  onFrame?: (f: { time: number; probability: number; isSpeech: boolean }) => void,
  onSpeechStart?: (time: number) => void,
  onSpeechEnd?: (utterance: { audio: Float32Array; start: number; end: number }) => void,
});

vad.processChunk(pcm: Float32Array): Promise<VadFrame[]>  // direct feed
await vad.start(source: AudioSource);                      // e.g. micSource()
await vad.stop();
vad.reset();
```

- `micSource()` wraps getUserMedia + a 16 kHz AudioContext + an AudioWorklet
  posting transferred batches (from the fireredvad-web demo). `AudioSource`
  is a tiny interface (`start(onChunk)`, `stop()`, `sampleRate`) so tests
  and file playback implement it trivially.
- A ring buffer holds the last `maxSpeechSec + prePadSec` of 16 kHz audio;
  `onSpeechEnd` slices [speechStart - prePadSec, speechEnd] from it.

## Model artifacts

Bundled in the npm package under `models/` and resolved per provider via
`new URL("../models/<file>", import.meta.url)`, overridable with the
factory's `model` option (URL or bytes). Sizes: FireRed e2e ~3.3 MB
(Apache-2.0), Silero ~2 MB (MIT), TEN-VAD ~0.3 MB (Apache-2.0) — ~6 MB
total, in line with @ricky0123/vad-web's precedent of bundling Silero.
Licenses reproduced in `models/NOTICE`.

## Package layout

Single package, subpath exports for tree-shaking; onnxruntime-web is a peer
dependency required only by providers that use it:

```
vadkit
├─ src/
│  ├─ index.ts          # createVad, micSource, types (no provider imports)
│  ├─ engine/           # buffering, serialization, resampler, segmenter
│  └─ providers/
│     ├─ fireredvad.ts  # export via "vadkit/fireredvad"
│     ├─ silero.ts      # export via "vadkit/silero"
│     └─ ten.ts         # export via "vadkit/ten"
├─ models/
├─ tests/               # vitest, ort-web under Node
└─ demo/                # vite: all providers side by side on one mic feed
```

## Testing

- **Engine unit tests**: buffering across odd chunk sizes, serialization
  under un-awaited concurrent calls, resampler continuity, segmenter state
  machine against hand-built probability sequences.
- **Provider parity fixtures**: each provider's probabilities on committed
  test audio versus its reference implementation
  (FireRedVAD: the fireredvad Python pipeline; Silero: silero-vad's Python
  package; TEN-VAD: the upstream reference), generated by scripts committed
  alongside the fixtures. Tests run onnxruntime-web under Node.
- **Cross-provider invariants**: all providers produce sensible segments on
  the same speech clip (start/end within a tolerance band), guarding against
  geometry/unit mistakes that per-provider tests can miss.

## Risks and open items

1. **TEN-VAD input contract.** The published ONNX may expect precomputed
   features rather than raw PCM. Resolution order: (a) bake the feature
   frontend into the ONNX graph, as done for FireRedVAD; (b) wrap TEN-VAD's
   official wasm build behind VadProvider (the interface is runtime-agnostic
   precisely for this). Confirm before implementation of that provider.
2. **Silero licensing/version.** Model is MIT; pin one version (v5) in v1
   and record its sha256 with the fixture generator.
3. **AudioWorklet asset shipping.** The worklet file must be servable by
   consumers' bundlers; ship as a `?url`-importable asset plus a documented
   fallback (inline blob URL) for bundlers that mangle worklet assets.

## Milestones

1. Engine + FireRed provider + tests (port/adapt from fireredvad-web).
2. Silero provider + parity fixtures.
3. Session layer (mic, ring buffer, events) + demo page.
4. TEN-VAD provider (after resolving Risk 1).
5. Packaging polish (exports map, prepublishOnly, README) + npm publish.

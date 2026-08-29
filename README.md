# vadkit

Multi-provider voice activity detection for the browser. One TypeScript API
over multiple VAD models — [FireRedVAD](https://github.com/FireRedTeam/FireRedVAD),
[Silero VAD](https://github.com/snakers4/silero-vad), and WebRTC VAD — with
a batteries-included session layer: microphone capture,
speech start/end events, and the utterance's raw audio handed to you on speech
end, ready for ASR.

Every provider is parity-tested against its reference implementation with
committed fixtures, and the engine serializes all stateful model calls so
event-driven audio delivery (AudioWorklet callbacks) cannot race recurrent
state.

## Install

```sh
npm install vadkit onnxruntime-web
```

`onnxruntime-web` is a peer dependency used by the ONNX-backed providers.
Models ship inside the package under `models/`.

## Quickstart

```ts
import { createVad, micSource } from "vadkit";
import { sileroVad } from "vadkit/silero"; // or: fireRedVad from "vadkit/fireredvad"

const vad = await createVad(sileroVad(), {
  speechThreshold: 0.5,
  fallDelaySec: 0.2,
  onSpeechStart: (time) => console.log("speech started at", time),
  onSpeechEnd: ({ audio, startTime, endTime }) => {
    // audio: Float32Array of the utterance (16 kHz), including pre-padding
    transcribe(audio);
  },
});

await vad.start(micSource()); // resamples if the browser ignores 16 kHz
// ... later:
await vad.stop();
```

Or feed PCM yourself — chunks of any length, from any source:

```ts
const frames = await vad.processChunk(pcm); // Float32Array in [-1, 1] at 16 kHz
// frames[i]: { time, probability, smoothedProbability, isSpeech, events }
```

Options are denominated in seconds and mean the same thing across providers
(`speechThreshold`, `smoothWindowSec`, `riseDelaySec`, `fallDelaySec`,
`prePadSec`, `maxSpeechSec`).

## Providers

| Provider   | Import              | Window/hop | Frame  | Model                     | License      |
| ---------- | ------------------- | ---------- | ------ | ------------------------- | ------------ |
| FireRedVAD | `vadkit/fireredvad` | 400 / 160  | 10 ms  | 3.3 MB (PCM-in)           | Apache-2.0   |
| Silero v5  | `vadkit/silero`     | 512 / 512  | 32 ms  | 2.3 MB                    | MIT          |
| WebRTC VAD | `vadkit/webrtc`     | 160 / 160* | 10 ms* | none (29 KB wasm inlined) | BSD-3-Clause |

All consume raw 16 kHz PCM; the FireRedVAD model has its fbank+CMVN feature
frontend inside the ONNX graph. Model provenance and hashes: `models/NOTICE`.

\*WebRTC VAD (the classic GMM VAD, via a vendored
[libfvad](https://github.com/dpirch/libfvad) wasm build — no
onnxruntime-web needed) supports `frameMs: 10 | 20 | 30` and emits hard 0/1
decisions; the segmenter's smoothing turns those into a
fraction-of-window-voiced value, so tune sensitivity primarily with
`aggressiveness: 0-3`. Its parity fixture is bit-exact against
py-webrtcvad across all four modes.

Custom backends implement the `VadProvider` interface (window/hop geometry +
stateful `process(samples) → probabilities`) — see `src/types.ts`.

## Demo

```sh
npm install
npm run demo   # FireRed and Silero side by side on one mic feed
```

## Development

```sh
npm test           # engine unit tests + per-provider parity fixtures
npm run typecheck  # strict tsc, package and demo
npm run build      # tsdown + publint + attw
npm run fixtures   # regenerate parity fixtures (onnxruntime-node reference)
```

Design docs live in `docs/superpowers/specs/`. (TEN-VAD was evaluated and
dropped: Agora's license terms are incompatible with vendoring into an MIT
package — see the spec's Decisions section.)

# vadkit

[![npm](https://img.shields.io/npm/v/vadkit)](https://www.npmjs.com/package/vadkit)
[![CI](https://github.com/will-rice/vadkit/actions/workflows/ci.yml/badge.svg)](https://github.com/will-rice/vadkit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/vadkit)](https://github.com/will-rice/vadkit/blob/main/LICENSE)

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

`onnxruntime-web` is a required peer dependency (npm installs it
automatically) — the FireRedVAD and Silero models are ONNX. Models ship
inside the package under `models/`. Apps using only the WebRTC provider
still bundle ort-free: the subpath entries are isolated, so bundlers
tree-shake onnxruntime-web out entirely (verified: a webrtc-only consumer
builds to 38 KB total).

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

await vad.start(micSource()); // resamples (anti-aliased) if the browser ignores 16 kHz
// ... later:
await vad.stop(); // flushes: an utterance still in progress is delivered
await vad.dispose(); // releases the model/wasm resources when done for good
```

`encodeWav(utterance.audio)` turns an utterance into a 16-bit PCM WAV
`ArrayBuffer`, ready to upload to an ASR API.

Or feed PCM yourself — chunks of any length, from any source:

```ts
const frames = await vad.processChunk(pcm); // Float32Array in [-1, 1] at 16 kHz
// frames[i]: { time, probability, smoothedProbability, isSpeech, events }
const last = await vad.flush(); // end of stream: closes an open utterance
```

That is the whole offline story too: chunk a file through `processChunk`,
then `flush()` — it delivers a still-open final utterance to `onSpeechEnd`
and returns it.

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
frontend inside the ONNX graph. Third-party licenses, model provenance, and hashes: `THIRD_PARTY_NOTICES`.

\*WebRTC VAD (the classic GMM VAD, via a vendored
[libfvad](https://github.com/dpirch/libfvad) wasm build — no
onnxruntime-web needed) supports `frameMs: 10 | 20 | 30` and emits hard 0/1
decisions; the segmenter's smoothing turns those into a
fraction-of-window-voiced value, so tune sensitivity primarily with
`aggressiveness: 0-3`. Its parity fixture is bit-exact against
py-webrtcvad across all four modes.

Custom backends implement the `VadProvider` interface (window/hop geometry,
stateful `process(samples) → probabilities`, `reset`/`dispose`) — see
`src/types.ts`.

## Bundling

The bundled models resolve via `new URL(..., import.meta.url)`, which
Vite/webpack-5-class bundlers turn into hashed assets automatically — a
plain install needs no configuration (verified against a packed tarball in
a fresh Vite app). Without a bundler, or to self-host, pass an explicit
location: `sileroVad({ model: "https://cdn.jsdelivr.net/npm/vadkit@<your-installed-version>/models/silero_vad.onnx" })`
(pin the URL to the version you installed so model and runtime stay matched)
(or bytes). onnxruntime-web ships its own wasm the same way; its default
build is large, so size-sensitive apps may want ort's slimmer wasm variants.
The WebRTC provider is fully self-contained (29 KB, wasm inlined).
ONNX inference is serialized through one shared queue across providers, so
running multiple ONNX-backed sessions concurrently is safe (ort-web's wasm
backend is single-threaded and rejects overlapping runs otherwise).

## Demo

Live at [will-rice.github.io/vadkit](https://will-rice.github.io/vadkit/) —
all three providers side by side on one mic feed (audio never leaves the
page). Or locally:

```sh
npm install
npm run demo
```

## Development

vadkit uses [Vite+](https://voidzero.dev/posts/announcing-vite-plus-beta) as
its toolchain: the single `vite-plus` dev dependency provides Vitest, Oxfmt,
Oxlint, tsdown, and Vite behind the `vp` command, and one `vite.config.ts`
configures the dev server, tests, and library packaging.

### Setup

- **Node >= 24** (see `.nvmrc`; `nvm use` if you use nvm). Runtime support
  floor for consumers is Node >= 22.
- **npm >= 11.5** — enforced via `devEngines`. npm 11 downloads a newer
  npm automatically if yours is older; npm 10 (as bundled with Node 22)
  fails the gate instead, so develop on Node 24. CI still runs the test
  suite on Node 22, the consumer floor, by invoking the runner directly.
- `npm install` brings in the whole toolchain and installs the git hooks
  (pre-commit: format, lint, typecheck on staged files; commit-msg:
  conventional commits via commitlint). No global installs needed.

### Everyday commands

```sh
npm test           # vp test: engine unit tests + per-provider parity fixtures
npm run typecheck  # strict tsc, package and demo configs
npm run lint       # eslint (type-aware, strictTypeChecked)
npm run format     # vp fmt (oxfmt; config in .oxfmtrc.json)
npm run build      # vp pack (tsdown) + publint + attw packaging checks
npm run demo       # vp dev demo
```

The npm scripts are thin wrappers over `vp` — `npx vp test`, `npx vp fmt`,
`npx vp pack` work directly too (pass `-c .oxfmtrc.json` to bare `vp fmt`).
ESLint intentionally remains the lint gate: `vp lint --type-aware`
(tsgolint) covers part of the same ground and will take over once its rule
coverage matches typescript-eslint's strictTypeChecked.

### Regenerating artifacts

```sh
npm run fixtures   # parity fixtures, regenerated against reference
                   # implementations (needs uv: https://docs.astral.sh/uv/)
./scripts/build_libfvad.sh   # rebuild the vendored libfvad wasm
                             # (needs emscripten + git; pinned revision)
```

Fixtures and the wasm module are committed, so neither tool is needed for
normal development — only when changing what they generate.

## Releasing

Releases are automated with
[semantic-release](https://github.com/semantic-release/semantic-release):
each push to `main` whose conventional commits warrant a release computes
the version, updates CHANGELOG.md and package.json, tags, creates the
GitHub release, and publishes to npm via
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no
tokens; provenance attached automatically); `npm publish` runs the full
gate (typecheck, parity suite, build with publint/attw) on the way out.
Pre-1.0, breaking changes bump the minor version (a `releaseRules`
override in `.releaserc.json`); delete that override to release 1.0.0 on
the next breaking change.

Design docs live in [docs/superpowers/specs/](https://github.com/will-rice/vadkit/tree/main/docs/superpowers/specs)
in the repository. (TEN-VAD was evaluated and dropped: Agora's license terms
are incompatible with vendoring into an MIT package — see the spec's
Decisions section.)

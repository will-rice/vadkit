## [0.4.0](https://github.com/will-rice/vadkit/compare/v0.3.0...v0.4.0) (2026-09-06)

### Features

- **providers:** add FSMN-VAD as a fourth provider ([5fe0a9b](https://github.com/will-rice/vadkit/commit/5fe0a9bddb89bcae9b8c038d729da32dbe780d4e))

## [0.3.0](https://github.com/will-rice/vadkit/compare/v0.2.1...v0.3.0) (2026-09-06)

### ⚠ BREAKING CHANGES

- AudioSource.start's callback receives only the PCM
  chunk; the sampleRate argument is gone. Custom sources must deliver
  16 kHz or reject from start().
- ChunkBuffer, AudioRingBuffer, and Segmenter are no
  longer exported; VadStream remains for engine-only use.

### Features

- move teeSource into the package ([d9839d9](https://github.com/will-rice/vadkit/commit/d9839d968c343280acf447f934fb4a6f6c824918))
- reject use after dispose with a concise error ([a508b80](https://github.com/will-rice/vadkit/commit/a508b80407d7c890f96bb165993e4559af680b06))
- validate the capture rate once, in micSource ([15e3981](https://github.com/will-rice/vadkit/commit/15e398168a04ef13e40900836f5e759ecdc71fbe))

### Bug Fixes

- **webrtc:** build the wasm module for web and worker only ([e3e50dd](https://github.com/will-rice/vadkit/commit/e3e50dd51b9ed37a6ff2c9c65ebc34f0e1c60c3b))

### Reverts

- chore(release): 0.3.0 ([2a275a7](https://github.com/will-rice/vadkit/commit/2a275a71782dd01a59bcb6cf1221ca3dcfec396a))

### Code Refactoring

- trim the root entry to the documented API ([c640c44](https://github.com/will-rice/vadkit/commit/c640c44cddd217d1adc300d07598c845efde2b0e))

## [0.2.1](https://github.com/will-rice/vadkit/compare/v0.2.0...v0.2.1) (2026-08-31)

## [0.2.0](https://github.com/will-rice/vadkit/compare/v0.1.3...v0.2.0) (2026-08-31)

### ⚠ BREAKING CHANGES

- delegate all sample-rate conversion to the platform
- add dispose/flush lifecycle and WAV encoding to the session API

### Features

- add dispose/flush lifecycle and WAV encoding to the session API ([eb0ecf4](https://github.com/will-rice/vadkit/commit/eb0ecf44b82cfd5474191640341b06841ee25f5b))
- delegate all sample-rate conversion to the platform ([25668e2](https://github.com/will-rice/vadkit/commit/25668e2bfb3353f05030ddab603e3ba17e88c366))

### Bug Fixes

- anti-alias the resampler's downsampling path ([cc3b4b6](https://github.com/will-rice/vadkit/commit/cc3b4b6dc75a4bf9aff96cc83d9bcdf5e7f6c7bc))

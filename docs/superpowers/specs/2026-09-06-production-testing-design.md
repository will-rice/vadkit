# vadkit — production-readiness testing

Date: 2026-09-06
Status: approved in discussion, awaiting spec review

## Goals

- Every path a consumer actually takes is exercised in CI: bundling with
  Vite and webpack 5, importing under Node, loading unbundled from a CDN,
  and running the providers inside a real browser.
- Error and lifecycle behaviour is pinned by tests, not by reading the
  code: queue isolation, provider failures mid-stream, use after dispose,
  repeated stop/dispose.
- Coverage cannot regress silently; performance can be measured on demand.
- One new public API, `teeSource`, so the demo's fan-out is library code
  with tests instead of demo-only code without.

## Non-goals

- Raising the Node floor. Node 22 is in maintenance LTS until 2027-04-30
  and stays the `engines` floor; checks run on 22 and on the `.nvmrc` Node.
- Benchmarks as a CI gate. Shared runners make timing a noisy signal;
  benchmarks are a local tool with documented invocation.
- Testing against Firefox or WebKit. Chromium is the only browser in the
  suite; the wasm and Web Audio surfaces used are standard, and adding
  instances later is a config change.
- Any change to VAD behaviour. Parity fixtures are the reference and must
  keep passing unchanged.

## Current state

The suite (13 files, 57 tests) covers engine units, per-provider parity
fixtures under Node, cross-provider agreement, and `micSource` in headless
Chromium. Both bundler checks in the README are manual. The ONNX providers
never run in a browser, so bundled-model resolution via `import.meta.url`
and onnxruntime-web's wasm loading are untested. There is no `SerialQueue`
test, no mid-stream failure test, and no use-after-dispose test.

## Design

### 1. Packaging check

`scripts/check_packaging.sh`, invoked as `npm run check:packaging` and by
a `packaging` CI job. It packs the tarball once into a scratch directory
and runs four checks against it.

- **Vite app** (`tests/packaging/vite/`): a `package.json`, `index.html`,
  and two entries, `webrtc-only.ts` importing `vadkit` and `vadkit/webrtc`,
  and `silero.ts` importing `vadkit` and `vadkit/silero`. `vite build`
  must exit zero, the webrtc-only chunk must not contain the string
  `onnxruntime`, and the silero build must emit a hashed `.onnx` asset.
- **webpack 5 app** (`tests/packaging/webpack/`): the same two entries and
  the same three assertions with `webpack --mode production`.
- **Node import safety**: `node --input-type=module -e` importing
  `vadkit`, `vadkit/fireredvad`, `vadkit/silero`, and `vadkit/webrtc`
  from the installed tarball, with no DOM globals, must exit zero. Run
  under the current Node and, in CI, also under Node 22.
- **No-bundler path** (`tests/packaging/cdn.mjs`): a Playwright script
  (the `playwright` dev dependency already present) that opens a blank
  page on a fake origin and fulfils every request under it from disk:
  `dist/` and `models/` from the installed tarball, and
  `onnxruntime-web/dist/` from `node_modules`. The page carries an import
  map for `vadkit` and `onnxruntime-web`, creates a Silero session with an
  explicit model URL as the README instructs, processes one second of
  synthetic audio, and must return frames with probabilities in [0, 1].

Scratch consumer apps pin their bundler versions in their own
`package.json` so failures are attributable. They are excluded from the
root tsconfig, lint, and Vitest include patterns.

### 2. Providers in real Chromium

The existing provider tests run unchanged in both Vitest projects. Two
loaders in `tests/helpers.ts` become environment-aware:

- `loadPcm()` and `loadFixture()` resolve `new URL("./…", import.meta.url)`.
  Under Node that is a `file:` URL read with `readFileSync`; in the browser
  it is a dev-server URL read with `fetch`. The Node branch uses a dynamic
  `import("node:fs")` so the module evaluates in both environments.
- `loadModel(name)` returns bytes under Node and `undefined` in the browser,
  so each provider falls back to its bundled-model URL. That fallback is
  the point: in Chromium the parity tests exercise `import.meta.url`
  resolution and onnxruntime-web's wasm loading, the path a consumer hits.

The browser project's include becomes `tests/**/*.test.ts` minus
`tests/*.node.test.ts`; the `libfvad` source test is renamed to
`libfvad.node.test.ts`. Both loaders become async; call sites `await`.

### 3. Error and lifecycle coverage

New or extended Node tests:

- `serialQueue.test.ts`: tasks run in submission order even when earlier
  ones resolve later; a rejected task rejects only its own promise and the
  next task still runs.
- Session: a provider that throws on one call reports to `onError` when
  driven by a source, and a later `processChunk` succeeds.
- Chunk-size invariance: for each provider, feeding the clip in chunks of
  1, 7, 160, and 4096 samples yields frames identical to one whole-buffer
  call. This pins `ChunkBuffer` overlap arithmetic for the 400/160
  geometry at more than one size.
- `reset()` restores FireRedVAD and Silero bit-exactly (currently only
  WebRTC is tested).
- `stop()` and `dispose()` without a prior `start()`, and each called
  twice, resolve without throwing; `dispose()` releases the provider once.
- Model provenance: sha256 of each file in `models/` equals the hash
  recorded in `THIRD_PARTY_NOTICES`.

### 4. Use after dispose

`VadStream` records disposal. `processChunk`, `flush`, and `reset` after
`dispose()` reject with `Error("stream disposed")` instead of surfacing
onnxruntime's released-session error. `VadSession` inherits the behaviour
through its stream. Test first, one guard, no other change.

### 5. Coverage thresholds

Add `@vitest/coverage-v8`. Coverage is collected across both projects
(the v8 provider merges project results into one map; Chromium reports
through the Playwright provider) with `include: ["src/**"]` and
`exclude: ["src/providers/libfvad/**"]`. Thresholds are set two points
below the measured baseline for lines, functions, branches, and
statements, rounded down to a whole number. `npm run coverage` runs the
suite with coverage and enforces thresholds; CI runs it in the toolchain
job in place of `npm test`. `npm test` itself is unchanged.

### 6. Benchmarks

`tests/bench/providers.bench.ts` measures `processChunk` over the test
clip for each provider and reports real-time factor (seconds of audio per
second of wall time) in the benchmark name. Invocation is
`npm run bench`, documented in the README, not run in CI.

Where it runs is decided by a spike in the first benchmark task: if a
benchmark file executes under the browser project in this Vitest
version, it runs there (consumer-realistic numbers); otherwise it runs in
the Node project, and the README says so. Either way the file is one
file and the decision is recorded in the commit message.

### 7. Demo end to end

`tests/browser/demo.test.ts` sets `document.body.innerHTML` to the body of
`demo/index.html`, imports `demo/main.ts`, clicks the toggle, waits until
every panel's status has left "silence" at least once or a timeout
elapses, then clicks stop. It asserts all three panels received frames
and that stop resolved. `demo/main.ts` keeps its `window.demo` seam.

### 8. `teeSource` in the library

`src/teeSource.ts` exports
`teeSource(source: AudioSource, count: number): AudioSource[]`, the
demo's implementation moved verbatim and documented: the underlying source
starts once, after every consumer has started, and stops once, after
every consumer has stopped; the tees can be started again after that. It
is exported from the root entry (the export-surface test is updated) and
the demo imports it. Node tests with the fake source cover start-once,
fan-out to every consumer, stop-once, and restart.

## CI wiring

- `check` job: unchanged except `npm run coverage` replaces `npm test`.
- `node-floor` job: unchanged (`--project node` on Node 22).
- New `packaging` job: `npm ci`, `npx playwright install --with-deps
  chromium`, `npm run check:packaging` on the `.nvmrc` Node, then the
  Node import step again under Node 22 via a second `setup-node`.

## Decisions

- **Node 22 stays the floor** (2026-09-06). Maintenance LTS until
  2027-04-30; supporting it costs one existing CI job. Import safety is
  checked on 22 and on the `.nvmrc` Node.
- **One test file per provider, two runtimes.** Environment-aware loaders
  beat duplicated browser copies of the parity tests; the fixtures are
  the single source of truth.
- **Playwright routing instead of an HTTP server** for the CDN check. It
  keeps the check self-contained and dependency-free beyond what is
  already installed.
- **Benchmarks are informational.** A gate would either be flaky or so
  loose it never fires.

## Risks

1. **onnxruntime-web in Vitest browser mode.** The demo already runs ort
   under Vite dev with `optimizeDeps.exclude`, and the browser project
   extends the root config, so this is expected to work. If ort's wasm
   fails to resolve, the fix is a `server.fs.allow` or `optimizeDeps`
   entry, not a design change.
2. **Coverage in browser mode.** Supported by the v8 provider through
   Playwright. If Chromium coverage proves unreliable, thresholds are
   computed from the Node project only and `micSource` is excluded from
   the threshold set with a comment saying why.
3. **Fake microphone silence.** Chromium's fake device emits a tone, so
   the demo test's "left silence" condition should hold. If it does not,
   the test asserts frames received per panel and drops the status
   condition.
4. **Scratch app installs in CI** add roughly a minute (webpack, Vite).
   Accepted; the job is separate from `check` so it does not slow the
   fast feedback path.

## Milestones

1. Packaging check (Vite, webpack, Node import on both versions, CDN).
2. Providers in Chromium.
3. Error and lifecycle tests, use-after-dispose guard.
4. Coverage thresholds.
5. `teeSource` into the library, demo end to end.
6. Benchmarks.

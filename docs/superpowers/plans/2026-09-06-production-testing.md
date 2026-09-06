# Production-Readiness Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every consumer path (Vite, webpack, Node import, CDN, real browser) and every error/lifecycle path is exercised by CI, coverage cannot regress, and `teeSource` becomes tested library code.

**Architecture:** A bash packaging script builds scratch consumer apps against the packed tarball and drives a Playwright CDN check. The existing provider tests gain environment-aware loaders so the same files run in the Node and Chromium Vitest projects. New Node tests pin queue, failure, chunk-size, reset, and provenance behaviour; one small `VadStream` guard makes use-after-dispose a concise error.

**Tech Stack:** TypeScript strict/NodeNext, Vite+ (`vp` = Vitest 4.1.11, tsdown, oxfmt), `@vitest/browser-playwright` + Playwright 1.62 (Chromium), bash, onnxruntime-web 1.29.

**Spec:** `docs/superpowers/specs/2026-09-06-production-testing-design.md`

## Global Constraints

- Node floor stays `>=22` in `engines`; `.nvmrc` is 24. Develop on 24 (npm >= 11.5 is enforced by `devEngines`; npm 10 fails the gate).
- Conventional commit subjects, no attribution lines, explain why not what. Husky runs lint-staged (oxfmt, eslint) and `npm run typecheck` on every commit; commitlint on the message.
- `erasableSyntaxOnly`: no enums, no parameter properties. `isolatedDeclarations` in `src/`: explicit return types on every export. `noUncheckedIndexedAccess`: narrow indexed reads with `?? NaN`/explicit checks, never `!`. `exactOptionalPropertyTypes`: optional properties typed `| undefined`.
- Imports inside the package use `#`-subpath specifiers with `.ts` extensions (`#engine/session.ts`); tests import helpers relatively (`./helpers.ts`).
- Tests use `vite-plus/test` (`expect`, `test`). Run a single file with `npx vp test run <path>`; the whole suite with `npm test`. Browser project needs `npx playwright install chromium` once.
- No defensive code, no unused paths. Raise a concise `Error` for unsupported cases.
- Parity fixtures must keep passing unchanged. Never edit `tests/fixtures/*`.
- Commit each task separately with `git commit <paths>` (never bare `-a` when unrelated files are dirty).

---

### Task 1: Packaging check — Vite and webpack consumer builds

**Files:**
- Create: `tests/packaging/vite/package.json`, `tests/packaging/vite/vite.config.js`, `tests/packaging/vite/src/webrtc-only.js`, `tests/packaging/vite/src/silero.js`
- Create: `tests/packaging/webpack/package.json`, `tests/packaging/webpack/webpack.config.cjs`, `tests/packaging/webpack/src/webrtc-only.js`, `tests/packaging/webpack/src/silero.js`
- Create: `scripts/check_packaging.sh`
- Modify: `package.json` (scripts), `.github/workflows/ci.yml` (new job), `README.md` (Development section), `tsconfig.json` (exclude), `eslint.config.mjs` (ignore)

**Interfaces:**
- Produces: `scripts/check_packaging.sh` — exits non-zero on any failed check; honours env `EXTRA_NODE=<path to a node binary>` (used by Task 2). Scratch work dir is a `mktemp -d`, removed on exit.

- [ ] **Step 1: Scratch Vite app**

`tests/packaging/vite/package.json`:
```json
{
  "name": "vadkit-consumer-vite",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build" },
  "devDependencies": { "vite": "8.2.2" }
}
```

`tests/packaging/vite/vite.config.js` (one entry per build, chosen by `ENTRY`, so each output directory holds exactly one consumer's bundle):
```js
import { defineConfig } from "vite";

const entry = process.env.ENTRY;
if (!entry) throw new Error("ENTRY=webrtc-only|silero is required");

export default defineConfig({
  build: {
    rollupOptions: { input: `src/${entry}.js` },
    outDir: `out/${entry}`,
    assetsInlineLimit: 0,
  },
});
```

`tests/packaging/vite/src/webrtc-only.js`:
```js
import { createVad } from "vadkit";
import { webrtcVad } from "vadkit/webrtc";

// Exported so tree-shaking keeps the import graph.
export const ready = createVad(webrtcVad());
```

`tests/packaging/vite/src/silero.js`:
```js
import { createVad } from "vadkit";
import { sileroVad } from "vadkit/silero";

export const ready = createVad(sileroVad());
```

- [ ] **Step 2: Scratch webpack app**

`tests/packaging/webpack/package.json`:
```json
{
  "name": "vadkit-consumer-webpack",
  "private": true,
  "type": "module",
  "scripts": { "build": "webpack" },
  "devDependencies": { "webpack": "5.110.3", "webpack-cli": "7.2.3" }
}
```

`tests/packaging/webpack/webpack.config.cjs`:
```js
const path = require("node:path");

const entry = process.env.ENTRY;
if (!entry) throw new Error("ENTRY=webrtc-only|silero is required");

module.exports = {
  mode: "production",
  target: "web",
  entry: `./src/${entry}.js`,
  output: { path: path.join(__dirname, "out", entry), clean: true },
};
```

`tests/packaging/webpack/src/webrtc-only.js` and `src/silero.js`: identical content to the Vite ones above (copy them; the two apps must stay independent).

- [ ] **Step 3: The check script**

`scripts/check_packaging.sh`:
```bash
#!/usr/bin/env bash
# Consumer-side packaging checks against the packed tarball, the artifact
# npm actually publishes:
#   1. a Vite app and a webpack 5 app each build a webrtc-only entry and a
#      silero entry; the webrtc-only bundle must be free of onnxruntime and
#      the silero build must emit the model as a hashed asset;
#   2. every exports-map subpath imports under Node with no DOM
#      (and under $EXTRA_NODE too, when set — CI passes Node 22);
#   3. the no-bundler path: dist/ + models/ + ort served as static files
#      behind an import map, driven by Playwright (tests/packaging/cdn.mjs).
# Run: npm run check:packaging   (needs `npx playwright install chromium`)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== pack"
(cd "$ROOT" && npx vp pack >/dev/null)
TARBALL="$WORK/$(cd "$ROOT" && npm pack --silent --pack-destination "$WORK" | tail -1)"

for app in vite webpack; do
  echo "== $app"
  cp -R "$ROOT/tests/packaging/$app" "$WORK/$app"
  (cd "$WORK/$app" && npm install --no-audit --no-fund --silent "$TARBALL")
  for entry in webrtc-only silero; do
    (cd "$WORK/$app" && ENTRY="$entry" npm run -s build >/dev/null)
  done
  if grep -rq onnxruntime "$WORK/$app/out/webrtc-only"; then
    echo "FAIL: $app webrtc-only bundle contains onnxruntime" >&2
    exit 1
  fi
  if ! find "$WORK/$app/out/silero" -name '*.onnx' | grep -q .; then
    echo "FAIL: $app silero build emitted no .onnx asset" >&2
    exit 1
  fi
  echo "ok: $app webrtc-only is ort-free; silero emits the model asset"
done

echo "== node import"
mkdir "$WORK/node"
(cd "$WORK/node" && npm install --no-audit --no-fund --silent "$TARBALL")
cp "$ROOT/tests/packaging/node_import.mjs" "$WORK/node/"
for NODE_BIN in "$(command -v node)" ${EXTRA_NODE:-}; do
  (cd "$WORK/node" && "$NODE_BIN" node_import.mjs)
done

echo "== cdn"
(cd "$ROOT" && node tests/packaging/cdn.mjs "$WORK/node/node_modules")
echo "packaging checks passed"
```

For this task, create `tests/packaging/node_import.mjs` and `tests/packaging/cdn.mjs` as the minimal stubs below so the script runs end to end; Tasks 2 and 3 replace them.

`tests/packaging/node_import.mjs` (stub): `console.log("node import: not yet checked");`

`tests/packaging/cdn.mjs` (stub): `console.log("cdn: not yet checked");`

Make it executable: `chmod +x scripts/check_packaging.sh`.

- [ ] **Step 4: Keep the scratch apps out of the root toolchain**

`package.json` scripts, add:
```json
"check:packaging": "./scripts/check_packaging.sh"
```

`tsconfig.json`: add `"exclude": ["tests/packaging"]` next to `include`.

`eslint.config.mjs` `globalIgnores`: add `"tests/packaging/**"`.

- [ ] **Step 5: Run it**

Run: `npm run check:packaging`
Expected: the four `ok:` lines and `packaging checks passed`. If the webpack webrtc-only check fails with `onnxruntime` present, inspect `out/webrtc-only/main.js`; it must not, since the fix in commit `abc44b7` removed the Node branch.

- [ ] **Step 6: CI job and README**

`.github/workflows/ci.yml`, append:
```yaml
  packaging:
    name: packaging (consumer builds, Node import, CDN)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      # Node 22 first, so its binary is on disk for the import check below.
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          package-manager-cache: false
      - run: echo "EXTRA_NODE=$(command -v node)" >> "$GITHUB_ENV"
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run check:packaging
```

README, Development > Everyday commands, add after `npm run build`:
```
npm run check:packaging  # pack the tarball, build Vite + webpack consumers,
                         # import under Node, load unbundled behind an import map
```

- [ ] **Step 7: Commit**

```bash
git add tests/packaging scripts/check_packaging.sh package.json tsconfig.json eslint.config.mjs .github/workflows/ci.yml README.md
git commit -m "ci: build the packed tarball in Vite and webpack consumers

The two bundler checks in the README were manual, and the webpack break
shipped because nothing automated them. A packaging job now packs the
tarball, builds a webrtc-only and a silero entry in scratch Vite and
webpack apps, and asserts the webrtc-only bundle is ort-free and the
silero build emits the model asset."
```

---

### Task 2: Packaging check — Node import safety on 22 and the toolchain Node

**Files:**
- Modify: `tests/packaging/node_import.mjs` (replace stub)

**Interfaces:**
- Consumes: `scripts/check_packaging.sh` runs this file with cwd = a directory where the tarball is installed, once per Node binary.

- [ ] **Step 1: Write the check**

`tests/packaging/node_import.mjs`:
```js
// Import every exports-map subpath with no DOM present. Any top-level use
// of a browser global (window, AudioContext, navigator) throws here, which
// is what a server-side-rendering framework would hit at module load.
const subpaths = ["vadkit", "vadkit/fireredvad", "vadkit/silero", "vadkit/webrtc"];
for (const subpath of subpaths) {
  const mod = await import(subpath);
  if (Object.keys(mod).length === 0) throw new Error(`${subpath} exported nothing`);
}
console.log(`ok: ${subpaths.length} subpaths import under node ${process.version}`);
```

- [ ] **Step 2: Prove it can fail**

Temporarily add `window.x;` as the first line of `src/micSource.ts`, run `npm run check:packaging`, expect `ReferenceError: window is not defined` from the node import step. Revert with `git checkout -- src/micSource.ts`.

- [ ] **Step 3: Run green**

Run: `EXTRA_NODE="$HOME/.nvm/versions/node/v22.21.1/bin/node" npm run check:packaging`
Expected: two `ok: 4 subpaths import under node v24…` / `v22…` lines.

- [ ] **Step 4: Commit**

```bash
git add tests/packaging/node_import.mjs
git commit -m "ci: import every subpath under Node 22 and the toolchain Node

Server-side frameworks evaluate modules with no DOM; a top-level browser
global would crash them at import. The packaging job now imports each
exports-map subpath on the consumer floor and on the .nvmrc Node."
```

---

### Task 3: Packaging check — no-bundler path via import map

**Files:**
- Modify: `tests/packaging/cdn.mjs` (replace stub)

**Interfaces:**
- Consumes: argv[2] = path to a `node_modules` containing `vadkit` (installed tarball) and `onnxruntime-web`. Uses the root `playwright` dev dependency.

- [ ] **Step 1: Write the check**

`tests/packaging/cdn.mjs`:
```js
// The README's no-bundler path: dist/, models/, and onnxruntime-web's dist
// served as static files behind an import map, no bundler in the loop.
// Playwright fulfils every request under a fake origin from disk, so no
// HTTP server is needed. Usage: node tests/packaging/cdn.mjs <node_modules>
import { readFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const nodeModules = process.argv[2];
if (!nodeModules) throw new Error("usage: cdn.mjs <node_modules dir>");

const ORIGIN = "https://cdn.test";
const MOUNTS = {
  "/vadkit/": path.join(nodeModules, "vadkit"),
  "/ort/": path.join(nodeModules, "onnxruntime-web", "dist"),
};
const TYPES = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
};

const HTML = `<!doctype html>
<script type="importmap">
{"imports":{
  "vadkit":"/vadkit/dist/index.js",
  "vadkit/silero":"/vadkit/dist/providers/silero.js",
  "onnxruntime-web":"/ort/ort.bundle.min.mjs"
}}
</script>
<script type="module">
import { createVad } from "vadkit";
import { sileroVad } from "vadkit/silero";
const vad = await createVad(sileroVad({ model: "/vadkit/models/silero_vad.onnx" }));
const pcm = new Float32Array(16000);
for (let i = 0; i < pcm.length; i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / 16000);
const frames = await vad.processChunk(pcm);
window.result = frames.map((f) => f.probability);
</script>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    const prefix = Object.keys(MOUNTS).find((p) => pathname.startsWith(p));
    if (prefix === undefined) return route.fulfill({ status: 404 });
    const file = path.join(MOUNTS[prefix], pathname.slice(prefix.length));
    return route.fulfill({
      body: await readFile(file),
      contentType: TYPES[path.extname(file)] ?? "application/octet-stream",
    });
  });
  await page.route(`${ORIGIN}/`, (route) => route.fulfill({ contentType: "text/html", body: HTML }));
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => Array.isArray(window.result), null, { timeout: 30000 });
  const probs = await page.evaluate(() => window.result);
  if (errors.length > 0) throw errors[0];
  if (probs.length === 0) throw new Error("no frames returned");
  if (!probs.every((p) => p >= 0 && p <= 1)) throw new Error(`probability outside [0, 1]: ${probs}`);
  console.log(`ok: cdn page ran silero unbundled, ${probs.length} frames`);
} finally {
  await browser.close();
}
```

If `waitForFunction` times out, print `errors` before failing: Playwright registers routes newest-first, so the `/` route must be registered after the catch-all (it is above).

- [ ] **Step 2: Prove it can fail**

Temporarily change the import map's `"onnxruntime-web"` target to `/ort/missing.mjs`, run `npm run check:packaging`, expect a failure from the cdn step (a 404-driven module error). Revert.

- [ ] **Step 3: Run green**

Run: `npm run check:packaging`
Expected: `ok: cdn page ran silero unbundled, 31 frames` (16000 / 512 = 31).

- [ ] **Step 4: Commit**

```bash
git add tests/packaging/cdn.mjs
git commit -m "ci: load the package unbundled behind an import map

The README documents a CDN path with explicit model URLs that nothing
exercised. A Playwright script serves dist, the models, and ort's dist
from disk under a fake origin and runs Silero through it."
```

---

### Task 4: Providers in real Chromium via environment-aware loaders

**Files:**
- Modify: `tests/helpers.ts`, `tests/silero.test.ts`, `tests/fireredvad.test.ts`, `tests/webrtc.test.ts`, `tests/crossProvider.test.ts`, `tests/wav.test.ts`
- Rename: `tests/libfvad.test.ts` → `tests/libfvad.node.test.ts`
- Modify: `vite.config.ts` (browser project include)

**Interfaces:**
- Produces (in `tests/helpers.ts`):
```ts
export function readWav16kMono(buffer: ArrayBuffer): Float32Array; // unchanged
export function loadPcm(): Promise<Float32Array>;
export function loadFixture(name: string): Promise<unknown>;
export function loadModel(name: "fireredvad_stream_vad_e2e.onnx" | "silero_vad.onnx"): Promise<Uint8Array | undefined>; // undefined in the browser → provider uses its bundled URL
export function fakeProvider(windowSamples?: number, hopSamples?: number): VadProvider; // unchanged
```

- [ ] **Step 1: Rewrite the loaders**

Replace the three loader functions in `tests/helpers.ts` (keep `readWav16kMono` and `fakeProvider`, drop the `readFileSync`/`path`/`fileURLToPath` imports and `ROOT`):
```ts
// Both Vitest projects run these files: under Node import.meta.url is a
// file: URL, in Chromium it is the dev-server URL, and new URL() resolves
// relative to either. Only the read differs.
const IS_NODE = typeof window === "undefined";

async function readBytes(url: URL): Promise<ArrayBuffer> {
  if (IS_NODE) {
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(url);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.href}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

/** tests/assets/hello_en.wav as 16 kHz float PCM (2.24 s, speech ~0.3-1.8 s). */
export async function loadPcm(): Promise<Float32Array> {
  return readWav16kMono(await readBytes(new URL("./assets/hello_en.wav", import.meta.url)));
}

/** A parity fixture from tests/fixtures; the caller asserts its shape. */
export async function loadFixture(name: string): Promise<unknown> {
  const bytes = await readBytes(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Model bytes under Node, where ort cannot fetch a file: URL. In the
 * browser returns undefined so the provider resolves its bundled model via
 * import.meta.url — the path a consumer's bundler has to get right.
 */
export async function loadModel(
  name: "fireredvad_stream_vad_e2e.onnx" | "silero_vad.onnx",
): Promise<Uint8Array | undefined> {
  if (!IS_NODE) return undefined;
  return new Uint8Array(await readBytes(new URL(`../models/${name}`, import.meta.url)));
}
```

- [ ] **Step 2: Await at every call site**

In `silero.test.ts`, `fireredvad.test.ts`, `crossProvider.test.ts`, `wav.test.ts`: `loadPcm()` → `await loadPcm()`, `loadModel(...)` → `await loadModel(...)`, `loadFixture(...)` → `await loadFixture(...)`. In `webrtc.test.ts` the module-level fixture becomes top-level await:
```ts
const fixture = (await loadFixture("webrtc.json")) as {
  wav: string;
  frameMs: number;
  modes: Record<string, number[]>;
};
```
`git mv tests/libfvad.test.ts tests/libfvad.node.test.ts`.

- [ ] **Step 3: Include the suite in the browser project**

`vite.config.ts`, browser project `test.include`:
```ts
include: ["tests/*.test.ts", "tests/browser/*.test.ts"],
exclude: ["tests/*.node.test.ts"],
```
Node project stays `include: ["tests/*.test.ts"]` (its default exclude does not matter; `libfvad.node.test.ts` matches and should run there).

- [ ] **Step 4: Run both projects**

Run: `npm test`
Expected: Node project 13 files / 57 tests; browser project ≥ 15 files, all green. If Chromium fails to load ort's wasm, add `"onnxruntime-web"` to the root `optimizeDeps.exclude` (already present) and check the browser console via the failure output; the demo runs the same path under Vite dev, so this should pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add tests vite.config.ts
git commit -m "test: run the provider suites in Chromium too

The ONNX providers only ever ran under Node, so bundled-model resolution
via import.meta.url and onnxruntime-web's wasm loading were untested.
The loaders now resolve assets relative to import.meta.url in either
runtime, and loadModel hands the browser nothing so each provider falls
back to its bundled URL, which is the consumer path."
```

---

### Task 5: SerialQueue tests

**Files:**
- Create: `tests/serialQueue.test.ts`

- [ ] **Step 1: Write the tests**

```ts
import { expect, test } from "vite-plus/test";

import { SerialQueue } from "#engine/serialQueue.ts";

test("tasks run in submission order even when an earlier one resolves later", async () => {
  const queue = new SerialQueue();
  const order: number[] = [];
  const slow = queue.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push(1);
  });
  const fast = queue.run(() => {
    order.push(2);
  });
  await Promise.all([slow, fast]);
  expect(order).toEqual([1, 2]);
});

test("a rejected task rejects only its own promise; the next task still runs", async () => {
  const queue = new SerialQueue();
  const failing = queue.run(() => {
    throw new Error("boom");
  });
  const next = queue.run(() => "ok");
  await expect(failing).rejects.toThrow("boom");
  await expect(next).resolves.toBe("ok");
});
```

- [ ] **Step 2: Mutation check, then green**

Temporarily change `src/engine/serialQueue.ts` line 8-11 to `this.tail = result.then(() => undefined);` (drop the rejection handler). Run `npx vp test run --project node tests/serialQueue.test.ts`; the second test must fail (the queue stalls or `next` rejects). Revert with `git checkout -- src/engine/serialQueue.ts`, rerun, expect 2 passed.

- [ ] **Step 3: Commit**

```bash
git add tests/serialQueue.test.ts
git commit -m "test(serialQueue): pin ordering and failure isolation

The whole engine's safety rests on this class and it had no direct
test; a dropped rejection handler stalled every later chunk silently."
```

---

### Task 6: Session failure path and cross-provider invariants

**Files:**
- Modify: `tests/session.test.ts` (append)
- Create: `tests/providers.test.ts`

- [ ] **Step 1: Session: provider failure reaches onError, later chunks process**

Append to `tests/session.test.ts`:
```ts
test("a provider failure reaches onError and later chunks still process", async () => {
  const good = fakeProvider();
  let calls = 0;
  const flaky: VadProvider = {
    ...good,
    process(samples: Float32Array): Promise<Float32Array> {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("model exploded")) : good.process(samples);
    },
  };
  const errors: unknown[] = [];
  const frames: number[] = [];
  const vad = await createVad(() => Promise.resolve(flaky), {
    ...OPTS,
    onFrame: (f) => frames.push(f.index),
    onError: (e) => errors.push(e),
  });
  await vad.start(fakeSource(new Float32Array(2000), 1000));
  await vad.processChunk(new Float32Array(0)); // barrier: drain the serialized queue
  expect(errors).toHaveLength(1);
  expect(String(errors[0])).toMatch(/model exploded/);
  expect(frames.length).toBeGreaterThan(0);
});
```
Run: `npx vp test run --project node tests/session.test.ts` → passes (existing behaviour; the test documents it). Mutation: in `session.ts` `start`, replace `result.catch(onError)` with `void result` and confirm `errors` is empty and the test fails; revert.

- [ ] **Step 2: Cross-provider invariants**

`tests/providers.test.ts`:
```ts
import { expect, test } from "vite-plus/test";

import { createVad } from "#index.ts";
import { fireRedVad } from "#providers/fireredvad.ts";
import { sileroVad } from "#providers/silero.ts";
import { webrtcVad } from "#providers/webrtc.ts";
import type { ProviderFactory } from "#types.ts";

import { loadModel, loadPcm } from "./helpers.ts";

const pcm = await loadPcm();
const PROVIDERS: Record<string, ProviderFactory> = {
  fireRedVad: fireRedVad({ model: await loadModel("fireredvad_stream_vad_e2e.onnx") }),
  sileroVad: sileroVad({ model: await loadModel("silero_vad.onnx") }),
  webrtcVad: webrtcVad(),
};

async function probabilities(factory: ProviderFactory, chunkSize: number): Promise<number[]> {
  const vad = await createVad(factory);
  const out: number[] = [];
  for (let i = 0; i < pcm.length; i += chunkSize) {
    for (const f of await vad.processChunk(pcm.subarray(i, i + chunkSize))) out.push(f.probability);
  }
  await vad.dispose();
  return out;
}

for (const [name, factory] of Object.entries(PROVIDERS)) {
  test(`${name}: chunk size does not change the frames`, async () => {
    const whole = await probabilities(factory, pcm.length);
    expect(whole.length).toBeGreaterThan(0);
    for (const size of [1, 7, 160, 4096]) {
      const chunked = await probabilities(factory, size);
      expect(chunked.length, `size ${size}`).toBe(whole.length);
      for (const [i, p] of chunked.entries()) {
        // Same model, same state, different run lengths: kernel noise only.
        expect(Math.abs(p - (whole[i] ?? NaN)), `size ${size} frame ${i}`).toBeLessThanOrEqual(1e-4);
      }
    }
  });

  test(`${name}: reset() restores the initial state exactly`, async () => {
    const vad = await createVad(factory);
    const first = (await vad.processChunk(pcm)).map((f) => f.probability);
    await vad.reset();
    const second = (await vad.processChunk(pcm)).map((f) => f.probability);
    await vad.dispose();
    expect(second).toEqual(first);
  });
}
```

- [ ] **Step 3: Run**

Run: `npx vp test run tests/providers.test.ts` (both projects)
Expected: 6 tests pass per project. Chunk size 1 makes ~36k queue turns per provider; if it exceeds the 60 s timeout in Chromium, drop size 1 to 3 and note it in the commit.

- [ ] **Step 4: Commit**

```bash
git add tests/session.test.ts tests/providers.test.ts
git commit -m "test: pin chunk-size invariance, reset, and failure reporting

ChunkBuffer's overlap arithmetic was only exercised at one chunk size
per provider, reset was bit-exact-tested for WebRTC alone, and nothing
showed a mid-stream provider failure reaching onError."
```

---

### Task 7: Model provenance

**Files:**
- Create: `tests/models.node.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, test } from "vite-plus/test";

const NOTICES = readFileSync(new URL("../THIRD_PARTY_NOTICES", import.meta.url), "utf-8");

for (const name of ["fireredvad_stream_vad_e2e.onnx", "silero_vad.onnx"]) {
  test(`${name} matches the sha256 recorded in THIRD_PARTY_NOTICES`, () => {
    const section = NOTICES.slice(NOTICES.indexOf(`models/${name}`));
    const recorded = /sha256: ([0-9a-f]{64})/.exec(section)?.[1];
    expect(recorded).toBeDefined();
    const bytes = readFileSync(new URL(`../models/${name}`, import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(recorded);
  });
}
```

- [ ] **Step 2: Run, then commit**

Run: `npx vp test run --project node tests/models.node.test.ts` → 2 passed. Mutation: change one hex digit in `THIRD_PARTY_NOTICES`, confirm failure, revert.

```bash
git add tests/models.node.test.ts
git commit -m "test: pin the bundled models to the hashes in THIRD_PARTY_NOTICES

A silently swapped model would pass no test today unless it broke a
fixture; the notices already record each file's sha256."
```

---

### Task 8: Use after dispose is a concise error, dispose is idempotent

**Files:**
- Modify: `src/engine/vadStream.ts`, `src/engine/session.ts`
- Modify: `tests/session.test.ts` (append), `tests/vadStream.test.ts` (append)

**Interfaces:**
- Produces: `VadStream.disposed: boolean` getter; `processChunk`/`flush`/`reset` reject with `Error("stream disposed")` after `dispose()`; second `dispose()` is a no-op.

- [ ] **Step 1: Failing tests**

Append to `tests/vadStream.test.ts`:
```ts
test("use after dispose rejects with a concise error", async () => {
  const vad = await createVad(() => Promise.resolve(fakeProvider()), OPTS);
  await vad.dispose();
  expect(vad.stream.disposed).toBe(true);
  await expect(vad.stream.processChunk(new Float32Array(1000))).rejects.toThrow("stream disposed");
  await expect(vad.stream.flush()).rejects.toThrow("stream disposed");
  await expect(vad.stream.reset()).rejects.toThrow("stream disposed");
});
```
Append to `tests/session.test.ts`:
```ts
test("stop() and dispose() are safe without start() and when repeated", async () => {
  let disposed = 0;
  const provider: VadProvider = {
    ...fakeProvider(),
    dispose(): Promise<void> {
      disposed += 1;
      return Promise.resolve();
    },
  };
  const vad = await createVad(() => Promise.resolve(provider), OPTS);
  await vad.stop();
  await vad.stop();
  await vad.dispose();
  await vad.dispose();
  expect(disposed).toBe(1);
});
```

- [ ] **Step 2: Verify red**

Run: `npx vp test run --project node tests/vadStream.test.ts tests/session.test.ts`
Expected: the first fails on `disposed` being undefined; the second fails with `disposed` = 2.

- [ ] **Step 3: Implement**

`src/engine/vadStream.ts`: add a field and a guard.
```ts
  private live = true;

  /** True once dispose() has run; every other method rejects afterwards. */
  get disposed(): boolean {
    return !this.live;
  }
```
Change the four queued methods:
```ts
  processChunk(pcm: Float32Array): Promise<VadFrame[]> {
    return this.queue.run(() => {
      this.assertLive();
      return this.processContiguous(pcm);
    });
  }

  flush(): Promise<VadEvent[]> {
    return this.queue.run(() => {
      this.assertLive();
      return this.segmenter.flush();
    });
  }

  dispose(): Promise<void> {
    return this.queue.run(async () => {
      if (!this.live) return;
      this.live = false;
      await this.provider.dispose();
    });
  }

  reset(): Promise<void> {
    return this.queue.run(() => {
      this.assertLive();
      this.buffer.reset();
      this.segmenter.reset();
      this.provider.reset();
    });
  }

  private assertLive(): void {
    if (!this.live) throw new Error("stream disposed");
  }
```
`src/engine/session.ts` `dispose()`:
```ts
  /** Stop and flush, then release the provider. Unusable afterwards; repeat calls are no-ops. */
  async dispose(): Promise<void> {
    if (this.stream.disposed) return;
    await this.stop();
    await this.stream.dispose();
  }
```

- [ ] **Step 4: Verify green, update docs**

Run: `npm test` → all green. README Quickstart comment on `dispose()` already says "when done for good"; no change needed.

- [ ] **Step 5: Commit**

```bash
git add src/engine/vadStream.ts src/engine/session.ts tests/vadStream.test.ts tests/session.test.ts
git commit -m "feat: reject use after dispose with a concise error

processChunk after dispose surfaced onnxruntime's released-session
message, and a second dispose released the provider twice. The stream
now records disposal, rejects later calls with \"stream disposed\", and
treats repeated dispose as a no-op."
```

---

### Task 9: Coverage thresholds

**Files:**
- Modify: `package.json` (dev dep + script), `vite.config.ts` (coverage), `.github/workflows/ci.yml` (`check` job), `README.md`

- [ ] **Step 1: Install and measure**

```bash
npm install -D @vitest/coverage-v8@4.1.11
npx vp test run --coverage --coverage.include='src/**' --coverage.exclude='src/providers/libfvad/**'
```
Record the `All files` line percentages for statements, branches, functions, lines.

- [ ] **Step 2: Configure**

`vite.config.ts` root `test`, add (numbers = each measured value minus 2, floored; replace the 90s below with the measured results):
```ts
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/providers/libfvad/**"],
      thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
    },
```
`package.json` scripts: `"coverage": "vp test run --coverage"`.
`ci.yml` `check` job: replace `- run: npm test` with `- run: npm run coverage`.
README Everyday commands: `npm run coverage   # npm test + v8 coverage, thresholds enforced`.

- [ ] **Step 3: Prove the gate**

Temporarily set `lines: 100`, run `npm run coverage`, expect a threshold failure and non-zero exit. Restore.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json vite.config.ts .github/workflows/ci.yml README.md
git commit -m "ci: enforce coverage thresholds two points under the baseline

Coverage across both Vitest projects is merged by the v8 provider; the
thresholds catch a dropped test or an untested branch without making
the numbers a target."
```

---

### Task 10: `teeSource` in the library

**Files:**
- Create: `src/teeSource.ts`, `tests/teeSource.test.ts`
- Modify: `src/index.ts`, `tests/exports.test.ts`, `demo/main.ts`, `README.md`

**Interfaces:**
- Produces: `export function teeSource(source: AudioSource, count: number): AudioSource[]`

- [ ] **Step 1: Failing tests**

`tests/teeSource.test.ts`:
```ts
import { expect, test } from "vite-plus/test";

import { teeSource } from "#index.ts";
import type { AudioSource } from "#index.ts";

/** A source that records lifecycle calls and lets the test push chunks. */
function trackedSource(): AudioSource & { starts: number; stops: number; push(pcm: Float32Array): void } {
  let deliver: ((pcm: Float32Array) => void) | null = null;
  return {
    starts: 0,
    stops: 0,
    start(onChunk): Promise<void> {
      this.starts += 1;
      deliver = onChunk;
      return Promise.resolve();
    },
    stop(): Promise<void> {
      this.stops += 1;
      deliver = null;
      return Promise.resolve();
    },
    push(pcm: Float32Array): void {
      if (deliver === null) throw new Error("not started");
      deliver(pcm);
    },
  };
}

test("the underlying source starts once, after every tee has started", async () => {
  const source = trackedSource();
  const [a, b] = teeSource(source, 2);
  if (a === undefined || b === undefined) throw new Error("expected two tees");
  await a.start(() => undefined);
  expect(source.starts).toBe(0);
  await b.start(() => undefined);
  expect(source.starts).toBe(1);
});

test("chunks fan out to every tee", async () => {
  const source = trackedSource();
  const received: number[][] = [[], []];
  const tees = teeSource(source, 2);
  await Promise.all(tees.map((tee, i) => tee.start((pcm) => received[i]?.push(pcm.length))));
  source.push(new Float32Array(3));
  source.push(new Float32Array(5));
  expect(received).toEqual([[3, 5], [3, 5]]);
});

test("the underlying source stops once, after every tee has stopped, and can restart", async () => {
  const source = trackedSource();
  const tees = teeSource(source, 3);
  await Promise.all(tees.map((tee) => tee.start(() => undefined)));
  await tees[0]?.stop();
  await tees[1]?.stop();
  expect(source.stops).toBe(0);
  await tees[2]?.stop();
  expect(source.stops).toBe(1);
  await Promise.all(tees.map((tee) => tee.start(() => undefined)));
  expect(source.starts).toBe(2);
});
```
`tests/exports.test.ts`: add `"teeSource"` to the list.

- [ ] **Step 2: Verify red**

Run: `npx vp test run --project node tests/teeSource.test.ts tests/exports.test.ts`
Expected: import error (`teeSource` is not exported) and the export-list mismatch.

- [ ] **Step 3: Implement**

`src/teeSource.ts` (the demo's implementation, moved):
```ts
import type { AudioSource } from "#engine/session.ts";

/**
 * Split one AudioSource into `count` sources that share its lifecycle, e.g.
 * one microphone feeding several sessions. The underlying source starts
 * once all tees have started and stops once all tees have stopped; after
 * that the tees can be started again.
 */
export function teeSource(source: AudioSource, count: number): AudioSource[] {
  const listeners: ((pcm: Float32Array) => void)[] = [];
  let started = 0;
  let stopped = 0;
  return Array.from({ length: count }, () => ({
    async start(onChunk: (pcm: Float32Array) => void): Promise<void> {
      listeners.push(onChunk);
      started += 1;
      if (started === count) {
        await source.start((pcm) => {
          for (const listener of listeners) listener(pcm);
        });
      }
    },
    async stop(): Promise<void> {
      stopped += 1;
      if (stopped === count) {
        started = 0;
        stopped = 0;
        listeners.length = 0;
        await source.stop();
      }
    },
  }));
}
```
`src/index.ts`: add `export { teeSource } from "#teeSource.ts";` (keep alphabetical by specifier: after `#micSource.ts`).
`demo/main.ts`: delete the local `teeSource` function and its doc comment; add `teeSource` to the `#index.ts` value import; keep `teeSource` on `window.demo`.
README, after the `micSource` quickstart block, one sentence: "`teeSource(micSource(), n)` splits one microphone across `n` sessions sharing its lifecycle (the demo runs three providers on one mic this way)."

- [ ] **Step 4: Verify green**

Run: `npm test && npm run typecheck && npm run lint` → green. `npx vp build demo --base /vadkit/` → builds.

- [ ] **Step 5: Commit**

```bash
git add src/teeSource.ts src/index.ts tests/teeSource.test.ts tests/exports.test.ts demo/main.ts README.md
git commit -m "feat: move teeSource into the package

Fanning one microphone across several sessions is a real use case the
demo needed; as demo-only code it had no tests. It is now exported with
lifecycle tests: start once after all tees start, stop once after all
tees stop, restartable."
```

---

### Task 11: Demo end to end in Chromium

**Files:**
- Modify: `demo/main.ts` (frame counts on the seam)
- Create: `tests/browser/demo.test.ts`

- [ ] **Step 1: Expose frame counts on the existing seam**

`demo/main.ts`: add `const frameCounts: Record<string, number> = {};` next to `panels`; in `callbacksFor`'s `onFrame`, first line `frameCounts[name] = (frameCounts[name] ?? 0) + 1;`; add `frameCounts` to the `window.demo` object.

- [ ] **Step 2: Write the test**

`tests/browser/demo.test.ts`:
```ts
import { expect, test } from "vite-plus/test";

interface DemoSeam {
  frameCounts: Record<string, number>;
}

function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = (): void => {
      if (predicate()) resolve();
      else if (performance.now() - started > timeoutMs) reject(new Error("timed out"));
      else setTimeout(tick, 50);
    };
    tick();
  });
}

test("the demo runs all three providers on one microphone and stops cleanly", async () => {
  document.body.innerHTML = `
    <p id="info"></p>
    <button id="toggle" disabled>Start microphone</button>
    <div id="panels"></div>`;
  await import("../../demo/main.ts"); // loads the models, enables the toggle
  const toggle = document.getElementById("toggle") as HTMLButtonElement;
  expect(toggle.disabled).toBe(false);
  expect(document.querySelectorAll(".provider")).toHaveLength(3);

  const seam = (window as unknown as { demo: DemoSeam }).demo;
  toggle.click();
  await waitFor(() => Object.values(seam.frameCounts).filter((n) => n >= 5).length === 3);

  toggle.click();
  await waitFor(() => toggle.textContent === "Start microphone");
  const counts = { ...seam.frameCounts };
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(seam.frameCounts).toEqual(counts); // nothing arrives after stop
});
```

- [ ] **Step 3: Run**

Run: `npx vp test run --project browser tests/browser/demo.test.ts`
Expected: 1 passed. If the model `?url` imports fail to resolve from the test file, the cause is Vite's `import.meta.url` base for `demo/main.ts`; report it rather than patch around it.

- [ ] **Step 4: Commit**

```bash
git add demo/main.ts tests/browser/demo.test.ts
git commit -m "test: run the demo end to end against the fake microphone

The published demo is the one thing users see first and nothing
exercised it. The existing window.demo seam gains per-provider frame
counts; the test starts the mic, waits for frames on all three panels,
and stops."
```

---

### Task 12: Benchmarks

**Files:**
- Create: `tests/bench/providers.bench.ts`
- Modify: `vite.config.ts` (benchmark include), `package.json` (script), `README.md`

- [ ] **Step 1: Write the benchmark**

`tests/bench/providers.bench.ts`:
```ts
import { bench } from "vite-plus/test";

import { createVad } from "#index.ts";
import { fireRedVad } from "#providers/fireredvad.ts";
import { sileroVad } from "#providers/silero.ts";
import { webrtcVad } from "#providers/webrtc.ts";

import { loadModel, loadPcm } from "../helpers.ts";

// Real-time factor = clip seconds / mean run time; the clip length is in
// each benchmark's name so the reporter's mean reads directly.
const pcm = await loadPcm();
const clipSec = (pcm.length / 16000).toFixed(2);

const sessions = {
  fireRedVad: await createVad(fireRedVad({ model: await loadModel("fireredvad_stream_vad_e2e.onnx") })),
  sileroVad: await createVad(sileroVad({ model: await loadModel("silero_vad.onnx") })),
  webrtcVad: await createVad(webrtcVad()),
};

for (const [name, vad] of Object.entries(sessions)) {
  bench(`${name}: ${clipSec} s clip`, async () => {
    await vad.reset();
    await vad.processChunk(pcm);
  });
}
```
If `vite-plus/test` does not export `bench`, import it from `"vitest"` (hoisted at the root of node_modules).

- [ ] **Step 2: Spike — which project runs it**

Add to the browser project's `test`: `benchmark: { include: ["tests/bench/*.bench.ts"] }`. Run `npx vp test bench --project browser` (if `vp test bench` is not a command, `npx vitest bench --project browser`). If benchmarks execute in Chromium and print a table, keep it there. If Vitest reports that benchmarks are unsupported in browser mode, move the `benchmark` block to the Node project instead and run `--project node`. Record the outcome in the commit message and README.

- [ ] **Step 3: Script and docs**

`package.json` scripts: `"bench": "vp test bench --project browser"` (or `--project node` per the spike; use the exact command that worked).
README, Everyday commands: `npm run bench       # per-provider throughput; RTF = clip seconds / mean` plus one sentence under Development noting which runtime the numbers come from.

- [ ] **Step 4: Commit**

```bash
git add tests/bench vite.config.ts package.json README.md
git commit -m "test: benchmark per-provider throughput on the parity clip

Production readiness includes knowing the real-time factor of each
provider. The benchmark is a local tool, not a CI gate, because shared
runners make timing noise."
```
(Append a line stating whether it runs in Chromium or Node and why.)

---

## Self-review notes

- Spec §1 → Tasks 1-3; §2 → Task 4; §3 → Tasks 5-7; §4 → Task 8; §5 → Task 9; §6 → Task 12; §7 → Task 11; §8 → Task 10; CI wiring → Tasks 1, 2, 9.
- Task 8's idempotent-dispose test was placed there rather than in Task 6 because it needs the guard to pass.
- `loadModel` returns `Promise<Uint8Array | undefined>` in Task 4 and is consumed as such in Tasks 6 and 12; `teeSource`'s signature in Task 10 matches its use in `demo/main.ts` and the exports test.

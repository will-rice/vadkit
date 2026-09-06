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
  // Playwright matches routes newest-first, so the catch-all goes first.
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
  await page.route(`${ORIGIN}/`, (route) =>
    route.fulfill({ contentType: "text/html", body: HTML }),
  );
  await page.goto(`${ORIGIN}/`);
  try {
    await page.waitForFunction(() => Array.isArray(window.result), null, { timeout: 30000 });
  } catch (error) {
    throw errors[0] ?? error;
  }
  const probs = await page.evaluate(() => window.result);
  if (probs.length === 0) throw new Error("no frames returned");
  if (!probs.every((p) => p >= 0 && p <= 1))
    throw new Error(`probability outside [0, 1]: ${probs}`);
  console.log(`ok: cdn page ran silero unbundled, ${probs.length} frames`);
} finally {
  await browser.close();
}

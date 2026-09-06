import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("the vendored wasm module has no Node-only imports", () => {
  // Emscripten's node environment emits `import("node:module")`, which
  // webpack 5 rejects outright (UnhandledSchemeError) in browser builds.
  // The module embeds its wasm and has no filesystem, so it needs none.
  const source = readFileSync(
    path.join(HERE, "..", "src", "providers", "libfvad", "fvad.js"),
    "utf-8",
  );
  expect(source).not.toMatch(/["']node:[a-z]+["']/);
});

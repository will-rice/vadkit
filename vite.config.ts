import { defineConfig } from "vitest/config";

// Serves the demo (npm run demo passes the demo/ root on the CLI) and
// carries the vitest config; vitest picks this file up automatically.
export default defineConfig({
  assetsInclude: ["**/*.onnx"],
  // Keep onnxruntime-web unbundled so its import.meta.url-relative wasm
  // assets resolve from node_modules during dev.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  test: { testTimeout: 60000 },
});

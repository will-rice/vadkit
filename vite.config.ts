import { defineConfig } from "vite";

export default defineConfig({
  root: "demo",
  assetsInclude: ["**/*.onnx"],
  // Keep onnxruntime-web unbundled so its import.meta.url-relative wasm
  // assets resolve from node_modules during dev.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
});

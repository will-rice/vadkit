import { defineConfig } from "vite-plus";

// One config for the whole Vite+ toolchain: demo dev server (npm run demo
// passes the demo/ root on the CLI), vitest, and library packaging.
export default defineConfig({
  assetsInclude: ["**/*.onnx"],
  // Keep onnxruntime-web unbundled so its import.meta.url-relative wasm
  // assets resolve from node_modules during dev.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  test: { testTimeout: 60000 },
  // One entry per package.json "exports" subpath, so output lands at
  // dist/index.js and dist/providers/<name>.js. A new provider is added
  // here and in "exports" together. publint + attw run as explicit
  // build-script steps.
  pack: {
    entry: [
      "src/index.ts",
      "src/providers/fireredvad.ts",
      "src/providers/silero.ts",
      "src/providers/webrtc.ts",
    ],
    tsconfig: "tsconfig.build.json",
    outDir: "dist",
    platform: "browser",
    target: "es2022",
    format: ["esm"],
    dts: { sourcemap: true },
    sourcemap: true,
  },
});

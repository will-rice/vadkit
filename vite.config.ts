import { defineConfig } from "vite-plus";

// One config for the whole Vite+ toolchain: demo dev server (npm run demo
// passes the demo/ root on the CLI), vitest, and library packaging.
export default defineConfig({
  assetsInclude: ["**/*.onnx"],
  // Keep onnxruntime-web unbundled so its import.meta.url-relative wasm
  // assets resolve from node_modules during dev.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  test: { testTimeout: 60000 },
  // Entries mirror src/, so output lands at dist/index.js and
  // dist/providers/<name>.js — the paths package.json "exports" already
  // pins. The providers glob means adding a provider needs no config
  // change. publint + attw run as explicit build-script steps.
  pack: {
    entry: ["src/index.ts", "src/providers/*.ts"],
    tsconfig: "tsconfig.build.json",
    outDir: "dist",
    platform: "browser",
    target: "es2022",
    format: ["esm"],
    dts: true,
    sourcemap: false,
  },
});

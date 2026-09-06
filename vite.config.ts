import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vite-plus";

// One config for the whole Vite+ toolchain: demo dev server (npm run demo
// passes the demo/ root on the CLI), vitest, and library packaging.
export default defineConfig({
  assetsInclude: ["**/*.onnx"],
  // Keep onnxruntime-web unbundled so its import.meta.url-relative wasm
  // assets resolve from node_modules during dev.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  test: {
    testTimeout: 60000,
    // Merged across both projects by the v8 provider. Thresholds sit two
    // points under the baseline measured when they were introduced, so a
    // dropped test fails the build without making the numbers a target.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/providers/libfvad/**"],
      thresholds: { statements: 95, branches: 87, functions: 98, lines: 96 },
    },
    // Engine and provider suites run in Node; tests/browser runs in real
    // Chromium so the AudioContext + AudioWorklet capture path (which no
    // Node fake can stand in for) is gated like everything else.
    projects: [
      {
        extends: true,
        test: { name: "node", include: ["tests/*.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["tests/*.test.ts", "tests/browser/*.test.ts"],
          exclude: ["tests/*.node.test.ts"],
          benchmark: { include: ["tests/bench/*.bench.ts"] },
          browser: {
            enabled: true,
            headless: true,
            // Fake media flags: getUserMedia yields a synthetic microphone
            // with no permission prompt.
            provider: playwright({
              launchOptions: {
                channel: "chromium",
                args: [
                  "--use-fake-device-for-media-stream",
                  "--use-fake-ui-for-media-stream",
                  "--autoplay-policy=no-user-gesture-required",
                ],
              },
            }),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
  // One entry per package.json "exports" subpath, so output lands at
  // dist/index.js and dist/providers/<name>.js. A new provider is added
  // here and in "exports" together. publint + attw run as explicit
  // build-script steps.
  pack: {
    entry: [
      "src/index.ts",
      "src/providers/fireredvad.ts",
      "src/providers/fsmn.ts",
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

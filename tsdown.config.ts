import { defineConfig } from "tsdown";

// Entries mirror src/, so output lands at dist/index.js and
// dist/providers/<name>.js — the paths package.json "exports" already pins.
// The providers glob means adding a provider needs no build-config change.
export default defineConfig({
  entry: ["src/index.ts", "src/providers/*.ts"],
  tsconfig: "tsconfig.build.json",
  outDir: "dist",
  platform: "browser",
  // Explicit: tsdown otherwise infers target from engines.node.
  target: "es2022",
  format: ["esm"],
  dts: true,
  sourcemap: false,
  publint: true,
  // ESM-only package (type: module, engines.node >= 20): legacy node10 and
  // require() resolutions are out of scope by design.
  attw: { profile: "esm-only" },
});

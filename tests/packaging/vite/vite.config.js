import { defineConfig } from "vite";

// One entry per build, chosen by ENTRY, so each output directory holds
// exactly one consumer's bundle and the assertions stay unambiguous.
const entry = process.env.ENTRY;
if (!entry) throw new Error("ENTRY=webrtc-only|silero is required");

export default defineConfig({
  build: {
    rollupOptions: { input: `src/${entry}.js` },
    outDir: `out/${entry}`,
    assetsInlineLimit: 0,
  },
});

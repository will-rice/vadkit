import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, test } from "vite-plus/test";

const NOTICES = readFileSync(new URL("../THIRD_PARTY_NOTICES", import.meta.url), "utf-8");

for (const name of ["fireredvad_stream_vad_e2e.onnx", "silero_vad.onnx", "fsmn_vad_e2e.onnx"]) {
  test(`${name} matches the sha256 recorded in THIRD_PARTY_NOTICES`, () => {
    const section = NOTICES.slice(NOTICES.indexOf(`models/${name}`));
    const recorded = /sha256: ([0-9a-f]{64})/.exec(section)?.[1];
    expect(recorded).toBeDefined();
    const bytes = readFileSync(new URL(`../models/${name}`, import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(recorded);
  });
}

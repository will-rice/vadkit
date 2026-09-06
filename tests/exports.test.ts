import { expect, test } from "vite-plus/test";

import * as vadkit from "#index.ts";

test("the root entry exports exactly the documented API", () => {
  // Anything listed here is public and therefore frozen by semver. The
  // engine's buffers and segmenter are implementation details.
  expect(Object.keys(vadkit).sort()).toEqual(
    [
      "DEFAULT_VAD_OPTIONS",
      "SAMPLE_RATE",
      "VadSession",
      "VadStream",
      "createVad",
      "encodeWav",
      "micSource",
      "teeSource",
    ].sort(),
  );
});

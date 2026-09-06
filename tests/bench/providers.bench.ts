import { bench } from "vite-plus/test";

import { createVad } from "#index.ts";
import { fireRedVad } from "#providers/fireredvad.ts";
import { fsmnVad } from "#providers/fsmn.ts";
import { sileroVad } from "#providers/silero.ts";
import { webrtcVad } from "#providers/webrtc.ts";

import { loadModel, loadPcm } from "../helpers.ts";

// Real-time factor = clip seconds / mean run time; the clip length is in
// each benchmark's name so the reporter's mean reads directly.
const pcm = await loadPcm();
const clipSec = (pcm.length / 16000).toFixed(2);

const sessions = {
  fireRedVad: await createVad(
    fireRedVad({ model: await loadModel("fireredvad_stream_vad_e2e.onnx") }),
  ),
  sileroVad: await createVad(sileroVad({ model: await loadModel("silero_vad.onnx") })),
  fsmnVad: await createVad(fsmnVad({ model: await loadModel("fsmn_vad_e2e.onnx") })),
  webrtcVad: await createVad(webrtcVad()),
};

for (const [name, vad] of Object.entries(sessions)) {
  bench(`${name}: ${clipSec} s clip`, async () => {
    await vad.reset();
    await vad.processChunk(pcm);
  });
}

import { createVad } from "vadkit";
import { webrtcVad } from "vadkit/webrtc";

// Exported so tree-shaking keeps the import graph.
export const ready = createVad(webrtcVad());

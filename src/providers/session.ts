import * as ort from "onnxruntime-web";

import { SerialQueue } from "../engine/serialQueue.ts";

// ort-web's wasm backend is single-threaded and rejects overlapping run()
// calls across sessions ("Session already started") in bundled apps.
// Serializing every inference through one queue makes concurrent use of
// multiple ONNX providers safe, and costs nothing: the runs could never
// actually execute in parallel.
const inferenceQueue = new SerialQueue();

/** Create an ort session from a model URL/path or raw bytes. */
export function createSession(
  model: string | Uint8Array,
  sessionOptions?: ort.InferenceSession.SessionOptions,
): Promise<ort.InferenceSession> {
  return typeof model === "string"
    ? ort.InferenceSession.create(model, sessionOptions)
    : ort.InferenceSession.create(model, sessionOptions);
}

/** Run inference, serialized across every ONNX-backed provider. */
export function runInference(
  session: ort.InferenceSession,
  feeds: Record<string, ort.Tensor>,
): Promise<ort.InferenceSession.OnnxValueMapType> {
  return inferenceQueue.run(() => session.run(feeds));
}

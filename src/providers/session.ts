import * as ort from "onnxruntime-web";

/** Create an ort session from a model URL/path or raw bytes. */
export function createSession(
  model: string | Uint8Array,
  sessionOptions?: ort.InferenceSession.SessionOptions,
): Promise<ort.InferenceSession> {
  return typeof model === "string"
    ? ort.InferenceSession.create(model, sessionOptions)
    : ort.InferenceSession.create(model, sessionOptions);
}

import { createVad } from "vadkit";
import { sileroVad } from "vadkit/silero";

// Exported so tree-shaking keeps the import graph.
export const ready = createVad(sileroVad());

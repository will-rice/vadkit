import { createVad, micSource, teeSource } from "#index.ts";
import type { Utterance, VadFrame } from "#index.ts";
import { fireRedVad } from "#providers/fireredvad.ts";
import { fsmnVad } from "#providers/fsmn.ts";
import { sileroVad } from "#providers/silero.ts";
import { webrtcVad } from "#providers/webrtc.ts";

import fireRedModelUrl from "../models/fireredvad_stream_vad_e2e.onnx?url";
import fsmnModelUrl from "../models/fsmn_vad_e2e.onnx?url";
import sileroModelUrl from "../models/silero_vad.onnx?url";

const HISTORY_SEC = 8;
const DEFAULT_THRESHOLD = 0.4;

// FSMN-VAD sits near 0.5 on non-speech where the others fall to their floor;
// FunASR reads it against 0.6, so it gets its own threshold here.
const PROVIDERS = [
  {
    label: "FireRedVAD (10 ms)",
    frameSec: 0.01,
    speechThreshold: DEFAULT_THRESHOLD,
    factory: fireRedVad({ model: fireRedModelUrl }),
  },
  {
    label: "Silero VAD (32 ms)",
    frameSec: 0.032,
    speechThreshold: DEFAULT_THRESHOLD,
    factory: sileroVad({ model: sileroModelUrl }),
  },
  {
    label: "FSMN-VAD (10 ms)",
    frameSec: 0.01,
    speechThreshold: 0.7,
    factory: fsmnVad({ model: fsmnModelUrl }),
  },
  {
    label: "WebRTC VAD (10 ms, mode 3)",
    frameSec: 0.01,
    speechThreshold: DEFAULT_THRESHOLD,
    factory: webrtcVad({ aggressiveness: 3 }),
  },
];

interface Panel {
  history: VadFrame[];
  maxFrames: number;
  speechThreshold: number;
  segments: string[];
  canvas: HTMLCanvasElement;
  status: HTMLSpanElement;
  utterances: HTMLDivElement;
}

const info = document.getElementById("info") as HTMLParagraphElement;
const toggle = document.getElementById("toggle") as HTMLButtonElement;
const panelsRoot = document.getElementById("panels") as HTMLDivElement;
const panels = new Map<string, Panel>();
const frameCounts: Record<string, number> = {};

function mustQuery<T extends Element>(root: ParentNode, selector: string, type: new () => T): T {
  const element = root.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`missing element ${selector}`);
  return element;
}

function makePanel(name: string, frameSec: number, speechThreshold: number): void {
  const root = document.createElement("div");
  root.className = "provider";
  root.innerHTML = `
    <h2>${name} <span class="status">silence</span></h2>
    <canvas width="1700" height="180"></canvas>
    <div class="utterances">&mdash;</div>`;
  panelsRoot.append(root);
  panels.set(name, {
    history: [],
    maxFrames: Math.round(HISTORY_SEC / frameSec),
    speechThreshold,
    segments: [],
    canvas: mustQuery(root, "canvas", HTMLCanvasElement),
    status: mustQuery(root, ".status", HTMLSpanElement),
    utterances: mustQuery(root, ".utterances", HTMLDivElement),
  });
}

function draw(panel: Panel): void {
  const ctx = panel.canvas.getContext("2d");
  if (ctx === null) return;
  const { width, height } = panel.canvas;
  const frames = panel.history.slice(-panel.maxFrames);
  const x = (i: number): number => (i / panel.maxFrames) * width;
  const y = (p: number): number => height - p * height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(46, 160, 90, 0.25)";
  for (let i = 0; i < frames.length; i++) {
    if (frames[i]?.isSpeech === true) {
      ctx.fillRect(x(i), 0, width / panel.maxFrames + 1, height);
    }
  }
  ctx.strokeStyle = "#5a5f6a";
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(0, y(panel.speechThreshold));
  ctx.lineTo(width, y(panel.speechThreshold));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = "#4f7cff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < frames.length; i++) {
    const py = y(frames[i]?.smoothedProbability ?? 0);
    if (i === 0) ctx.moveTo(x(i), py);
    else ctx.lineTo(x(i), py);
  }
  ctx.stroke();
}

function callbacksFor(name: string): {
  onFrame: (frame: VadFrame) => void;
  onSpeechEnd: (utterance: Utterance) => void;
} {
  return {
    onFrame: (frame): void => {
      frameCounts[name] = (frameCounts[name] ?? 0) + 1;
      const panel = panels.get(name);
      if (panel === undefined) return;
      panel.history.push(frame);
      panel.status.textContent = frame.isSpeech ? "speech" : "silence";
      panel.status.classList.toggle("speech", frame.isSpeech);
      draw(panel);
    },
    onSpeechEnd: (utterance): void => {
      const panel = panels.get(name);
      if (panel === undefined) return;
      const dur = utterance.audio.length / 16000;
      panel.segments.push(
        `${utterance.startTime.toFixed(2)}–${utterance.endTime.toFixed(2)} (${dur.toFixed(2)}s audio)`,
      );
      panel.utterances.textContent = panel.segments.join("  |  ");
    },
  };
}

const sessions = await Promise.all(
  PROVIDERS.map(({ label, factory, speechThreshold }) =>
    createVad(factory, { speechThreshold, ...callbacksFor(label) }),
  ),
);
for (const { label, frameSec, speechThreshold } of PROVIDERS) {
  makePanel(label, frameSec, speechThreshold);
}

info.textContent = "Models loaded. Audio never leaves this page.";
toggle.disabled = false;
let running = false;

toggle.onclick = (): void => {
  void (async (): Promise<void> => {
    if (running) {
      running = false;
      toggle.textContent = "Start microphone";
      // The mic stops once every session has released its tee.
      for (const session of sessions) await session.stop();
      return;
    }
    toggle.disabled = true;
    try {
      const tees = teeSource(micSource(), sessions.length);
      // The mic opens on the last start, once every tee has a consumer.
      for (const [i, session] of sessions.entries()) {
        const tee = tees[i];
        if (tee === undefined) throw new Error("teeSource returned too few");
        await session.start(tee);
      }
      running = true;
      toggle.textContent = "Stop microphone";
    } finally {
      toggle.disabled = false;
    }
  })();
};

// Seam for driving the demo without a microphone (e.g. an AudioBufferSource
// routed through a MediaStreamDestination wrapped as an AudioSource).
(window as unknown as Record<string, unknown>).demo = {
  teeSource,
  sessions: Object.fromEntries(PROVIDERS.map(({ label }, i) => [label, sessions[i]])),
  frameCounts,
};

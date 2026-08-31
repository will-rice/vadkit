import { createVad, micSource } from "#index.ts";
import type { AudioSource, Utterance, VadFrame } from "#index.ts";
import { fireRedVad } from "#providers/fireredvad.ts";
import { sileroVad } from "#providers/silero.ts";
import { webrtcVad } from "#providers/webrtc.ts";

import fireRedModelUrl from "../models/fireredvad_stream_vad_e2e.onnx?url";
import sileroModelUrl from "../models/silero_vad.onnx?url";

const HISTORY_SEC = 8;
const THRESHOLD = 0.4;

interface Panel {
  history: VadFrame[];
  maxFrames: number;
  segments: string[];
  canvas: HTMLCanvasElement;
  status: HTMLSpanElement;
  utterances: HTMLDivElement;
}

const info = document.getElementById("info") as HTMLParagraphElement;
const toggle = document.getElementById("toggle") as HTMLButtonElement;
const panelsRoot = document.getElementById("panels") as HTMLDivElement;
const panels = new Map<string, Panel>();

function mustQuery<T extends Element>(root: ParentNode, selector: string, type: new () => T): T {
  const element = root.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`missing element ${selector}`);
  return element;
}

function makePanel(name: string, frameSec: number): void {
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
  ctx.moveTo(0, y(THRESHOLD));
  ctx.lineTo(width, y(THRESHOLD));
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

/**
 * Split one AudioSource into n AudioSources sharing its start/stop: the
 * underlying source starts once all consumers started and stops once all
 * consumers stopped.
 */
function teeSource(source: AudioSource, count: number): AudioSource[] {
  const listeners: ((pcm: Float32Array, sampleRate: number) => void)[] = [];
  let started = 0;
  let stopped = 0;
  return Array.from({ length: count }, () => ({
    async start(onChunk: (pcm: Float32Array, sampleRate: number) => void): Promise<void> {
      listeners.push(onChunk);
      started += 1;
      if (started === count) {
        await source.start((pcm, sampleRate) => {
          for (const listener of listeners) listener(pcm, sampleRate);
        });
      }
    },
    async stop(): Promise<void> {
      stopped += 1;
      if (stopped === count) {
        started = 0;
        stopped = 0;
        listeners.length = 0;
        await source.stop();
      }
    },
  }));
}

const fireRedSession = await createVad(fireRedVad({ model: fireRedModelUrl }), {
  speechThreshold: THRESHOLD,
  ...callbacksFor("FireRedVAD (10 ms)"),
});
const sileroSession = await createVad(sileroVad({ model: sileroModelUrl }), {
  speechThreshold: THRESHOLD,
  ...callbacksFor("Silero VAD (32 ms)"),
});
const webrtcSession = await createVad(webrtcVad({ aggressiveness: 3 }), {
  speechThreshold: THRESHOLD,
  ...callbacksFor("WebRTC VAD (10 ms, mode 3)"),
});
makePanel("FireRedVAD (10 ms)", 0.01);
makePanel("Silero VAD (32 ms)", 0.032);
makePanel("WebRTC VAD (10 ms, mode 3)", 0.01);

info.textContent = "Models loaded. Audio never leaves this page.";
toggle.disabled = false;
let running = false;

toggle.onclick = (): void => {
  void (async (): Promise<void> => {
    if (running) {
      running = false;
      toggle.textContent = "Start microphone";
      await fireRedSession.stop();
      await sileroSession.stop();
      await webrtcSession.stop(); // last tee stop stops the mic
      return;
    }
    toggle.disabled = true;
    try {
      const [teeA, teeB, teeC] = teeSource(micSource(), 3);
      if (teeA === undefined || teeB === undefined || teeC === undefined) {
        throw new Error("teeSource returned too few");
      }
      await fireRedSession.start(teeA);
      await sileroSession.start(teeB);
      await webrtcSession.start(teeC); // this one actually opens the mic
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
  sessions: { fireRedSession, sileroSession, webrtcSession },
};

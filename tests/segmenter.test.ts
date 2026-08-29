import { expect, test } from "vite-plus/test";

import { DEFAULT_VAD_OPTIONS, Segmenter } from "../src/engine/segmenter.js";
import type { VadFrame } from "../src/engine/segmenter.js";

const OPTS = {
  ...DEFAULT_VAD_OPTIONS,
  speechThreshold: 0.5,
  smoothWindowSec: 0.01, // 1 frame -> smoothing off
  riseDelaySec: 0.03, // 3 frames
  fallDelaySec: 0.05, // 5 frames
  prePadSec: 0.02, // 2 frames
  maxSpeechSec: 30,
};

function feed(seg: Segmenter, probs: number[]): VadFrame[] {
  return probs.map((p) => seg.process(p));
}

test("emits speech_start after riseDelaySec of voiced frames, pre-padded", () => {
  const seg = new Segmenter(OPTS, 0.01);
  const frames = feed(seg, [0, 0, 0, 0, 0.9, 0.9, 0.9, 0.9]);
  const starts = frames.flatMap((f) => f.events).filter((e) => e.type === "speech_start");
  expect(starts).toHaveLength(1);
  // voiced run starts at index 4 (t=0.04); minus prePad 0.02 -> 0.02
  expect(starts[0]?.time).toBeCloseTo(0.02, 9);
  expect(frames[6]?.isSpeech).toBe(true); // 3rd voiced frame flips state
  expect(frames[5]?.isSpeech).toBe(false);
});

test("a blip shorter than riseDelaySec never starts speech", () => {
  const seg = new Segmenter(OPTS, 0.01);
  const frames = feed(seg, [0.9, 0.9, 0, 0, 0, 0, 0, 0]);
  expect(frames.flatMap((f) => f.events)).toHaveLength(0);
  expect(frames.every((f) => !f.isSpeech)).toBe(true);
});

test("emits speech_end after fallDelaySec, at the first silent frame", () => {
  const seg = new Segmenter(OPTS, 0.01);
  const probs = [0.9, 0.9, 0.9, 0.9, 0, 0, 0, 0, 0, 0];
  const frames = feed(seg, probs);
  const ends = frames.flatMap((f) => f.events).filter((e) => e.type === "speech_end");
  expect(ends).toHaveLength(1);
  expect(ends[0]?.time).toBeCloseTo(0.04, 9); // first silent frame t=0.04
  expect(ends[0]?.type === "speech_end" && ends[0].startTime).toBeCloseTo(0, 9); // prePad clamped at 0
});

test("short silence inside speech does not end the segment", () => {
  const seg = new Segmenter(OPTS, 0.01);
  const probs = [0.9, 0.9, 0.9, 0, 0, 0.9, 0.9, 0.9];
  const frames = feed(seg, probs);
  expect(frames.flatMap((f) => f.events).filter((e) => e.type === "speech_end")).toHaveLength(0);
  expect(frames[7]?.isSpeech).toBe(true);
});

test("maxSpeechSec force-splits a long segment", () => {
  const seg = new Segmenter({ ...OPTS, maxSpeechSec: 0.06 }, 0.01);
  const frames = feed(seg, new Array<number>(12).fill(0.9));
  const events = frames.flatMap((f) => f.events);
  expect(events.filter((e) => e.type === "speech_end").length).toBeGreaterThanOrEqual(1);
  expect(events.filter((e) => e.type === "speech_start").length).toBeGreaterThanOrEqual(2);
});

test("speech_start never precedes the previous speech_end", () => {
  const seg = new Segmenter(OPTS, 0.01);
  const probs = [0.9, 0.9, 0.9, 0, 0, 0, 0, 0, 0.9, 0.9, 0.9, 0.9];
  const events = feed(seg, probs).flatMap((f) => f.events);
  const end = events.find((e) => e.type === "speech_end");
  const secondStart = events.filter((e) => e.type === "speech_start")[1];
  expect(end).toBeDefined();
  expect(secondStart).toBeDefined();
  expect(secondStart?.time ?? NaN).toBeGreaterThanOrEqual(end?.time ?? NaN);
});

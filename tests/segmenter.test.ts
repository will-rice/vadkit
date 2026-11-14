import { expect, test } from "vite-plus/test";

import { DEFAULT_VAD_OPTIONS, Segmenter } from "#engine/segmenter.ts";
import type { VadFrame } from "#engine/segmenter.ts";

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

test("flush ends an open segment at the last frame boundary", () => {
  const seg = new Segmenter(OPTS, 0.01);
  feed(seg, [0.9, 0.9, 0.9, 0.9, 0.9]); // in speech, last frame index 4
  const events = seg.flush();
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("speech_end");
  expect(events[0]?.time).toBeCloseTo(0.05, 9);
  expect(events[0]?.type === "speech_end" && events[0].startTime).toBeCloseTo(0, 9);
});

test("flush during possible_silence ends where the silence began", () => {
  const seg = new Segmenter(OPTS, 0.01);
  feed(seg, [0.9, 0.9, 0.9, 0.9, 0, 0]); // silence run starts at index 4
  const events = seg.flush();
  expect(events).toHaveLength(1);
  expect(events[0]?.time).toBeCloseTo(0.04, 9);
});

test("flush with no open segment emits nothing", () => {
  const seg = new Segmenter(OPTS, 0.01);
  feed(seg, [0, 0, 0.9, 0.9]); // possible_speech: rise delay not met
  expect(seg.flush()).toHaveLength(0);
});

test("after flush, a new segment needs a fresh rise delay and never overlaps the flushed one", () => {
  const seg = new Segmenter(OPTS, 0.01);
  feed(seg, [0.9, 0.9, 0.9, 0.9, 0.9]);
  const flushEnd = seg.flush()[0]?.time ?? NaN;
  const events = feed(seg, [0.9, 0.9, 0.9, 0.9]).flatMap((f) => f.events);
  const start = events.find((e) => e.type === "speech_start");
  expect(start).toBeDefined();
  expect(start?.time ?? NaN).toBeGreaterThanOrEqual(flushEnd);
});

test("smoothing is a trailing mean over smoothWindowSec, shorter while it fills", () => {
  const seg = new Segmenter({ ...OPTS, smoothWindowSec: 0.03 }, 0.01); // 3 frames
  const smoothed = feed(seg, [0, 0.9, 0.9, 0.9, 0]).map((f) => f.smoothedProbability);
  const expected = [0, 0.45, 0.6, 0.9, 0.6];
  for (const [i, value] of expected.entries()) expect(smoothed[i]).toBeCloseTo(value, 9);
});

test("maxSpeechSec splits exactly at the limit, measured from the padded start", () => {
  const seg = new Segmenter({ ...OPTS, maxSpeechSec: 0.06 }, 0.01);
  const frames = feed(seg, new Array<number>(12).fill(0.9));
  const events = frames.flatMap((f) => f.events);
  // Start confirmed at index 2, pre-pad clamps the segment start to 0; the
  // split lands on the first frame at or past 0.06 s, in the same frame.
  expect(events.map((e) => e.type)).toEqual(["speech_start", "speech_end", "speech_start"]);
  expect(events[0]?.time).toBeCloseTo(0, 9);
  expect(events[1]?.time).toBeCloseTo(0.06, 9);
  expect(events[1]?.type === "speech_end" && events[1].startTime).toBeCloseTo(0, 9);
  expect(events[2]?.time).toBeCloseTo(0.06, 9);
  expect(frames[6]?.events).toHaveLength(2);
});

test("maxSpeechSec reached during trailing silence ends the segment where the silence began", () => {
  const seg = new Segmenter({ ...OPTS, maxSpeechSec: 0.06 }, 0.01);
  // Voiced 0-3, silent from index 4: the limit (0.06 s) lands inside the
  // 5-frame fall delay, so there is nothing voiced left to split off.
  const events = feed(seg, [0.9, 0.9, 0.9, 0.9, 0, 0, 0, 0, 0, 0, 0, 0]).flatMap((f) => f.events);
  expect(events.map((e) => e.type)).toEqual(["speech_start", "speech_end"]);
  expect(events[1]?.time).toBeCloseTo(0.04, 9);
});

test("skip advances frame times and leaves silence and speech as they were", () => {
  const seg = new Segmenter(OPTS, 0.01);
  feed(seg, [0, 0]);
  seg.skip(3);
  const silent = seg.process(0);
  expect(silent.index).toBe(5);
  expect(silent.time).toBeCloseTo(0.05, 9);
  expect(silent.isSpeech).toBe(false);
  feed(seg, [0.9, 0.9, 0.9]);
  seg.skip(3);
  const voiced = seg.process(0.9);
  expect(voiced.isSpeech).toBe(true);
  expect(voiced.events).toHaveLength(0);
});

test("skipped frames do not count toward the rise delay", () => {
  const seg = new Segmenter({ ...OPTS, riseDelaySec: 0.08 }, 0.01);
  const first = seg.process(0.9);
  seg.skip(10);
  const second = seg.process(0.9);
  expect([...first.events, ...second.events]).toHaveLength(0);
  expect(second.isSpeech).toBe(false);
  // The voiced run restarts after the gap: 8 frames from the second one.
  const frames = feed(seg, new Array<number>(7).fill(0.9));
  expect(frames.slice(0, 6).flatMap((f) => f.events)).toHaveLength(0);
  expect(frames[6]?.events.map((e) => e.type)).toEqual(["speech_start"]);
});

test("skipped frames do not count toward the fall delay", () => {
  const seg = new Segmenter(OPTS, 0.01);
  feed(seg, [0.9, 0.9, 0.9, 0, 0]);
  seg.skip(10);
  // The silent run restarts after the gap: 5 frames from index 15.
  const frames = feed(seg, [0, 0, 0, 0, 0]);
  expect(frames.slice(0, 4).flatMap((f) => f.events)).toHaveLength(0);
  expect(frames[3]?.isSpeech).toBe(true);
  expect(frames[4]?.events).toEqual([{ type: "speech_end", time: 0.15, startTime: 0 }]);
});

test("smoothing does not average across skipped frames", () => {
  const seg = new Segmenter({ ...OPTS, smoothWindowSec: 0.03 }, 0.01);
  feed(seg, [0.9, 0.9, 0.9]);
  seg.skip(5);
  expect(seg.process(0).smoothedProbability).toBe(0);
});

test("maxSpeechSec applies on the first frame processed after a skip", () => {
  const seg = new Segmenter({ ...OPTS, maxSpeechSec: 0.06 }, 0.01);
  feed(seg, [0.9, 0.9, 0.9]);
  seg.skip(10);
  const frame = seg.process(0.9);
  expect(frame.events).toEqual([
    { type: "speech_end", time: 0.13, startTime: 0 },
    { type: "speech_start", time: 0.13 },
  ]);
});

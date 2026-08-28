export interface VadOptions {
  /** Smoothed probability at/above this is voiced. Default 0.5. */
  speechThreshold: number;
  /** Trailing moving-average window in seconds. Default 0.05. */
  smoothWindowSec: number;
  /** Voiced run needed to start a segment. Default 0.08. */
  minSpeechSec: number;
  /** Silent run needed to end a segment. Default 0.2. */
  minSilenceSec: number;
  /** Reported segment start precedes the voiced run by this much. Default 0.1. */
  prePadSec: number;
  /** Segments are force-split at this length. Default 30. */
  maxSpeechSec: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  speechThreshold: 0.5,
  smoothWindowSec: 0.05,
  minSpeechSec: 0.08,
  minSilenceSec: 0.2,
  prePadSec: 0.1,
  maxSpeechSec: 30,
};

export type VadEvent =
  { type: "speech_start"; time: number } | { type: "speech_end"; time: number; startTime: number };

export interface VadFrame {
  index: number;
  time: number;
  probability: number;
  smoothedProbability: number;
  /** In-segment state (includes hangover), not the instantaneous threshold. */
  isSpeech: boolean;
  events: VadEvent[];
}

type State = "silence" | "possible_speech" | "speech" | "possible_silence";

/** Hangover state machine over per-frame probabilities, config in seconds. */
export class Segmenter {
  private readonly frameSec: number;
  private readonly options: VadOptions;
  private readonly smoothFrames: number;
  private readonly minSpeechFrames: number;
  private readonly minSilenceFrames: number;

  private index = -1;
  private window: number[] = [];
  private windowSum = 0;
  private state: State = "silence";
  private voicedRunStart = -1;
  private silenceRunStart = -1;
  private segmentStartTime = -1;
  private lastEndTime = 0;

  constructor(options: VadOptions, frameSec: number) {
    this.options = options;
    this.frameSec = frameSec;
    const frames = (sec: number): number => Math.max(1, Math.round(sec / frameSec));
    this.smoothFrames = frames(options.smoothWindowSec);
    this.minSpeechFrames = frames(options.minSpeechSec);
    this.minSilenceFrames = frames(options.minSilenceSec);
  }

  reset(): void {
    this.index = -1;
    this.window = [];
    this.windowSum = 0;
    this.state = "silence";
    this.voicedRunStart = -1;
    this.silenceRunStart = -1;
    this.segmentStartTime = -1;
    this.lastEndTime = 0;
  }

  process(probability: number): VadFrame {
    this.index += 1;
    const time = this.index * this.frameSec;
    const smoothed = this.smooth(probability);
    const voiced = smoothed >= this.options.speechThreshold;
    const events: VadEvent[] = [];

    switch (this.state) {
      case "silence":
        if (voiced) {
          this.state = "possible_speech";
          this.voicedRunStart = this.index;
        }
        break;
      case "possible_speech":
        if (!voiced) {
          this.state = "silence";
        } else if (this.index - this.voicedRunStart + 1 >= this.minSpeechFrames) {
          this.state = "speech";
          this.segmentStartTime = Math.max(
            0,
            this.lastEndTime,
            this.voicedRunStart * this.frameSec - this.options.prePadSec,
          );
          events.push({ type: "speech_start", time: this.segmentStartTime });
        }
        break;
      case "speech":
        if (!voiced) {
          this.state = "possible_silence";
          this.silenceRunStart = this.index;
        }
        break;
      case "possible_silence":
        if (voiced) {
          this.state = "speech";
        } else if (this.index - this.silenceRunStart + 1 >= this.minSilenceFrames) {
          this.state = "silence";
          const endTime = this.silenceRunStart * this.frameSec;
          events.push({ type: "speech_end", time: endTime, startTime: this.segmentStartTime });
          this.lastEndTime = endTime;
          this.segmentStartTime = -1;
        }
        break;
    }

    // Force-split overlong segments.
    if (
      (this.state === "speech" || this.state === "possible_silence") &&
      time - this.segmentStartTime >= this.options.maxSpeechSec
    ) {
      events.push({ type: "speech_end", time, startTime: this.segmentStartTime });
      events.push({ type: "speech_start", time });
      this.segmentStartTime = time;
      this.lastEndTime = time;
      this.state = "speech";
    }

    const isSpeech = this.state === "speech" || this.state === "possible_silence";
    return {
      index: this.index,
      time,
      probability,
      smoothedProbability: smoothed,
      isSpeech,
      events,
    };
  }

  private smooth(probability: number): number {
    if (this.smoothFrames <= 1) return probability;
    this.window.push(probability);
    this.windowSum += probability;
    if (this.window.length > this.smoothFrames) {
      const removed = this.window.shift();
      if (removed !== undefined) this.windowSum -= removed;
    }
    return this.windowSum / this.window.length;
  }
}

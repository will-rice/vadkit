import type { AudioSource } from "#engine/session.ts";

/**
 * Split one AudioSource into `count` sources that share its lifecycle, e.g.
 * one microphone feeding several sessions. The underlying source starts
 * once all tees have started and stops once all tees have stopped; after
 * that the tees can be started again.
 */
export function teeSource(source: AudioSource, count: number): AudioSource[] {
  const listeners: ((pcm: Float32Array) => void)[] = [];
  let started = 0;
  let stopped = 0;
  return Array.from({ length: count }, () => ({
    async start(onChunk: (pcm: Float32Array) => void): Promise<void> {
      listeners.push(onChunk);
      started += 1;
      if (started === count) {
        await source.start((pcm) => {
          for (const listener of listeners) listener(pcm);
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

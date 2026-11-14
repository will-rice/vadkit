import { SerialQueue } from "#engine/serialQueue.ts";
import type { AudioSource } from "#engine/session.ts";

/**
 * Split one AudioSource into `count` sources that share its lifecycle, e.g.
 * one microphone feeding several sessions. The underlying source starts
 * once all tees have started and stops once all tees have stopped; after
 * that the tees can be started again. A stopped tee receives no further
 * chunks, and can rejoin while the others keep the source running; the last
 * tee to stop still receives what the source delivers while it stops. If the
 * underlying start fails, the tee whose start triggered it rejects and may
 * simply be started again. Starts and stops of all the tees run one after
 * another, in call order, so none acts on a half-finished transition.
 */
export function teeSource(source: AudioSource, count: number): AudioSource[] {
  const listeners = new Map<number, (pcm: Float32Array) => void>();
  const lifecycle = new SerialQueue();
  let running = false;
  return Array.from({ length: count }, (_, id) => ({
    start(onChunk: (pcm: Float32Array) => void): Promise<void> {
      return lifecycle.run(async () => {
        if (listeners.has(id)) throw new Error("tee already started");
        listeners.set(id, onChunk);
        if (listeners.size < count || running) return;
        try {
          await source.start((pcm) => {
            for (const listener of listeners.values()) listener(pcm);
          });
          running = true;
        } catch (error) {
          listeners.delete(id);
          throw error;
        }
      });
    },
    stop(): Promise<void> {
      return lifecycle.run(async () => {
        if (!listeners.has(id)) return;
        try {
          // The last tee keeps listening while the source stops, so it
          // receives the tail; no tee can rejoin until this stop is over.
          if (listeners.size === 1 && running) {
            running = false;
            await source.stop();
          }
        } finally {
          listeners.delete(id);
        }
      });
    },
  }));
}

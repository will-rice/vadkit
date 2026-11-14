import type { AudioSource } from "#engine/session.ts";

/**
 * Split one AudioSource into `count` sources that share its lifecycle, e.g.
 * one microphone feeding several sessions. The underlying source starts
 * once all tees have started and stops once all tees have stopped; after
 * that the tees can be started again. A stopped tee receives no further
 * chunks, and can rejoin while the others keep the source running; the last
 * tee to stop still receives what the source delivers while it stops. If the
 * underlying start fails, the tee whose start triggered it rejects and may
 * simply be started again.
 */
export function teeSource(source: AudioSource, count: number): AudioSource[] {
  const listeners = new Map<number, (pcm: Float32Array) => void>();
  let running = false;
  let stopping: Promise<void> | null = null;
  let draining: ((pcm: Float32Array) => void) | null = null;
  return Array.from({ length: count }, (_, id) => ({
    async start(onChunk: (pcm: Float32Array) => void): Promise<void> {
      if (listeners.has(id)) throw new Error("tee already started");
      listeners.set(id, onChunk);
      if (listeners.size < count || running) return;
      running = true;
      try {
        // A restart must not reach the source while it is still stopping.
        await Promise.allSettled([stopping]);
        await source.start((pcm) => {
          // A stopping source's tail belongs to the last tee that stopped,
          // not to tees that have rejoined since.
          if (draining !== null) draining(pcm);
          else for (const listener of listeners.values()) listener(pcm);
        });
      } catch (error) {
        running = false;
        listeners.delete(id);
        throw error;
      }
    },
    async stop(): Promise<void> {
      const listener = listeners.get(id);
      if (listener === undefined) return;
      listeners.delete(id);
      if (listeners.size > 0 || !running) return;
      running = false;
      draining = listener;
      stopping = (async (): Promise<void> => {
        try {
          await source.stop();
        } finally {
          draining = null;
        }
      })();
      await stopping;
    },
  }));
}

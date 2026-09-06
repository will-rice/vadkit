import { expect, test } from "vite-plus/test";

import { teeSource } from "#index.ts";
import type { AudioSource } from "#index.ts";

/** A source that records lifecycle calls and lets the test push chunks. */
function trackedSource(): AudioSource & {
  starts: number;
  stops: number;
  push(pcm: Float32Array): void;
} {
  let deliver: ((pcm: Float32Array) => void) | null = null;
  return {
    starts: 0,
    stops: 0,
    start(onChunk): Promise<void> {
      this.starts += 1;
      deliver = onChunk;
      return Promise.resolve();
    },
    stop(): Promise<void> {
      this.stops += 1;
      deliver = null;
      return Promise.resolve();
    },
    push(pcm: Float32Array): void {
      if (deliver === null) throw new Error("not started");
      deliver(pcm);
    },
  };
}

test("the underlying source starts once, after every tee has started", async () => {
  const source = trackedSource();
  const [a, b] = teeSource(source, 2);
  if (a === undefined || b === undefined) throw new Error("expected two tees");
  await a.start(() => undefined);
  expect(source.starts).toBe(0);
  await b.start(() => undefined);
  expect(source.starts).toBe(1);
});

test("chunks fan out to every tee", async () => {
  const source = trackedSource();
  const received: number[][] = [[], []];
  const tees = teeSource(source, 2);
  await Promise.all(tees.map((tee, i) => tee.start((pcm) => received[i]?.push(pcm.length))));
  source.push(new Float32Array(3));
  source.push(new Float32Array(5));
  expect(received).toEqual([
    [3, 5],
    [3, 5],
  ]);
});

test("the underlying source stops once, after every tee has stopped, and can restart", async () => {
  const source = trackedSource();
  const tees = teeSource(source, 3);
  await Promise.all(tees.map((tee) => tee.start(() => undefined)));
  await tees[0]?.stop();
  await tees[1]?.stop();
  expect(source.stops).toBe(0);
  await tees[2]?.stop();
  expect(source.stops).toBe(1);
  await Promise.all(tees.map((tee) => tee.start(() => undefined)));
  expect(source.starts).toBe(2);
});

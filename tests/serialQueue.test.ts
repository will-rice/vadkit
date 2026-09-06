import { expect, test } from "vite-plus/test";

import { SerialQueue } from "#engine/serialQueue.ts";

test("tasks run in submission order even when an earlier one resolves later", async () => {
  const queue = new SerialQueue();
  const order: number[] = [];
  const slow = queue.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push(1);
  });
  const fast = queue.run(() => {
    order.push(2);
  });
  await Promise.all([slow, fast]);
  expect(order).toEqual([1, 2]);
});

test("a rejected task rejects only its own promise; the next task still runs", async () => {
  const queue = new SerialQueue();
  const failing = queue.run(() => {
    throw new Error("boom");
  });
  const next = queue.run(() => "ok");
  await expect(failing).rejects.toThrow("boom");
  await expect(next).resolves.toBe("ok");
});

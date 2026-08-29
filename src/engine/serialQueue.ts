/** Runs async tasks strictly in submission order; a failure rejects that
 * task's promise but does not stall the queue. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

import { expect, test } from "vite-plus/test";

interface DemoSeam {
  frameCounts: Record<string, number>;
}

function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = (): void => {
      if (predicate()) resolve();
      else if (performance.now() - started > timeoutMs) reject(new Error("timed out"));
      else setTimeout(tick, 50);
    };
    tick();
  });
}

test("the demo runs all three providers on one microphone and stops cleanly", async () => {
  document.body.innerHTML = `
    <p id="info"></p>
    <button id="toggle" disabled>Start microphone</button>
    <div id="panels"></div>`;
  await import("../../demo/main.ts"); // loads the models, enables the toggle
  const toggle = document.getElementById("toggle") as HTMLButtonElement;
  expect(toggle.disabled).toBe(false);
  expect(document.querySelectorAll(".provider")).toHaveLength(3);

  const seam = (window as unknown as { demo: DemoSeam }).demo;
  toggle.click();
  await waitFor(() => Object.values(seam.frameCounts).filter((n) => n >= 5).length === 3);

  toggle.click();
  await waitFor(() => toggle.textContent === "Start microphone");
  const counts = { ...seam.frameCounts };
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(seam.frameCounts).toEqual(counts); // nothing arrives after stop
});

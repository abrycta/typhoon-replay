import { afterEach, expect, it, vi } from "vitest";

import { PlayerClock } from "./player";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Regression: Play at hour 0 stalled on "Loading frames…" when the first animation frame's timestamp was
// earlier than performance.now() at the click (common in Chromium on an idle page): the negative step moved
// the playhead to -0.0x, i.e. frame -1, which never becomes ready.
it("plays from the start when the first rAF timestamp predates the click, holds for a missing frame, then resumes", () => {
  let queued: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => ((queued = cb), 1));
  vi.stubGlobal("cancelAnimationFrame", () => (queued = undefined));
  vi.spyOn(performance, "now").mockReturnValue(1000);
  const frames = (from: number, to: number) => {
    for (let ts = from; ts <= to; ts += 16) {
      const cb = queued;
      queued = undefined;
      cb?.(ts);
    }
  };

  const ready = new Set([0, 1, 2, 3]);
  const clock = new PlayerClock(10, { index: 0, speed: 4 }, { isReady: (i) => ready.has(i) });
  clock.play();
  frames(984, 984); // stale frame timestamp, 16 ms before the click
  expect(clock.snapshot.index).toBe(0);
  frames(1000, 1300);
  expect(clock.snapshot).toMatchObject({ index: 1, playing: true, buffering: false });

  // Frame 4 not decoded yet: hold at 3 with the waiting state, then go on by itself once it arrives.
  frames(1316, 1900);
  expect(clock.snapshot).toMatchObject({ index: 3, playing: true, buffering: true });
  ready.add(4).add(5);
  frames(1916, 2300);
  expect(clock.snapshot).toMatchObject({ index: 4, playing: true, buffering: false });
});

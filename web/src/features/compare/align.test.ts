import { describe, expect, it } from "vitest";

import { availableAlignments, effectiveAlignment, sharedTimeline, sideStatus, splitDuration, type StormSpan } from "./align";

const H = 3600;
// Haiyan-like: 223 h, peak at 126 h, landfall at 137 h; Mangkhut-like: 271 h, peak 138 h, landfall 198 h.
const a: StormSpan = { start: 0, hours: 223, peakAt: 126 * H, landfallAt: 137 * H + 1260 };
const b: StormSpan = { start: 10_000 * H, hours: 271, peakAt: 10_138 * H, landfallAt: 10_198 * H };
const noLand: StormSpan = { start: 0, hours: 100, peakAt: 40 * H };

describe("shared timeline", () => {
  it("from formation: hour 0 is both first frames and the timeline is the longer storm", () => {
    expect(sharedTimeline([a, b], "formation")).toEqual({ alignment: "formation", frames: 271, zero: 0, offsets: [0, 0] });
  });

  it("at peak: the anchors meet at `zero` and the timeline spans both lives", () => {
    const tl = sharedTimeline([a, b], "peak");
    expect(tl.zero).toBe(138);
    expect(tl.offsets).toEqual([12, 0]);
    expect(tl.frames).toBe(Math.max(223 + 12, 271));
    // At the shared zero both storms are at their peak index.
    expect(sideStatus(tl.zero, tl.offsets[0]!, a.hours)).toEqual({ kind: "during", index: 126 });
    expect(sideStatus(tl.zero, tl.offsets[1]!, b.hours)).toEqual({ kind: "during", index: 138 });
  });

  it("at landfall: rounds to the hour; the shorter storm is before / after outside its life", () => {
    const tl = sharedTimeline([a, b], "landfall");
    expect(tl.zero).toBe(198);
    expect(tl.offsets).toEqual([198 - 137, 0]);
    expect(sideStatus(0, tl.offsets[0]!, a.hours)).toEqual({ kind: "before", hours: 61 });
    expect(sideStatus(tl.frames - 1, tl.offsets[1]!, b.hours)).toEqual({ kind: "after", hours: tl.frames - 271 });
  });

  it("offers landfall only when every storm made one, and falls back to peak", () => {
    expect(availableAlignments([a, noLand])).toEqual(["peak", "formation"]);
    expect(effectiveAlignment([a, noLand], "landfall")).toBe("peak");
    expect(sharedTimeline([a, { start: 0, hours: 5 }], "peak").alignment).toBe("formation");
  });

  it("splits durations into days and hours", () => {
    expect(splitDuration(222)).toEqual({ days: 9, hours: 6 });
  });
});

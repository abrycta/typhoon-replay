import { describe, expect, it } from "vitest";

import type { TrackHour } from "@/shared/model/types";

import { labelCandidates, overlaps, sealAt } from "./seal";

const h = (t: number, jtwcKt?: number, jmaKt?: number): TrackHour => ({ t, lon: 130, lat: 10, observed: true, jtwcKt, jmaKt });

describe("storm seal", () => {
  it("shows the JTWC category and grows with it", () => {
    expect(sealAt([h(0, 30)], 0)).toMatchObject({ text: "TD", size: 14 });
    expect(sealAt([h(0, 50)], 0)).toMatchObject({ text: "TS", size: 14 });
    expect(sealAt([h(0, 170)], 0)).toMatchObject({ text: "5", size: 18 });
  });

  it("interpolates the wind between hours; the numeral steps only at category thresholds", () => {
    const hours = [h(0, 110), h(3600, 120)];
    expect(sealAt(hours, 1200).kt).toBeCloseTo(113.33, 1);
    expect(sealAt(hours, 1200).text).toBe("4");
    expect(sealAt(hours, 600).text).toBe("3");
  });

  it("falls back to JMA classes, then to an empty seal", () => {
    expect(sealAt([h(0, undefined, 70)], 0).text).toBe("TY");
    expect(sealAt([h(0)], 0)).toMatchObject({ text: "", size: 14 });
    expect(sealAt([], 0).text).toBe("");
  });

  it("puts the label first on the side of the track facing up, clear of the seal", () => {
    const seal = { x: 92, y: 92, w: 16, h: 16 };
    for (const dir of [[1, 0], [-1, 0], [1, 1], [-1, 1], [0, 1]] as [number, number][]) {
      const [first, ...rest] = labelCandidates(100, 100, dir, 8, 120, 18);
      expect(first!.y + first!.h / 2).toBeLessThanOrEqual(100);
      for (const r of [first!, ...rest]) expect(overlaps(r, seal)).toBe(false);
    }
  });
});

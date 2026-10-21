import { describe, expect, it } from "vitest";

import { unwrapWindowLons, worldShift } from "./field-layer";

// Paka (1997333N06194) moved west across the antimeridian; its published windows (81 cells, 0.25°) have
// north-west corners in (-180, 180], so they jump by 360° when the window centre passes about 170°W.
const nx = 81, res = 0.25, half = 10;

describe("field windows across the antimeridian", () => {
  it("keeps consecutive windows continuous", () => {
    const centres = [-166.3, -168.9, -172.4, -179.1, 179.9, 175.7, 165.9];
    const nw = centres.map((c) => {
      const w = c - half;
      return w <= -180 ? w + 360 : w; // as the pipeline writes it (lon180)
    });
    expect(nw).toContain(170.9); // the 360° jump the app used to draw in another world copy
    const got = unwrapWindowLons(nw, nx, res).map((w) => +(w + half).toFixed(2));
    expect(got).toEqual([-166.3, -168.9, -172.4, -179.1, -180.1, -184.3, -194.1]);
  });

  it("starts the first window's centre in (-180, 180]", () => {
    expect(unwrapWindowLons([171.0], nx, res)[0]! + half).toBeCloseTo(-179);
    expect(unwrapWindowLons([115.0], nx, res)[0]).toBe(115);
  });

  it("draws the field in the world copy nearest the camera", () => {
    expect(worldShift(-168.9, -170)).toBe(0);
    expect(worldShift(-168.9, 185)).toBe(360);
    expect(worldShift(175.7, -180)).toBe(-360);
    expect(worldShift(-184.3, 175)).toBe(360);
    expect(worldShift(125, 125)).toBe(0);
  });
});

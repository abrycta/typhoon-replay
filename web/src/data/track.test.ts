import { describe, expect, it } from "vitest";

import { bestWind, hourAt, interpolateHourly } from "./track";

const fixes = [
  { t: "2013-11-07T06:00:00Z", lon: 130, lat: 10, jtwcKt: 150, jmaKt: 120, jmaHpa: 905 },
  { t: "2013-11-07T09:00:00Z", lon: 129, lat: 10.3, jmaKt: 125 }, // JTWC skipped this fix
  { t: "2013-11-07T12:00:00Z", lon: 128, lat: 10.6, jtwcKt: 170, jmaKt: 125, jmaHpa: 895 },
];
const h = (iso: string) => Date.parse(iso) / 1000;

describe("interpolateHourly", () => {
  const hours = interpolateHourly(fixes);

  it("produces one point per hour, marking observed fixes", () => {
    expect(hours).toHaveLength(7);
    expect(hours.filter((p) => p.observed).map((p) => p.t)).toEqual(fixes.map((f) => h(f.t)));
  });

  it("interpolates position and names the bracketing fixes", () => {
    const p = hours[1]!; // 07:00
    expect(p.observed).toBe(false);
    expect(p.between).toEqual([h(fixes[0]!.t), h(fixes[1]!.t)]);
    expect(p.lon).toBeCloseTo(129.667, 2);
    expect(p.lat).toBeCloseTo(10.1, 3);
  });

  it("interpolates each agency between the fixes that report it", () => {
    const p = hours[3]!; // 09:00, JTWC missing at this fix
    expect(p.jtwcKt).toBeCloseTo(160);
    expect(p.jmaKt).toBe(125);
    expect(hours[2]!.jmaHpa).toBeCloseTo(901.7, 1);
  });

  it("takes the short way across the antimeridian", () => {
    const pts = interpolateHourly([
      { t: "2020-01-01T00:00:00Z", lon: 179.5, lat: 10 },
      { t: "2020-01-01T02:00:00Z", lon: -179.5, lat: 10 },
    ]);
    expect(Math.abs(pts[1]!.lon)).toBeCloseTo(180);
  });

  it("finds the hour at or before a time, and the preferred best-track wind", () => {
    expect(hourAt(hours, h("2013-11-07T10:30:00Z"))!.t).toBe(h("2013-11-07T10:00:00Z"));
    expect(hourAt(hours, 0)!.t).toBe(hours[0]!.t);
    expect(bestWind({ jtwcKt: 170, jmaKt: 125 })).toEqual({ kt: 170, agency: "jtwc" });
    expect(bestWind({ jmaKt: 125 })).toEqual({ kt: 125, agency: "jma" });
    expect(bestWind({})).toBeUndefined();
  });
});

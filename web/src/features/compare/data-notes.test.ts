import { describe, expect, it } from "vitest";

import type { AgencyIntensity, StormDetail } from "@/shared/model/types";

import { agencyWinds, eraOf, fixInterval, gapsOf, jmaGap, lowestPressure, offsetSummary } from "./data-notes";

const fixes = (hours: number[]) => hours.map((h) => ({ t: new Date(Date.UTC(2018, 8, 6) + h * 3_600_000).toISOString() }));
const storm = (season: number, intensity: AgencyIntensity[], frames = true) =>
  ({ season, intensity, peak: undefined, frames: frames ? { format: "webp", frames: 10 } : undefined }) as unknown as StormDetail;
const HAIYAN = storm(2013, [
  { agency: "jtwc", windAveragingMinutes: 1, maxWindKt: 170, minPressureHpa: 895 },
  { agency: "jma", windAveragingMinutes: 10, maxWindKt: 125, minPressureHpa: 895 },
  { agency: "wmo", windAveragingMinutes: 10, maxWindKt: 125, minPressureHpa: 895 },
]);
const GERTRUDE = storm(1948, [{ agency: "jtwc", windAveragingMinutes: 1, maxWindKt: 85 }]);

describe("card data", () => {
  it("fix interval: the typical gaps, ignoring rare long or short ones", () => {
    expect(fixInterval(fixes([0, 6, 12, 18, 30, 36]))).toEqual({ min: 6, max: 6 }); // one 12 h gap
    // Mangkhut-like: 6-hourly, 3-hourly near land and a few hourly landfall fixes.
    expect(fixInterval(fixes([0, 6, 12, 18, 24, 27, 30, 33, 36, 37, 38, 42]))).toEqual({ min: 3, max: 6 });
    expect(fixInterval(fixes([0]))).toBeUndefined();
  });

  it("winds per agency without WMO, and why JMA is missing", () => {
    expect(agencyWinds(HAIYAN)).toEqual([
      { agency: "jtwc", kt: 170, minutes: 1 },
      { agency: "jma", kt: 125, minutes: 10 },
    ]);
    expect(jmaGap(HAIYAN)).toBeUndefined();
    expect(jmaGap(GERTRUDE)).toBe("before-1951");
    expect(jmaGap(storm(1960, []))).toBe("none");
    expect(lowestPressure(HAIYAN)).toBe(895);
    expect(lowestPressure(GERTRUDE)).toBeUndefined();
  });

  it("ERA5 against the track: pending, median and share over 150 km, or mostly no centre", () => {
    expect(offsetSummary(undefined)).toEqual({ kind: "pending" });
    const co = (km: (number | null)[]) => ({ frameIndex: km.map((_, k) => 3 * k), km, bearingDeg: km.map(() => 0) });
    expect(offsetSummary(co([20, 30, 40, 200]))).toEqual({ kind: "offset", medianKm: 35, offPct: 25 });
    expect(offsetSummary(co([20, 30, 40, 200, null]))).toEqual({ kind: "offset", medianKm: 35, offPct: 25, noCentrePct: 20 });
    expect(offsetSummary(co([20, null, null, null]))).toEqual({ kind: "mostly-none", noCentrePct: 75 });
  });

  it("era and gaps", () => {
    expect([1940, 1948, 1966, 1987, 1988].map(eraOf)).toEqual(["ships", "aircraft", "satellite-aircraft", "satellite-aircraft", "satellite"]);
    expect(gapsOf(HAIYAN)).toEqual([]);
    expect(gapsOf(GERTRUDE)).toEqual(["no-pressure", "no-jma"]);
    expect(gapsOf(storm(1960, [{ agency: "jma", windAveragingMinutes: 10, maxWindKt: 60 }], false))).toEqual(["no-jtwc", "no-pressure", "no-maps"]);
  });
});

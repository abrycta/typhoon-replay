import { describe, expect, it } from "vitest";

import { compassPoint, markerAt, offsetAt } from "./centre-offset";

// Sally 1954 (1954314N11152) near Luzon: ERA5's low sat about 240 km north-east of the best track.
const co = {
  frameIndex: [0, 3, 6, 9],
  km: [40, 240, null, 60],
  bearingDeg: [10, 57, null, 200],
  lat: [15.4, 17.1, null, 15.0],
  lon: [121.0, 123.3, null, 120.9],
};

describe("ERA5 centre offset", () => {
  it("reads the 3-hourly value at or before the hour, never across a gap", () => {
    expect(offsetAt(co, 4)).toEqual({ kind: "offset", km: 240, bearingDeg: 57, lat: 17.1, lon: 123.3 });
    expect(offsetAt(co, 7)).toEqual({ kind: "none" });
    expect(offsetAt(co, 12)).toBeUndefined();
    expect(offsetAt(undefined, 0)).toBeUndefined();
  });

  it("names the compass point", () => {
    expect([0, 57, 100, 200, 350].map(compassPoint)).toEqual([0, 1, 2, 4, 0]);
  });

  it("marks ERA5's centre only from 150 km", () => {
    expect(markerAt(offsetAt(co, 3))).toEqual({ lon: 123.3, lat: 17.1 });
    expect(markerAt(offsetAt(co, 0))).toBeUndefined(); // 40 km: within the noise
    expect(markerAt(offsetAt(co, 6))).toBeUndefined(); // no ERA5 centre
  });
});

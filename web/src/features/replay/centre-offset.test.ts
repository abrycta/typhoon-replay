import { describe, expect, it } from "vitest";

import { compassPoint, offsetAt } from "./centre-offset";

// Sally 1954 (1954314N11152) near Luzon: ERA5's low sat about 240 km north-east of the best track.
const co = { frameIndex: [0, 3, 6, 9], km: [40, 240, null, 60], bearingDeg: [10, 57, null, 200] };

describe("ERA5 centre offset", () => {
  it("reads the 3-hourly value at or before the hour, never across a gap", () => {
    expect(offsetAt(co, 4)).toEqual({ kind: "offset", km: 240, bearingDeg: 57 });
    expect(offsetAt(co, 7)).toEqual({ kind: "none" });
    expect(offsetAt(co, 12)).toBeUndefined();
    expect(offsetAt(undefined, 0)).toBeUndefined();
  });

  it("names the compass point", () => {
    expect([0, 57, 100, 200, 350].map(compassPoint)).toEqual([0, 1, 2, 4, 0]);
  });
});

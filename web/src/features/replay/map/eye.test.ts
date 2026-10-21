import { describe, expect, it } from "vitest";

import { interpolateHourly } from "@/data";

import { eyeAt } from "./eye";

// Haiyan (2013306N07162), 6-hourly observed fixes as in its track.json; the app plays the hourly track.
const fixes = [
  { t: "2013-11-06T18:00:00Z", lon: 135.3, lat: 7.9 },
  { t: "2013-11-07T00:00:00Z", lon: 133.0, lat: 8.7 },
  { t: "2013-11-07T06:00:00Z", lon: 130.6, lat: 9.5 },
  { t: "2013-11-07T12:00:00Z", lon: 128.3, lat: 10.3 },
];
const hours = interpolateHourly(fixes);
const km = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) =>
  Math.hypot((a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180), a.lat - b.lat) * 111.2;

describe("eye marker during playback", () => {
  it("moves smoothly through observed fixes (no jump, no blink)", () => {
    const t0 = hours[0]!.t, t1 = hours[hours.length - 1]!.t;
    const dt = 60; // one playback step per simulated minute
    // Bound: the fastest fix-to-fix segment's speed (km/s) × step; a snap to a fix would far exceed it.
    const fx = fixes.map((f) => ({ ...f, u: Date.parse(f.t) / 1000 }));
    const fastest = Math.max(...fx.slice(1).map((f, i) => km(f, fx[i]!) / (f.u - fx[i]!.u)));
    let prev = eyeAt(hours, t0, true)!;
    for (let t = t0 + dt; t <= t1; t += dt) {
      const e = eyeAt(hours, t, true)!;
      expect(e.filled).toBe(false);
      expect(km(prev, e)).toBeLessThan(fastest * dt * 1.05);
      prev = e;
    }
  });

  it("sits exactly on a fix and fills the ring only when paused there", () => {
    const fix = Date.parse(fixes[1]!.t) / 1000;
    expect(eyeAt(hours, fix, false)).toEqual({ lon: 133.0, lat: 8.7, filled: true });
    expect(eyeAt(hours, fix, true)!.filled).toBe(false);
    expect(eyeAt(hours, fix + 1800, false)!.filled).toBe(false);
  });

  it("crosses the antimeridian the short way", () => {
    const h = interpolateHourly([
      { t: "1997-12-06T18:00:00Z", lon: -179.1, lat: 7.6 },
      { t: "1997-12-07T00:00:00Z", lon: 179.9, lat: 7.4 },
    ]);
    const mid = eyeAt(h, Date.parse("1997-12-06T21:00:00Z") / 1000, true)!;
    expect(Math.abs(mid.lon)).toBeGreaterThan(179);
  });
});

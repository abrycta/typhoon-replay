import { describe, expect, it } from "vitest";

import { hexToRgb, oklabToRgb, rgbToOklab } from "./color";
import { FIELDS, fieldLut, rampPosition } from "./fields";
import { formatDateTime, fromUrlHour, toUrlHour } from "./time";
import { jtwcCategory, lon180 } from "./units";

describe("colour scales", () => {
  it("round-trips colours through OKLab", () => {
    for (const hex of ["#23467a", "#e6ecf4", "#c4532f"]) expect(oklabToRgb(rgbToOklab(hexToRgb(hex)))).toEqual(hexToRgb(hex));
  });

  it("builds a 256-entry LUT whose calm end is nearly transparent and strong end opaque", () => {
    const lut = fieldLut("light");
    expect(lut).toHaveLength(1024);
    expect(lut[3]).toBeLessThan(20);
    expect(lut[1023]).toBeGreaterThan(200);
  });

  it("uses fixed domains: sqrt for rain, reversed for pressure", () => {
    expect(rampPosition(FIELDS.wind, 20)).toBeCloseTo(0.5);
    expect(rampPosition(FIELDS.wind, 99)).toBe(1);
    expect(rampPosition(FIELDS.rain, 7.5)).toBeCloseTo(0.5);
    expect(rampPosition(FIELDS.pressure, 950)).toBe(1);
  });
});

describe("time and units", () => {
  it("formats hours in the storm's time zone and round-trips URL hours", () => {
    expect(formatDateTime(1383825600, "en", "Asia/Manila")).toMatch(/7 Nov 2013, 20:00 GMT\+8/);
    expect(formatDateTime(1383825600, "en", "UTC")).toMatch(/12:00 UTC$/);
    expect(toUrlHour(1383825600)).toBe("2013-11-07T12:00Z");
    expect(fromUrlHour("2013-11-07T12:00Z")).toBe(1383825600);
    expect(fromUrlHour("garbage")).toBeUndefined();
  });

  it("labels categories and normalises longitudes", () => {
    expect(jtwcCategory(170)).toBe("Cat 5");
    expect(jtwcCategory(40)).toBe("TS");
    expect(lon180(190)).toBe(-170);
    expect(lon180(-180)).toBe(180);
  });
});

describe("particle ink", () => {
  it("keeps particles at 3:1 or more on the basemap and every field colour, in all four themes", async () => {
    const { contrastRatio } = await import("@abrycta/akari/maps");
    const { map } = await import("@abrycta/akari/tokens");
    const { particleInkLut, fieldLut, PARTICLE_ALPHA } = await import("./fields");
    const hex = (c: number[]) => `#${c.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;
    for (const theme of ["light", "dark", "light-hc", "dark-hc"] as const) {
      const ink = particleInkLut(theme), field = fieldLut(theme.startsWith("dark") ? "dark" : "light");
      const ground = [1, 3, 5].map((i) => parseInt(map[theme].background.slice(i, i + 2), 16));
      for (let i = 0; i < 256; i += 5) {
        const a = field[i * 4 + 3]! / 255;
        const under = [0, 1, 2].map((c) => field[i * 4 + c]! * a + ground[c]! * (1 - a));
        const head = [0, 1, 2].map((c) => ink[i * 4 + c]! * PARTICLE_ALPHA + under[c]! * (1 - PARTICLE_ALPHA));
        expect(contrastRatio(hex(head), hex(under)), `${theme} t=${i}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});


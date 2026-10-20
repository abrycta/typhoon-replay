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

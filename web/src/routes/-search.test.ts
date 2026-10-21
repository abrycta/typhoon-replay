import { describe, expect, it } from "vitest";

import { CATALOG_SORTS } from "@/data";

import { catalogSearch, compareSearch, replaySearch, townSearch } from "./-search";

describe("URL state schemas", () => {
  it("fills defaults and keeps valid share-link params", () => {
    expect(replaySearch.parse({ t: "2013-11-07T12:00Z", layer: "gust", speed: "8", v: "125.1,11.2,6" })).toMatchObject({
      t: "2013-11-07T12:00Z",
      layer: "gust",
      speed: 8,
      units: "ms",
      track: true,
      v: "125.1,11.2,6",
    });
  });

  it("repairs garbage instead of failing the page", () => {
    expect(replaySearch.parse({ t: "yesterday", layer: "lava", speed: 3, v: "x" })).toMatchObject({ t: undefined, layer: "wind", speed: 4, v: undefined });
    expect(townSearch.parse({ radius: "75" }).radius).toBe(100);
    // h counts from the aligned 0 h, so it may be negative; garbage and unknown line-ups are dropped.
    expect(compareSearch.parse({ a: "2013306N07162", h: "-3", al: "landfall" })).toMatchObject({ a: "2013306N07162", h: -3, al: "landfall", layer: "wind" });
    expect(compareSearch.parse({ h: "1.5", al: "sideways" })).toMatchObject({ h: undefined, al: undefined });
  });
});

describe("catalogue URL state", () => {
  it("accepts every sort the data layer knows, and the replay flag", () => {
    for (const sort of CATALOG_SORTS) expect(catalogSearch.parse({ sort }).sort).toBe(sort);
    expect(catalogSearch.parse({ sort: "loudest", replay: true })).toMatchObject({ sort: undefined, replay: true });
    expect(catalogSearch.parse({ replay: "yes" }).replay).toBeUndefined();
  });
});

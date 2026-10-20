import { describe, expect, it } from "vitest";

import { compareSearch, replaySearch, townSearch } from "./-search";

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
    expect(compareSearch.parse({ a: "2013306N07162", h: "-3" })).toMatchObject({ a: "2013306N07162", h: undefined, layer: "wind" });
  });
});

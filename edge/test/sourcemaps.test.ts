import { describe, expect, it } from "vitest";

import { isSourceMap, sourceMapGone } from "../src/sourcemaps";

describe("source maps", () => {
  it("matches only maps under /assets/", () => {
    expect(isSourceMap("/assets/main-D277azOg.js.map")).toBe(true);
    expect(isSourceMap("/assets/fonts-x.css.map")).toBe(true);
    expect(isSourceMap("/assets/main-D277azOg.js")).toBe(false);
    expect(isSourceMap("/assets/map-tiles.json")).toBe(false);
    expect(isSourceMap("/storm/x.map")).toBe(false);
  });

  it("answers 404, uncached", async () => {
    const res = sourceMapGone();
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).not.toContain("sources");
  });
});

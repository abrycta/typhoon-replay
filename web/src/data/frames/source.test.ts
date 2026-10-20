import { describe, expect, it } from "vitest";

import goniSummary from "../../../fixtures/v1/storms/2020299N11144/summary.json";
import haiyanSummary from "../../../fixtures/v1/storms/2013306N07162/summary.json";
import type { FramesManifest } from "@/shared/model/types";

import { frameSource, resolveUrl, sourceKey } from "./source";

// The bundled fixture summaries are pipeline output (scripts/make_webp_fixtures.py): Haiyan carries both
// formats, Goni WebP only.
const HAIYAN = "2013306N07162", GONI = "2020299N11144";
const fixture = (sid: string) => (sid === HAIYAN ? haiyanSummary : goniSummary).frames as unknown as FramesManifest;
const dir = (sid: string) => `/fixtures/v1/storms/${sid}/`;

describe("frame source selection", () => {
  it("resolves summary paths against the storm directory", () => {
    expect(resolveUrl("/fixtures/v1/storms/X/", "../../../frames/X/a.webp")).toBe("/fixtures/frames/X/a.webp");
    expect(resolveUrl("https://h.co/d/resolve/main/v2/storms/X/", "../../../frames/X/a.tyf")).toBe("https://h.co/d/resolve/main/frames/X/a.tyf");
    expect(resolveUrl("/fixtures/v1/storms/X/", "frames.tyf")).toBe("/fixtures/v1/storms/X/frames.tyf");
    expect(resolveUrl("/a/", "https://cdn/x.webp")).toBe("https://cdn/x.webp");
  });

  it("prefers WebP when a storm has both formats, keeping the .tyf as fallback", () => {
    const s = frameSource(HAIYAN, fixture(HAIYAN), dir(HAIYAN));
    expect(s?.kind).toBe("webp");
    if (s?.kind !== "webp") return;
    expect(s.fallback).toEqual({ kind: "tyf", url: `${dir(HAIYAN)}frames.tyf`, format: "tyf" });
    expect(s.field.vars.map((v) => v.name)).toEqual(["wind", "gust", "mslp", "tp", "u", "v"]);
    expect(s.field.vars[0]!.url).toMatch(/^\/fixtures\/frames\/2013306N07162\/[0-9a-f]{16}\.field\.wind\.webp$/);
    expect(s.header).toMatchObject({ format: "webp", nx: 81, ny: 81, res_deg: 0.25, frames: 72, nodata: 255 });
    expect(s.header.vars.map((v) => v.name)).toEqual(["wind", "gust", "mslp", "tp"]);
    expect(s.header.time).toHaveLength(72);
    expect(s.exact).toBeUndefined(); // the summary has per-frame series: no need for the readout grid
  });

  it("plays WebP-only storms, and fetches the exact grid only when the summary has no series", () => {
    const fr = fixture(GONI);
    expect(fr.format).toBe("webp");
    const s = frameSource(GONI, fr, dir(GONI));
    expect(s).toMatchObject({ kind: "webp" });
    expect(s?.kind === "webp" && s.fallback).toBeUndefined();
    const bare = frameSource(GONI, { ...fr, series: undefined }, dir(GONI));
    if (bare?.kind !== "webp" || !bare.exact) throw new Error("expected an exact grid");
    expect(bare.exact.set.vars.map((v) => v.name)).toEqual(["wind", "mslp"]);
    expect(bare.exact.frameIndex).toEqual(Array.from({ length: 16 }, (_, i) => i * 3));
    // the exact grid shares the field's north-west cell centre at its hours, at twice the spacing
    expect(bare.exact.header).toMatchObject({ nx: 41, ny: 41, res_deg: 0.5, frames: 16 });
    expect(bare.exact.header.nw_lon[1]).toBe(fr.nwLon![3]);
  });

  it("falls back to the .tyf when the WebP set is incomplete or missing", () => {
    const fr = fixture(HAIYAN);
    const noU = { ...fr, field: { ...fr.field!, vars: fr.field!.vars.filter((v) => v.name !== "u") } };
    expect(frameSource(HAIYAN, noU, dir(HAIYAN))).toEqual({ kind: "tyf", url: `${dir(HAIYAN)}frames.tyf`, format: "tyf" });
    const legacy: FramesManifest = { format: "tyf.gz", path: "frames.tyf.gz", frames: 3 };
    expect(frameSource(HAIYAN, legacy, dir(HAIYAN))).toMatchObject({ kind: "tyf", format: "tyf.gz" });
    expect(frameSource(HAIYAN, { format: "webp", frames: 3 }, dir(HAIYAN))).toBeUndefined();
    expect(frameSource(HAIYAN, undefined, dir(HAIYAN))).toBeUndefined();
  });

  it("keys sources by their files", () => {
    const a = frameSource(HAIYAN, fixture(HAIYAN), dir(HAIYAN));
    expect(sourceKey(a)).toBe(sourceKey(frameSource(HAIYAN, fixture(HAIYAN), dir(HAIYAN))));
    expect(sourceKey(a)).not.toBe(sourceKey(frameSource(GONI, fixture(GONI), dir(GONI))));
  });
});

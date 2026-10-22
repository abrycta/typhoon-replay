import { describe, expect, it } from "vitest";

import { filterStorms } from "./catalog";
import {
  bakedDataset,
  DataError,
  framesUrl,
  loadIndex,
  loadManifest,
  loadStormDetail,
  loadTrack,
  ogImageUrl,
  pointerPath,
  resolveDataset,
  sameDataset,
  stormRoot,
} from "./dataset";

function host(files: Record<string, unknown>, status: Record<string, number> = {}) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (status[url]) return new Response("denied", { status: status[url] });
    if (!(url in files)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(files[url]), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const HF = "https://hf.example/resolve/main/";
const FX = "/fixtures/";
const cfg = { baseUrl: HF, pointer: "latest.json", fallbackBaseUrls: [FX] };

describe("dataset resolution", () => {
  it("follows the pointer to the version directory and reads the manifest", async () => {
    const f = host({ [`${HF}latest.json`]: { version: 2, path: "v2/" }, [`${HF}v2/manifest.json`]: { datasetVersion: 2, dataAsOf: "2026-10-30", sources: [] } });
    const ds = await resolveDataset(cfg, f);
    expect(ds).toMatchObject({ root: `${HF}v2/`, version: 2, source: "primary" });
    expect((await loadManifest(ds, f)).dataAsOf).toBe("2026-10-30");
  });

  it("falls back to the bundled fixture when the primary host refuses", async () => {
    const f = host({ [`${FX}latest.json`]: { version: 1 }, [`${FX}v1/manifest.json`]: { datasetVersion: 1, fixture: true, sources: [] } }, { [`${HF}latest.json`]: 401 });
    const ds = await resolveDataset(cfg, f);
    expect(ds).toMatchObject({ root: `${FX}v1/`, source: "fallback" });
    expect(ds.primaryError).toMatch(/401/);
  });

  it("treats an HTML answer (SPA fallback) as missing and fails when nothing is reachable", async () => {
    const html = (async () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } })) as typeof fetch;
    await expect(resolveDataset(cfg, html)).rejects.toBeInstanceOf(DataError);
  });

  it("is tolerant of pointer shapes", () => {
    expect(pointerPath({ version: 3 })).toEqual({ path: "v3/", version: 3 });
    expect(pointerPath({ path: "v4" })).toMatchObject({ path: "v4/" });
    expect(pointerPath("v5")).toEqual({ path: "v5/", version: 5 });
    expect(pointerPath(6)).toEqual({ path: "v6/", version: 6 });
  });

  it("reads the index (object or bare array), summaries and tracks", async () => {
    const root = `${FX}v1/`;
    const ds = { root, baseUrl: FX, version: 1, source: "fallback" as const };
    expect(await loadManifest(ds, host({}))).toEqual({ datasetVersion: 1, sources: [] });
    const storm = { sid: "2013306N07162", name: "Haiyan", season: 2013, basin: "WP", startedAt: "", endedAt: "", landfallCountries: ["PH"] };
    const f = host({
      [`${root}index.json`]: [storm, { name: "no sid" }],
      [`${root}storms/2013306N07162/summary.json`]: { ...storm, frames: { format: "tyf", path: "frames.tyf", frames: 3 } },
      [`${root}storms/2013306N07162/track.json`]: { fixes: [{ t: "2013-11-07T00:00:00Z", lon: 130, lat: 10 }, { t: "2013-11-07T03:00:00Z", lon: 129, lat: 10 }] },
    });
    expect(await loadIndex(ds, f)).toHaveLength(1);
    const d = await loadStormDetail(ds, "2013306N07162", f);
    expect(d.replayAvailable).toBe(true); // inferred from the frames manifest
    expect(d.intensity).toEqual([]);
    expect(framesUrl(ds, d)).toBe(`${root}storms/2013306N07162/frames.tyf`);
    expect((await loadTrack(ds, "2013306N07162", f)).hours).toHaveLength(4);
  });
});

describe("catalogue filter", () => {
  const storms = [
    { sid: "2013306N07162", name: "Haiyan", localNames: { ph: "Yolanda", ja: "平成25年台風第30号" }, season: 2013, basin: "WP", startedAt: "", endedAt: "", landfallCountries: ["PH" as const] },
    { sid: "2019278N16165", name: "Hagibis", localNames: { ja: "令和元年東日本台風" }, season: 2019, basin: "WP", startedAt: "", endedAt: "", landfallCountries: ["JP" as const] },
  ];
  it("matches international, PAGASA and Japanese names, years, decades and countries", () => {
    expect(filterStorms(storms, { q: "yolanda" }).map((s) => s.name)).toEqual(["Haiyan"]);
    expect(filterStorms(storms, { q: "東日本" }).map((s) => s.name)).toEqual(["Hagibis"]);
    expect(filterStorms(storms, { q: "2019" }).map((s) => s.name)).toEqual(["Hagibis"]);
    expect(filterStorms(storms, { decade: 2010, country: "PH" }).map((s) => s.name)).toEqual(["Haiyan"]);
    expect(filterStorms(storms, { q: "nothing" })).toEqual([]);
  });
});

describe("bundled storms", () => {
  const cfg = {
    baseUrl: "https://hf.example/ds/",
    pointer: "latest.json",
    fallbackBaseUrls: [],
    bundle: { root: "/data/", version: 4, path: "v4/", storms: ["2013306N07162"] },
  };

  it("uses the build's version at once, and the site's copy only for bundled storms", () => {
    const ds = bakedDataset(cfg)!;
    expect(ds.root).toBe("https://hf.example/ds/v4/");
    expect(stormRoot(ds, "2013306N07162")).toBe("/data/v4/storms/2013306N07162/");
    expect(stormRoot(ds, "2021346N05145")).toBe("https://hf.example/ds/v4/storms/2021346N05145/");
    expect(ogImageUrl(ds, { sid: "2013306N07162", ogImage: "og.png" })).toBe("https://hf.example/ds/v4/storms/2013306N07162/og.png");
  });

  it("keeps the baked dataset only while the pointer names the same version", () => {
    const ds = bakedDataset(cfg)!;
    expect(sameDataset(ds, { root: "https://hf.example/ds/v4/", baseUrl: cfg.baseUrl, version: 4, source: "primary" })).toBe(true);
    expect(sameDataset(ds, { root: "https://hf.example/ds/v5/", baseUrl: cfg.baseUrl, version: 5, source: "primary" })).toBe(false);
    expect(sameDataset(ds, { root: "/fixtures/v1/", baseUrl: "/fixtures/", version: 1, source: "fallback" })).toBe(false);
    expect(bakedDataset({ ...cfg, bundle: undefined })).toBeUndefined();
  });
});

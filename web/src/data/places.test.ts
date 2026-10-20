import { describe, expect, it } from "vitest";

import type { ResolvedDataset } from "./dataset";
import { boundedDistance, preparePlaces, searchPlaces } from "./place-search";
import { datasetUrl, exposureWithin, loadPlaceIndex, loadPlaceShard, parseShard } from "./places";

// The bundled fixture's place files, by path relative to web/fixtures/.
const FILES = Object.fromEntries(
  Object.entries(import.meta.glob("../../fixtures/v1/places/*.json", { eager: true, query: "?raw", import: "default" })).map(([k, v]) => [k.replace("../../fixtures/", ""), v as string]),
);
const ds: ResolvedDataset = { root: "/fixtures/v1/", baseUrl: "/fixtures/", version: 1, source: "fallback" };

/** Serves web/fixtures/ at /fixtures/, recording the URLs asked for. */
function fixtureHost(missing: RegExp[] = []) {
  const seen: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (missing.some((m) => m.test(url))) return new Response("not found", { status: 404 });
    const body = FILES[url.replace(/^\/fixtures\//, "")];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { f, seen };
}

describe("static place index", () => {
  it("reads the compact search index and finds places by English and Japanese name", async () => {
    const { f, seen } = fixtureHost();
    const places = await loadPlaceIndex(ds, f);
    expect(places).toHaveLength(10);
    expect(seen).toEqual(["/fixtures/v1/places/index.json", "/fixtures/v1/places/search.json"]);
    const prepared = preparePlaces(places);
    expect(searchPlaces(prepared, "tacloban")[0]).toMatchObject({ id: "PH-0831600000", shard: "/fixtures/v1/places/ph-leyte.json", admin2: "Leyte" });
    expect(searchPlaces(prepared, "那覇")[0]).toMatchObject({ id: "JP-47201", nameJa: "那覇市", admin1Ja: "沖縄県" });
    expect(searchPlaces(prepared, "Naha")[0]!.id).toBe("JP-47201");
    // "City of Manila" is found as "manila"; typos still match; nothing for nonsense.
    expect(searchPlaces(prepared, "manila")[0]!.id).toBe("PH-1380600000");
    expect(searchPlaces(prepared, "taclobn")[0]!.id).toBe("PH-0831600000");
    expect(searchPlaces(prepared, "kagosima")[0]!.id).toBe("JP-46201");
    expect(searchPlaces(prepared, "zzzz")).toEqual([]);
    // A province name lists its places, after direct name matches.
    expect(searchPlaces(prepared, "leyte").map((p) => p.id).sort()).toEqual(["PH-0803738000", "PH-0831600000"]);
  });

  it("falls back to the shard files when the dataset has no search index", async () => {
    const { f, seen } = fixtureHost([/search\.json$/]);
    const places = await loadPlaceIndex(ds, f);
    expect(places.map((p) => p.id).sort()).toHaveLength(10);
    expect(seen.filter((u) => /places\/(ph|jp)-/.test(u))).toHaveLength(8);
    expect(places.find((p) => p.id === "JP-47201")).toMatchObject({ country: "JP", admin1: "Okinawa", nameJa: "那覇市" });
    expect(places.find((p) => p.id === "PH-0831600000")).toMatchObject({ country: "PH", admin2: "Leyte", storms100: 2 });
  });

  it("returns an empty index when the dataset has no places at all", async () => {
    const { f } = fixtureHost([/places\//]);
    expect(await loadPlaceIndex(ds, f)).toEqual([]);
  });

  it("lists the storms near a place from its shard, per radius, closest first", async () => {
    const { f } = fixtureHost();
    const shard = await loadPlaceShard("/fixtures/v1/places/ph-leyte.json", f);
    const within100 = exposureWithin(shard, "PH-0831600000", 100);
    expect(within100[0]).toMatchObject({ sid: "2013306N07162", name: "Haiyan", season: 2013, closestApproachAt: "2013-11-08T00:00:00Z" });
    expect(within100[0]!.maxWindKtWithinRadius).toBeGreaterThan(150);
    expect(within100[0]!.hoursWithinRadius).toBeGreaterThan(0);
    const within500 = exposureWithin(shard, "PH-0831600000", 500);
    expect(within500.length).toBeGreaterThan(within100.length);
    expect(within500.map((h) => h.closestApproachKm)).toEqual([...within500.map((h) => h.closestApproachKm)].sort((a, b) => a - b));
    expect(exposureWithin(shard, "PH-unknown", 500)).toEqual([]);
  });

  it("is tolerant of shard shapes: object rows, ISO times, place ids, unknown fields", () => {
    const shard = parseShard(
      {
        country: "JP",
        admin1: "Okinawa",
        places: [{ id: "JP-47201", name: "Naha", centroid: [127.68, 26.21], extra: true }, { name: "no id" }],
        hits: [
          { placeId: "JP-47201", sid: "A", km: 80, at: "2020-01-01T00:00:00Z", w100: 90, h100: 3 },
          { placeId: "JP-47201", sid: "B" }, // unreadable: skipped
        ],
        storms: { A: { name: "Alpha", season: 2020 } },
      },
      "u",
    );
    expect(shard.places).toEqual([{ id: "JP-47201", country: "JP", kind: "municipality", name: "Naha", admin1: "Okinawa", centroid: [127.68, 26.21], shard: "u" }]);
    expect(exposureWithin(shard, "JP-47201", 100)).toEqual([
      { sid: "A", name: "Alpha", season: 2020, closestApproachKm: 80, closestApproachAt: "2020-01-01T00:00:00Z", maxWindKtWithinRadius: 90, hoursWithinRadius: 3 },
    ]);
    expect(exposureWithin(shard, "JP-47201", 50)).toEqual([]);
  });

  it("resolves dataset paths in every form the files use", () => {
    expect(datasetUrl(ds, "v1/places/ph-leyte.json")).toBe("/fixtures/v1/places/ph-leyte.json");
    expect(datasetUrl(ds, "places/search.json")).toBe("/fixtures/v1/places/search.json");
    expect(datasetUrl(ds, "ph-leyte.json")).toBe("/fixtures/v1/places/ph-leyte.json");
    expect(datasetUrl(ds, "https://cdn.example/p.json")).toBe("https://cdn.example/p.json");
  });

  it("bounded edit distance gives up early", () => {
    expect(boundedDistance("tacloban", "tacloben", 1)).toBe(1);
    expect(boundedDistance("naha", "osaka", 1)).toBe(2);
  });
});

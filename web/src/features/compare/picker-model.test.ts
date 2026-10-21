import { describe, expect, it } from "vitest";

import type { StormSummary } from "@/shared/model/types";

import { pairReason, searchStorms, suggestPairs, unnamedStats } from "./picker-model";

const s = (sid: string, name: string, season: number, extra: Partial<StormSummary> = {}): StormSummary => ({
  sid,
  name,
  season,
  basin: "WP",
  startedAt: `${season}-06-01T00:00:00Z`,
  endedAt: `${season}-06-09T12:00:00Z`,
  landfallCountries: [],
  ...extra,
});
const HAIYAN = s("2013306N07162", "Haiyan", 2013, { localNames: { ph: "Yolanda", ja: "台風第30号" }, peakWindKt: 170, landfallCountries: ["PH"], saffirSimpson: "cat5" });
const GONI = s("2020299N11144", "Goni", 2020, { localNames: { ph: "Rolly", ja: "台風第19号" }, peakWindKt: 170, landfallCountries: ["PH"], saffirSimpson: "cat5" });
const UNNAMED = s("1940032N08122", "Unnamed", 1940);
const PAGASA_ONLY = s("1990001N10130", "Unnamed", 1990, { localNames: { ph: "Atring" } });
const ALL = [UNNAMED, HAIYAN, GONI, PAGASA_ONLY];

describe("storm picker search", () => {
  it("finds names, PAGASA names, Japanese numbers (any width), seasons and IDs", () => {
    const q = (x: string) => searchStorms(ALL, { q: x, includeUnnamed: false }).storms.map((r) => r.name);
    expect(q("yolanda")).toEqual(["Haiyan"]);
    expect(q("台風第３０号")).toEqual(["Haiyan"]);
    expect(q("2020")).toEqual(["Goni"]);
    expect(q("2013306N07162")).toEqual(["Haiyan"]);
    expect(q("haiyan 2013")).toEqual(["Haiyan"]);
  });

  it("lists named storms (PAGASA names count) newest first and hides unnamed ones until asked", () => {
    const off = searchStorms(ALL, { q: "", includeUnnamed: false });
    expect(off.storms.map((r) => r.sid)).toEqual([GONI.sid, HAIYAN.sid, PAGASA_ONLY.sid]);
    expect(off.hiddenUnnamed).toBe(1);
    expect(searchStorms(ALL, { q: "", includeUnnamed: true }).storms).toHaveLength(4);
    expect(unnamedStats(ALL)).toEqual({ count: 1, before1980: 1 });
  });

  it("filters by decade, landfall country and category", () => {
    expect(searchStorms(ALL, { q: "", includeUnnamed: true, decade: 2010 }).storms).toEqual([HAIYAN]);
    expect(searchStorms(ALL, { q: "", includeUnnamed: true, country: "PH", category: "5" }).storms).toHaveLength(2);
  });
});

describe("suggested pairs", () => {
  it("keeps only pairs in the index and gives each a reason from the data", () => {
    const pairs = suggestPairs(ALL);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ alignment: "landfall", reason: { kind: "same-peak", kt: 170, country: "PH" } });
  });

  it("says which storm lived longer, and the same life span when equal", () => {
    const mk = s("2018250N12170", "Mangkhut", 2018, { peakWindKt: 155, landfallCountries: ["PH"], endedAt: "2018-06-11T12:00:00Z" });
    expect(pairReason(HAIYAN, mk, [HAIYAN, GONI, mk])).toEqual({ kind: "peaks", ktA: 170, ktB: 155, longer: "b", hours: 48 });
    expect(pairReason(s("x", "Gertrude", 1948), s("y", "Faye", 1949), [])).toEqual({ kind: "same-length", hours: 204 });
    // With the index's peak times (data v4): hours from formation to peak differ by 48 h.
    const g = s("x", "Gertrude", 1948, { peakAt: "1948-06-03T00:00:00Z" });
    const f = s("y", "Faye", 1949, { peakAt: "1949-06-05T00:00:00Z" });
    expect(pairReason(g, f, [])).toEqual({ kind: "same-length", hours: 204, peaksApart: 48 });
  });
});

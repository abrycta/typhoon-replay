import { describe, expect, it } from "vitest";

import type { StormSummary } from "@/shared/model/types";

import { CATALOG_SORTS, filterStorms, sortStorms } from "./catalog";

// Shapes copied from the live index (data v1): named, PAGASA-only, JMA-number-only and bare unnamed storms.
const storm = (sid: string, name: string, startedAt: string, extra: Partial<StormSummary> = {}): StormSummary => ({
  sid,
  name,
  season: Number(sid.slice(0, 4)),
  basin: "WP",
  startedAt,
  endedAt: startedAt,
  landfallCountries: [],
  ...extra,
});

const HAIYAN = storm("2013306N07162", "Haiyan", "2013-11-03T00:00:00Z", { localNames: { ph: "Yolanda", ja: "台風第30号" }, peakWindKt: 170, minPressureHpa: 895, ace: 41.5, replayAvailable: true, landfallCountries: ["PH"] });
const GONI = storm("2020299N11144", "Goni", "2020-10-26T00:00:00Z", { localNames: { ph: "Rolly" }, peakWindKt: 170, minPressureHpa: 905, ace: 27, landfallCountries: ["PH"] });
const NANCY = storm("1961250N12169", "Nancy", "1961-09-07T00:00:00Z", { peakWindKt: 185, minPressureHpa: 882, ace: 77.3, replayAvailable: true });
const CRISING = storm("2021132N06132", "Unnamed", "2021-05-12T00:00:00Z", { localNames: { ph: "Crising" }, designation: "03W", peakWindKt: 35, ace: 0.2 });
const JMA7 = storm("1951181N21122", "Unnamed", "1951-06-30T06:00:00Z", { localNames: { ja: "台風第7号" }, minPressureHpa: 992, landfallCountries: ["JP"] });
const BARE1940 = storm("1940032N08122", "Unnamed", "1940-02-01T00:00:00Z", { landfallCountries: ["PH"] });
// Same start time as BARE1940: the SID breaks the tie.
const BARE1940B = storm("1940032N09130", "Unnamed", "1940-02-01T00:00:00Z");
const BETTY1 = storm("1946100N10140", "Betty", "1946-04-10T00:00:00Z", { peakWindKt: 60 });
const BETTY2 = storm("1987210N12150", "Betty", "1987-08-08T00:00:00Z", { peakWindKt: 140 });

// File order of the published index: oldest first.
const INDEX = [BARE1940, BARE1940B, BETTY1, JMA7, NANCY, BETTY2, HAIYAN, GONI, CRISING];
const sids = (xs: StormSummary[]) => xs.map((s) => s.sid);

describe("sortStorms", () => {
  it("defaults to newest first, with the SID as the tie-break", () => {
    expect(sids(sortStorms(INDEX))).toEqual(sids([CRISING, GONI, HAIYAN, BETTY2, NANCY, JMA7, BETTY1, BARE1940, BARE1940B]));
  });

  it("oldest first keeps the same tie-break", () => {
    expect(sids(sortStorms(INDEX, "oldest"))).toEqual(sids([BARE1940, BARE1940B, BETTY1, JMA7, NANCY, BETTY2, HAIYAN, GONI, CRISING]));
  });

  it("strongest: peak wind, then lowest pressure, then ACE; storms without a wind estimate last", () => {
    // Haiyan and Goni tie at 170 kt: Haiyan's 895 hPa beats Goni's 905. JMA7 has a pressure but no wind.
    expect(sids(sortStorms(INDEX, "strongest"))).toEqual(sids([NANCY, HAIYAN, GONI, BETTY2, BETTY1, CRISING, JMA7, BARE1940, BARE1940B]));
  });

  it("name: international A–Z, then PAGASA-only names, then the rest newest first", () => {
    expect(sids(sortStorms(INDEX, "name"))).toEqual(sids([BETTY2, BETTY1, GONI, HAIYAN, NANCY, CRISING, JMA7, BARE1940, BARE1940B]));
  });

  it("is total and stable: any input order gives the same output, and the input is not changed", () => {
    const shuffled = [GONI, BARE1940B, CRISING, NANCY, BARE1940, HAIYAN, BETTY2, JMA7, BETTY1];
    const before = sids(shuffled);
    for (const sort of CATALOG_SORTS) expect(sids(sortStorms(shuffled, sort))).toEqual(sids(sortStorms(INDEX, sort)));
    expect(sids(shuffled)).toEqual(before);
  });

  it("falls back to the season when a start time is missing", () => {
    const odd = storm("1950001N00000", "Unnamed", "");
    expect(sids(sortStorms([odd, BETTY1], "newest"))).toEqual(sids([odd, BETTY1]));
  });
});

describe("filterStorms", () => {
  it("finds named storms by English, PAGASA or Japanese name and by designation", () => {
    expect(sids(filterStorms(INDEX, { q: "haiyan" }))).toEqual([HAIYAN.sid]);
    expect(sids(filterStorms(INDEX, { q: "Yolanda" }))).toEqual([HAIYAN.sid]);
    expect(sids(filterStorms(INDEX, { q: "rolly" }))).toEqual([GONI.sid]);
    expect(sids(filterStorms(INDEX, { q: "crising" }))).toEqual([CRISING.sid]);
    expect(sids(filterStorms(INDEX, { q: "台風第30号" }))).toEqual([HAIYAN.sid]);
    expect(sids(filterStorms(INDEX, { q: "03w" }))).toEqual([CRISING.sid]);
  });

  it("filters on replay availability and keeps unnamed storms otherwise", () => {
    expect(sids(filterStorms(INDEX, { replay: true }))).toEqual([NANCY.sid, HAIYAN.sid]);
    expect(filterStorms(INDEX, { decade: 1940 })).toHaveLength(3);
    expect(sids(filterStorms(INDEX, { decade: 1940, country: "PH" }))).toEqual([BARE1940.sid]);
  });
});

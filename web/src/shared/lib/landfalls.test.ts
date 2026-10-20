import { describe, expect, it } from "vitest";

import type { Country } from "../model/types";
import { formatDateRange, groupLandfalls, landfallSummary, type LandfallPhrases } from "./landfalls";

// Rai / Odette 2021 (2021346N05145): eight Philippine landfalls over two days.
const RAI = [
  "2021-12-16T05:30:00Z",
  "2021-12-16T08:00:00Z",
  "2021-12-16T10:00:00Z",
  "2021-12-16T12:00:00Z",
  "2021-12-16T13:30:00Z",
  "2021-12-16T17:00:00Z",
  "2021-12-16T20:00:00Z",
  "2021-12-17T01:00:00Z",
].map((at) => ({ country: "PH" as Country, at }));

const NAMES: Record<Country, string> = { PH: "the Philippines", JP: "Japan" };
const EN: LandfallPhrases = {
  lead: (g, d) => (g.count > 1 ? `landfalls in ${NAMES[g.country]} ${d} (${g.count})` : `landfall in ${NAMES[g.country]} ${d}`),
  more: (g, d) => `${NAMES[g.country].replace(/^the /, "")} ${d}${g.count > 1 ? ` (${g.count})` : ""}`,
};

describe("landfall summary", () => {
  it("groups eight landfalls in one country into one phrase", () => {
    expect(groupLandfalls(RAI)).toEqual([{ country: "PH", first: "2021-12-16T05:30:00Z", last: "2021-12-17T01:00:00Z", count: 8 }]);
    expect(landfallSummary(RAI, "en", EN)).toBe("landfalls in the Philippines 16–17 Dec 2021 (8)");
  });

  it("lists each country once, in order of first landfall", () => {
    const l = [
      { country: "JP" as Country, at: "2019-10-03T00:00:00Z" },
      { country: "PH" as Country, at: "2019-10-01T00:00:00Z" },
    ];
    expect(landfallSummary(l, "en", EN)).toBe("landfall in the Philippines 1 Oct 2019 · Japan 3 Oct 2019");
    expect(landfallSummary([], "en", EN)).toBe("");
  });

  it("formats ranges per language and collapses a single day", () => {
    expect(formatDateRange("2021-12-16T05:30:00Z", "2021-12-16T20:00:00Z", "en")).toBe("16 Dec 2021");
    expect(formatDateRange("2021-12-16T05:30:00Z", "2021-12-17T01:00:00Z", "ja")).toBe("2021年12月16日～17日");
  });
});

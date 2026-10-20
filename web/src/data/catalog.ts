import { isUnnamed, searchKey } from "@/shared/lib/names";
import type { Country, StormSummary } from "@/shared/model/types";

/**
 * Orders of the catalogue (URL `sort`; `newest` is the default and is left out of the URL):
 * - newest / oldest: by start time;
 * - strongest: best-track peak wind (kt), then lowest central pressure, then ACE; storms with no
 *   wind estimate (mostly 1940s–50s) come after every storm that has one;
 * - name: international names A–Z, then PAGASA-only names A–Z, then storms with neither.
 * Every order ends with the same tie-break: newest first, then the IBTrACS SID, so the list is
 * total and stable (identical input always gives the identical order).
 */
export const CATALOG_SORTS = ["newest", "oldest", "strongest", "name"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];
export const DEFAULT_SORT: CatalogSort = "newest";

export interface CatalogFilter {
  q?: string;
  decade?: number;
  season?: number;
  country?: Country;
  /** Only storms with a published field replay (ERA5 frames). */
  replay?: boolean;
  sort?: CatalogSort;
}

/** Filter the static storm index (names: international, PAGASA, JMA; designation; or a season number). */
export function filterStorms(storms: readonly StormSummary[], f: CatalogFilter): StormSummary[] {
  const q = f.q ? searchKey(f.q.trim()) : "";
  return storms.filter((s) => {
    if (f.country && !s.landfallCountries.includes(f.country)) return false;
    if (f.season && s.season !== f.season) return false;
    if (f.decade && Math.floor(s.season / 10) * 10 !== f.decade) return false;
    if (f.replay && !s.replayAvailable) return false;
    if (!q) return true;
    if (/^\d{4}$/.test(q)) return s.season === Number(q);
    const hay = [s.name, s.localNames?.ph, s.localNames?.ja, s.designation, s.sid].filter(Boolean).map((x) => searchKey(x as string));
    return hay.some((h) => h.includes(q));
  });
}

const started = (s: StormSummary) => {
  const t = Date.parse(s.startedAt);
  return Number.isNaN(t) ? Date.UTC(s.season, 0, 1) : t;
};

/** Ascending, with missing values after every present one (whatever the direction of the caller). */
function present(a: number | undefined, b: number | undefined, dir: 1 | -1): number {
  const ha = a !== undefined && Number.isFinite(a);
  const hb = b !== undefined && Number.isFinite(b);
  if (ha && hb) return dir * ((a as number) - (b as number));
  return ha === hb ? 0 : ha ? -1 : 1;
}

const byNewest = (a: StormSummary, b: StormSummary) => started(b) - started(a) || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0);

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** 0: international name, 1: PAGASA name only, 2: neither (JMA number or nothing). */
function nameGroup(s: StormSummary): [number, string] {
  if (!isUnnamed(s.name)) return [0, s.name];
  const ph = s.localNames?.ph?.trim();
  return ph ? [1, ph] : [2, ""];
}

const comparators: Record<CatalogSort, (a: StormSummary, b: StormSummary) => number> = {
  newest: byNewest,
  oldest: (a, b) => started(a) - started(b) || byNewest(a, b),
  strongest: (a, b) =>
    present(a.peakWindKt, b.peakWindKt, -1) || present(a.minPressureHpa, b.minPressureHpa, 1) || present(a.ace, b.ace, -1) || byNewest(a, b),
  name: (a, b) => {
    const [ga, na] = nameGroup(a);
    const [gb, nb] = nameGroup(b);
    return ga - gb || collator.compare(na, nb) || byNewest(a, b);
  },
};

/** A sorted copy of the index (the input is left as it is). */
export function sortStorms(storms: readonly StormSummary[], sort: CatalogSort = DEFAULT_SORT): StormSummary[] {
  return [...storms].sort(comparators[sort] ?? byNewest);
}

export function decades(storms: readonly StormSummary[]): number[] {
  return [...new Set(storms.map((s) => Math.floor(s.season / 10) * 10))].sort((a, b) => b - a);
}

export function seasons(storms: readonly StormSummary[]): number[] {
  return [...new Set(storms.map((s) => s.season))].sort((a, b) => b - a);
}

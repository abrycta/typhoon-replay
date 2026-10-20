import { searchKey } from "@/shared/lib/names";
import type { Country, StormSummary } from "@/shared/model/types";

export interface CatalogFilter {
  q?: string;
  decade?: number;
  season?: number;
  country?: Country;
}

/** Filter the static storm index (names: international, PAGASA, JMA; or a season number). */
export function filterStorms(storms: readonly StormSummary[], f: CatalogFilter): StormSummary[] {
  const q = f.q ? searchKey(f.q.trim()) : "";
  return storms.filter((s) => {
    if (f.country && !s.landfallCountries.includes(f.country)) return false;
    if (f.season && s.season !== f.season) return false;
    if (f.decade && Math.floor(s.season / 10) * 10 !== f.decade) return false;
    if (!q) return true;
    if (/^\d{4}$/.test(q)) return s.season === Number(q);
    const hay = [s.name, s.localNames?.ph, s.localNames?.ja, s.sid].filter(Boolean).map((x) => searchKey(x as string));
    return hay.some((h) => h.includes(q));
  });
}

export function decades(storms: readonly StormSummary[]): number[] {
  return [...new Set(storms.map((s) => Math.floor(s.season / 10) * 10))].sort((a, b) => b - a);
}

export function seasons(storms: readonly StormSummary[]): number[] {
  return [...new Set(storms.map((s) => s.season))].sort((a, b) => b - a);
}

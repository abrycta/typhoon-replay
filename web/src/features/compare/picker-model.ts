// Storm picker search and suggestions over the static index (pure; the UI is StormPicker.tsx).
import { isUnnamed, jmaNumber, searchKey } from "@/shared/lib/names";
import type { Country, StormSummary } from "@/shared/model/types";

/** A storm with an international, PAGASA or JMA-numbered name (anything a person could search for by name). */
export const hasName = (s: StormSummary) => !isUnnamed(s.name) || !!s.localNames?.ph?.trim();

const started = (s: StormSummary) => Date.parse(s.startedAt) || Date.UTC(s.season, 0, 1);
const newestFirst = (a: StormSummary, b: StormSummary) => started(b) - started(a) || (a.sid < b.sid ? -1 : 1);

/** Japanese numbers in any width ("台風第１号" = "台風第1号"), and "1号" / "第1号" without "台風". */
const jaKey = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");

function haystack(s: StormSummary): string[] {
  const ja = s.localNames?.ja;
  const n = jmaNumber(ja ? jaKey(ja) : undefined);
  return [isUnnamed(s.name) ? "" : s.name, s.localNames?.ph, ja ? jaKey(ja) : undefined, n !== undefined ? `${s.season}-${n}` : undefined, s.designation, s.sid]
    .filter((x): x is string => !!x)
    .map(searchKey);
}

export type CategoryFilter = "5" | "4+";

export interface PickerQuery {
  q: string;
  includeUnnamed: boolean;
  decade?: number;
  country?: Country;
  category?: CategoryFilter;
}

/** Saffir–Simpson category number from the index ("cat4" -> 4; TD/TS and unknown -> 0). */
export const categoryOf = (s: StormSummary) => Number(/^cat(\d)$/.exec(s.saffirSimpson ?? "")?.[1] ?? 0);

function passesFilters(s: StormSummary, f: PickerQuery): boolean {
  if (f.decade !== undefined && Math.floor(s.season / 10) * 10 !== f.decade) return false;
  if (f.country && !s.landfallCountries.includes(f.country)) return false;
  if (f.category === "5" && categoryOf(s) !== 5) return false;
  if (f.category === "4+" && categoryOf(s) < 4) return false;
  return true;
}

export interface PickerResults {
  /** Matches to show (named storms, plus unnamed ones when included), newest first. */
  storms: StormSummary[];
  /** Unnamed storms that match the query but are hidden while the toggle is off. */
  hiddenUnnamed: number;
}

/**
 * Every whitespace-separated term must match: a four-digit term is a season, anything else is a substring of
 * a name (international, PAGASA, Japanese), the JTWC designation or the IBTrACS SID. Names that start with the
 * term come before names that merely contain it; within each, newest first.
 */
export function searchStorms(storms: readonly StormSummary[], query: PickerQuery): PickerResults {
  const { q, includeUnnamed } = query;
  const terms = q.normalize("NFKC").split(/[\s,·]+/).filter(Boolean).map(searchKey);
  const prefix: StormSummary[] = [];
  const contains: StormSummary[] = [];
  let hiddenUnnamed = 0;
  for (const s of storms) {
    if (!passesFilters(s, query)) continue;
    const hay = haystack(s);
    let starts = terms.length > 0;
    const ok = terms.every((t) => {
      if (/^\d{4}$/.test(t) && s.season === Number(t)) return true;
      const hit = hay.find((h) => h.includes(t));
      if (hit && !hay.some((h) => h.startsWith(t))) starts = false;
      return !!hit;
    });
    if (!ok) continue;
    if (!hasName(s) && !includeUnnamed) {
      hiddenUnnamed++;
      continue;
    }
    (starts && terms.some((t) => !/^\d{4}$/.test(t)) ? prefix : contains).push(s);
  }
  return { storms: [...prefix.sort(newestFirst), ...contains.sort(newestFirst)], hiddenUnnamed };
}

/** Unnamed storms in the index, and how many of them are from before 1980 (for the toggle's label). */
export function unnamedStats(storms: readonly StormSummary[]): { count: number; before1980: number } {
  const u = storms.filter((s) => !hasName(s));
  return { count: u.length, before1980: u.filter((s) => s.season < 1980).length };
}

export type PairAlignment = "formation" | "peak" | "landfall";

/** Suggested pairs (IBTrACS SIDs); the reason shown for each is worked out from the index, never typed in. */
export const CURATED_PAIRS: readonly { a: string; b: string; alignment: PairAlignment }[] = [
  { a: "2013306N07162", b: "2020299N11144", alignment: "landfall" }, // Haiyan (Yolanda) vs Goni (Rolly)
  { a: "2013306N07162", b: "2018250N12170", alignment: "landfall" }, // Haiyan vs Mangkhut (Ompong)
  { a: "2023138N05151", b: "2019278N16165", alignment: "peak" }, // Mawar vs Hagibis
  { a: "1948240N14139", b: "1949192N19142", alignment: "peak" }, // Gertrude 1948 vs Faye 1949
];

export type PairReason =
  /** The same peak wind, both into the same country. */
  | { kind: "same-peak"; kt: number; country: Country }
  /** The two strongest landfalls in `country` since `since`. */
  | { kind: "strongest"; country: Country; since: number; ktA: number; ktB: number }
  /** The same life span (hours from first to last fix); `peaksApart`: hours between their peaks, counted from formation (index `peakAt`, data v4). */
  | { kind: "same-length"; hours: number; peaksApart?: number }
  /** Different peaks; `longer` lived `hours` longer. */
  | { kind: "peaks"; ktA?: number; ktB?: number; longer?: "a" | "b"; hours: number };

export interface SuggestedPair {
  a: StormSummary;
  b: StormSummary;
  alignment: PairAlignment;
  reason: PairReason;
}

const lifeHours = (s: StormSummary) => Math.round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 3_600_000);
const hoursToPeak = (s: StormSummary) => (s.peakAt && Date.parse(s.peakAt) ? Math.round((Date.parse(s.peakAt) - Date.parse(s.startedAt)) / 3_600_000) : undefined);
const shared = (a: StormSummary, b: StormSummary) => a.landfallCountries.find((c) => b.landfallCountries.includes(c));

function strongestSince(storms: readonly StormSummary[], country: Country, since: number): StormSummary[] {
  return storms
    .filter((s) => hasName(s) && s.landfallCountries.includes(country) && s.peakWindKt !== undefined && s.season >= since)
    .sort((x, y) => (y.peakWindKt ?? 0) - (x.peakWindKt ?? 0));
}

export function pairReason(a: StormSummary, b: StormSummary, storms: readonly StormSummary[]): PairReason {
  const country = shared(a, b);
  if (country && a.peakWindKt !== undefined && a.peakWindKt === b.peakWindKt) return { kind: "same-peak", kt: a.peakWindKt, country };
  if (country && a.peakWindKt !== undefined && b.peakWindKt !== undefined) {
    const since = 2000;
    const top = strongestSince(storms, country, since);
    // Only when nothing else is as strong as the weaker of the two (ties would make "the two strongest" untrue).
    const weaker = Math.min(a.peakWindKt, b.peakWindKt);
    const atLeast = top.filter((s) => (s.peakWindKt ?? 0) >= weaker);
    if (Math.min(a.season, b.season) >= since && atLeast.length === 2 && atLeast.some((s) => s.sid === a.sid) && atLeast.some((s) => s.sid === b.sid))
      return { kind: "strongest", country, since, ktA: a.peakWindKt, ktB: b.peakWindKt };
  }
  const la = lifeHours(a);
  const lb = lifeHours(b);
  if (la === lb) {
    const pa = hoursToPeak(a);
    const pb = hoursToPeak(b);
    return pa !== undefined && pb !== undefined && pa !== pb ? { kind: "same-length", hours: la, peaksApart: Math.abs(pa - pb) } : { kind: "same-length", hours: la };
  }
  return { kind: "peaks", ktA: a.peakWindKt, ktB: b.peakWindKt, longer: la > lb ? "a" : "b", hours: Math.abs(la - lb) };
}

/** The curated pairs whose storms are in this index, each with its reason. */
export function suggestPairs(storms: readonly StormSummary[]): SuggestedPair[] {
  const bySid = new Map(storms.map((s) => [s.sid, s]));
  return CURATED_PAIRS.flatMap((p) => {
    const a = bySid.get(p.a);
    const b = bySid.get(p.b);
    return a && b ? [{ a, b, alignment: p.alignment, reason: pairReason(a, b, storms) }] : [];
  });
}

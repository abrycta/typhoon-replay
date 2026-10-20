import type { Country, Landfall } from "../model/types";
import { formatDate, type Lang } from "./time";

export interface LandfallGroup {
  country: Country;
  first: string;
  last: string;
  count: number;
}

/** Landfalls grouped by country, in order of each country's first landfall. */
export function groupLandfalls(landfalls: readonly Pick<Landfall, "country" | "at">[]): LandfallGroup[] {
  const sorted = [...landfalls].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const groups = new Map<Country, LandfallGroup>();
  for (const l of sorted) {
    const g = groups.get(l.country);
    if (g) {
      g.last = l.at;
      g.count++;
    } else groups.set(l.country, { country: l.country, first: l.at, last: l.at, count: 1 });
  }
  return [...groups.values()];
}

/** "16–17 Dec 2021" / "2021年12月16日～17日"; a single date when both fall on the same UTC day. */
export function formatDateRange(a: string, b: string, lang: Lang): string {
  const da = new Date(a);
  const db = new Date(b);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  if (day(da) === day(db)) return formatDate(a, lang);
  const sameMonth = day(da).slice(0, 7) === day(db).slice(0, 7);
  if (lang === "ja") return sameMonth ? `${formatDate(a, lang)}～${db.getUTCDate()}日` : `${formatDate(a, lang)}～${formatDate(b, lang)}`;
  return sameMonth ? `${da.getUTCDate()}–${formatDate(b, lang)}` : `${formatDate(a, lang)} – ${formatDate(b, lang)}`;
}

export interface LandfallPhrases {
  /** Lead phrase for the first country: (country, dates, count) => "landfall(s) in the Philippines 16–17 Dec 2021 (8)". */
  lead: (g: LandfallGroup, dates: string) => string;
  /** Each further country: "Japan 3 Oct 2019". */
  more: (g: LandfallGroup, dates: string) => string;
}

/** Compact summary for the storm header: one phrase per country instead of one per landfall. */
export function landfallSummary(landfalls: readonly Pick<Landfall, "country" | "at">[], lang: Lang, p: LandfallPhrases): string {
  return groupLandfalls(landfalls)
    .map((g, i) => {
      const dates = formatDateRange(g.first, g.last, lang);
      return i === 0 ? p.lead(g, dates) : p.more(g, dates);
    })
    .join(" · ");
}

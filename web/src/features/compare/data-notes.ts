// What the per-storm data cards and "About this comparison" say, worked out from the published data (pure; the
// words are in DataCard.tsx and AboutComparison.tsx).
import type { Agency, CentreOffset, StormDetail, TrackFix } from "@/shared/model/types";

/** JMA's best track starts in 1951 (IBTrACS has no JMA record before it). */
export const JMA_FIRST_SEASON = 1951;
/** ERA5 is "off the track" from here on: the replay's LARGE_OFFSET_KM (features/replay/centre-offset.ts). */
export const OFF_TRACK_KM = 150;

/** Typical hours between best-track fixes: every gap that makes up at least a quarter of them (e.g. 6, or 3 to 6). */
export function fixInterval(fixes: readonly Pick<TrackFix, "t">[]): { min: number; max: number } | undefined {
  const ts = fixes.map((f) => Date.parse(f.t)).filter(Number.isFinite);
  const gaps = ts.slice(1).map((t, k) => Math.round((t - ts[k]!) / 3_600_000)).filter((g) => g > 0);
  if (!gaps.length) return undefined;
  const count = new Map<number, number>();
  for (const g of gaps) count.set(g, (count.get(g) ?? 0) + 1);
  const common = [...count].filter(([, n]) => n * 4 >= gaps.length).map(([g]) => g);
  const typical = common.length ? common : [[...count].sort((a, b) => b[1] - a[1])[0]![0]];
  return { min: Math.min(...typical), max: Math.max(...typical) };
}

export interface AgencyWind {
  agency: Agency;
  kt: number;
  minutes: number;
}

/** Peak wind per agency, JTWC then JMA then the rest (WMO repeats the official agency, JMA here: left out). */
export function agencyWinds(d: Pick<StormDetail, "intensity">): AgencyWind[] {
  const order: Agency[] = ["jtwc", "jma", "pagasa", "cma", "hko", "kma"];
  return d.intensity
    .filter((i) => i.agency !== "wmo" && i.maxWindKt !== undefined)
    .map((i) => ({ agency: i.agency, kt: i.maxWindKt!, minutes: i.windAveragingMinutes }))
    .sort((a, b) => order.indexOf(a.agency) - order.indexOf(b.agency));
}

/** Why there is no JMA wind: none at all, or the storm predates JMA's best track. Undefined when JMA has one. */
export function jmaGap(d: Pick<StormDetail, "intensity" | "season">): "before-1951" | "none" | undefined {
  if (d.intensity.some((i) => i.agency === "jma" && (i.maxWindKt !== undefined || i.minPressureHpa !== undefined))) return undefined;
  return d.season < JMA_FIRST_SEASON ? "before-1951" : "none";
}

/** Lowest central pressure from any agency (or the peak's). */
export function lowestPressure(d: Pick<StormDetail, "intensity" | "peak">): number | undefined {
  const all = [d.peak?.pressureHpa, ...d.intensity.map((i) => i.minPressureHpa)].filter((x): x is number => x !== undefined);
  return all.length ? Math.min(...all) : undefined;
}

export type OffsetSummary =
  /** The current data version predates the measurement (or the storm has no maps). */
  | { kind: "pending" }
  /** ERA5 has no closed low near the track at `noCentrePct` % of the measured hours (half or more). */
  | { kind: "mostly-none"; noCentrePct: number }
  /** Median distance and the share of measured hours over OFF_TRACK_KM; `noCentrePct` when it is notable (10 % or more). */
  | { kind: "offset"; medianKm: number; offPct: number; noCentrePct?: number };

const pct = (n: number, of: number) => Math.round((100 * n) / of);

/** ERA5's centre against the best track over the whole replay, from `frames.centreOffset`. */
export function offsetSummary(co: CentreOffset | undefined): OffsetSummary {
  if (!co?.km.length) return { kind: "pending" };
  const located = co.km.filter((k): k is number => typeof k === "number").sort((a, b) => a - b);
  const none = co.km.length - located.length;
  const noCentrePct = pct(none, co.km.length);
  if (!located.length || none * 2 >= co.km.length) return { kind: "mostly-none", noCentrePct };
  const mid = located.length >> 1;
  const medianKm = Math.round(located.length % 2 ? located[mid]! : (located[mid - 1]! + located[mid]!) / 2);
  const offPct = pct(located.filter((k) => k > OFF_TRACK_KM).length, located.length);
  return noCentrePct >= 10 ? { kind: "offset", medianKm, offPct, noCentrePct } : { kind: "offset", medianKm, offPct };
}

/**
 * How positions were observed: before aircraft reconnaissance (1945), before weather satellites (routine
 * coverage from 1966), satellites with aircraft reconnaissance (until it ended in the western Pacific in
 * August 1987), satellites only.
 */
export type Era = "ships" | "aircraft" | "satellite-aircraft" | "satellite";
export function eraOf(season: number): Era {
  if (season < 1945) return "ships";
  if (season < 1966) return "aircraft";
  if (season <= 1987) return "satellite-aircraft";
  return "satellite";
}

export type Gap = "no-wind" | "no-jtwc" | "no-jma" | "no-pressure" | "no-maps";

/** What a storm's data lacks (empty when nothing is missing). */
export function gapsOf(d: Pick<StormDetail, "intensity" | "season" | "peak" | "frames">): Gap[] {
  const out: Gap[] = [];
  const winds = agencyWinds(d);
  if (!winds.length) out.push("no-wind");
  else if (!winds.some((w) => w.agency === "jtwc")) out.push("no-jtwc");
  if (lowestPressure(d) === undefined) out.push("no-pressure");
  if (jmaGap(d)) out.push("no-jma");
  if (!d.frames) out.push("no-maps");
  return out;
}

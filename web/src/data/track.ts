import type { TrackFix, TrackHour } from "@/shared/model/types";

const KEYS = ["jtwcKt", "jtwcHpa", "jmaKt", "jmaHpa"] as const;
type Key = (typeof KEYS)[number];

const unix = (t: string | number) => (typeof t === "number" ? t : Math.round(Date.parse(t) / 1000));

/** Shortest-way longitude interpolation (handles the antimeridian). */
function lerpLon(a: number, b: number, f: number): number {
  let d = b - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  let x = a + d * f;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
}

/**
 * Hourly best-track points from observed fixes. Position is linear in lat/lon; each intensity value is
 * linear between the nearest fixes that report it (an agency that skips a fix does not create a gap).
 * Points on a fix hour are `observed`; the rest carry `between` = the bracketing fix times.
 */
export function interpolateHourly(fixes: readonly TrackFix[]): TrackHour[] {
  const fx = fixes.map((f) => ({ ...f, u: unix(f.t) })).sort((a, b) => a.u - b.u);
  if (fx.length === 0) return [];
  const first = Math.ceil(fx[0]!.u / 3600) * 3600;
  const last = fx[fx.length - 1]!.u;
  const series = Object.fromEntries(
    KEYS.map((k) => [k, fx.filter((f) => f[k] !== undefined).map((f) => [f.u, f[k] as number] as const)]),
  ) as Record<Key, (readonly [number, number])[]>;
  const valueAt = (k: Key, t: number): number | undefined => {
    const s = series[k];
    if (!s.length || t < s[0]![0] || t > s[s.length - 1]![0]) return undefined;
    let i = 0;
    while (i < s.length - 1 && s[i + 1]![0] < t) i++;
    const [t0, v0] = s[i]!;
    const [t1, v1] = s[Math.min(i + 1, s.length - 1)]!;
    if (t === t0 || t1 === t0) return v0;
    if (t === t1) return v1;
    return Math.round((v0 + ((v1 - v0) * (t - t0)) / (t1 - t0)) * 10) / 10;
  };
  const out: TrackHour[] = [];
  let j = 0;
  for (let t = first; t <= last; t += 3600) {
    while (j < fx.length - 2 && fx[j + 1]!.u <= t) j++;
    const a = fx[j]!;
    const b = fx[Math.min(j + 1, fx.length - 1)]!;
    const exact = a.u === t ? a : b.u === t ? b : undefined;
    const f = exact ? 0 : (t - a.u) / (b.u - a.u);
    const p: TrackHour = exact
      ? { t, lon: exact.lon, lat: exact.lat, observed: true }
      : { t, lon: lerpLon(a.lon, b.lon, f), lat: a.lat + (b.lat - a.lat) * f, observed: false, between: [a.u, b.u] };
    for (const k of KEYS) {
      const v = exact && exact[k] !== undefined ? exact[k] : valueAt(k, t);
      if (v !== undefined) p[k] = v;
    }
    out.push(p);
  }
  return out;
}

/** The hourly point at or just before time t (binary search). */
export function hourAt(hours: readonly TrackHour[], t: number): TrackHour | undefined {
  if (!hours.length) return undefined;
  let lo = 0, hi = hours.length - 1;
  if (t <= hours[0]!.t) return hours[0];
  if (t >= hours[hi]!.t) return hours[hi];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (hours[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return hours[lo];
}

/** Best-track wind (kt) and its agency for display: JTWC 1-min first, else JMA 10-min. */
export function bestWind(p: Pick<TrackHour, "jtwcKt" | "jmaKt">): { kt: number; agency: "jtwc" | "jma" } | undefined {
  if (p.jtwcKt !== undefined) return { kt: p.jtwcKt, agency: "jtwc" };
  if (p.jmaKt !== undefined) return { kt: p.jmaKt, agency: "jma" };
  return undefined;
}

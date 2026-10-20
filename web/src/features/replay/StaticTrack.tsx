import type { TrackHour } from "@/shared/model/types";

/** No-WebGL fallback: the best track as an SVG polyline (equirectangular), current centre as a ring. */
export function StaticTrack({ hours, current, label }: { hours: readonly TrackHour[]; current?: TrackHour; label: string }) {
  if (!hours.length) return null;
  const lons = hours.map((h) => (h.lon < 0 ? h.lon + 360 : h.lon));
  const lats = hours.map((h) => h.lat);
  const w = Math.min(...lons) - 2, e = Math.max(...lons) + 2, s = Math.min(...lats) - 2, n = Math.max(...lats) + 2;
  const X = (lon: number) => (((lon < 0 ? lon + 360 : lon) - w) / (e - w)) * 1000;
  const Y = (lat: number) => ((n - lat) / (n - s)) * 1000 * ((n - s) / (e - w));
  const height = 1000 * ((n - s) / (e - w));
  return (
    <svg viewBox={`0 0 1000 ${height}`} role="img" aria-label={label} className="absolute inset-0 h-full w-full bg-muted">
      <polyline fill="none" stroke="currentColor" strokeWidth={3} points={hours.map((h) => `${X(h.lon)},${Y(h.lat)}`).join(" ")} />
      {current ? <circle cx={X(current.lon)} cy={Y(current.lat)} r={12} fill={current.observed ? "var(--seal, #c4532f)" : "none"} stroke="var(--seal, #c4532f)" strokeWidth={4} /> : null}
    </svg>
  );
}

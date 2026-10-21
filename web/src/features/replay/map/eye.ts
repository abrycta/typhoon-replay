import type { TrackHour } from "@/shared/model/types";

export interface Eye {
  lon: number;
  lat: number;
  /** Filled ring: paused exactly on an observed fix. Never toggled while playing (it blinked at every fix). */
  filled: boolean;
}

/**
 * The eye marker at time t: one continuous position, linear between consecutive hourly track points (which
 * pass through the observed fixes), shortest way across the antimeridian. Works with gaps between points.
 */
export function eyeAt(hours: readonly TrackHour[], t: number, playing: boolean): Eye | undefined {
  if (!hours.length) return undefined;
  let lo = 0, hi = hours.length - 1;
  if (t <= hours[0]!.t) hi = 0;
  else if (t >= hours[hi]!.t) lo = hi;
  else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (hours[mid]!.t <= t) lo = mid;
      else hi = mid;
    }
  }
  const a = hours[lo]!, b = hours[hi]!;
  const f = b.t === a.t ? 0 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
  let dl = b.lon - a.lon;
  if (dl > 180) dl -= 360;
  if (dl < -180) dl += 360;
  let lon = a.lon + dl * f;
  if (lon > 180) lon -= 360;
  if (lon <= -180) lon += 360;
  const on = f === 0 ? a : f === 1 ? b : undefined;
  return { lon, lat: a.lat + (b.lat - a.lat) * f, filled: !playing && !!on?.observed };
}

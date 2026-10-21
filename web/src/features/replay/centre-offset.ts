import type { CentreOffset } from "@/shared/model/types";

/**
 * From this distance on, the replay says that ERA5's storm is visibly off the official track. Measured on 303
 * storms (20,915 3-hourly frames): for typhoon-strength hours since 2000 the offset is 24 km at the median and
 * 71 km at the 95th percentile (grid size and the track's own error), so 150 km is clearly beyond the noise;
 * 36% of located frames from 1940-59 exceed it, 6% since 2000.
 */
export const LARGE_OFFSET_KM = 150;
/** Best-track wind (kt) from which a missing ERA5 centre is worth saying: a tropical storm by then. */
export const NAMED_STORM_KT = 34;

export type OffsetReading = { kind: "offset"; km: number; bearingDeg: number; lat?: number; lon?: number } | { kind: "none" };

/**
 * ERA5's centre offset at hourly frame `index`: the 3-hourly value at or before it, never read across a gap
 * of 3 hours or more (as the other numbers from the lossless grid). Undefined when the data has none.
 */
export function offsetAt(co: CentreOffset | undefined, index: number): OffsetReading | undefined {
  if (!co?.frameIndex.length) return undefined;
  let k = -1;
  for (let j = 0; j < co.frameIndex.length && co.frameIndex[j]! <= index; j++) k = j;
  if (k < 0 || index - co.frameIndex[k]! >= 3) return undefined;
  const km = co.km[k], b = co.bearingDeg[k];
  if (km === null || km === undefined || b === null || b === undefined) return { kind: "none" };
  const lat = co.lat?.[k], lon = co.lon?.[k];
  return lat == null || lon == null ? { kind: "offset", km, bearingDeg: b } : { kind: "offset", km, bearingDeg: b, lat, lon };
}

/** Where to mark ERA5's centre on the map: only when it is LARGE_OFFSET_KM or more from the track. */
export function markerAt(r: OffsetReading | undefined): { lon: number; lat: number } | undefined {
  if (r?.kind !== "offset" || r.km < LARGE_OFFSET_KM || r.lat === undefined || r.lon === undefined) return undefined;
  return { lon: r.lon, lat: r.lat };
}

/** Eight-point compass index (0 = N, 1 = NE, ... 7 = NW). */
export const compassPoint = (deg: number) => Math.round((((deg % 360) + 360) % 360) / 45) % 8;

import { jtwcCategory } from "@/shared/lib/units";
import type { TrackHour } from "@/shared/model/types";

export interface Seal {
  /** Best-track wind at t (JTWC 1-min, else JMA 10-min), linear between hours. */
  kt?: number;
  /** What the seal shows: "1"–"5", "TS" or "TD" (JTWC); "TY", "TS" or "TD" (JMA only); "" when unknown. */
  text: string;
  /** Square side in px: 14 (TD, TS) growing 0.8 px per category to 18 (Cat 5). */
  size: number;
}

function bracket(hours: readonly TrackHour[], t: number): [TrackHour, TrackHour, number] | undefined {
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
  return [a, b, b.t === a.t ? 0 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)))];
}

const lerp = (a: number | undefined, b: number | undefined, f: number) =>
  a === undefined ? b : b === undefined ? a : a + (b - a) * f;

/** The storm seal at time t: its category text and size. */
export function sealAt(hours: readonly TrackHour[], t: number): Seal {
  const br = bracket(hours, t);
  if (!br) return { text: "", size: 14 };
  const [a, b, f] = br;
  const jtwc = lerp(a.jtwcKt, b.jtwcKt, f);
  if (jtwc !== undefined) {
    const c = jtwcCategory(jtwc)!;
    const n = c.startsWith("Cat ") ? Number(c.slice(4)) : 0;
    return { kt: jtwc, text: n ? String(n) : c, size: 14 + n * 0.8 };
  }
  const jma = lerp(a.jmaKt, b.jmaKt, f);
  if (jma === undefined) return { text: "", size: 14 };
  return { kt: jma, text: jma >= 64 ? "TY" : jma >= 34 ? "TS" : "TD", size: jma >= 64 ? 15.6 : 14 };
}

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Label boxes to try around a seal at (x, y), best first: off the side of the track facing up, then the other
 * side, then the four diagonals, then above, below, right and left. `dir` is the track's screen direction (any length).
 */
export function labelCandidates(x: number, y: number, dir: [number, number], half: number, w: number, h: number): Rect[] {
  const len = Math.hypot(dir[0], dir[1]) || 1;
  let nx = -dir[1] / len, ny = dir[0] / len;
  if (ny > 0) [nx, ny] = [-nx, -ny];
  const gap = half + 6;
  // Centre of a w×h box whose nearest edge sits `gap` px from the seal centre along (ux, uy).
  const along = (ux: number, uy: number): Rect => {
    const d = gap + Math.abs(ux) * (w / 2) + Math.abs(uy) * (h / 2);
    return { x: x + ux * d - w / 2, y: y + uy * d - h / 2, w, h };
  };
  // A box with its corner (sx, sy) nearest the seal, `half + 4` px out on each axis.
  const corner = (sx: number, sy: number): Rect => {
    const c = half + 4;
    return { x: sx > 0 ? x + c : x - c - w, y: sy > 0 ? y + c : y - c - h, w, h };
  };
  return [along(nx, ny), along(-nx, -ny), corner(1, -1), corner(-1, -1), corner(1, 1), corner(-1, 1), along(0, -1), along(0, 1), along(1, 0), along(-1, 0)];
}

export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

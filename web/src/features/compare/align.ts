// Shared timeline for two storms of different lengths. Each storm's replay is hourly (index 0 = its first
// frame); an alignment picks one moment in each storm (its anchor) and lines the anchors up. The shared
// timeline spans from the earliest aligned start to the latest aligned end, so it is as long as needed for
// both: a storm is "before" (not formed yet) or "after" (ended) outside its own hours.

import { isoToUnix } from "@/shared/lib/time";
import type { StormDetail, TrackHour } from "@/shared/model/types";

export const ALIGNMENTS = ["peak", "formation", "landfall"] as const;
export type Alignment = (typeof ALIGNMENTS)[number];
/** Peak intensity: both storms are at their strongest at the same moment (see the About panel). */
export const DEFAULT_ALIGNMENT: Alignment = "peak";

export interface StormSpan {
  /** Unix seconds of the replay's first hourly index. */
  start: number;
  /** Unix seconds of the first and last best-track fix. */
  formedAt?: number;
  endedAt?: number;
  /** Hourly indices in the replay (frames, or best-track hours when there are none). */
  hours: number;
  /** Unix seconds of the best-track peak, when known. */
  peakAt?: number;
  /** Unix seconds of the first landfall, when the storm made one. */
  landfallAt?: number;
}

export interface SharedTimeline {
  /** The alignment actually used (falls back when an anchor is missing). */
  alignment: Alignment;
  /** Length of the shared timeline in hourly steps. */
  frames: number;
  /** Shared index at which the anchors meet ("hour 0"). */
  zero: number;
  /** Per storm: local index = shared index - offset. */
  offsets: number[];
}

const anchorTime = (s: StormSpan, a: Alignment): number | undefined => (a === "formation" ? s.start : a === "peak" ? s.peakAt : s.landfallAt);

/** Alignments every storm has an anchor for (formation always; landfall only when all made landfall). */
export function availableAlignments(spans: readonly StormSpan[]): Alignment[] {
  return ALIGNMENTS.filter((a) => spans.every((s) => anchorTime(s, a) !== undefined));
}

/** The requested alignment when every storm supports it, else peak, else formation. */
export function effectiveAlignment(spans: readonly StormSpan[], wanted: Alignment): Alignment {
  const ok = availableAlignments(spans);
  if (ok.includes(wanted)) return wanted;
  return ok.includes("peak") ? "peak" : "formation";
}

export function sharedTimeline(spans: readonly StormSpan[], wanted: Alignment = DEFAULT_ALIGNMENT): SharedTimeline {
  const alignment = effectiveAlignment(spans, wanted);
  // Anchor as an index inside each storm's replay (clamped: a peak or landfall just outside the frames).
  const anchors = spans.map((s) => Math.min(Math.max(0, Math.round(((anchorTime(s, alignment) ?? s.start) - s.start) / 3600)), Math.max(0, s.hours - 1)));
  const zero = Math.max(0, ...anchors);
  const offsets = anchors.map((a) => zero - a);
  const frames = spans.length ? Math.max(...spans.map((s, k) => s.hours + offsets[k]!)) : 0;
  return { alignment, frames, zero, offsets };
}

export type SideStatus = { kind: "before"; hours: number } | { kind: "during"; index: number } | { kind: "after"; hours: number };

/** Where a storm is at a shared index: hours until it starts, its own index, or hours since it ended. */
export function sideStatus(shared: number, offset: number, hours: number): SideStatus {
  const local = shared - offset;
  if (local < 0) return { kind: "before", hours: -local };
  if (local > hours - 1) return { kind: "after", hours: local - (hours - 1) };
  return { kind: "during", index: local };
}

/** "3 d 4 h" style parts for a duration in hours. */
export function splitDuration(h: number): { days: number; hours: number } {
  const total = Math.max(0, Math.round(h));
  return { days: Math.floor(total / 24), hours: total % 24 };
}

/**
 * A storm's place on the timeline, from its summary and (when it has no frames) its hourly track: the replay's
 * hours are the frames when published, else the best-track hours, exactly as StormReplay plays them.
 */
export function spanOf(d: StormDetail, hours?: readonly TrackHour[]): StormSpan | undefined {
  const f = d.frames;
  let start: number | undefined;
  let n = 0;
  if (f?.time?.length) [start, n] = [f.time[0], f.frames || f.time.length];
  else if (f?.start && f.frames) [start, n] = [isoToUnix(f.start), f.frames];
  else if (hours?.length) [start, n] = [hours[0]!.t, hours.length];
  if (start === undefined || n < 1) return undefined;
  const landfalls = d.landfalls.map((l) => isoToUnix(l.at)).sort((x, y) => x - y);
  return {
    start,
    hours: n,
    formedAt: isoToUnix(d.startedAt),
    endedAt: isoToUnix(d.endedAt),
    peakAt: d.peak?.at ? isoToUnix(d.peak.at) : undefined,
    landfallAt: landfalls[0],
  };
}

/** Hours from a storm's first replay index to a moment (fractional; may fall outside the replay). */
export const hoursInto = (s: StormSpan, t: number) => (t - s.start) / 3600;

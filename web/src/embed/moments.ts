// The embed's moments (CLAUDE.md rule 27): the richest hours of the storm inside the baked view, chosen from the data by
// scripts/build-embed.mjs, shown in turn and captioned. Each fact is a fixed EN/JA template filled with figures from
// the data. Under reduced motion the embed holds the densest moment, still.
import { useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import { formatShort, type TimeZoneChoice } from "@/shared/lib/time";
import { msToKt, type SpeedUnit } from "@/shared/lib/units";
import { usePrefersReducedMotion } from "@/shared/ui/hooks";
import { hostPause } from "@/shared/ui/host-pause";

import { EMBED } from "./haiyan.generated";

export type MomentFact =
  | { kind: "peak"; t: string; kt: number; agency: string; minutes?: number; hpa?: number }
  | { kind: "landfall"; t: string; place: string }
  | { kind: "strengthening"; t: string; kt: number }
  | { kind: "era5Wind" | "era5Gust"; t: string; ms: number }
  | { kind: "era5Rain"; t: string; mmh: number }
  | { kind: "gale"; t: string; km2: number };

export interface Moment {
  /** The hour shown, as in the URL (`2013-11-07T23:00Z`). */
  t: string;
  facts: readonly MomentFact[];
}

export const MOMENTS: readonly Moment[] = EMBED.moments as readonly Moment[];
export const DENSEST: number = EMBED.densest;
/** How long each fact is on screen: a moment with more facts is held longer. */
export const BEAT_MS = 5000;

/** Every fact of every moment in play order: a moment is held for one beat per fact. */
const BEATS = MOMENTS.flatMap((m, k) => m.facts.map((_, f) => ({ moment: k, fact: f })));

/**
 * The beat on show: steps every BEAT_MS while the embed may move (the parent has not paused it, the tab is visible),
 * and never under reduced motion, which holds the densest moment.
 */
export function useMomentBeat(): { moment: number; fact: number; still: boolean } {
  const reduced = usePrefersReducedMotion();
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    if (reduced || BEATS.length < 2) return;
    const TICK = 250;
    let elapsed = 0;
    const id = window.setInterval(() => {
      if (hostPause.get() || document.hidden) return;
      elapsed += TICK;
      if (elapsed < BEAT_MS) return;
      elapsed = 0;
      setBeat((b) => (b + 1) % BEATS.length);
    }, TICK);
    return () => window.clearInterval(id);
  }, [reduced]);
  if (reduced) return { moment: DENSEST, fact: 0, still: true };
  return { ...BEATS[beat]!, still: false };
}

const sameHour = (a: string, b: string) => Math.floor(Date.parse(a) / 3600000) === Math.floor(Date.parse(b) / 3600000);

/** One fact as a sentence. `at` is the moment's hour: an ERA5 fact from a nearby hour names its own. */
export function useFactText(units: SpeedUnit, tz: TimeZoneChoice): (f: MomentFact, at: string) => string {
  const { t } = useLingui();
  const { lang } = useLang();
  const time = (iso: string) => formatShort(iso, lang, tz);
  const speed = (ms: number) => (units === "kt" ? `${msToKt(ms).toFixed(0)} kt` : `${ms.toFixed(1)} m/s`);
  return (f, at) => {
    const when = (s: string) => (sameHour(f.t, at) ? s : `${s} (${time(f.t)})`);
    switch (f.kind) {
      case "peak": {
        const agency = f.minutes ? `${f.agency.toUpperCase()} ${f.minutes}-min` : f.agency.toUpperCase();
        return f.hpa !== undefined ? t`Peak intensity: ${f.kt} kt (${agency}), ${f.hpa} hPa` : t`Peak intensity: ${f.kt} kt (${agency})`;
      }
      case "landfall":
        return t`Landfall at ${f.place}, ${time(f.t)}`;
      case "strengthening":
        return when(t`Fastest strengthening: +${f.kt} kt in 24 hours`);
      case "era5Wind":
        return when(t`Peak ERA5 wind near the centre in view: ${speed(f.ms)}`);
      case "era5Gust":
        return when(t`Peak ERA5 gust near the centre in view: ${speed(f.ms)}`);
      case "era5Rain":
        return when(t`Peak ERA5 rain near the centre in view: ${f.mmh.toFixed(1)} mm/h`);
      case "gale":
        return when(t`Widest ERA5 gale-force area in view: ${f.km2.toLocaleString(lang)} km²`);
    }
  };
}

// The wake-up story, in one place: which backends sleep, how long they take to wake, and every sentence that says so.
// Wake times come only from the conformance table's "Cold start on free hosting" row (conformance.json, coldStartS),
// so the copy, the table and the lanes' waiting bar show the same measured number. A backend without a measured
// figure gets no number anywhere ("a minute or more" in the copy, "—" in the table); its figure appears here
// automatically once CI writes it.
import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";

import { WAKE_CAP_MS } from "@/api";
import type { BackendId } from "@/shared/config/config";

import { CONFORMANCE } from "./catalogue";

/** Backends on Render's free plan: they sleep after 15 minutes idle. Node and Rust run as Cloudflare Workers and never sleep. */
export const SLEEPING_BACKENDS: readonly BackendId[] = ["java", "go"];

export const sleeps = (id: BackendId) => SLEEPING_BACKENDS.includes(id);

/** Measured cold start on free hosting, in seconds, or undefined when it has not been measured. */
export const coldStartS = (id: BackendId): number | undefined => CONFORMANCE.backends[id]?.coldStartS;

/**
 * How long a lane's waiting bar takes to fill (to 95 %): the measured cold start, else the time the page keeps
 * trying before it gives up (no number is shown for the bar, so this states no figure).
 */
export const typicalWakeMs = (id: BackendId) => {
  const s = coldStartS(id);
  return s !== undefined ? s * 1000 : WAKE_CAP_MS;
};

const DEFAULT_LABELS: Record<BackendId, string> = { java: "Java", node: "Node", rust: "Rust", go: "Go" };

/** Every wake-up sentence on the Tech page, EN and JA through Lingui. */
export function useWakeCopy(labels: Record<BackendId, string> = DEFAULT_LABELS) {
  const { t } = useLingui();
  return useMemo(() => {
    /** "about 100 s for Java" or, unmeasured, "a minute or more for Go". */
    const wakeFor = (id: BackendId) => {
      const s = coldStartS(id);
      const label = labels[id];
      return s !== undefined ? t`about ${s} s for ${label}` : t`a minute or more for ${label}`;
    };
    const [first, second] = SLEEPING_BACKENDS.map(wakeFor);
    const wakeTimes = t`${first} and ${second}`;
    return {
      /** The "Hosting" fact at the top of the page; matches the HowItWorks stack table. */
      hostingFact: t`Java and Go run on Render's free plan and sleep after 15 minutes idle; Node and Rust run as Cloudflare Workers and never sleep`,
      /** The paragraph under the race heading. */
      raceIntro: t`Java and Go sleep after 15 minutes idle. Waking takes ${wakeTimes} (the cold-start row below). Opening this page starts waking both, and the race waits for them on its own. Node and Rust never sleep.`,
      /** A lane that got a "waking" answer during a run. */
      laneWaking: (label: string, id: BackendId) => {
        const s = coldStartS(id);
        if (!sleeps(id)) return t`${label} is not answering yet. This page keeps trying.`;
        return s !== undefined
          ? t`${label} is waking up from sleep: about ${s} s on free hosting. This page keeps trying.`
          : t`${label} is waking up from sleep: waking can take a minute or more. This page keeps trying.`;
      },
      /** An idle lane whose wake-up ping found it asleep. */
      laneWakingHint: (label: string) => t`${label} is waking up; opening this page started it.`,
      /** The explorer's answer when the chosen backend is asleep. */
      explorerWaking: (id: BackendId, retryAfterS: number) => {
        const s = coldStartS(id);
        if (!sleeps(id)) return t`The backend is not answering yet. Send again in ${retryAfterS} s.`;
        return s !== undefined
          ? t`The backend is waking up (about ${s} s on free hosting). Send again in ${retryAfterS} s.`
          : t`The backend is waking up (waking can take a minute or more). Send again in ${retryAfterS} s.`;
      },
    };
  }, [t, labels]);
}

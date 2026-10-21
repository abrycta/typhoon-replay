import { useLingui } from "@lingui/react/macro";

import { cn } from "@abrycta/akari/react";

import type { Alignment } from "./align";
import { type PairReason, type SuggestedPair } from "./picker-model";

function useReason() {
  const { t } = useLingui();
  return (p: SuggestedPair): string => {
    const r: PairReason = p.reason;
    const [ya, yb] = [p.a.season, p.b.season];
    switch (r.kind) {
      case "same-peak": {
        const { kt } = r;
        return r.country === "PH" ? t`Both ${kt} kt into the Philippines, ${ya} and ${yb}` : t`Both ${kt} kt into Japan, ${ya} and ${yb}`;
      }
      case "strongest": {
        const { since, ktA, ktB } = r;
        return r.country === "PH"
          ? t`The two strongest Philippine landfalls since ${since}: ${ktA} kt and ${ktB} kt`
          : t`Japan's strongest since ${since}: ${ktA} kt and ${ktB} kt`;
      }
      case "same-length": {
        const { hours } = r;
        return t`Same ${hours} h life, ${ya} and ${yb}, before weather satellites`;
      }
      case "peaks": {
        const { hours } = r;
        const ka = r.ktA ?? "?";
        const kb = r.ktB ?? "?";
        const longer = r.longer === "a" ? p.a.name : p.b.name;
        return t`${ka} kt vs ${kb} kt; ${longer} lived ${hours} h longer`;
      }
    }
  };
}

export function SuggestedPairs({ pairs, a, b, onChoose }: { pairs: SuggestedPair[]; a?: string; b?: string; onChoose: (p: SuggestedPair) => void }) {
  const { t } = useLingui();
  const reason = useReason();
  const at = (al: Alignment) => (al === "landfall" ? t`at landfall` : al === "peak" ? t`at peak` : t`from formation`);
  if (!pairs.length) return null;
  return (
    <section aria-labelledby="pairs-h" className="grid gap-2.5">
      <h2 id="pairs-h" className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
        {t`Suggested pairs`}
      </h2>
      <ul role="list" className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))]">
        {pairs.map((p) => {
          const now = (p.a.sid === a && p.b.sid === b) || (p.a.sid === b && p.b.sid === a);
          const old = p.a.season < 1960 || p.b.season < 1960;
          const title = old ? `${p.a.name} ${p.a.season} vs ${p.b.name} ${p.b.season}` : `${p.a.name} vs ${p.b.name}`;
          const how = at(p.alignment);
          return (
            <li key={`${p.a.sid}-${p.b.sid}`} className="grid">
              <button
                type="button"
                onClick={() => onChoose(p)}
                aria-current={now ? "true" : undefined}
                className={cn(
                  "grid content-start gap-1.5 rounded-md border bg-card px-4 py-3.5 text-left text-card-foreground transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  now ? "border-2 border-primary" : "border-border",
                )}
                data-testid="suggested-pair"
              >
                <b className="font-heading text-lg font-semibold">{title}</b>
                <span className="text-sm text-muted-foreground">{reason(p)}</span>
                <span className="font-mono text-xs uppercase tracking-wider text-primary">{now ? t`Showing now · ${how}` : t`Aligned ${how} →`}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

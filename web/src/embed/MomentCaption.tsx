// The desktop embed's moment caption (./moments.ts), under the storm's title in place of the page's actions row.
import { Badge } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";

import type { TimeZoneChoice } from "@/shared/lib/time";
import type { SpeedUnit } from "@/shared/lib/units";

import { MOMENTS, useFactText } from "./moments";

/** The desktop caption, under the storm's title: the step, the lead fact, then the moment's other facts. */
export function MomentCaption({ moment, units, tz }: { moment: number; units: SpeedUnit; tz: TimeZoneChoice }) {
  const { t } = useLingui();
  const text = useFactText(units, tz);
  const m = MOMENTS[moment]!;
  const [lead, ...rest] = m.facts.map((f) => text(f, m.t));
  return (
    <div className="grid h-14 content-start gap-1" data-testid="embed-moment" data-moment={moment} aria-live="off">
      <p className="flex min-w-0 items-center gap-3 text-xl leading-7 font-semibold">
        <Badge variant="outline" className="shrink-0 font-mono tabular-nums">
          {t`${moment + 1} of ${MOMENTS.length}`}
        </Badge>
        <span className="truncate">{lead}</span>
      </p>
      <p className="truncate text-base text-muted-foreground">{rest.join(" · ")}</p>
    </div>
  );
}

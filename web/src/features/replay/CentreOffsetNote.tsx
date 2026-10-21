import { useLingui } from "@lingui/react/macro";

import { compassPoint, LARGE_OFFSET_KM, NAMED_STORM_KT, type OffsetReading } from "./centre-offset";
import { useCompassNames } from "./use-compass-names";

/**
 * A small note on the map when ERA5's storm is far from the official track (or missing), so the field is not
 * mistaken for a drawing error. The field is never moved: it is shown where ERA5 has it.
 */
export function CentreOffsetNote({ reading, bestTrackKt }: { reading?: OffsetReading; bestTrackKt?: number }) {
  const { t } = useLingui();
  const dirs = useCompassNames();
  if (!reading) return null;
  let text: string;
  if (reading.kind === "offset") {
    if (reading.km < LARGE_OFFSET_KM) return null;
    const km = Math.round(reading.km / 10) * 10;
    const dir = dirs[compassPoint(reading.bearingDeg)]!;
    text = t`ERA5 places this storm about ${km} km ${dir} of the official track here.`;
  } else {
    if (bestTrackKt === undefined || bestTrackKt < NAMED_STORM_KT) return null;
    text = t`ERA5 shows no clear centre near the official track here.`;
  }
  return (
    <div
      className="pointer-events-none absolute top-2 left-2 max-w-[min(26rem,calc(100%-4rem))] rounded-sm bg-background/90 px-2 py-1 text-xs text-foreground shadow-sm"
      role="note"
      data-testid="centre-offset-note"
    >
      {text} <span className="text-muted-foreground">{t`Reanalysis is coarse, especially before satellites; the field is shown where ERA5 has it.`}</span>
    </div>
  );
}

/** Map key for the ERA5 centre marker (storm page sidebar). */
export function Era5CentreKey() {
  const { t } = useLingui();
  return (
    <p className="flex items-start gap-2 text-xs text-muted-foreground" data-testid="era5-centre-key">
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="mt-0.5 shrink-0">
        <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <span>{t`ERA5 centre: where the reanalysis has the storm, marked when it is ${LARGE_OFFSET_KM} km or more from the official track (the ring).`}</span>
    </p>
  );
}

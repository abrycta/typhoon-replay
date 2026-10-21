import { Skeleton, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";

import { isUnnamed } from "@/shared/lib/names";
import { formatMonth } from "@/shared/lib/time";
import type { StormDetail, StormSummary } from "@/shared/model/types";
import { useStormName } from "@/shared/ui/use-storm-name";

import { SLOT_COLOR, useCountryName, useDuration } from "./labels";
import { categoryOf } from "./picker-model";
import { StormPicker } from "./StormPicker";

export function SlotCard({
  slot,
  summary,
  detail,
  loading,
  storms,
  onPick,
}: {
  slot: "A" | "B";
  summary?: StormSummary;
  detail?: StormDetail;
  loading: boolean;
  storms: readonly StormSummary[];
  onPick: (sid: string) => void;
}) {
  const { t } = useLingui();
  const { lang } = useLang();
  const stormName = useStormName();
  const duration = useDuration();
  const country = useCountryName();
  const s = detail ?? summary;
  const named = s && !isUnnamed(s.name);
  const local = s ? [named ? s.localNames?.ph : undefined, s.localNames?.ja, formatMonth(s.startedAt, lang)].filter(Boolean) : [];
  const cat = summary ? categoryOf(summary) : 0;
  const kt = detail?.peak?.windKt ?? summary?.peakWindKt;
  const agency = detail?.peak?.agency ?? summary?.peakWindAgency;
  const minutes = agency ? detail?.intensity.find((i) => i.agency === agency)?.windAveragingMinutes : undefined;
  const hpa = detail?.peak?.pressureHpa ?? detail?.intensity.map((i) => i.minPressureHpa).filter((x): x is number => x !== undefined).sort((a, b) => a - b)[0];
  const hours = detail?.durationHours ?? (s ? (Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 3_600_000 : undefined);
  const landfalls = detail?.landfalls.length;
  const countries = (s?.landfallCountries ?? []).map(country).join(", ");
  const label = slot === "A" ? t`Storm A` : t`Storm B`;
  return (
    <section
      aria-label={label}
      className="grid content-start gap-1.5 rounded-md border border-border border-t-4 bg-card px-4 py-3.5 text-card-foreground"
      style={{ borderTopColor: SLOT_COLOR[slot] }}
      data-testid={`slot-${slot}`}
    >
      <span className="font-mono text-xs uppercase tracking-wider" style={{ color: SLOT_COLOR[slot] }}>
        {label}
      </span>
      {!s ? (
        loading ? (
          <Skeleton className="h-16" />
        ) : (
          <p className="text-sm text-muted-foreground">{t`No storm chosen yet.`}</p>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2.5">
            <h2 className="font-heading text-2xl font-semibold">{named ? s.name : stormName(s)}</h2>
            {local.length ? <span className="text-muted-foreground">{local.join(" · ")}</span> : null}
          </div>
          <p className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-muted-foreground">
            {kt !== undefined ? (
              <span>
                {cat ? `${t`Cat ${cat}`} · ` : ""}
                {kt} kt{agency ? ` (${agency.toUpperCase()}${minutes ? ` ${t`${minutes}-min`}` : ""})` : ""}
              </span>
            ) : (
              <span>{t`No wind estimate`}</span>
            )}
            {hpa !== undefined ? <span>{hpa} hPa</span> : null}
            {hours !== undefined ? <span>{duration(hours)}</span> : null}
            {landfalls ? (
              <span>
                {landfalls === 1 ? t`1 landfall` : t`${landfalls} landfalls`} · {countries}
              </span>
            ) : detail ? (
              <span>{t`No landfall in the Philippines or Japan`}</span>
            ) : null}
          </p>
        </>
      )}
      <div className="mt-1.5">
        <StormPicker slot={slot} storms={storms} onPick={onPick} hasValue={!!s} />
      </div>
    </section>
  );
}

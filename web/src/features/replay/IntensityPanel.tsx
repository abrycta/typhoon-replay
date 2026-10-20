import { Badge, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@abrycta/akari/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronDownIcon } from "lucide-react";

import { formatShort, type Lang, type TimeZoneChoice } from "@/shared/lib/time";
import { jtwcCategory, ktToMs, msToKt, type SpeedUnit } from "@/shared/lib/units";
import type { ReanalysisCheck, TrackHour } from "@/shared/model/types";

export interface IntensityPanelProps {
  hour?: TrackHour;
  /** ERA5 max 10 m wind (m/s) within `radiusDeg` of the best-track centre at this hour. */
  era5WindMs?: number;
  era5MinMslp?: number;
  radiusDeg: number;
  /** ERA5 numbers come from the lossless 3-hourly grid: there is no reading between its hours. */
  threeHourly?: boolean;
  check?: ReanalysisCheck;
  units: SpeedUnit;
  lang: Lang;
  tz: TimeZoneChoice;
}

const fmt = (v: number, d = 0) => v.toFixed(d);

export function IntensityPanel({ hour, era5WindMs, era5MinMslp, radiusDeg, threeHourly, check, units, lang, tz }: IntensityPanelProps) {
  const { t } = useLingui();
  const sp = (kt: number) => (units === "kt" ? `${fmt(kt)} kt` : `${fmt(ktToMs(kt), 1)} m/s`);
  const spMs = (ms: number) => (units === "kt" ? `${fmt(msToKt(ms))} kt` : `${fmt(ms, 1)} m/s`);
  const jtwc = hour?.jtwcKt;
  const jma = hour?.jmaKt;
  const ratioJtwc = era5WindMs !== undefined && jtwc ? era5WindMs / ktToMs(jtwc) : undefined;
  const ratioJma = era5WindMs !== undefined && jma ? era5WindMs / ktToMs(jma) : undefined;
  const km = Math.round((radiusDeg * 111) / 10) * 10;

  return (
    <section className="grid gap-4 rounded-sm border border-border p-4" aria-labelledby="intensity-h" data-testid="intensity-panel">
      <div className="grid gap-2">
        <h2 id="intensity-h" className="text-base font-semibold">
          {t`Best-track intensity`}
        </h2>
        {hour ? (
          <>
            <p className="text-xs text-muted-foreground">
              {hour.observed ? (
                <Badge variant="secondary">{t`Observed fix`}</Badge>
              ) : (
                <>
                  <Badge variant="outline">{t`Interpolated`}</Badge>{" "}
                  {hour.between
                    ? t`between the ${formatShort(hour.between[0], lang, tz)} and ${formatShort(hour.between[1], lang, tz)} fixes`
                    : null}
                </>
              )}
            </p>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-sm tabular-nums">
              <dt className="text-muted-foreground">{t`JTWC, 1-min mean`}</dt>
              <dd data-testid="bt-jtwc">
                {jtwc !== undefined ? (
                  <>
                    {sp(jtwc)} <span className="text-muted-foreground">{jtwcCategory(jtwc)}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">{t`not reported`}</span>
                )}
              </dd>
              <dt className="text-muted-foreground">{t`JMA, 10-min mean`}</dt>
              <dd>{jma !== undefined ? sp(jma) : <span className="text-muted-foreground">{t`not reported`}</span>}</dd>
              <dt className="text-muted-foreground">{t`JMA central pressure`}</dt>
              <dd>{hour.jmaHpa !== undefined ? `${fmt(hour.jmaHpa)} hPa` : <span className="text-muted-foreground">{t`not reported`}</span>}</dd>
            </dl>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t`No best-track fix at this hour.`}</p>
        )}
      </div>

      <div className="grid gap-2 border-t border-border pt-3">
        <h3 className="text-sm font-semibold">
          {t`ERA5 field near the centre`} <span className="font-normal text-muted-foreground">({t`reanalysis context`})</span>
        </h3>
        {era5WindMs !== undefined ? (
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-sm tabular-nums">
            <dt className="text-muted-foreground">{t`Strongest 10 m wind within ${km} km`}</dt>
            <dd data-testid="era5-wind">{spMs(era5WindMs)}</dd>
            {era5MinMslp !== undefined ? (
              <>
                <dt className="text-muted-foreground">{t`Lowest sea-level pressure`}</dt>
                <dd>{fmt(era5MinMslp)} hPa</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">{t`Field ÷ best track`}</dt>
            <dd data-testid="honesty-ratio" className="whitespace-nowrap">
              {ratioJtwc !== undefined ? <span>{t`${ratioJtwc.toFixed(2)}× JTWC`}</span> : null}
              {ratioJtwc !== undefined && ratioJma !== undefined ? " · " : null}
              {ratioJma !== undefined ? <span>{t`${ratioJma.toFixed(2)}× JMA`}</span> : null}
              {ratioJtwc === undefined && ratioJma === undefined ? <span className="text-muted-foreground">{t`no best-track wind to compare`}</span> : null}
            </dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="era5-none">
            {threeHourly ? t`No ERA5 reading at this hour: the numbers come from a lossless grid every 3 hours; the map between them is for viewing only.` : t`No field data at this hour.`}
          </p>
        )}
        {threeHourly && era5WindMs !== undefined ? (
          <p className="text-xs text-muted-foreground">{t`From the lossless 3-hourly grid (0.5°).`}</p>
        ) : null}
        {check ? (
          <p className="text-xs text-muted-foreground" data-testid="peak-check">
            {t`At this storm's peak the field's strongest wind was ${check.atPeak.era5WindMs.toFixed(1)} m/s against ${check.atPeak.jtwcMs?.toFixed(1) ?? "?"} m/s (JTWC) and ${check.atPeak.jmaMs?.toFixed(1) ?? "?"} m/s (JMA): ${check.atPeak.ratioToJtwc?.toFixed(2) ?? "?"}× and ${check.atPeak.ratioToJma?.toFixed(2) ?? "?"}×.`}
          </p>
        ) : null}
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-ak-text-link underline-offset-4 hover:underline">
            {t`Why is the field weaker than the storm?`}
            <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2 text-sm text-muted-foreground">
            <Trans>
              Wind and rain fields are ERA5 reanalysis on a grid of about 28 km. For intense typhoons it smooths the eye wall: at Haiyan's peak, ERA5's
              strongest 10 m wind was about a third of the JTWC best-track estimate (0.31×) and under half of JMA's 10-minute estimate (0.42×), and its
              central pressure was 88 hPa too high. Use the best-track intensity for peak strength and the field for spatial extent and timing.
            </Trans>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </section>
  );
}

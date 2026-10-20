import { Button, Switch, Label, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";

import { hourAt } from "@/data";
import { formatShort, type Lang, type TimeZoneChoice } from "@/shared/lib/time";
import { ktToMs, msToKt, type SpeedUnit } from "@/shared/lib/units";
import type { TrackHour } from "@/shared/model/types";

export interface TimelineTableProps {
  times: number[];
  hours: readonly TrackHour[];
  /** ERA5 max wind near the centre per timeline index (m/s), where frames are loaded. */
  era5: (index: number) => number | undefined;
  current: number;
  onJump: (index: number) => void;
  units: SpeedUnit;
  lang: Lang;
  tz: TimeZoneChoice;
}

const ll = (lat: number, lon: number) => `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? "E" : "W"}`;

/** The text alternative to the animated map: the same data, one row per hour, in the DOM. */
export function TimelineTable({ times, hours, era5, current, onJump, units, lang, tz }: TimelineTableProps) {
  const { t } = useLingui();
  const [observedOnly, setObservedOnly] = useState(false);
  const step = times.length > 240 ? 3 : 1;
  const rows = useMemo(
    () =>
      times
        .map((time, index) => ({ index, time, hour: hourAt(hours, time) }))
        .filter((r) => r.hour && (r.index % step === 0 || r.index === current))
        .filter((r) => !observedOnly || (r.hour?.observed && r.hour.t === r.time)),
    [times, hours, step, observedOnly, current],
  );
  const sp = (kt?: number) => (kt === undefined ? "" : units === "kt" ? `${kt.toFixed(0)}` : ktToMs(kt).toFixed(1));
  const unit = units === "kt" ? "kt" : "m/s";
  const na = t`n/a`;
  return (
    <div className="grid gap-2" data-testid="timeline-table">
      <div className="flex items-center gap-2 text-sm">
        <Switch id="observed-only" checked={observedOnly} onCheckedChange={setObservedOnly} />
        <Label htmlFor="observed-only">{t`Observed fixes only`}</Label>
      </div>
      <div className="max-h-[28rem] overflow-auto rounded-sm border border-border" tabIndex={0} role="region" aria-label={t`Timeline table`}>
        <Table>
          <TableCaption className="sr-only">
            {t`Hour-by-hour track, best-track intensity and ERA5 field wind. Choose a time to move the replay there.`}
          </TableCaption>
          <TableHeader className="sticky top-0 bg-background">
            <TableRow>
              <TableHead scope="col">{t`Time`}</TableHead>
              <TableHead scope="col">{t`Centre`}</TableHead>
              <TableHead scope="col" className="text-right">{t`JTWC 1-min (${unit})`}</TableHead>
              <TableHead scope="col" className="text-right">{t`JMA 10-min (${unit})`}</TableHead>
              <TableHead scope="col" className="text-right">{t`JMA hPa`}</TableHead>
              <TableHead scope="col">{t`Source`}</TableHead>
              <TableHead scope="col" className="text-right">{t`ERA5 max wind (${unit})`}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ index, time, hour }) => {
              const h = hour!;
              const e = era5(index);
              const exact = h.t === time;
              return (
                <TableRow key={index} aria-current={index === current ? "true" : undefined} className={index === current ? "bg-muted" : undefined}>
                  <TableCell>
                    <Button variant="link" size="xs" className="h-auto p-0 font-mono tabular-nums" onClick={() => onJump(index)}>
                      {formatShort(time, lang, tz)}
                    </Button>
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">{ll(h.lat, h.lon)}</TableCell>
                  <TableCell className="text-right tabular-nums">{sp(h.jtwcKt) || na}</TableCell>
                  <TableCell className="text-right tabular-nums">{sp(h.jmaKt) || na}</TableCell>
                  <TableCell className="text-right tabular-nums">{h.jmaHpa?.toFixed(0) ?? na}</TableCell>
                  <TableCell className="text-xs">
                    {h.observed && exact
                      ? t`observed`
                      : h.between
                        ? t`interpolated (${formatShort(h.between[0], lang, tz)}–${formatShort(h.between[1], lang, tz)})`
                        : t`interpolated`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{e === undefined ? <span aria-label={t`not loaded yet`}>…</span> : units === "kt" ? msToKt(e).toFixed(0) : e.toFixed(1)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

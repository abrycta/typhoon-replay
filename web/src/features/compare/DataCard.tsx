import { useLingui } from "@lingui/react/macro";

import { useStormTrack } from "@/data";
import type { StormDetail } from "@/shared/model/types";

import { agencyWinds, type Era, eraOf, fixInterval, jmaGap, lowestPressure, OFF_TRACK_KM, offsetSummary } from "./data-notes";
import { SLOT_COLOR } from "./labels";

function useEraText() {
  const { t } = useLingui();
  return (e: Era) =>
    e === "ships"
      ? t`Before aircraft reconnaissance: positions from ships and land stations`
      : e === "aircraft"
        ? t`Before weather satellites: positions from ships, land stations and aircraft`
        : e === "satellite-aircraft"
          ? t`Weather satellites, with aircraft reconnaissance`
          : t`Weather satellites`;
}

/** One storm's data under its map: track, winds per agency, pressure, maps, ERA5 against the track, era. */
export function DataCard({ slot, name, detail }: { slot: "A" | "B"; name: string; detail: StormDetail }) {
  const { t } = useLingui();
  const eraText = useEraText();
  // Shared with the replay's own track query (same key), so no extra request.
  const track = useStormTrack(detail.sid);
  const iv = track.data ? fixInterval(track.data.fixes) : undefined;
  const winds = agencyWinds(detail);
  const jma = jmaGap(detail);
  const hpa = lowestPressure(detail);
  const off = offsetSummary(detail.frames?.centreOffset);
  const limit = OFF_TRACK_KM;

  const trackText = !iv
    ? t`IBTrACS best track, shown hourly`
    : iv.min === iv.max
      ? (() => {
          const h = iv.min;
          return t`IBTrACS, ${h}-hourly fixes, shown hourly`;
        })()
      : (() => {
          const { min, max } = iv;
          return t`IBTrACS, ${min}- to ${max}-hourly fixes, shown hourly`;
        })();
  const windParts = winds.map((w) => {
    const { kt, minutes } = w;
    const agency = w.agency.toUpperCase();
    return t`${kt} kt ${agency} (${minutes}-min)`;
  });
  if (jma === "before-1951") windParts.push(t`no JMA record (before 1951)`);
  else if (jma === "none") windParts.push(t`no JMA record`);
  const offText = (() => {
    if (off.kind === "pending") return t`Not measured`;
    if (off.kind === "mostly-none") {
      const p = off.noCentrePct;
      return t`ERA5 shows no clear centre at ${p}% of hours`;
    }
    const { medianKm, offPct } = off;
    const base = t`Centre ${medianKm} km from the track (median); over ${limit} km at ${offPct}% of hours`;
    const n = off.noCentrePct;
    return n === undefined ? base : `${base}; ${t`no clear centre at ${n}%`}`;
  })();

  const rows: [string, string, string][] = [
    ["track", t`Track`, trackText],
    ["wind", t`Peak wind`, winds.length ? windParts.join(" · ") : [t`No wind estimate`, ...windParts].join(" · ")],
    ["pressure", t`Pressure`, hpa !== undefined ? `${hpa} hPa` : t`Not recorded`],
    ["maps", t`Maps`, detail.frames ? t`ERA5, hourly, about 28 km grid` : t`None (track only)`],
    ...(detail.frames ? [["offset", t`ERA5 vs track`, offText] as [string, string, string]] : []),
    ["era", t`Era`, eraText(eraOf(detail.season))],
  ];
  const title = t`${name}'s data`;
  return (
    <section
      aria-label={title}
      className="grid content-start gap-2 rounded-md border border-border border-t-4 bg-card px-4 py-3.5 text-card-foreground"
      style={{ borderTopColor: SLOT_COLOR[slot] }}
      data-testid={`data-card-${slot}`}
    >
      <h3 className="font-mono text-xs uppercase tracking-wider" style={{ color: SLOT_COLOR[slot] }}>
        {title}
      </h3>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        {rows.map(([k, label, value]) => (
          <div key={k} className="contents" data-testid={`data-${k}`}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="m-0 [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

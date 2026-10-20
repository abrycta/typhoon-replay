import { Badge, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

import { formatDate } from "@/shared/lib/time";
import type { StormSummary } from "@/shared/model/types";

export function StormCard({ s }: { s: StormSummary }) {
  const { t } = useLingui();
  const { lang } = useLang();
  return (
    <li className="grid gap-1 rounded-sm border border-border p-3 transition-colors hover:bg-muted/60">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link to="/storm/$sid" params={{ sid: s.sid }} className="font-heading text-lg font-semibold underline-offset-4 hover:underline">
          {s.name}
          {s.localNames?.ph ? <span className="font-normal text-muted-foreground"> ({s.localNames.ph})</span> : null}
        </Link>
        <span className="font-mono text-sm tabular-nums text-muted-foreground">{s.season}</span>
      </div>
      {lang === "ja" && s.localNames?.ja ? (
        <p lang="ja" className="text-sm text-muted-foreground">
          {s.localNames.ja}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {formatDate(s.startedAt, lang)} – {formatDate(s.endedAt, lang)}
        {s.peakWindKt ? <> · {t`peak ${s.peakWindKt.toFixed(0)} kt (${(s.peakWindAgency ?? "").toUpperCase()})`}</> : null}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {s.landfallCountries.map((c) => (
          <Badge key={c} variant="secondary">
            {c === "PH" ? t`Landfall: Philippines` : t`Landfall: Japan`}
          </Badge>
        ))}
        {s.replayAvailable ? <Badge>{t`Field replay`}</Badge> : <Badge variant="outline">{t`Track only`}</Badge>}
      </div>
    </li>
  );
}

export function StormList({ storms, label }: { storms: readonly StormSummary[]; label: string }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2" aria-label={label}>
      {storms.map((s) => (
        <StormCard key={s.sid} s={s} />
      ))}
    </ul>
  );
}

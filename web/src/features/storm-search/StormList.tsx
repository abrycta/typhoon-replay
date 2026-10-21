import { Badge, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

import { stormLabel } from "@/shared/lib/names";
import { formatDate } from "@/shared/lib/time";
import type { StormSummary } from "@/shared/model/types";
import { StormName } from "@/shared/ui/storm-name";

export function StormCard({ s }: { s: StormSummary }) {
  const { t } = useLingui();
  const { lang } = useLang();
  const label = stormLabel(s);
  const local = label.kind === "pagasa" || label.kind === "jma";
  const designation = local ? label.designation : undefined;
  return (
    <li className="grid gap-1 rounded-sm border border-border p-3 transition-colors hover:bg-muted/60">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link to="/storm/$sid" params={{ sid: s.sid }} className="font-heading text-lg font-semibold underline-offset-4 hover:underline">
          <StormName s={s} />
        </Link>
        <span className="font-mono text-sm tabular-nums text-muted-foreground">{s.season}</span>
      </div>
      {local ? (
        <p className="text-sm text-muted-foreground">
          {designation ? t`No international name · ${designation}` : t`No international name`}
        </p>
      ) : null}
      {lang === "ja" && s.localNames?.ja && label.kind !== "jma" ? (
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
    // role="list": Safari drops list semantics from unstyled (list-style: none) lists.
    <ul role="list" className="grid gap-3 sm:grid-cols-2" aria-label={label}>
      {storms.map((s) => (
        <StormCard key={s.sid} s={s} />
      ))}
    </ul>
  );
}

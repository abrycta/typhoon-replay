import { useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

import { formatDate } from "@/shared/lib/time";
import type { StormDetail } from "@/shared/model/types";

/**
 * Places the storm passed near, from the storm's static summary (`affectedPlaces`, computed by the pipeline).
 * Static only: a dataset version without the list says so instead of asking an API.
 */
export function AffectedPlaces({ detail }: { detail: StormDetail }) {
  const { t } = useLingui();
  const { lang } = useLang();
  const items = detail.affectedPlaces;
  const radius = detail.affectedRadiusKm ?? 100;

  return (
    <section aria-labelledby="places-h" className="grid content-start gap-2" data-testid="affected-places">
      <h2 id="places-h" className="text-lg font-semibold">
        {t`Affected places`}
      </h2>
      <p className="text-xs text-muted-foreground">{t`Places the best track passed within ${radius} km of, closest first.`}</p>
      {!items ? (
        <p className="text-sm text-muted-foreground">{t`This dataset version has no place list for this storm yet.`}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t`No covered place was within ${radius} km.`}</p>
      ) : (
        <ol className="grid gap-1.5 text-sm">
          {items.map((h) => (
            <li key={h.place.id} className="flex flex-wrap justify-between gap-x-3 border-b border-border pb-1.5 last:border-0">
              <span>
                <Link to="/town" search={{ place: h.place.id, radius: 100 }} className="underline-offset-4 hover:underline">
                  {lang === "ja" && h.place.nameJa ? h.place.nameJa : h.place.name}
                </Link>
                <span className="text-muted-foreground">, {lang === "ja" && h.place.admin1Ja ? h.place.admin1Ja : (h.place.admin2 ?? h.place.admin1)}</span>
              </span>
              <span className="tabular-nums text-muted-foreground">
                {t`${h.closestApproachKm.toFixed(0)} km · ${formatDate(h.closestApproachAt, lang)}`}
                {h.maxWindKtWithinRadius !== undefined ? ` · ${t`${h.maxWindKtWithinRadius} kt`}` : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

import { Skeleton, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";

import { useStormPlaces } from "@/api";
import { formatDate } from "@/shared/lib/time";
import type { PlaceHit, StormDetail } from "@/shared/model/types";

/**
 * Places the storm passed near. The static summary carries them when the pipeline computed them;
 * otherwise the selected API backend is asked (the replay itself never waits on this).
 */
export function AffectedPlaces({ detail }: { detail: StormDetail }) {
  const { t } = useLingui();
  const { lang } = useLang();
  const fromStatic = detail.affectedPlaces;
  const api = useStormPlaces(detail.sid, { enabled: !fromStatic });
  const items: PlaceHit[] | undefined = fromStatic ?? api.data;
  const radius = detail.affectedRadiusKm ?? 200;

  return (
    <section aria-labelledby="places-h" className="grid gap-2" data-testid="affected-places">
      <h2 id="places-h" className="text-lg font-semibold">
        {t`Affected places`}
      </h2>
      <p className="text-xs text-muted-foreground">
        {t`Places whose centre the best track passed within ${radius} km of, closest first.`}{" "}
        {fromStatic ? t`From the static dataset.` : t`From the API.`}
      </p>
      {!items && api.isPending ? (
        <Skeleton className="h-20" />
      ) : !items ? (
        <p className="text-sm text-muted-foreground">{t`The place list is unavailable right now (the API may be asleep). The replay is unaffected.`}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t`No covered place was within ${radius} km.`}</p>
      ) : (
        <ol className="grid gap-1.5 text-sm">
          {items.map((h) => (
            <li key={h.place.id} className="flex flex-wrap justify-between gap-x-3 border-b border-border pb-1.5 last:border-0">
              <span>
                {lang === "ja" && h.place.nameJa ? h.place.nameJa : h.place.name}
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
